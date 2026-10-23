// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {
  TransformComponent,
  type Entity,
} from 'meta/worlds';
import {ActorBehavior} from 'meta/worlds';
import {GotoBehavior} from './GotoBehavior';
import type {ActorController} from 'meta/worlds';
import type {ActorBehaviorManager} from 'meta/worlds';
import {
  ActorPickupItemControllerTypeId,
  type ActorPickupItemController,
  ActorRequestDropData,
  PickupItemSlot,
} from 'meta/worlds';

export type UseItemCallback = (
  actorEntity: Entity,
  targetEntity: Entity,
  itemEntity: Entity,
  slot: PickupItemSlot,
) => void;

/**
 * UseItemBehavior - Makes an actor walk to a target entity and use a held item on it.
 *
 * When the actor reaches the target (within useRange), invokes the onUseItem
 * callback with the actor, target, and item entities. Game scripts provide
 * this callback to implement the "use" logic (open door, consume potion,
 * activate lever, etc.).
 *
 * After use, optionally drops or destroys the held item and/or target.
 *
 * Uses GotoBehavior internally for locomotion.
 */
export class UseItemBehavior extends ActorBehavior {
  override name: string = 'UseItemBehavior';

  targetEntity: Entity | null = null;
  useSlot: PickupItemSlot = PickupItemSlot.RightHand;
  useRange: number = 2.0;
  moveSpeed: number = 5.0;
  dropAfterUse: boolean = true;
  destroyItemAfterUse: boolean = false;
  destroyTargetAfterUse: boolean = false;
  onUseItem: UseItemCallback | null = null;

  private currentGotoBehavior: GotoBehavior | null = null;
  private actorTransform: TransformComponent | null = null;
  private pendingUse: boolean = false;

  override initialize(behaviorManager: ActorBehaviorManager): void {
    super.initialize(behaviorManager);
    this.actorTransform = this.getEntity().getComponent(TransformComponent);

    this.currentGotoBehavior = new GotoBehavior();
    this.currentGotoBehavior.desiredSpeed = this.moveSpeed;
    this.currentGotoBehavior.basePriority = this.basePriority;
    // Preserve prior behavior: UseItem does not control body direction, so keep
    // the nested goto from claiming the body-direction controller.
    this.currentGotoBehavior.shouldFaceDirection = false;

    const actorPos = this.actorTransform?.worldPosition;
    if (this.targetEntity) {
      const targetTransform = this.targetEntity.getComponent(TransformComponent);
      if (targetTransform) {
        this.currentGotoBehavior.targetPosition = targetTransform.worldPosition;
      } else if (actorPos) {
        this.currentGotoBehavior.targetPosition = actorPos;
      }
    } else if (actorPos) {
      this.currentGotoBehavior.targetPosition = actorPos;
    }

    if (this.behaviorManager) {
      void this.currentGotoBehavior.initialize(this.behaviorManager);
    }
  }

  override update(deltaTime: number): void {
    if (!this.currentGotoBehavior || !this.targetEntity || !this.actorTransform) {
      return;
    }

    if (this.targetEntity.isDestroyed()) {
      this.isFinished = true;
      return;
    }

    const targetTransform = this.targetEntity.getComponent(TransformComponent);
    if (!targetTransform) {
      console.warn('UseItemBehavior: target entity has no TransformComponent — finishing behavior.');
      this.isFinished = true;
      return;
    }

    this.currentGotoBehavior.targetPosition = targetTransform.worldPosition;

    const actorPos = this.actorTransform.worldPosition;
    const targetPos = targetTransform.worldPosition;
    const dx = actorPos.x - targetPos.x;
    const dz = actorPos.z - targetPos.z;
    const distXZ = Math.sqrt(dx * dx + dz * dz);

    if (distXZ <= this.useRange) {
      this.pendingUse = true;
    } else {
      this.pendingUse = false;
      void this.currentGotoBehavior.update(deltaTime);
    }
  }

  override getControllerUsePriority(controllerType: string): number {
    if (!this.targetEntity || this.isFinished) {
      return -1;
    }

    if (controllerType === ActorPickupItemControllerTypeId) {
      return this.pendingUse ? this.basePriority : -1;
    }

    if (this.currentGotoBehavior && !this.pendingUse) {
      return this.currentGotoBehavior.getControllerUsePriority(controllerType);
    }

    return -1;
  }

  override useController(controllerType: string, controller: ActorController): void {
    if (controllerType === ActorPickupItemControllerTypeId) {
      if (this.pendingUse) {
        this.executeUse(controller as ActorPickupItemController);
      }
      return;
    }

    if (this.currentGotoBehavior && !this.pendingUse) {
      this.currentGotoBehavior.useController(controllerType, controller);
    }
  }

  override onRemove(): void {
    this.currentGotoBehavior?.onRemove();
    this.currentGotoBehavior = null;
    this.targetEntity = null;
    this.onUseItem = null;
    super.onRemove();
  }

  private executeUse(pickupController: ActorPickupItemController): void {
    const itemData = pickupController.getItemData();
    const heldItem = itemData.getPickupItem(this.useSlot);

    if (!heldItem || !this.targetEntity) {
      console.warn('UseItemBehavior: no item held in slot — finishing behavior.');
      this.isFinished = true;
      return;
    }

    if (this.onUseItem) {
      this.onUseItem(this.getEntity(), this.targetEntity, heldItem, this.useSlot);
    }

    if (heldItem.valid && !heldItem.isDestroyed()) {
      if (this.destroyItemAfterUse) {
        pickupController.dropItem(new ActorRequestDropData(this.useSlot));
        heldItem.destroy();
      } else if (this.dropAfterUse) {
        pickupController.dropItem(new ActorRequestDropData(this.useSlot));
      }
    }

    if (this.destroyTargetAfterUse && this.targetEntity.valid && !this.targetEntity.isDestroyed()) {
      this.targetEntity.destroy();
    }

    this.isFinished = true;
  }
}
