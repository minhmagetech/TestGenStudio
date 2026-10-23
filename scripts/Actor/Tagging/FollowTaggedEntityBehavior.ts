// @generated - Actor Framework Scripts v8
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import type {Entity} from 'meta/worlds';
import {CompositeBehavior} from '../Behaviors/CompositeBehavior';
import {FollowBehavior} from '../Behaviors/FollowBehavior';
import {TargetInfo} from '../Behaviors/TargetingBehavior';
import type {ActorBehaviorManager} from 'meta/worlds';
import {TargetTaggedEntityBehavior} from './TargetTaggedEntityBehavior';

/**
 * Composite behavior that finds the closest entity with a given tag and
 * follows it.
 *
 * Internally wires two sub-behaviors:
 * 1. **TargetTaggedEntityBehavior** (priority 200) — resolves the closest
 *    entity matching `targetTag` from the ActorTaggingBlackboard and writes
 *    smoothed position / velocity / prediction data to a shared TargetInfo.
 * 2. **FollowBehavior** (priority 50) — reads the shared TargetInfo and
 *    moves the actor towards the resolved target.
 *
 * @example
 * ```typescript
 * const follow = new FollowTaggedEntityBehavior();
 * follow.basePriority = 30;
 * follow.targetTags = ['player'];
 * follow.followRange = 2.0;
 * follow.followSpeed = 4.0;
 * behaviorManager.addBehavior(follow);
 * ```
 *
 * To run this behavior only some of the time — on a timer or a condition — keep
 * it registered and gate it by priority (return `-1` from
 * `getControllerUsePriority` while inactive) so a lower-priority default (e.g.
 * `IdleWanderBehavior`) resumes automatically. Do NOT add/remove it at runtime
 * from an `OnWorldUpdateEvent` component — that fights the priority system and
 * is fragile. See the `working-with-actor-behaviors` skill, "Timed / Periodic
 * Switching", for a worked timed-cycle example.
 */
export class FollowTaggedEntityBehavior extends CompositeBehavior {
  override name: string = 'FollowTaggedEntityBehavior';

  // ── Targeting Configuration ───────────────────────────────────────

  /**
   * The tags to follow (e.g. ["player"], ["player", "enemy"]).
   * The closest entity matching any tag is selected.
   *
   * ⚠️ Consumer half only. The target entity must ALSO carry a matching
   * `ActorSdkTagComponent` (set its `tags` property to the same case-sensitive
   * string, or register the entity via `ActorTaggingBlackboard.registerTags`);
   * players are auto-tagged "player". Otherwise `resolveTarget` returns null and
   * the actor acquires nothing. See the Tag Targeting Contract in implementing-actor-behaviors.
   */
  targetTags: string[] = [];

  /**
   * Time constant for position smoothing in seconds.
   */
  positionSmoothingTimeConstant: number = 0.3;

  /**
   * Time constant for velocity smoothing in seconds.
   */
  velocitySmoothingTimeConstant: number = 0.5;

  /**
   * How far ahead to predict the target's position in seconds.
   */
  velocityPredictionTime: number = 0.5;

  /**
   * Maximum range in meters for target acquisition and retention.
   * Targets beyond this distance are ignored. Set to 0 or negative to disable.
   */
  maxRange: number = 0;

  // ── Follow Configuration ──────────────────────────────────────────

  /**
   * Desired follow distance from target in meters.
   */
  followRange: number = 1.0;

  /**
   * Movement speed in m/s.
   */
  followSpeed: number = 5.0;

  /**
   * Controls which direction the actor faces while following.
   *   'faceTarget'   — face toward the target entity
   *   'faceMovement' — face the direction the actor is moving (its travel heading)
   *   'matchTarget'  — face the same direction as the target
   *   'none'         — do not control body direction (actor keeps its facing)
   */
  bodyDirectionMode: 'faceTarget' | 'faceMovement' | 'matchTarget' | 'none' = 'faceTarget';

  /**
   * Angular speed in radians per second for body direction rotation.
   */
  bodyDirectionAngularSpeed: number = 3.14;

  // ── Hysteresis pass-through (see FollowBehavior) ──────────────────

  /**
   * Soft-zone radius (m) around the follow point. 0 disables hysteresis.
   * Tuning: ≳ `velocityPredictionTime * expectedTargetSpeed` to absorb
   * predicted-point snap-back when a moving target stops.
   */
  hysteresisRadius: number = 0;

  /**
   * Actor XZ speed (m/s) below which the actor is considered "stuck".
   */
  stuckSpeedThreshold: number = 0.1;

  /**
   * Sustained stuck-while-in-hysteresis time (s) before forcing settled.
   * 0 disables the fallback.
   */
  stuckSettleTime: number = 0.5;

