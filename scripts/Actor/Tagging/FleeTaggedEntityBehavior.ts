// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {CompositeBehavior} from '../Behaviors/CompositeBehavior';
import {FleeBehavior} from '../Behaviors/FleeBehavior';
import {TargetInfo} from '../Behaviors/TargetingBehavior';
import type {ActorBehaviorManager} from 'meta/worlds';
import {TargetTaggedEntityBehavior} from './TargetTaggedEntityBehavior';

/**
 * Composite behavior that finds the closest entity with a given tag and
 * flees from it. The inverse of FollowTaggedEntityBehavior.
 *
 * Internally wires two sub-behaviors:
 * 1. **TargetTaggedEntityBehavior** (priority 200) — resolves the closest
 *    entity matching any of `targetTags` from the ActorTaggingBlackboard and writes
 *    smoothed position / velocity / prediction data to a shared TargetInfo.
 * 2. **FleeBehavior** (priority 50) — reads the shared TargetInfo and
 *    moves the actor away from the resolved target.
 *
 * @example
 * ```typescript
 * const flee = new FleeTaggedEntityBehavior();
 * flee.basePriority = 40;
 * flee.targetTags = ['player'];
 * flee.fleeDistance = 10.0;
 * flee.fleeSpeed = 6.0;
 * flee.leashRadius = 20.0;
 * behaviorManager.addBehavior(flee);
 * ```
 */
export class FleeTaggedEntityBehavior extends CompositeBehavior {
  override name: string = 'FleeTaggedEntityBehavior';

  // ── Targeting Configuration ───────────────────────────────────────

  /**
   * The tags to flee from (e.g. ["player"], ["player", "enemy"]).
   * The behavior resolves the closest entity matching any tag each frame.
   */
  targetTags: string[] = [];

  /**
   * Time constant for position smoothing in seconds.
   * Higher values = smoother but laggier target tracking.
   */
  positionSmoothingTimeConstant: number = 0.3;

  /**
   * Time constant for velocity smoothing in seconds.
   */
  velocitySmoothingTimeConstant: number = 0.5;

  /**
   * How far ahead to predict the target's position in seconds.
   * Helps the actor flee proactively from where the target is heading.
   */
  velocityPredictionTime: number = 0.5;

  // ── Flee Configuration ────────────────────────────────────────────

  /**
   * Minimum safe distance (meters) to maintain from the target. When
   * the target is closer than this, the actor flees directly away.
   * When further, the actor idles and releases controllers.
   */
  fleeDistance: number = 10.0;

  /**
   * Movement speed (m/s) while fleeing.
   */
  fleeSpeed: number = 6.0;

  /**
   * Distance (meters) at which the actor considers itself arrived at
   * the flee point.
   */
  arrivalDistance: number = 1.0;

  // ── Leash ─────────────────────────────────────────────────────────

  /**
   * Maximum distance (meters) the actor can flee from its starting
   * position (the "anchor"). Set to 0 to disable.
   *
   * When the leash prevents full retreat, the flee point is clamped
   * to the leash boundary — the actor goes as far as it can.
   */
  leashRadius: number = 0;

  // ── Body direction ────────────────────────────────────────────────

  /**
   * If true, the actor rotates to face the direction it is moving
   * (away from the target).
   */
  rotateTowardsMovement: boolean = true;

  /**
   * Angular speed (radians/sec) for body rotation while fleeing.
   */
  bodyDirectionAngularSpeed: number = 3.14;

  // ── GotoBehavior pass-through ─────────────────────────────────────

  repathInterval: number = 0.2;
  distanceToStop: number = 0.1;

  // ── Internal ──────────────────────────────────────────────────────

  private sharedTargetInfo: TargetInfo = new TargetInfo();
  private targetBehavior: TargetTaggedEntityBehavior | null = null;
  private fleeBehavior: FleeBehavior | null = null;

  override initialize(behaviorManager: ActorBehaviorManager): void {
    // Sub-behavior 1: resolve closest tagged entity → writes to sharedTargetInfo
    this.targetBehavior = new TargetTaggedEntityBehavior();
    this.targetBehavior.basePriority = 200;
    this.targetBehavior.targetTags = this.targetTags;
    this.targetBehavior.positionSmoothingTimeConstant = this.positionSmoothingTimeConstant;
    this.targetBehavior.velocitySmoothingTimeConstant = this.velocitySmoothingTimeConstant;
    this.targetBehavior.velocityPredictionTime = this.velocityPredictionTime;
    this.targetBehavior.targetInfo = this.sharedTargetInfo;

    // Sub-behavior 2: flee away from the resolved target
    this.fleeBehavior = new FleeBehavior();
    this.fleeBehavior.basePriority = 50;
    this.fleeBehavior.fleeDistance = this.fleeDistance;
    this.fleeBehavior.fleeSpeed = this.fleeSpeed;
    this.fleeBehavior.arrivalDistance = this.arrivalDistance;
    this.fleeBehavior.leashRadius = this.leashRadius;
    this.fleeBehavior.rotateTowardsMovement = this.rotateTowardsMovement;
    this.fleeBehavior.bodyDirectionAngularSpeed = this.bodyDirectionAngularSpeed;
    this.fleeBehavior.repathInterval = this.repathInterval;
    this.fleeBehavior.distanceToStop = this.distanceToStop;
    this.fleeBehavior.targetInfo = this.sharedTargetInfo;

    this.subBehaviors = [this.targetBehavior, this.fleeBehavior];

    super.initialize(behaviorManager);
  }
}
