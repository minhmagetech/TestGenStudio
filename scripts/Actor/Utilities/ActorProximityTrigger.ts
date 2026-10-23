// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {
  component,
  Component,
  editor,
  ExecuteOn,
  OnEntityStartEvent,
  OnWorldUpdateEvent,
  OnWorldUpdateEventPayload,
  PlayerService,
  property,
  subscribe,
  TransformComponent,
  type Entity,
  type Vec3,
} from 'meta/worlds';
import {ActorSpawner} from './ActorSpawner';

// Effective floor for spawnInterval; a 0/negative editor value would otherwise
// fire spawn() every frame while the player is outside the safe zone.
const MIN_INTERVAL_SECONDS = 0.1;

/**
 * Drives a sibling ActorSpawner from the player's distance to a landmark:
 * spawns on an interval WHILE the nearest player is OUTSIDE a safe-zone radius
 * around the landmark — positioning each spawn relative to that player — and
 * despawns everything once the player returns INSIDE the safe zone.
 *
 * Place this on the SAME entity as an ActorSpawner (like ActorIntervalTrigger).
 * This is the proximity/aggro counterpart to the time-only ActorIntervalTrigger:
 * it owns a distance-gated *when* + a player-relative *where*, while ActorSpawner
 * still owns the *how* (spawn + live-set + cap + despawn). See the
 * actor_spawning_architecture design.
 *
 * The gate + cadence are driven by accumulating OnWorldUpdateEvent deltaTime
 * (never setTimeout/setInterval, per worlds init/perf rules) on the Owner
 * (server) so the Networked spawn stays single-authority. Player position read
 * server-side is network-replicated (slightly stale) — fine for a radius gate.
 *
 * Note: entering the safe zone despawns spawned actors immediately; the
 * "walk back to spawn point, then disappear" return animation is not modeled
 * here (a future behavior concern, not this trigger's job).
 */
@component({
  description:
    'Spawns from a sibling ActorSpawner on an interval while the nearest player is beyond safeZoneRadius of the landmark (spawning near that player), and despawns all when the player returns inside. Compose with ActorSpawner on the same entity.',
})
export class ActorProximityTrigger extends Component {
  @property()
  @editor({
    description:
      'Landmark/anchor the safe zone is measured from (e.g. a tent or camp). Falls back to this entity if unset.',
  })
  landmark: Entity | null = null;

  @property()
  @editor({
    description:
      'Radius (meters) around the landmark. Spawning is active only while the nearest player is OUTSIDE this radius; the player re-entering it despawns all spawned actors.',
  })
  safeZoneRadius: number = 15.0;

  @property()
  @editor({
    description:
      'Seconds between spawns while the player is outside the safe zone.',
  })
  spawnInterval: number = 3.0;

  @property()
  @editor({description: 'Enable debug logging to console.'})
  debugLogEnabled: boolean = false;

  private spawner: ActorSpawner | null = null;
  private elapsed: number = 0;
  // Prior-frame gate state so we act on the boundary crossing, not every frame.
  private wasOutside: boolean = false;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart(): void {
    this.spawner = this.entity.getComponent(ActorSpawner);
    if (!this.spawner) {
      console.warn(
        `[ActorProximityTrigger] ${this.entityName}: no sibling ActorSpawner on this entity; nothing to drive.`,
      );
    }
  }

  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Owner})
  onUpdate(params: OnWorldUpdateEventPayload): void {
    if (!this.spawner) {
      return;
    }

    const anchorPos = this.anchorPosition();
    if (!anchorPos) {
      return;
    }

    const player = this.nearestPlayerTo(anchorPos);
    const playerPos = player?.getComponent(TransformComponent)?.worldPosition;
    if (!playerPos) {
      // Player unavailable: none joined yet, all disconnected, or the entity
      // briefly lacks a TransformComponent. If we were previously outside (and
      // may have spawned actors), fire the despawn edge now so those actors
      // don't linger until some future player enters then re-enters the safe
      // zone. On the pre-join first frames wasOutside is false, so this stays a
      // no-op and no spurious despawn fires.
      if (this.wasOutside) {
        this.log('Player unavailable while outside; despawning.');
        this.spawner.despawnAll();
      }
      this.wasOutside = false;
      return;
    }

    const interval = Math.max(this.spawnInterval, MIN_INTERVAL_SECONDS);
    const safeSq = this.safeZoneRadius * this.safeZoneRadius;
    const outside = anchorPos.distanceSquared(playerPos) > safeSq;

    if (outside && !this.wasOutside) {
      // inside -> outside edge: arm the cadence so the first spawn fires on the
      // next tick rather than a full interval later.
      this.log('Player left the safe zone; arming spawn cadence.');
      this.elapsed = interval;
    } else if (!outside && this.wasOutside) {
      // outside -> inside edge: player is back in the safe zone; despawn once.
      this.log('Player entered the safe zone; despawning.');
      this.spawner.despawnAll();
    }
    this.wasOutside = outside;

    if (!outside) {
      return;
    }

    this.elapsed += params.deltaTime;
    if (this.elapsed >= interval) {
      // Reset to 0 (NOT subtract/catch-up): one spawn per interval crossing, so a
      // single oversized catch-up tick (post-load / resume / long pause) yields at
      // most ONE spawn, not a backlog drain. deltaTime is game time (respects
      // pause); ActorSpawner.spawn() is single-flight, so paced calls can't pile up.
      this.elapsed = 0;
      // Spawn around the player (ActorSpawner scatters within its spawnRadius).
      void this.spawner.spawn(playerPos);
    }
  }

  // World position of the safe-zone anchor (the landmark, or this entity).
  private anchorPosition(): Vec3 | null {
    const anchor = this.landmark ?? this.entity;
    return anchor?.getComponent(TransformComponent)?.worldPosition ?? null;
  }

  // Nearest player to a reference position. Uses server-authoritative
  // getAllPlayers() (getLocalPlayer() is null on the server / Owner context).
  private nearestPlayerTo(reference: Vec3): Entity | null {
    let nearest: Entity | null = null;
    let nearestSq = Infinity;
    for (const player of PlayerService.get().getAllPlayers()) {
      if (!player || !player.valid) {
        continue;
      }
      const pos = player.getComponent(TransformComponent)?.worldPosition;
      if (!pos) {
        continue;
      }
      const distSq = reference.distanceSquared(pos);
      if (distSq < nearestSq) {
        nearestSq = distSq;
        nearest = player;
      }
    }
    return nearest;
  }

  private log(...args: unknown[]): void {
    if (this.debugLogEnabled) {
      console.log(`[ActorProximityTrigger] ${this.entityName}:`, ...args);
    }
  }

  private get entityName(): string {
    return this.entity?.valid ? this.entity.name : '<destroyed>';
  }
}
