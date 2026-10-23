// @generated - Actor Framework Scripts v12
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {
  TransformComponent, type Entity, ColliderCapsuleComponent, ColliderSphereComponent,
  ColliderBoxComponent,
} from 'meta/worlds';
import type { ActorBehaviorManager } from 'meta/worlds';
import { AttackEntityInRangeBehavior } from './AttackEntityInRangeBehavior';
import { CompositeBehavior } from '../CompositeBehavior';
import { FollowTaggedEntityBehavior } from '../../Tagging/FollowTaggedEntityBehavior';

/**
 * Compound combat behavior that wraps FollowTaggedEntityBehavior and
 * AttackEntityInRangeBehavior with a detection range gate.
 *
 * All distance parameters use **surface-to-surface** semantics —
 * the framework reads each actor's collider radius automatically, so
 * authors never need to account for body size. Set {@link maxAttackDistance}
 * to the weapon's reach (e.g. 0 = bite, 0.3 = sword, 1.0 = spear,
 * 10 = bow) and the composite derives all internal follow/attack/
 * hysteresis values so the NPC is guaranteed to park inside its own
 * attack band.
 *
 * Extends CompositeBehavior so that sub-behavior controller routing
 * is handled automatically — the attack behavior (higher internal
 * priority) wins the movement controller when in range, stopping
 * the actor from moving while attacking.
 *
 * Target acquisition is handled by {@link FollowTaggedEntityBehavior},
 * which resolves the closest entity matching {@link targetTags} from the
 * ActorTaggingBlackboard. The resolved target is automatically synced
 * to the attack behavior each frame.
 *
 * Use {@link ActorSdkTagPlayerService} to auto-tag players with "player",
 * and {@link ActorSdkTagComponent} to tag other entities.
 */
export class EngageCombatBehavior extends CompositeBehavior {
  override name: string = 'EngageCombatBehavior';

  /**
   * The tags to target (e.g. ["player"], ["player", "enemy"]).
   *
   * ⚠️ Consumer half only. Non-player targets must ALSO carry a matching
   * `ActorSdkTagComponent` tag (same case-sensitive string) or none is acquired.
   */
  targetTags: string[] = ['player'];

  /**
   * Maximum surface-to-surface distance (meters) at which the actor can
   * attack. This is the weapon's reach — the framework adds both actors'
   * collider radii automatically.
   *
   * Examples: 0 = bite/unarmed, 0.3 = sword, 1.0 = spear, 10 = bow.
   */
  maxAttackDistance: number = 1.5;

  /**
   * Minimum surface-to-surface distance (meters) at which the actor can
   * attack. Creates a dead zone when the target is too close (e.g. for
   * ranged NPCs that should flee or switch to melee when crowded).
   * Default 0 (no dead zone).
   */
  minAttackDistance: number = 0;

  /**
   * Surface-to-surface distance (meters) where the NPC prefers to stand.
   * Clamped to [minAttackDistance, maxAttackDistance] at runtime — the NPC
   * always parks inside its own attack band.
   */
  followDistance: number = 1.5;

  /**
   * Maximum surface-to-surface distance (meters) at which the actor acquires
   * and retains a target. A positive value ignores targets beyond it (a
   * dormant enemy that wakes only when a target comes within range).
   *
   * `<= 0` means UNLIMITED: the actor acquires the nearest tagged target at any
   * distance and hunts it from wherever it spawns. That is the default, and it
   * matches `ActorCombatStarterComponent`: an enemy dropped away from its target
   * (e.g. a spawner that scatters enemies across an arena) never sees the target
   * under a finite range and idles at its spawn point. Note `@property`-driven
   * template instances zero-init this field, so an unset combat template is
   * unlimited too.
   */
  engagementRange: number = 0;

  /** Movement speed in meters per second when following a target. */
  followSpeed: number = 5.0;

  /** Damage value passed to the attack controller. */
  attackDamage: number = 1;

  /** Minimum time in seconds between attacks. */
  attackFrequency: number = 1.0;

  protected followTaggedBehavior: FollowTaggedEntityBehavior | null = null;
  protected attackBehavior: AttackEntityInRangeBehavior | null = null;

  private pursuitStallTimer: number = 0;
  private hasWarnedStall: boolean = false;

