// @generated - Actor Framework Scripts v9
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {
  component,
  Component,
  editor,
  EntityService,
  NavMeshComponent,
  property,
  TransformComponent,
  Vec3,
  type Entity,
  type TemplateAsset,
} from 'meta/worlds';
import {SpawnService} from './SpawnService';

// How far findClosestPoint() may search off the sampled point for navmesh. The
// navmesh default; wide enough to catch a spawner parked just off the mesh.
const SNAP_SEARCH_DISTANCE_M = 5;

// maxSearchDistance for the clearance probes. The probe origin is already an
// on-navmesh point (it came from findClosestPoint), so this only absorbs
// float error -- it is NOT a search budget.
const CLEARANCE_SNAP_TOLERANCE_M = 2;

// Radial probes used to measure clearance around a candidate. 8 samples every
// 45 degrees: enough to catch the gap between two headstones without making
// spawn placement expensive (raycast is synchronous, so this is 8 native calls
// per attempt, event-driven -- never per frame).
const CLEARANCE_PROBE_COUNT = 8;

// Ring width (m) used to step the search outward when spawnRadius is 0 (spawn
// exactly at the entity), which has no disk to widen.
const DEFAULT_EXPANSION_STEP_M = 2;

/**
 * Places + configures a spawn source for a template and delegates the actual
 * spawn + live-set + cap enforcement to the server-authoritative SpawnService.
 *
 * This component owns the *where* of a spawn (this entity's position, scattered
 * within spawnRadius) and the per-source knobs (template, cap, scale, group);
 * it does NOT own the *when* (a trigger -- ActorIntervalTrigger /
 * ActorProximityTrigger -- calls `spawn()`), and it no longer keeps its own live
 * set. The cap is enforced GLOBALLY per group by SpawnService, so two spawners
 * feeding one wave share a single maxAlive instead of each enforcing their own
 * (which summed to 2x the cap). See the actor_spawning_architecture design.
 *
 * Spawning is server-authoritative (SpawnService gates on isServerContext) and
 * uses NetworkMode.Networked: the server creates the entity and it replicates to
 * clients, so a spawner evaluated on more than one context cannot duplicate.
 */
@component({
  description:
    'A spawn source for an actor template; delegates spawn + global per-group cap to SpawnService. Driven by a sibling trigger (interval/proximity) that calls spawn().',
})
export class ActorSpawner extends Component {
  @property()
  @editor({description: 'Template asset to spawn as the actor instance.'})
  spawnTemplate: TemplateAsset | null = null;

  @property()
  @editor({
    description:
      'Maximum number of simultaneously-live actors in this spawner group. 0 = unbounded. Enforced GLOBALLY by SpawnService across every spawner sharing the group, so a spawn() request is skipped when the group is already at the cap.',
  })
  maxAlive: number = 0;

  @property()
  @editor({
    description:
      'Radius (meters) of the random horizontal scatter around this entity for each spawn. 0 = spawn exactly at this entity.',
  })
  spawnRadius: number = 0;

  @property()
  @editor({description: 'Uniform scale applied to each spawned actor.'})
  scale: number = 1.0;

  @property()
  @editor({
    description:
      'Shared cap group. Spawners with the SAME non-empty id share one maxAlive cap and one despawn set via SpawnService. Leave empty to group by the spawn template (all spawners of the same enemy type share a cap automatically).',
  })
  spawnGroupId: string = '';

  @property()
  @editor({
    description:
      'Snap each scattered spawn point onto the navmesh and require actorRadius of clearance before spawning there. Prevents spawning inside/on top of scenery colliders (e.g. a graveyard prop) where the actor wedges and never moves. No-op in a world with no baked navmesh. Set false for the raw scatter.',
  })
  snapSpawnToNavMesh: boolean = true;

  @property()
  @editor({
    description:
      "Horizontal half-width (meters) of the spawned actor's collider -- the clearance a spawn point must have from the nearest navmesh boundary, measured surface-to-surface. A candidate is rejected when any boundary is closer than this, so the actor's body (not just its pivot) fits. 0 = snap to the navmesh but skip the clearance check.",
  })
  actorRadius: number = 0.5;

