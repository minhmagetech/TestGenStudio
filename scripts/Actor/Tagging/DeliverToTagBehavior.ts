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
  ActorRequestDropData,
  PickupItemSlot,
} from 'meta/worlds';

/**
 * DeliverToTagBehavior - Walks to the closest entity with a given tag
 * and drops the currently held item when in range.
 *
 * Designed to be used after a pickup behavior (e.g. SearchAndPickupBehavior)
 * in a SequentialBehavior chain.
 *
 * Composes:
 * 1. **TargetTaggedEntityBehavior** — finds the closest drop-off entity by tag
 * 2. **FollowBehavior** — walks toward it
 * 3. **Drop logic** — when within range, drops the item from the specified slot
 *
 * @example
 * ```typescript
 * // Step 2 of a catch-and-deliver sequence:
 * const deliver = new DeliverToTagBehavior();
 * deliver.targetTags = ['drop-off'];
 * deliver.dropRange = 2.0;
 * deliver.dropSlot = PickupItemSlot.RightHand;
 * ```
 */
export class DeliverToTagBehavior extends CompositeBehavior {
  override name: string = 'DeliverToTagBehavior';

  // ── Targeting Configuration ───────────────────────────────────────

  /** Tags of the drop-off location entity (e.g. ["drop-off"], ["base", "counter"]). The closest entity matching any tag is selected. */
  targetTags: string[] = [];

  /** Time constant for position smoothing. */
  positionSmoothingTimeConstant: number = 0.3;

  /** Time constant for velocity smoothing. */
  velocitySmoothingTimeConstant: number = 0.5;

  /** How far ahead to predict position. */
  velocityPredictionTime: number = 0.5;

  // ── Follow Configuration ──────────────────────────────────────────

  /** Movement speed in m/s. */
  followSpeed: number = 5.0;

  /** Body direction mode while delivering. See FollowBehavior. */
  bodyDirectionMode: 'faceTarget' | 'faceMovement' | 'matchTarget' | 'none' = 'faceTarget';

  /** Angular speed for body rotation. */
  bodyDirectionAngularSpeed: number = 3.14;

  /** GotoBehavior repath interval. */
  repathInterval: number = 0.2;

  /** GotoBehavior distance to stop. */
  distanceToStop: number = 0.1;

  // ── Drop Configuration ────────────────────────────────────────────

  /** Distance (meters) from drop-off at which item is dropped. XZ only. */
  dropRange: number = 2.0;

  /** Which hand slot to drop from. */
  dropSlot: PickupItemSlot = PickupItemSlot.RightHand;

  // ── Internal State ────────────────────────────────────────────────

  private sharedTargetInfo: TargetInfo = new TargetInfo();
  private targetBehavior: TargetTaggedEntityBehavior | null = null;
  private followBehavior: FollowBehavior | null = null;
  private pendingDrop: boolean = false;
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
    this.followBehavior.followRange = 0;
    this.followBehavior.followSpeed = this.followSpeed;
    this.followBehavior.bodyDirectionMode = this.bodyDirectionMode;
    this.followBehavior.bodyDirectionAngularSpeed = this.bodyDirectionAngularSpeed;
    this.followBehavior.repathInterval = this.repathInterval;
    this.followBehavior.distanceToStop = this.distanceToStop;
    this.followBehavior.targetInfo = this.sharedTargetInfo;

    this.subBehaviors = [this.targetBehavior, this.followBehavior];

    // super.initialize() MUST be called before this.getEntity() —
    // getEntity() requires this.behaviorManager which is set in super.initialize().
    super.initialize(behaviorManager);
    this.actorTransform = this.getEntity().getComponent(TransformComponent);
  }

  override update(deltaTime: number): void {
    super.update(deltaTime);
    this.checkDropRange();
  }

  override getControllerUsePriority(controllerType: string): number {
    if (controllerType === ActorPickupItemControllerTypeId && this.pendingDrop) {
      return this.basePriority;
    }
    return super.getControllerUsePriority(controllerType);
  }

  override useController(controllerType: string, controller: ActorController): void {
    if (controllerType === ActorPickupItemControllerTypeId && this.pendingDrop) {
      const pickupController = controller as ActorPickupItemController;
      pickupController.dropItem(new ActorRequestDropData(this.dropSlot));
      this.pendingDrop = false;
      this.isFinished = true;
      return;
    }
    super.useController(controllerType, controller);
  }

  override onRemove(): void {
    super.onRemove();
    this.pendingDrop = false;
    this.targetBehavior = null;
    this.followBehavior = null;
    this.actorTransform = null;
  }

  // ── Private ───────────────────────────────────────────────────────

  private checkDropRange(): void {
    if (this.pendingDrop || !this.actorTransform) {
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

    const dx = actorPos.x - targetPos.x;
    const dz = actorPos.z - targetPos.z;
    const distXZ = Math.sqrt(dx * dx + dz * dz);

    if (distXZ <= this.dropRange) {
      this.pendingDrop = true;
    }
  }
}