  // Cached footprints. Recomputed lazily; auto-invalidated on target swap
  // and on world XZ-scale change of the relevant entity (root scale only).
  // Authors call `invalidateFootprintCache()` explicitly for rig swap,
  // equipment change, or child-collider scale animations that the root-scale
  // probe cannot see. Steady state: 0 footprint recomputes per frame.
  // `null` scale sentinel forces first-call recompute and remains null
  // when the entity lacks a TransformComponent — `NaN === NaN` is false,
  // which would otherwise defeat the cache every frame.
  private selfFootprintXZ: number | null = null;
  private selfScaleAtCache: number | null = null;
  private targetFootprintXZ: number | null = null;
  private targetScaleAtCache: number | null = null;
  private cachedTarget: Entity | null = null;

  /**
   * Updates the follow speed at runtime - called by debuff systems (e.g. slow perk effects)
   * to apply speed modifiers to the live behavior. Propagates to FollowTaggedEntityBehavior
   * immediately so the enemy slows down this frame.
   */
  public setFollowSpeed(speed: number): void {
    this.followSpeed = speed;
    if (this.followTaggedBehavior) {
      this.followTaggedBehavior.setFollowSpeed(speed);
    }
  }

  /**
   * Sets or clears a forced target override. When set, the enemy ignores the
   * normal closest-tagged-entity resolution and exclusively targets the given
   * entity. Pass null to revert to default targeting.
   */
  setTargetOverride(entity: Entity | null): void {
    if (this.followTaggedBehavior) {
      this.followTaggedBehavior.setTargetOverride(entity);
    }
  }

  override initialize(behaviorManager: ActorBehaviorManager): void {
    if (this.minAttackDistance > this.maxAttackDistance) {
      console.error(
        `[EngageCombat] minAttackDistance (${this.minAttackDistance}) > maxAttackDistance ` +
        `(${this.maxAttackDistance}) — creates an impossible attack band. ` +
        `Swapping values.`,
      );
      const tmp = this.minAttackDistance;
      this.minAttackDistance = this.maxAttackDistance;
      this.maxAttackDistance = tmp;
    }

    // A positive engagementRange must cover the attack band, otherwise the
    // actor drops the target before it can attack (target-acquire/drop
    // oscillation). `<= 0` is the "unlimited" sentinel — an unlimited actor
    // never drops a target for range, so oscillation is impossible and the
    // floor does not apply.
    if (this.engagementRange > 0 && this.engagementRange < this.maxAttackDistance) {
      console.error(
        `[EngageCombat] engagementRange (${this.engagementRange}) < maxAttackDistance ` +
        `(${this.maxAttackDistance}) — actor will lose its target while still in attack range. ` +
        `Clamping engagementRange to maxAttackDistance.`,
      );
      this.engagementRange = this.maxAttackDistance;
    }

    const standDist = this.getClampedFollowDistance();
    const bandW = this.maxAttackDistance - this.minAttackDistance;

    this.followTaggedBehavior = new FollowTaggedEntityBehavior();
    this.followTaggedBehavior.basePriority = 1;
    this.followTaggedBehavior.targetTags = this.targetTags;
    // 0 passes through to FollowTaggedEntityBehavior as "no range gate"
    // (unlimited acquisition). updateDerivedRanges() re-derives this each frame.
    this.followTaggedBehavior.maxRange = this.engagementRange > 0 ? this.engagementRange : 0;
    this.followTaggedBehavior.followSpeed = this.followSpeed;
    this.followTaggedBehavior.followRange = standDist;
    this.followTaggedBehavior.hysteresisRadius = Math.max(0.15, bandW * 0.4);
    this.followTaggedBehavior.distanceToStop = Math.max(0.05, bandW * 0.12);

    this.attackBehavior = new AttackEntityInRangeBehavior();
    this.attackBehavior.basePriority = 2;
    this.attackBehavior.minAttackDistance = this.minAttackDistance;
    this.attackBehavior.maxAttackDistance = this.maxAttackDistance;
    this.attackBehavior.damage = this.attackDamage;
    this.attackBehavior.attackFrequency = this.attackFrequency;

    this.subBehaviors = [this.followTaggedBehavior, this.attackBehavior];

    // CompositeBehavior.initialize() calls initialize on all sub-behaviors
    super.initialize(behaviorManager);

    // Replace the surface-to-surface seeding above with derived
    // center-to-center values so the first frame is consistent with the
    // steady state. Self footprint is computed once here and cached;
    // target footprint is 0 (no target yet) and the next update() will
    // populate it on acquisition.
    this.updateDerivedRanges(null);
  }