  @property()
  @editor({
    description:
      'How many scattered points to test for navmesh clearance before giving up and falling back (see snapSpawnToNavMesh). Each attempt is one navmesh snap plus a ring of clearance probes.',
  })
  spawnPlacementAttempts: number = 8;

  @property()
  @editor({
    description:
      "How many times to widen the search outward when NO point inside spawnRadius has room for the actor -- the signature of a spawner sitting inside scenery (e.g. parented to a graveyard prop, so its whole spawn disk is headstones). Each step searches the next ring out, so the actor is placed on the nearest walkable ground just outside the obstruction instead of on top of it. 0 = never widen (spawn stays inside spawnRadius).",
  })
  spawnSearchExpansions: number = 3;

  @property()
  @editor({description: 'Enable debug logging to console.'})
  debugLogEnabled: boolean = false;

  // True while a spawn() awaits SpawnService; a single-flight guard so a slow
  // spawn can't let a trigger's paced calls pile up and burst (see spawn()).
  private spawnInFlight: boolean = false;

  // Cached navmesh entity, re-discovered when destroyed (mirrors GotoBehavior).
  private cachedNavMeshEntity: Entity | null = null;

  // The "no navmesh in this world" warning is latched: a spawner on a 3s
  // interval would otherwise emit it on every spawn for the life of the world.
  private warnedNoNavMesh: boolean = false;

  // Set once the full placement search has failed to find a clear point, and
  // cleared by the next success. Latches both the warning and the reduced
  // search (see resolveSpawnPoint).
  private spawnAreaIsCramped: boolean = false;

  // Latches the "had to leave spawnRadius to find walkable ground" warning so a
  // 3s-cadence spawner reports the authoring problem once, not every spawn.
  private warnedSearchExpanded: boolean = false;

  // The SpawnService group key: an explicit id if set, else the template itself
  // (so same-template spawners share a cap). null only when no template is set.
  private get groupKey(): string | TemplateAsset | null {
    const explicit = this.spawnGroupId.trim();
    if (explicit) {
      return explicit;
    }
    return this.spawnTemplate;
  }

  /**
   * Current number of live actors in this spawner's group (delegated to
   * SpawnService, which prunes destroyed entities).
   */
  public getLiveCount(): number {
    const key = this.groupKey;
    return key != null ? SpawnService.get().getLiveCount(key) : 0;
  }

  /**
   * Spawn one actor instance, unless the group is already at the cap.
   * Called by a trigger component; returns the spawned entity, or null if the
   * spawn was skipped (no template, at cap, non-server) or did not resolve.
   *
   * @param originOverride Optional world position to scatter the spawn around
   * instead of this entity's own position -- e.g. a proximity trigger spawning
   * relative to the player. Snapshotted before the await, same as the self path.
   */
  public async spawn(originOverride?: Vec3): Promise<Entity | null | undefined> {
    if (!this.spawnTemplate) {
      this.warn('spawn() called but spawnTemplate is not set.');
      return null;
    }

    // Single-flight: skip if a spawn is already in-flight for this spawner rather
    // than queue behind it. A slow spawn (e.g. first-time template instantiation
    // in a cold runtime, which can take many seconds) would otherwise let a
    // trigger's paced spawn() calls pile up and then all resolve at once -- an
    // observable spawn burst even though the trigger cadence is correct. Dropping
    // the extra requests keeps spawns paced; the trigger fires again next interval.
    if (this.spawnInFlight) {
      this.log('spawn() skipped; a spawn is already in-flight.');
      return null;
    }

    // Snapshot the spawn transform BEFORE the await so a concurrent move of this
    // entity can't tear the spawn position mid-flight.
    const transform = this.entity.getComponent(TransformComponent);
    if (!transform) {
      this.warn('No TransformComponent on the spawner entity.');
      return null;
    }
    const spawnOrigin = originOverride ?? transform.worldPosition;
    const spawnRotation = transform.worldRotation;

    // Mark in-flight BEFORE the placement await, not just the spawn await:
    // resolveSpawnPoint() awaits findClosestPoint, so leaving the guard until
    // after it would let a trigger's paced calls slip past and burst.
    this.spawnInFlight = true;
    let spawned: Entity | null | undefined;
    try {
      const spawnPosition = await this.resolveSpawnPoint(spawnOrigin);
      spawned = await SpawnService.get().requestSpawn({
        // Single source of truth for the group key (the getter); ?? satisfies the
        // type — spawnTemplate is non-null here, so groupKey is never null.
        key: this.groupKey ?? this.spawnTemplate,
        template: this.spawnTemplate,
        position: spawnPosition,
        rotation: spawnRotation,
        maxAlive: this.maxAlive,
        scale: this.scale,
      });
    } finally {
      this.spawnInFlight = false;
    }
    if (spawned != null) {
      // Permanent spawn telemetry (ALWAYS on, not debug-gated). The engine emits
      // no native per-spawn line, so this spawner is the authoritative record of
      // spawn times. Tooling (the spawn_cadence eval) parses these from the
      // runtime log to measure spawn timing from world-live -- independent of any
      // later observation window. Event-driven (once per spawn, not per frame), so
      // it is not an update-loop log.
      console.log(
        `[ActorSpawnTelemetry] event=spawn spawner=${this.entityName} group=${this.spawnGroupId} alive=${this.getLiveCount()}`,
      );
    }
    return spawned;
  }

