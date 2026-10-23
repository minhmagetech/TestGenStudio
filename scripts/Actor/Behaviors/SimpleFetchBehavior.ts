// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {
  Vec3,
  type Entity,
  TransformComponent,
} from 'meta/worlds';
import {ActorBehavior} from 'meta/worlds';
import {GotoBehavior} from './GotoBehavior';
import type {ActorController} from 'meta/worlds';
import type {ActorBehaviorManager} from 'meta/worlds';
import {
  ActorPickupItemControllerTypeId,
  type ActorPickupItemController,
  ActorRequestPickupData,
  ActorRequestDropData,
  PickupItemSlot,
} from 'meta/worlds';

/**
 * Pending pickup/drop action to be executed via the priority system.
 */
enum PendingPickupAction {
  None,
  Pickup,
  Drop,
}

/**
 * SimpleFetchBehavior - Makes an Actor fetch a single item and deliver it.
 *
 * Flow:
 * - When not holding item: walk toward itemToPickUp, pick up when in range
 * - When holding item: walk toward itemDropOffPoint, drop when in range
 *
 * After drop-off, clears itemToPickUp and returns to finished.
 * Uses GotoBehavior internally for locomotion.
 * Pickup/drop actions go through the priority arbitration system via useController().
 */
export class SimpleFetchBehavior extends ActorBehavior {
  itemToPickUp: Entity | null = null;
  itemDropOffPoint: Entity | null = null;
  itemPickupRange: number = 1.0;
  moveSpeed: number = 5.0;
  pickupSlot: PickupItemSlot = PickupItemSlot.RightHand;
  /** Seconds to wait before starting the fetch cycle. Prevents instant completion during scene loading. */
  startDelay: number = 0;

  private currentGotoBehavior: GotoBehavior | null = null;
  private isHoldingItem: boolean = false;
  private pendingAction: PendingPickupAction = PendingPickupAction.None;
  private lastPickupController: ActorPickupItemController | null = null;
  private elapsedTime: number = 0;
  private started: boolean = false;

  override initialize(behaviorManager: ActorBehaviorManager): void {
    super.initialize(behaviorManager);

    this.currentGotoBehavior = new GotoBehavior();
    this.currentGotoBehavior.desiredSpeed = this.moveSpeed;
    // Preserve prior behavior: SimpleFetch does not control body direction, so
    // keep the nested goto from claiming the body-direction controller.
    this.currentGotoBehavior.shouldFaceDirection = false;

    const transform = this.getEntity().getComponent(TransformComponent);
    if (transform) {
      this.currentGotoBehavior.targetPosition = transform.worldPosition;
    }

    if (this.behaviorManager) {
      void this.currentGotoBehavior.initialize(this.behaviorManager);
    }
  }

  override update(deltaTime: number): void {
    // Wait for startDelay before beginning the fetch cycle
    if (!this.started) {
      this.elapsedTime += deltaTime;
      if (this.elapsedTime < this.startDelay) {
        return;
      }
      this.started = true;
    }

    if (!this.currentGotoBehavior || !this.itemToPickUp) {
      return;
    }

    this.updateHoldingState();

    const actorTransform = this.getEntity().getComponent(TransformComponent);
    if (!actorTransform) {
      return;
    }

    const actorPos = actorTransform.worldPosition;
    const actorPosXZ = new Vec3(actorPos.x, 0, actorPos.z);

    if (!this.isHoldingItem) {
      this.handleMovingToItem(actorPosXZ, actorPos);
    } else {
      this.handleMovingToDropOff(actorPosXZ, actorPos);
    }

    void this.currentGotoBehavior.update(deltaTime);
  }

  private updateHoldingState(): void {
    if (!this.lastPickupController) {
      this.isHoldingItem = false;
      return;
    }

    const itemData = this.lastPickupController.getItemData();
    const heldItem = itemData.getPickupItem(this.pickupSlot);
    this.isHoldingItem = heldItem === this.itemToPickUp;
  }

  private handleMovingToItem(actorPosXZ: Vec3, actorPos: Vec3): void {
    if (!this.itemToPickUp || !this.currentGotoBehavior) {
      return;
    }

    const itemTransform = this.itemToPickUp.getComponent(TransformComponent);
    if (!itemTransform) {
      return;
    }

    const itemPos = itemTransform.worldPosition;
    const itemPosXZ = new Vec3(itemPos.x, 0, itemPos.z);
    const distance = actorPosXZ.sub(itemPosXZ).magnitude();

    if (distance <= this.itemPickupRange) {
      this.pendingAction = PendingPickupAction.Pickup;
    } else {
      this.currentGotoBehavior.targetPosition = new Vec3(itemPos.x, actorPos.y, itemPos.z);
    }
  }

  private handleMovingToDropOff(actorPosXZ: Vec3, actorPos: Vec3): void {
    if (!this.itemDropOffPoint || !this.currentGotoBehavior) {
      // No drop-off point — drop item at current location and finish
      this.pendingAction = PendingPickupAction.Drop;
      return;
    }

    const dropOffTransform = this.itemDropOffPoint.getComponent(TransformComponent);
    if (!dropOffTransform) {
      return;
    }

    const dropOffPos = dropOffTransform.worldPosition;
    const dropOffPosXZ = new Vec3(dropOffPos.x, 0, dropOffPos.z);
    const distance = actorPosXZ.sub(dropOffPosXZ).magnitude();

    if (distance <= this.itemPickupRange) {
      this.pendingAction = PendingPickupAction.Drop;
    } else {
      this.currentGotoBehavior.targetPosition = new Vec3(dropOffPos.x, actorPos.y, dropOffPos.z);
    }
  }

  override getControllerUsePriority(controllerType: string): number {
    if (!this.itemToPickUp || !this.currentGotoBehavior) {
      return -1;
    }

    if (controllerType === ActorPickupItemControllerTypeId) {
      return this.basePriority;
    }

    return this.currentGotoBehavior.getControllerUsePriority(controllerType);
  }

  override useController(controllerType: string, controller: ActorController): void {
    if (controllerType === ActorPickupItemControllerTypeId) {
      const pickupController = controller as ActorPickupItemController;
      this.lastPickupController = pickupController;

      if (this.pendingAction === PendingPickupAction.Pickup && this.itemToPickUp) {
        pickupController.pickupItem(
          new ActorRequestPickupData(this.itemToPickUp, this.pickupSlot),
        );
        this.pendingAction = PendingPickupAction.None;
      } else if (this.pendingAction === PendingPickupAction.Drop) {
        pickupController.dropItem(new ActorRequestDropData(this.pickupSlot));
        this.pendingAction = PendingPickupAction.None;
        this.itemToPickUp = null;
        this.isFinished = true;
      }
      return;
    }

    if (this.currentGotoBehavior) {
      this.currentGotoBehavior.useController(controllerType, controller);
    }
  }

  override onRemove(): void {
    super.onRemove();
    if (this.currentGotoBehavior) {
      this.currentGotoBehavior.onRemove();
    }
    this.currentGotoBehavior = null;
    this.itemToPickUp = null;
    this.isHoldingItem = false;
    this.pendingAction = PendingPickupAction.None;
    this.lastPickupController = null;
  }
}