  /**
   * Returns the current target entity resolved by the tagging system,
   * or null if no valid target exists.
   */
  getTarget(): Entity | null {
    if (!this.followTaggedBehavior) return null;
    const info = this.followTaggedBehavior.getTargetInfo();
    return info.isValid ? info.targetEntity : null;
  }

  override update(deltaTime: number): void {
    if (this.followTaggedBehavior && this.attackBehavior) {
      const info = this.followTaggedBehavior.getTargetInfo();
      const targetEntity = info.isValid ? info.targetEntity : null;
      this.attackBehavior.targetEntity = targetEntity;
      // Forward the smoothed target velocity so the attack controller can lead
      // a moving target. The targeting stack already computes this for the
      // follow path; null it out when there is no valid target.
      this.attackBehavior.targetVelocity = info.isValid ? info.smoothedVelocity : null;

      // Invalidate target footprint when the target changes — collider
      // geometry differs per entity. Self + target footprints also
      // auto-invalidate on root XZ scale change inside the cached getters.
      // For child-collider scale animations or rig/equipment swaps the
      // root probe cannot see, authors call `invalidateFootprintCache()`.
      if (targetEntity !== this.cachedTarget) {
        this.targetFootprintXZ = null;
        this.targetScaleAtCache = null;
        this.cachedTarget = targetEntity;
      }

      this.updateDerivedRanges(targetEntity);
      this.updatePursuitStallWarning(deltaTime);
    }

    // CompositeBehavior.update() drives sub-behaviors in priority order
    // and handles controller routing automatically
    super.update(deltaTime);
  }

  /**
   * Invalidates the cached collider footprints so the next frame recomputes
   * them. Call this when the actor's or target's collider geometry / world
   * scale changes at runtime (e.g. scale animation, rig swap, equipment change).
   * Target-change invalidation is automatic.
   */
  public invalidateFootprintCache(scope: 'self' | 'target' | 'all' = 'all'): void {
    if (scope === 'self' || scope === 'all') this.selfFootprintXZ = null;
    if (scope === 'target' || scope === 'all') this.targetFootprintXZ = null;
  }

  /** Reads an entity's root XZ world scale; returns null when unavailable. */
  private getRootScaleXZ(entity: Entity): number | null {
    const t = entity.getComponent(TransformComponent);
    return t ? Math.max(Math.abs(t.worldScale.x), Math.abs(t.worldScale.z)) : null;
  }

  /**
   * Returns the cached self footprint, recomputing if the root XZ scale
   * changed since the last cache or if the cache was invalidated. Returns
   * 0 without caching when `getEntity()` is null (pre-init / teardown),
   * so the cache is not poisoned and the next frame retries. When the
   * entity has no TransformComponent the scale snapshot is null on both
   * sides of the compare, so the cache holds (avoids per-frame recompute
   * from a `NaN === NaN` mismatch).
   */
  private getSelfFootprintXZCached(): number {
    const selfEntity = this.getEntity();
    if (!selfEntity) return 0;
    const currentScale = this.getRootScaleXZ(selfEntity);
    if (this.selfFootprintXZ !== null && currentScale === this.selfScaleAtCache) {
      return this.selfFootprintXZ;
    }
    this.selfFootprintXZ = this.getFootprintXZ(selfEntity);
    this.selfScaleAtCache = currentScale;
    return this.selfFootprintXZ;
  }

  /**
   * Returns the cached target footprint, recomputing if the target's root
   * XZ scale changed since the last cache or if the cache was invalidated.
   * Target identity changes are auto-invalidated upstream in `update()`.
   */
  private getTargetFootprintXZCached(targetEntity: Entity | null): number {
    if (!targetEntity) return 0;
    const currentScale = this.getRootScaleXZ(targetEntity);
    if (this.targetFootprintXZ !== null && currentScale === this.targetScaleAtCache) {
      return this.targetFootprintXZ;
    }
    this.targetFootprintXZ = this.getFootprintXZ(targetEntity);
    this.targetScaleAtCache = currentScale;
    return this.targetFootprintXZ;
  }

