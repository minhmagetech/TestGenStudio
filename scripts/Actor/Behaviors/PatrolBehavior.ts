// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {TransformComponent, Vec3} from 'meta/worlds';
import type {Entity} from 'meta/worlds';
import {ActorBehavior} from 'meta/worlds';
import {FollowBehavior} from './FollowBehavior';
import type {ActorController} from 'meta/worlds';
import type {ActorBehaviorManager} from 'meta/worlds';
import {ActorTaggingBlackboard} from 'meta/worlds';
import {BlackboardScope} from 'meta/worlds';

/**
 * PatrolBehavior — Cycles through a list of waypoints, moving to each
 * one in sequence using FollowBehavior. When the actor arrives within
 * `arrivalDistance` of the current waypoint, it advances to the next.
 *
 * Supports two target modes:
 *
 * 1. **Entity list mode** — set `patrolEntities` to a direct array of Entity
 *    references. Waypoints are resolved once at initialization. Best for
 *    edit-time placed waypoints linked in the editor.
 *
 * 2. **Tag-based mode** — set `patrolTagPrefix` (e.g. "red_patrol") and the
 *    behavior resolves waypoints on-demand from the ActorTaggingBlackboard
 *    at runtime. Each waypoint is queried as `{prefix}_0`, `{prefix}_1`,
 *    etc. only when the behavior needs it. The behavior stays inactive
 *    until at least one tagged waypoint exists, and handles waypoints
 *    appearing or being destroyed at any time. Best for dynamically
 *    spawned waypoints where editor linkage isn't possible.
 *
 * If both are set, `patrolEntities` takes precedence.
 */
export class PatrolBehavior extends ActorBehavior {
  override name: string = 'PatrolBehavior';

  // ── Configuration ──────────────────────────────────────────────────

  /**
   * Direct entity references for patrol waypoints (mode 1).
   * Order determines patrol sequence.
   */
  patrolEntities: Entity[] = [];

  /**
   * Tag prefix for tag-based patrol (mode 2).
   * Entities should be tagged as `{prefix}_0`, `{prefix}_1`, etc.
   * Leave empty to use entity list mode instead.
   */
  patrolTagPrefix: string = '';

  /**
   * Distance at which the actor is considered to have "arrived"
   * at the current waypoint and should advance to the next.
   */
  arrivalDistance: number = 0.3;

  /**
   * Movement speed while patrolling.
   */
  patrolSpeed: number = 3.0;

  /**
   * Whether to loop back to the first waypoint after reaching the last.
   * If false, the behavior marks itself as finished after the last waypoint.
   */
  loop: boolean = true;

  /**
   * Optional pause duration (seconds) at each waypoint before moving on.
   */
  waitTimeAtWaypoint: number = 0.0;

  /**
   * If true, the actor rotates to face the movement direction.
   */
  rotateTowardsMovement: boolean = true;

  /**
   * Angular speed for body rotation in radians per second.
   */
  bodyDirectionAngularSpeed: number = 3.14;

  // ── Internal state ─────────────────────────────────────────────────

  private currentWaypointIndex: number = 0;
  private currentTarget: Entity | null = null;
  private followBehavior: FollowBehavior | null = null;
  private actorTransform: TransformComponent | null = null;
  private waitTimer: number = 0;
  private isWaiting: boolean = false;
  private isTagMode: boolean = false;

  override initialize(behaviorManager: ActorBehaviorManager): void {
    super.initialize(behaviorManager);

    this.actorTransform = this.getEntity().getComponent(TransformComponent);
    this.isTagMode = this.patrolEntities.length === 0 && this.patrolTagPrefix.length > 0;

    // Create internal follow behavior for movement
    this.followBehavior = new FollowBehavior();
    this.followBehavior.basePriority = this.basePriority;
    this.followBehavior.followSpeed = this.patrolSpeed;
    this.followBehavior.followRange = 0;
    this.followBehavior.distanceToStop = this.arrivalDistance * 0.5;
    this.followBehavior.bodyDirectionMode = this.rotateTowardsMovement ? 'faceTarget' : 'none';
    this.followBehavior.bodyDirectionAngularSpeed = this.bodyDirectionAngularSpeed;
    this.followBehavior.initialize(this.behaviorManager!);

    this.currentWaypointIndex = 0;
    this.isWaiting = false;
    this.waitTimer = 0;

    // For entity list mode, acquire the first target immediately
    if (!this.isTagMode) {
      this.currentTarget = this.getEntityListWaypoint(0);
    }
  }