  /**
   * Destroy all still-live actors in this spawner's group (e.g. a proximity
   * trigger returning the player to a safe zone). Delegated to SpawnService.
   */
  public despawnAll(): void {
    const key = this.groupKey;
    if (key != null) {
      SpawnService.get().despawnGroup(key);
    }
  }

  /**
   * Pick a spawn point that the actor actually fits on.
   *
   * `scatter()` alone only randomizes X/Z and copies the spawner's Y, so a
   * scattered point can land inside or on top of scenery geometry (a headstone,
   * a wall) -- the actor then spawns clipping the collider, gets shoved by
   * depenetration or wedges, and never moves. This resolves the point against
   * the navmesh instead:
   *
   *  1. snap the candidate to the nearest point ON the navmesh (this also
   *     supplies a real ground Y instead of the spawner's altitude), then
   *  2. require `actorRadius` of clearance around it, measured
   *     surface-to-surface -- being on the navmesh is not enough if the actor's
   *     body is wider than the gap it was snapped into.
   *
   * Falls back progressively and loudly rather than failing the spawn: a world
   * with no baked navmesh keeps the legacy behavior.
   */
  private async resolveSpawnPoint(origin: Vec3): Promise<Vec3> {
    if (!this.snapSpawnToNavMesh) {
      return this.scatter(origin);
    }

    const navMesh = this.resolveNavMeshComponent();
    if (navMesh == null) {
      // Not an error: most worlds ship without a baked navmesh, and the raw
      // scatter is exactly what those worlds got before this validation existed.
      if (!this.warnedNoNavMesh) {
        this.warnedNoNavMesh = true;
        this.warn(
          'no NavMeshComponent in world; spawning at the unvalidated scatter point. ' +
            'Bake a navmesh to place spawns on walkable ground with actor clearance.',
        );
      }
      return this.scatter(origin);
    }

    const clearance = Math.max(0, this.actorRadius);
    // A spawn area that has already exhausted the full search is very unlikely
    // to yield a clear point on the next spawn either (the geometry does not
    // move). Re-running the full sweep every 3s would burn attempts x rings
    // awaited navmesh queries per spawn and -- because single-flight is held
    // across placement -- start dropping the trigger's paced spawn() calls.
    // After the area proves cramped, drop to a single attempt per ring:
    // rings + 1 probes instead of attempts * (rings + 1), still walking outward
    // and still picking the roomiest point. Any success clears the latch.
    const attempts = this.spawnAreaIsCramped
      ? 1
      : Math.max(1, Math.floor(this.spawnPlacementAttempts));

    // Track the ROOMIEST candidate seen, not the first: when nothing meets the
    // bar, the best-available point is a materially better place to put the
    // actor than whichever candidate happened to come up first. Seeded at 0 so
    // a point measureClearance() could not verify (it returns 0 for those)
    // never wins the comparison and becomes the fallback.
    let bestPoint: Vec3 | null = null;
    let bestClearance = 0;

    // Ring 0 is the author's configured spawnRadius. Later rings step outward
    // in equal widths, so a spawner parked inside scenery (its whole disk is
    // headstones) walks its way out to the nearest walkable ground instead of
    // dropping the actor on top of the prop. Bounded by spawnSearchExpansions.
    const ringWidth =
      this.spawnRadius > 0 ? this.spawnRadius : DEFAULT_EXPANSION_STEP_M;
    const rings = Math.max(0, Math.floor(this.spawnSearchExpansions));

    for (let ring = 0; ring <= rings; ring++) {
      const innerRadius = ring === 0 ? 0 : ringWidth * ring;
      const outerRadius = ringWidth * (ring + 1);

      // Ring 0 of a spawnRadius-0 spawner has no disk to draw from: scatter()
      // hands back the origin verbatim, so extra attempts would re-probe
      // identical coordinates. One is all the information there is.
      const ringAttempts = ring === 0 && this.spawnRadius <= 0 ? 1 : attempts;

      for (let attempt = 0; attempt < ringAttempts; attempt++) {
        const candidate =
          ring === 0
            ? this.scatter(origin)
            : this.scatterInAnnulus(origin, innerRadius, outerRadius);
        const snapped = await navMesh.findClosestPoint(candidate, {
          maxSearchDistance: SNAP_SEARCH_DISTANCE_M,
        });
        if (snapped == null) {
          continue;
        }
        const measured = this.measureClearance(navMesh, snapped, clearance);
        if (measured > bestClearance) {
          bestClearance = measured;
          bestPoint = snapped;
        }
        if (clearance <= 0 || measured >= clearance) {
          this.spawnAreaIsCramped = false;
          if (ring > 0 && !this.warnedSearchExpanded) {
            // Once per spawner: the placement succeeded, but only by leaving
            // the configured disk. That is the author-actionable signal that
            // the spawner is sitting inside geometry.
            this.warnedSearchExpanded = true;
            this.warn(
              `no walkable ground within spawnRadius (${this.spawnRadius}m); ` +
                `placed the actor ${innerRadius}-${outerRadius}m out instead. ` +
                'The spawner is likely inside/on top of scenery -- move it to open ' +
                'ground next to the landmark rather than at its center.',
            );
          }
          this.log(
            `spawn point resolved on ring ${ring}, attempt ${attempt + 1}/${ringAttempts} with >=${clearance}m clearance.`,
          );
          return snapped;
        }
      }
    }

    if (bestPoint != null) {
      if (!this.spawnAreaIsCramped) {
        // Latch + warn ONCE per cramped streak. The per-spawn repeat added no
        // information and dominated the log at a 3s cadence.
        this.spawnAreaIsCramped = true;
        this.warn(
          `no spawn point with ${clearance}m clearance within ${ringWidth * (rings + 1)}m ` +
            `(${attempts} attempts x ${rings + 1} rings; best found: ${bestClearance.toFixed(2)}m); ` +
            'using the roomiest on-navmesh point and reducing the search until one ' +
            'clears. Move the spawner to open ground, raise spawnSearchExpansions, or ' +
            'lower actorRadius.',
        );
      }
      return bestPoint;
    }

    // Either nothing snapped, or every snapped point failed its own clearance
    // probe. Latch on the same flag as the cramped path above: without it this
    // dead area re-runs the whole awaited sweep and re-emits this line on every
    // trigger tick, which is exactly what the latch exists to prevent.
    if (!this.spawnAreaIsCramped) {
      this.spawnAreaIsCramped = true;
      this.warn(
        `no usable navmesh point for the spawn area (${attempts} attempts x ` +
          `${rings + 1} rings): either nothing snapped within ` +
          `${SNAP_SEARCH_DISTANCE_M}m, or every snapped point failed its clearance ` +
          'probe. Spawning at the unvalidated scatter point -- is the spawner ' +
          'inside geometry, or is the navmesh invalid?',
      );
    }
    return this.scatter(origin);
  }