  /**
   * Pushes derived center-to-center distances to the follow and attack
   * sub-behaviors using the cached collider footprints.
   *
   * Footprints are cached across frames; call `invalidateFootprintCache()`
   * when collider geometry or world scale changes at runtime (target-change
   * invalidation is automatic).
   */
  private updateDerivedRanges(targetEntity: Entity | null): void {
    const sumR = this.getSelfFootprintXZCached() + this.getTargetFootprintXZCached(targetEntity);

    // Re-validate engagementRange every frame — `initialize()` clamps once,
    // but authors can mutate the field at runtime and re-introduce the
    // target-acquire/drop oscillation it was added to prevent. Write the
    // clamped value back to the field so external readers of
    // `combat.engagementRange` see the effective value, consistent with
    // `initialize()`'s self-healing semantics. The `<= 0` "unlimited" sentinel
    // is preserved untouched — clamping it would silently defeat aggro-on-spawn.
    const unlimited = this.engagementRange <= 0;
    const effectiveEngagementRange = unlimited
      ? this.engagementRange
      : Math.max(this.engagementRange, this.maxAttackDistance);
    if (!unlimited && this.engagementRange !== effectiveEngagementRange) {
      this.engagementRange = effectiveEngagementRange;
    }

    const standDist = this.getClampedFollowDistance();
    const bandW = this.maxAttackDistance - this.minAttackDistance;

    // Push derived center-to-center values to attack behavior
    this.attackBehavior!.minAttackDistance = sumR + this.minAttackDistance;
    this.attackBehavior!.maxAttackDistance = sumR + this.maxAttackDistance;
    // Also push the raw radii sum so the attack behavior can convert its
    // center-to-center distance back to a surface (gap) distance for telemetry,
    // using the exact same sumR that defines the band above.
    this.attackBehavior!.radiiSum = sumR;

    // Push derived values to follow behavior via the runtime update API,
    // which writes both the outer public fields and the inner sub-behavior
    // per-frame caches. This template assumes the paired
    // `FollowTaggedEntityBehavior` is regenerated together with this one —
    // a legacy bundle without `updateRuntimeRanges` will fail loudly here,
    // which is the intended signal to regenerate both templates.
    const hysteresis = Math.max(0.15, bandW * 0.4);
    const stopDist = Math.max(0.05, bandW * 0.12);
    // Unlimited (<= 0): pass 0 so FollowTaggedEntityBehavior disables its range
    // gate and acquires/retains at any distance. Otherwise gate at the derived
    // center-to-center engagement range.
    const acquisitionMaxRange = unlimited ? 0 : sumR + effectiveEngagementRange;
    this.followTaggedBehavior!.updateRuntimeRanges(
      sumR + standDist,
      acquisitionMaxRange,
      hysteresis,
      stopDist,
    );
  }

  private getClampedFollowDistance(): number {
    // Honor the author-set followDistance, clamped into the attack band.
    // Fall back to the band midpoint when the author left followDistance
    // unset / NaN / non-finite — the midpoint absorbs pursuit-lag overshoot
    // symmetrically.
    const midpoint = (this.minAttackDistance + this.maxAttackDistance) / 2;
    const requested = Number.isFinite(this.followDistance) ? this.followDistance : midpoint;
    return Math.max(this.minAttackDistance, Math.min(requested, this.maxAttackDistance));
  }

  /**
   * Extracts the XZ-plane collision radius from an entity's collider,
   * scaled by the entity's world scale. Returns 0 if no collider is found.
   *
   * Returns the MAX scaled XZ radius across the root entity AND all child
   * colliders (capsule + sphere + box). Multi-collider rigs (e.g. tiny root
   * tag capsule + larger chest box on a child) get the conservative
   * bounding radius rather than the root-first match.
   */
  private getFootprintXZ(entity: Entity): number {
    // Root collider participates in the max — do not early-return on a
    // small root match that would mask larger child colliders.
    let maxRadius = this.getFootprintFromEntity(entity);

    const capsuleChildren = entity.getChildrenWithComponent(ColliderCapsuleComponent, true);
    for (const child of capsuleChildren) {
      const capsule = child.getComponent(ColliderCapsuleComponent);
      if (!capsule) continue;
      const childTransform = child.getComponent(TransformComponent);
      const scaleXZ = childTransform
        ? Math.max(Math.abs(childTransform.worldScale.x), Math.abs(childTransform.worldScale.z))
        : 1;
      const r = capsule.radius * scaleXZ;
      if (r > maxRadius) maxRadius = r;
    }

    const sphereChildren = entity.getChildrenWithComponent(ColliderSphereComponent, true);
    for (const child of sphereChildren) {
      const sphere = child.getComponent(ColliderSphereComponent);
      if (!sphere) continue;
      const childTransform = child.getComponent(TransformComponent);
      const scaleXZ = childTransform
        ? Math.max(Math.abs(childTransform.worldScale.x), Math.abs(childTransform.worldScale.z))
        : 1;
      const r = sphere.radius * scaleXZ;
      if (r > maxRadius) maxRadius = r;
    }

    const boxChildren = entity.getChildrenWithComponent(ColliderBoxComponent, true);
    for (const child of boxChildren) {
      const box = child.getComponent(ColliderBoxComponent);
      if (!box) continue;
      const childTransform = child.getComponent(TransformComponent);
      const scaleXZ = childTransform
        ? Math.max(Math.abs(childTransform.worldScale.x), Math.abs(childTransform.worldScale.z))
        : 1;
      const he = box.halfExtents;
      const r = Math.max(Math.abs(he.x), Math.abs(he.z)) * scaleXZ;
      if (r > maxRadius) maxRadius = r;
    }

    return maxRadius;
  }

