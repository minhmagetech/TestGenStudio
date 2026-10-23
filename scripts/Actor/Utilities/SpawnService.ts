// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {
  NetworkingService,
  NetworkMode,
  type Quaternion,
  service,
  Service,
  TransformComponent,
  Vec3,
  WorldService,
  type Entity,
  type TemplateAsset,
} from 'meta/worlds';

// Live-set + in-flight count for one spawn group. Private to the service so the
// cap is enforced in ONE place across however many ActorSpawner components feed
// the same group.
interface SpawnGroup {
  live: Entity[];
  pending: number;
  // Bumped by despawnGroup so a spawn that was in-flight across the despawn (its
  // await had not resolved yet) is destroyed instead of repopulating `live`.
  generation: number;
}

// A group is keyed either by an explicit string id (spawners that opt into a
// shared cap) or, by default, by the TemplateAsset itself so every spawner of
// the same enemy type shares one cap with no wiring.
type SpawnGroupKey = string | TemplateAsset;

/**
 * Server-authoritative singleton that owns the GLOBAL live-set and max-alive cap
 * for actor spawning, grouped by enemy type (or an explicit group id).
 *
 * WHY a service and not per-component state: ActorSpawner used to keep its own
 * live set + cap privately, so two spawners feeding one wave EACH enforced their
 * own maxAlive and the world ended up with 2x the cap (the zombie_cap "20 alive,
 * cap 10" overshoot). Centralizing the live-set here makes one cap hold no matter
 * how many spawner components exist, and the isServerContext() guard makes
 * spawning single-authority so a component evaluated on more than one network
 * context cannot double-spawn. See the actor_spawning_architecture design
 * (SpawnService = the spawn primitive + the global live budget).
 *
 * Components call `SpawnService.get().requestSpawn(...)`; do not cache the handle
 * (it does not survive hot-reload).
 */
@service()
export class SpawnService extends Service {
  private groups: Map<SpawnGroupKey, SpawnGroup> = new Map();

  private groupFor(key: SpawnGroupKey): SpawnGroup {
    let group = this.groups.get(key);
    if (!group) {
      group = {live: [], pending: 0, generation: 0};
      this.groups.set(key, group);
    }
    return group;
  }

  // Prune destroyed entities so a despawn/death frees cap room.
  private liveCount(group: SpawnGroup): number {
    group.live = group.live.filter(e => e != null && !e.isDestroyed());
    return group.live.length;
  }

  /** Current live count for a group (0 if it has never spawned). */
  public getLiveCount(key: SpawnGroupKey): number {
    const group = this.groups.get(key);
    return group ? this.liveCount(group) : 0;
  }

  /**
   * Spawn one networked actor instance into `key`'s group, unless the group is
   * already at `maxAlive`. Server-authoritative: returns null on any non-server
   * context so exactly ONE authority spawns and counts (a client calling this
   * would create a duplicate with its own counter -- the 2x overshoot). Returns
   * the spawned entity, or null/undefined when skipped (non-server, at cap) or
   * unresolved.
   *
   * The caller (ActorSpawner) snapshots the spawn transform BEFORE awaiting this,
   * so `position`/`rotation` are already coherent (snapshot -> await -> commit).
   */
  public async requestSpawn(params: {
    key: SpawnGroupKey;
    template: TemplateAsset;
    position: Vec3;
    rotation: Quaternion;
    maxAlive: number;
    scale?: number;
  }): Promise<Entity | null | undefined> {
    if (!NetworkingService.get().isServerContext()) {
      return null;
    }

    const group = this.groupFor(params.key);
    if (
      params.maxAlive > 0 &&
      this.liveCount(group) + group.pending >= params.maxAlive
    ) {
      return null;
    }

    // Count in-flight across the await so concurrent requests in one frame can't
    // all pass the cap check and overshoot maxAlive.
    group.pending++;
    // Snapshot the group generation so a despawnGroup that runs during our await
    // can be detected after it resolves (below), instead of this spawn surviving
    // the "despawn all" by landing in `live` afterward.
    const spawnGeneration = group.generation;
    let spawned: Entity | null | undefined;
    try {
      spawned = await WorldService.get().spawnTemplate({
        templateAsset: params.template,
        networkMode: NetworkMode.Networked,
        position: params.position,
        rotation: params.rotation,
      });
    } finally {
      group.pending--;
    }

    if (!spawned || spawned.isDestroyed()) {
      return spawned;
    }

    // The group was despawned (despawnGroup bumped generation) while this spawn
    // was in-flight: honor the despawn by destroying the just-resolved entity
    // rather than pushing it onto `live`, where it would survive a despawn-all.
    if (group.generation !== spawnGeneration) {
      spawned.destroy();
      return null;
    }

    const scale = params.scale ?? 1.0;
    if (scale !== 1.0) {
      const transform = spawned.getComponent(TransformComponent);
      if (transform) {
        transform.worldScale = new Vec3(scale, scale, scale);
      }
    }

    group.live.push(spawned);
    return spawned;
  }

  /** Destroy every still-live actor in a group (e.g. a proximity safe-zone return). */
  public despawnGroup(key: SpawnGroupKey): void {
    const group = this.groups.get(key);
    if (!group) {
      return;
    }
    for (const e of group.live) {
      if (e != null && !e.isDestroyed()) {
        e.destroy();
      }
    }
    group.live = [];
    // Invalidate any in-flight spawns so their post-await results are destroyed
    // instead of repopulating the group we just cleared.
    group.generation++;
  }
}