  /**
   * Target XZ speed (m/s) below which the target is considered "essentially
   * still" — gates entry into the settled state. When the target is moving
   * faster than this, the actor stays in pursuing and pace-matches the
   * target instead of stopping. Composite mode only.
   */
  targetMovingThreshold: number = 0.1;

  /**
   * Optional in-world text entity for live debug output (rolling log of
   * state, desiredSpeed, distance to follow point). See FollowBehavior.
   */
  debugTextEntity: Entity | null = null;

  // ── GotoBehavior pass-through ─────────────────────────────────────

  repathInterval: number = 0.2;
  distanceToStop: number = 0.1;

  // ── Internal ──────────────────────────────────────────────────────

  private sharedTargetInfo: TargetInfo = new TargetInfo();
  private targetBehavior: TargetTaggedEntityBehavior | null = null;
  private followBehavior: FollowBehavior | null = null;

  /**
   * Returns the shared TargetInfo so external systems (e.g. attack behaviors)
   * can read the resolved target entity and position data.
   */
  getTargetInfo(): TargetInfo {
    return this.sharedTargetInfo;
  }

  /**
   * Pushes derived range values to the internal FollowBehavior at runtime.
   * Called per-frame by EngageCombatBehavior so that footprint-aware,
   * surface-to-surface derived distances take effect immediately.
   */
  updateRuntimeRanges(
    followRange: number,
    maxRange: number,
    hysteresisRadius: number,
    distanceToStop: number,
  ): void {
    this.followRange = followRange;
    this.maxRange = maxRange;
    this.hysteresisRadius = hysteresisRadius;
    this.distanceToStop = distanceToStop;
    if (this.followBehavior) {
      this.followBehavior.followRange = followRange;
      this.followBehavior.hysteresisRadius = hysteresisRadius;
      this.followBehavior.distanceToStop = distanceToStop;
    }
    if (this.targetBehavior) {
      this.targetBehavior.maxRange = maxRange;
    }
  }

  /**
   * Updates the follow speed at runtime and propagates it to the inner
   * FollowBehavior — the actual mover, which reads `followSpeed` every frame.
   * The inner copy is otherwise only seeded once in `initialize()`, so without
   * this propagation a runtime speed change (e.g. a slow debuff) set on the
   * outer field never reaches the mover.
   */
  setFollowSpeed(speed: number): void {
    this.followSpeed = speed;
    if (this.followBehavior) {
      this.followBehavior.followSpeed = speed;
    }
  }

  /**
   * Sets or clears a forced target override on the internal
   * TargetTaggedEntityBehavior. When set, resolveTarget() returns this entity
   * directly, bypassing the tag query. Pass null to revert to normal targeting.
   */
  setTargetOverride(entity: Entity | null): void {
    if (this.targetBehavior) {
      this.targetBehavior.forcedTargetOverride = entity;
    }
  }

  override initialize(behaviorManager: ActorBehaviorManager): void {
    this.targetBehavior = new TargetTaggedEntityBehavior();
    this.targetBehavior.basePriority = 200;
    this.targetBehavior.targetTags = this.targetTags;
    this.targetBehavior.positionSmoothingTimeConstant = this.positionSmoothingTimeConstant;
    this.targetBehavior.velocitySmoothingTimeConstant = this.velocitySmoothingTimeConstant;
    this.targetBehavior.velocityPredictionTime = this.velocityPredictionTime;
    this.targetBehavior.maxRange = this.maxRange;
    this.targetBehavior.targetInfo = this.sharedTargetInfo;

    this.followBehavior = new FollowBehavior();
    this.followBehavior.basePriority = 50;
    this.followBehavior.followRange = this.followRange;
    this.followBehavior.followSpeed = this.followSpeed;
    this.followBehavior.bodyDirectionMode = this.bodyDirectionMode;
    this.followBehavior.bodyDirectionAngularSpeed = this.bodyDirectionAngularSpeed;
    this.followBehavior.hysteresisRadius = this.hysteresisRadius;
    this.followBehavior.stuckSpeedThreshold = this.stuckSpeedThreshold;
    this.followBehavior.stuckSettleTime = this.stuckSettleTime;
    this.followBehavior.targetMovingThreshold = this.targetMovingThreshold;
    this.followBehavior.debugTextEntity = this.debugTextEntity;
    this.followBehavior.repathInterval = this.repathInterval;
    this.followBehavior.distanceToStop = this.distanceToStop;
    this.followBehavior.targetInfo = this.sharedTargetInfo;

    this.subBehaviors = [this.targetBehavior, this.followBehavior];

    super.initialize(behaviorManager);
  }
}