  /** Checks a single entity for a collider and returns its scaled XZ radius. */
  private getFootprintFromEntity(entity: Entity): number {
    const transform = entity.getComponent(TransformComponent);
    const scaleXZ = transform
      ? Math.max(Math.abs(transform.worldScale.x), Math.abs(transform.worldScale.z))
      : 1;

    const capsule = entity.getComponent(ColliderCapsuleComponent);
    if (capsule) {
      return capsule.radius * scaleXZ;
    }

    const sphere = entity.getComponent(ColliderSphereComponent);
    if (sphere) {
      return sphere.radius * scaleXZ;
    }

    const box = entity.getComponent(ColliderBoxComponent);
    if (box) {
      const he = box.halfExtents;
      return Math.max(Math.abs(he.x), Math.abs(he.z)) * scaleXZ;
    }

    return 0;
  }

  /**
   * Warns when the actor has been pursuing without entering the
   * attack band for an extended period — indicates a configuration
   * problem or navmesh issue. Resets when target is lost so re-warning
   * is possible on a new target.
   */
  private updatePursuitStallWarning(deltaTime: number): void {
    const targetEntity = this.attackBehavior!.targetEntity;

    // Target-loss reset MUST run before the warned-stall short-circuit —
    // otherwise the warning latches for the NPC's entire lifetime and the
    // documented re-arm on new target acquisition never happens.
    if (!targetEntity) {
      this.pursuitStallTimer = 0;
      this.hasWarnedStall = false;
      return;
    }

    if (this.hasWarnedStall) return;

    const selfEntity = this.getEntity();
    if (!selfEntity) return;

    // Cached footprints — same sumR as updateDerivedRanges() this frame.
    const selfFootprint = this.getSelfFootprintXZCached();
    const targetFootprint = this.getTargetFootprintXZCached(targetEntity);
    const sumR = selfFootprint + targetFootprint;

    const selfPos = selfEntity.getComponent(TransformComponent)?.worldPosition;
    const targetPos = targetEntity.getComponent(TransformComponent)?.worldPosition;
    if (!selfPos || !targetPos) return;

    // XZ-plane distance matches footprint semantics. Stall warning therefore
    // cannot distinguish two-floor pursuit from same-floor; that's a known
    // limitation — combat balance lives in XZ space.
    const dx = selfPos.x - targetPos.x;
    const dz = selfPos.z - targetPos.z;
    const distXZ = Math.sqrt(dx * dx + dz * dz);
    const currentGap = Math.max(0, distXZ - sumR);
    const isInRange = currentGap >= this.minAttackDistance && currentGap <= this.maxAttackDistance;

    if (isInRange) {
      this.pursuitStallTimer = 0;
      return;
    }

    this.pursuitStallTimer += deltaTime;

    if (this.pursuitStallTimer > 5.0) {
      console.warn(
        `[EngageCombat] Actor cannot reach attack band after 5s of pursuit. ` +
        `Current surface distance=${currentGap.toFixed(2)}m, ` +
        `attack band=[${this.minAttackDistance}, ${this.maxAttackDistance}]m. ` +
        `Check navmesh connectivity, collider radii (self=${selfFootprint.toFixed(2)}, ` +
        `target=${targetFootprint.toFixed(2)}), or maxAttackDistance.`,
      );
      this.hasWarnedStall = true;
    }
  }
}