  override update(deltaTime: number): void {
    if (!this.followBehavior || !this.actorTransform) {
      return;
    }

    // Acquire current target if we don't have one
    if (!this.currentTarget || this.currentTarget.isDestroyed()) {
      this.currentTarget = this.resolveWaypoint(this.currentWaypointIndex);
      if (!this.currentTarget) {
        // No valid waypoint at current index — stay inactive
        return;
      }
    }

    // Handle wait timer at waypoint
    if (this.isWaiting) {
      this.waitTimer -= deltaTime;
      if (this.waitTimer <= 0) {
        this.isWaiting = false;
        this.advanceWaypoint();
      }
      return;
    }

    // Check if we've arrived at current waypoint
    const targetTransform = this.currentTarget.getComponent(TransformComponent);
    if (!targetTransform) {
      this.advanceWaypoint();
      return;
    }

    const actorPos = this.actorTransform.worldPosition;
    const targetPos = targetTransform.worldPosition;
    const horizontalDist = new Vec3(
      targetPos.x - actorPos.x,
      0,
      targetPos.z - actorPos.z,
    ).magnitude();

    if (horizontalDist <= this.arrivalDistance) {
      // Arrived at waypoint
      if (this.waitTimeAtWaypoint > 0) {
        this.isWaiting = true;
        this.waitTimer = this.waitTimeAtWaypoint;
      } else {
        this.advanceWaypoint();
      }
      return;
    }

    // Keep following current waypoint
    this.followBehavior.targetEntity = this.currentTarget;
    this.followBehavior.followSpeed = this.patrolSpeed;
    this.followBehavior.update(deltaTime);
  }

  /**
   * Advances to the next waypoint in the sequence.
   */
  private advanceWaypoint(): void {
    const nextIndex = this.currentWaypointIndex + 1;
    const nextTarget = this.resolveWaypoint(nextIndex);

    if (nextTarget) {
      // Next waypoint exists — move to it
      this.currentWaypointIndex = nextIndex;
      this.currentTarget = nextTarget;
    } else if (this.loop) {
      // No next waypoint — try looping back to 0
      const firstTarget = this.resolveWaypoint(0);
      if (firstTarget) {
        this.currentWaypointIndex = 0;
        this.currentTarget = firstTarget;
      } else {
        // No waypoints at all — go inactive
        this.currentTarget = null;
      }
    } else {
      // No loop, no more waypoints — finished
      this.isFinished = true;
      this.currentTarget = null;
    }
  }

  /**
   * Resolves a waypoint at the given index, using the appropriate mode.
   * Returns null if no valid waypoint exists at that index.
   */
  private resolveWaypoint(index: number): Entity | null {
    if (this.isTagMode) {
      return this.getTaggedWaypoint(index);
    } else {
      return this.getEntityListWaypoint(index);
    }
  }

  /**
   * Gets a waypoint from the direct entity list (mode 1).
   */
  private getEntityListWaypoint(index: number): Entity | null {
    if (index < 0 || index >= this.patrolEntities.length) {
      return null;
    }
    const entity = this.patrolEntities[index];
    if (!entity || entity.isDestroyed()) {
      return null;
    }
    return entity;
  }

  /**
   * Gets a waypoint by querying the tagging blackboard for `{prefix}_{index}`
   * on demand (mode 2). Returns null if no entity is tagged with that tag.
   */
  private getTaggedWaypoint(index: number): Entity | null {
    if (!this.behaviorManager) {
      return null;
    }

    const taggingBB = this.behaviorManager.actorBlackboardManager.getBlackboard(
      ActorTaggingBlackboard,
      /* actorId */ undefined,
      /* groupId */ undefined,
      BlackboardScope.Global,
    );
    if (!taggingBB) {
      return null;
    }

    const tag = `${this.patrolTagPrefix}_${index}`;
    const tagged = taggingBB.getTaggedEntities(tag);
    if (tagged.length === 0) {
      return null;
    }

    return tagged[0].entity;
  }

  /**
   * Returns the current waypoint index.
   */
  getCurrentWaypointIndex(): number {
    return this.currentWaypointIndex;
  }

  /**
   * Returns whether the behavior has an active target to move towards.
   */
  hasActiveTarget(): boolean {
    return this.currentTarget !== null && !this.currentTarget.isDestroyed();
  }

  override getControllerUsePriority(controllerType: string): number {
    if (!this.followBehavior || !this.hasActiveTarget() || this.isWaiting) {
      return super.getControllerUsePriority(controllerType);
    }
    return this.followBehavior.getControllerUsePriority(controllerType);
  }

  override useController(controllerType: string, controller: ActorController): void {
    if (this.followBehavior && this.hasActiveTarget() && !this.isWaiting) {
      this.followBehavior.useController(controllerType, controller);
    }
  }
}