  /**
   * Distance (m) from `point` to the nearest non-walkable navmesh edge, capped
   * at `radius`. Returns `radius` when nothing is within that range, and 0 when
   * a probe query fails (the point is not actually on the navmesh) -- an
   * unverifiable point is treated as a bad point.
   *
   * Measured surface-to-surface: probing out to the actor's half-width means a
   * point clears exactly when the actor's BODY fits, not merely when its pivot
   * sits on the mesh.
   *
   * Returns the measured distance rather than a bool so an exhausted search can
   * still pick the roomiest candidate it saw instead of the first one.
   */
  private measureClearance(
    navMesh: NavMeshComponent,
    point: Vec3,
    radius: number,
  ): number {
    if (radius <= 0) {
      return 0;
    }
    let nearest = radius;
    for (let i = 0; i < CLEARANCE_PROBE_COUNT; i++) {
      const angle = (i / CLEARANCE_PROBE_COUNT) * Math.PI * 2;
      const direction = new Vec3(Math.cos(angle), 0, Math.sin(angle));
      const result = navMesh.raycast(point, direction, radius, {
        maxSearchDistance: CLEARANCE_SNAP_TOLERANCE_M,
      });
      if (result.hit) {
        nearest = Math.min(nearest, result.distance);
      } else if (result.distance <= 0) {
        // Query failed: origin off-navmesh or navmesh invalid. Unverifiable.
        return 0;
      }
    }
    return nearest;
  }

