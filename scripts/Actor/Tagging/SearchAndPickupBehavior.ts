// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {TransformComponent} from 'meta/worlds';
import {CompositeBehavior} from '../Behaviors/CompositeBehavior';
import {FollowBehavior} from '../Behaviors/FollowBehavior';
import {TargetInfo} from '../Behaviors/TargetingBehavior';
import type {ActorBehaviorManager} from 'meta/worlds';
import type {ActorController} from 'meta/worlds';
import {TargetTaggedEntityBehavior} from './TargetTaggedEntityBehavior';
import {
  ActorPickupItemControllerTypeId,
  type ActorPickupItemController,
  ActorRequestPickupData,
  PickupItemSlot,
} from 'meta/worlds';

/**
 * SearchAndPickupBehavior - Finds the closest entity with a given tag,
 * walks toward it, and picks it up when in range.
 *
 * Composes three internal behaviors:
 * 1. **TargetTaggedEntityBehavior** (priority 200) — resolves the closest
 *    entity matching any of `targetTags` from the ActorTaggingBlackboard
 * 2. **FollowBehavior** (priority 50) — moves the actor toward the target
 * 3. **Pickup logic** — when within `pickupRange`, claims the pickup
 *    controller and grabs the item
 *
 * After pickup, the behavior either finishes (one-shot) or stays active
 * to search for the next item with the same tag (persistent mode).
 *
 * @example
 * ```typescript
 * const search = new SearchAndPickupBehavior();
 * search.basePriority = 30;
 * search.targetTags = ['sword'];
 * search.pickupRange = 2.0;
 * search.followSpeed = 4.0;
 * actorLogic.addBehavior(search);
 * ```
 */
export class SearchAndPickupBehavior extends CompositeBehavior {
  override name: string = 'SearchAndPickupBehavior';

  // ── Targeting Configuration ───────────────────────────────────────

  /** The tags to search for (e.g. ["sword"], ["sword", "key"]). The closest entity matching any tag is selected. */
  targetTags: string[] = [];

  /** Time constant for position smoothing in seconds. */
  positionSmoothingTimeConstant: number = 0.3;

  /** Time constant for velocity smoothing in seconds. */
  velocitySmoothingTimeConstant: number = 0.5;

  /** How far ahead to predict the target's position in seconds. */
  velocityPredictionTime: number = 0.5;

  // ── Follow Configuration ──────────────────────────────────────────

  /** Movement speed in m/s. */
  followSpeed: number = 5.0;

  /** Body direction mode while approaching. See FollowBehavior. */
  bodyDirectionMode: 'faceTarget' | 'faceMovement' | 'matchTarget' | 'none' = 'faceTarget';

  /** Angular speed in radians per second for body direction rotation. */
  bodyDirectionAngularSpeed: number = 3.14;

  /** GotoBehavior repath interval. */
  repathInterval: number = 0.2;

  /** GotoBehavior distance to stop. */
  distanceToStop: number = 0.1;

  // ── Pickup Configuration ──────────────────────────────────────────

  /** Distance (meters) from target at which pickup is triggered. XZ only. */
  pickupRange: number = 2.0;

  /** Which hand slot to use for pickup. */
  pickupSlot: PickupItemSlot = PickupItemSlot.RightHand;

  /** If true, stays active after pickup to search for the next item. */
  persistent: boolean = false;

  /** Seconds to wait before starting. Prevents instant actions during scene loading. */
  startDelay: number = 0;

  // ── Activation Configuration ─────────────────────────────────────

  /**
   * Detection range in meters (XZ plane). When > 0, the behavior stays
   * dormant (returns -1 for all controllers) until the target entity is
   * within this range. Once activated, the behavior stays active until
   * it finishes or is removed — it will NOT deactivate if the actor
   * moves beyond the detection range while approaching the target.
   *
   * Set to 0 (default) to always be active — the behavior claims
   * controllers immediately and starts moving toward the target.
   *
   * Use this with the priority system: give the pickup behavior a
   * higher basePriority than a concurrent follow behavior. While
   * dormant, the lower-priority follow behavior wins the controllers.
   * When the target enters detection range, this behavior activates
   * and its higher priority takes over movement.
   */
  detectionRange: number = 0;

  // ── Internal State ────────────────────────────────────────────────

  private sharedTargetInfo: TargetInfo = new TargetInfo();
  private targetBehavior: TargetTaggedEntityBehavior | null = null;
  private followBehavior: FollowBehavior | null = null;
  private pendingPickup: boolean = false;
  private activated: boolean = false;
  private elapsedTime: number = 0;
  private started: boolean = false;
  private actorTransform: TransformComponent | null = null;