  /**
   * Lazily resolves the NavMesh component, re-discovering it if the cache went
   * stale. Returns null when the world has no navmesh. Follows
   * GotoBehavior.resolveNavMeshComponent(), plus the component-removed case.
   */
  private resolveNavMeshComponent(): NavMeshComponent | null {
    if (this.cachedNavMeshEntity != null && !this.cachedNavMeshEntity.valid) {
      this.cachedNavMeshEntity = null;
    }
    if (this.cachedNavMeshEntity != null) {
      const cached = this.cachedNavMeshEntity.getComponent(NavMeshComponent);
      if (cached != null) {
        return cached;
      }
      // The entity outlived its NavMeshComponent. Drop it, or this spawner
      // keeps returning null for the life of the world even though another
      // entity may still host a navmesh.
      this.cachedNavMeshEntity = null;
    }
    const entities = EntityService.findEntitiesWithComponent(NavMeshComponent);
    if (entities.length === 0) {
      return null;
    }
    this.cachedNavMeshEntity = entities[0];
    return this.cachedNavMeshEntity.getComponent(NavMeshComponent);
  }

  // Horizontal random offset within spawnRadius; returns the point unchanged
  // when spawnRadius is 0. Called per spawn (event-driven, not per frame).
  private scatter(origin: Vec3): Vec3 {
    if (this.spawnRadius <= 0) {
      return origin;
    }
    return this.scatterInAnnulus(origin, 0, this.spawnRadius);
  }

  /**
   * Random horizontal point in the annulus [innerRadius, outerRadius] around
   * `origin`.
   *
   * Sampling an ANNULUS (rather than re-sampling the whole disk) is what makes
   * the outward search actually move: once the inner disk is known to be solid
   * scenery, re-drawing from it just re-tests ground that already failed.
   */
  private scatterInAnnulus(
    origin: Vec3,
    innerRadius: number,
    outerRadius: number,
  ): Vec3 {
    if (outerRadius <= 0) {
      return origin;
    }
    const angle = Math.random() * Math.PI * 2;
    // sqrt of a uniform draw across the squared radii keeps the distribution
    // uniform over AREA; a bare Math.random() on the radius would crowd the
    // inner edge of the ring.
    const inner2 = innerRadius * innerRadius;
    const outer2 = outerRadius * outerRadius;
    const dist = Math.sqrt(inner2 + Math.random() * (outer2 - inner2));
    return new Vec3(
      origin.x + Math.cos(angle) * dist,
      origin.y,
      origin.z + Math.sin(angle) * dist,
    );
  }

  private log(...args: unknown[]): void {
    if (this.debugLogEnabled) {
      console.log(`[ActorSpawner] ${this.entityName}:`, ...args);
    }
  }

  private warn(...args: unknown[]): void {
    console.warn(`[ActorSpawner] ${this.entityName}:`, ...args);
  }

  private get entityName(): string {
    return this.entity?.valid ? this.entity.name : '<destroyed>';
  }
}