  override initialize(behaviorManager: ActorBehaviorManager): void {
    this.targetBehavior = new TargetTaggedEntityBehavior();
    this.targetBehavior.basePriority = 200;
    this.targetBehavior.targetTags = this.targetTags;
    this.targetBehavior.positionSmoothingTimeConstant = this.positionSmoothingTimeConstant;
    this.targetBehavior.velocitySmoothingTimeConstant = this.velocitySmoothingTimeConstant;
    this.targetBehavior.velocityPredictionTime = this.velocityPredictionTime;
    this.targetBehavior.targetInfo = this.sharedTargetInfo;

    this.followBehavior = new FollowBehavior();
    this.followBehavior.basePriority = 50;
    this.followBehavior.followRange = 0; // Follow to exact position, not at a distance
    this.followBehavior.followSpeed = this.followSpeed;
    this.followBehavior.bodyDirectionMode = this.bodyDirectionMode;
    this.followBehavior.bodyDirectionAngularSpeed = this.bodyDirectionAngularSpeed;
    this.followBehavior.repathInterval = this.repathInterval;
    this.followBehavior.distanceToStop = this.distanceToStop;
    this.followBehavior.targetInfo = this.sharedTargetInfo;

    this.subBehaviors = [this.targetBehavior, this.followBehavior];

    // IMPORTANT: super.initialize() MUST be called before this.getEntity().
    // getEntity() requires this.behaviorManager to be set, which happens
    // inside super.initialize().
    super.initialize(behaviorManager);
    this.actorTransform = this.getEntity().getComponent(TransformComponent);
  }

  override update(deltaTime: number): void {
    // Wait for startDelay before doing anything
    if (!this.started) {
      this.elapsedTime += deltaTime;
      if (this.elapsedTime < this.startDelay) {
        return;
      }
      this.started = true;
    }

    // Run sub-behaviors (targeting + follow)
    super.update(deltaTime);

    // Check if target is within pickup range
    this.checkPickupRange();
  }

  override getControllerUsePriority(controllerType: string): number {
    // Detection range gate: stay dormant until target is within range.
    // Once activated, stay active until finished or removed.
    if (this.detectionRange > 0 && !this.activated) {
      if (!this.isTargetInDetectionRange()) {
        return -1;
      }
      this.activated = true;
    }

    // Claim pickup controller when we have a pending pickup
    if (controllerType === ActorPickupItemControllerTypeId && this.pendingPickup) {
      return this.basePriority;
    }

    // Delegate locomotion to sub-behaviors
    return super.getControllerUsePriority(controllerType);
  }

  override useController(controllerType: string, controller: ActorController): void {
    if (controllerType === ActorPickupItemControllerTypeId && this.pendingPickup) {
      const pickupController = controller as ActorPickupItemController;
      const targetEntity = this.sharedTargetInfo.targetEntity;

      if (targetEntity && !targetEntity.isDestroyed()) {
        pickupController.pickupItem(
          new ActorRequestPickupData(targetEntity, this.pickupSlot),
        );
        this.pendingPickup = false;

        if (!this.persistent) {
          this.isFinished = true;
        }
      } else {
        // Target was destroyed — reset so we can detect new targets
        this.pendingPickup = false;
      }
      return;
    }

    // Delegate to sub-behaviors (follow + targeting)
    super.useController(controllerType, controller);
  }

  override onRemove(): void {
    super.onRemove();
    this.pendingPickup = false;
    this.activated = false;
    this.targetBehavior = null;
    this.followBehavior = null;
    this.actorTransform = null;
  }

  // ── Private ───────────────────────────────────────────────────────

  /**
   * Returns true if the target entity is within detectionRange (XZ distance).
   * Used to gate activation when detectionRange > 0.
   */
  private isTargetInDetectionRange(): boolean {
    if (!this.actorTransform || !this.sharedTargetInfo.isValid || !this.sharedTargetInfo.targetEntity) {
      return false;
    }

    const targetTransform = this.sharedTargetInfo.targetEntity.getComponent(TransformComponent);
    if (!targetTransform) {
      return false;
    }

    const actorPos = this.actorTransform.worldPosition;
    const targetPos = targetTransform.worldPosition;
    const dx = actorPos.x - targetPos.x;
    const dz = actorPos.z - targetPos.z;
    return (dx * dx + dz * dz) <= (this.detectionRange * this.detectionRange);
  }

  private checkPickupRange(): void {
    if (this.pendingPickup || !this.actorTransform) {
      return;
    }

    if (!this.sharedTargetInfo.isValid || !this.sharedTargetInfo.targetEntity) {
      return;
    }

    const targetTransform = this.sharedTargetInfo.targetEntity.getComponent(TransformComponent);
    if (!targetTransform) {
      return;
    }

    const actorPos = this.actorTransform.worldPosition;
    const targetPos = targetTransform.worldPosition;

    // XZ distance only (ignore height)
    const dx = actorPos.x - targetPos.x;
    const dz = actorPos.z - targetPos.z;
    const distXZ = Math.sqrt(dx * dx + dz * dz);

    if (distXZ <= this.pickupRange) {
      this.pendingPickup = true;
    }
  }
}
