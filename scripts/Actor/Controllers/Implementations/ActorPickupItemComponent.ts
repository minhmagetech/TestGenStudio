// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {
  component,
  Component,
  OnEntityCreateEvent,
  subscribe,
  OnEntityDestroyEvent,
  OnWorldUpdateEvent,
  property,
  editor,
  TransformComponent,
  PhysicsBodyComponent,
  ExecuteOn,
  Vec3,
  Quaternion,
  type Entity,
  NetworkMode,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {
  ActorPickupItemControllerTypeId,
  type ActorPickupItemController,
  ActorRequestPickupData,
  ActorPickupItemData,
  ActorRequestDropData,
  PickupItemSlot,
} from 'meta/worlds';

class PickupItemState {
  entity: Entity;
  slot: PickupItemSlot;
  originalCollisionEnabled: boolean | null = null;
  originalIsAffectedByGravity: boolean | null = null;
  gripPositionOffset: Vec3 = Vec3.zero;
  gripRotationOffset: Quaternion = Quaternion.identity;

  constructor(entity: Entity, slot: PickupItemSlot) {
    this.entity = entity;
    this.slot = slot;
  }
}

/**
 * ActorPickupItemComponent - Implements ActorPickupItemController for item pickup/drop.
 *
 * Uses a transform-copy approach: per-frame copies worldPosition/worldRotation
 * from hand slot entity to held item. Supports both RightHand and LeftHand slots
 * with physics state preservation (disable on pickup, restore on drop).
 *
 * Hand slots are auto-resolved by searching for child entities named
 * "RightHandSocket"/"RightHandSlot" and "LeftHandSocket"/"LeftHandSlot".
 *
 * Networking: The server (Owner) performs pickup/drop logic. Held item entity
 * references are synced to the client via networked properties so the client
 * can do the per-frame transform copy where rendering happens.
 */
@component({
  networkedRequirement: NetworkMode.Networked,
})
export class ActorPickupItemComponent extends Component implements ActorPickupItemController {
  @property()
  @editor({description: 'Right hand slot entity. Auto-resolves if not set.'})
  rightHandSlotEntity: Entity | null = null;

  @property()
  @editor({description: 'Left hand slot entity. Auto-resolves if not set.'})
  leftHandSlotEntity: Entity | null = null;

  @property()
  @editor({description: 'Enable debug logging.'})
  debugLogEnabled: boolean = false;

  // Networked held item references — server writes, client reads
  @property({isNetworked: true})
  @editor({show: false})
  netRightHandItem: Entity | null = null;

  @property({isNetworked: true})
  @editor({show: false})
  netLeftHandItem: Entity | null = null;

  private actorLogicComponent: ActorSdkLogicComponent | null = null;
  // Resolved slot entities (may differ from @property values on client)
  private resolvedRightSlot: Entity | null = null;
  private resolvedLeftSlot: Entity | null = null;
  // Server-side pickup state (physics preservation, grip offsets)
  private pickupItems: Map<PickupItemSlot, PickupItemState> = new Map();
  // Client-side: tracks which items we're transform-copying (built from networked refs)
  private clientPickupItems: Map<PickupItemSlot, PickupItemState> = new Map();
  private slotsResolved: boolean = false;

  @subscribe(OnEntityCreateEvent, {execution: ExecuteOn.Owner})
  onCreate(): void {
    this.actorLogicComponent = this.entity.getComponent(ActorSdkLogicComponent);
    this.tryResolveSlots();
    this.registerActorController();
  }

  @subscribe(OnEntityDestroyEvent)
  onDestroy(): void {
    // Only restore physics and unregister on Owner (where pickupItems is populated)
    if (this.entity.isOwned()) {
      for (const [slot] of this.pickupItems) {
        this.dropItem(new ActorRequestDropData(slot));
      }
      this.unregisterActorController();
    }
  }

  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  onUpdate(): void {
    // Lazy retry: template children may not exist at onCreate time
    if (!this.slotsResolved) {
      this.tryResolveSlots();
    }

    if (this.entity.isOwned()) {
      // Server: use authoritative pickupItems map
      this.updateSlotTransform(PickupItemSlot.RightHand, this.resolvedRightSlot, this.pickupItems);
      this.updateSlotTransform(PickupItemSlot.LeftHand, this.resolvedLeftSlot, this.pickupItems);
    } else {
      // Client: sync from networked entity refs, then do transform copy
      this.syncClientPickupState();
      this.updateSlotTransform(PickupItemSlot.RightHand, this.resolvedRightSlot, this.clientPickupItems);
      this.updateSlotTransform(PickupItemSlot.LeftHand, this.resolvedLeftSlot, this.clientPickupItems);
    }
  }

  /**
   * Client-side: read networked entity refs and build local pickup state for transform copy.
   */
  private syncClientPickupState(): void {
    this.syncClientSlot(PickupItemSlot.RightHand, this.netRightHandItem);
    this.syncClientSlot(PickupItemSlot.LeftHand, this.netLeftHandItem);
  }

  private syncClientSlot(slot: PickupItemSlot, netItem: Entity | null): void {
    if (netItem && netItem.valid) {
      if (!this.clientPickupItems.has(slot)) {
        const state = new PickupItemState(netItem, slot);
        const gripPoints = netItem.findChildrenWithName('GripPoint', true);
        if (gripPoints.length > 0) {
          const gripTransform = gripPoints[0].getComponent(TransformComponent);
          if (gripTransform) {
            state.gripPositionOffset = gripTransform.localPosition.mul(-1);
            state.gripRotationOffset = gripTransform.localRotation.inverse();
          }
        }
        const physicsBody = netItem.getComponent(PhysicsBodyComponent);
        if (physicsBody) {
          state.originalCollisionEnabled = physicsBody.collisionEnabled;
          state.originalIsAffectedByGravity = physicsBody.isAffectedByGravity;
          physicsBody.collisionEnabled = false;
          physicsBody.isAffectedByGravity = false;
        }
        this.clientPickupItems.set(slot, state);
      }
    } else {
      const prevState = this.clientPickupItems.get(slot);
      if (prevState) {
        if (prevState.entity.valid) {
          const physicsBody = prevState.entity.getComponent(PhysicsBodyComponent);
          if (
            physicsBody &&
            prevState.originalCollisionEnabled !== null &&
            prevState.originalIsAffectedByGravity !== null
          ) {
            physicsBody.collisionEnabled = prevState.originalCollisionEnabled;
            physicsBody.isAffectedByGravity = prevState.originalIsAffectedByGravity;
          }
        }
        this.clientPickupItems.delete(slot);
      }
    }
  }

  private tryResolveSlots(): void {
    // Use @property values first (set in editor/template), then auto-resolve by name.
    // Write to private fields (not @property) so this works on both server and client.
    if (!this.resolvedRightSlot) {
      this.resolvedRightSlot = this.rightHandSlotEntity ?? this.findHandSlotEntity('RightHandSocket', 'RightHandSlot');
    }
    if (!this.resolvedLeftSlot) {
      this.resolvedLeftSlot = this.leftHandSlotEntity ?? this.findHandSlotEntity('LeftHandSocket', 'LeftHandSlot');
    }

    if (this.resolvedRightSlot || this.resolvedLeftSlot) {
      this.slotsResolved = true;
      if (this.debugLogEnabled) {
        console.log(
          `[ActorPickupItemComponent] Slots resolved: rightSlot=${String(!!this.resolvedRightSlot)} leftSlot=${String(!!this.resolvedLeftSlot)}`,
        );
      }
    }
  }

  private updateSlotTransform(
    slot: PickupItemSlot,
    slotEntity: Entity | null,
    items: Map<PickupItemSlot, PickupItemState>,
  ): void {
    if (!slotEntity || !slotEntity.valid) {
      return;
    }

    const itemState = items.get(slot);
    if (!itemState || !itemState.entity.valid) {
      return;
    }

    const slotTransform = slotEntity.getComponent(TransformComponent);
    const itemTransform = itemState.entity.getComponent(TransformComponent);

    if (!slotTransform || !itemTransform) {
      return;
    }

    const handRot = slotTransform.worldRotation;
    const finalRotation = handRot.mul(itemState.gripRotationOffset);
    const rotatedGripOffset = handRot.mulVec3(itemState.gripPositionOffset);
    const finalPosition = slotTransform.worldPosition.add(rotatedGripOffset);

    itemTransform.worldPosition = finalPosition;
    itemTransform.worldRotation = finalRotation;
  }

  // #region ActorPickupItemController

  pickupItem(data: ActorRequestPickupData): void {
    if (
      data.pickupItemSlot !== PickupItemSlot.RightHand &&
      data.pickupItemSlot !== PickupItemSlot.LeftHand
    ) {
      console.warn(`[ActorPickupItemComponent] Invalid pickup slot: ${data.pickupItemSlot}. Use PickupItemSlot.RightHand or LeftHand.`);
      return;
    }

    if (!data.pickupItemEntity) {
      console.warn('[ActorPickupItemComponent] pickupItem called with no entity.');
      return;
    }

    if (this.pickupItems.has(data.pickupItemSlot)) {
      if (this.debugLogEnabled) {
        console.log(`[ActorPickupItemComponent] Slot ${data.pickupItemSlot} already occupied`);
      }
      return;
    }

    const slotEntity =
      data.pickupItemSlot === PickupItemSlot.RightHand
        ? this.resolvedRightSlot
        : this.resolvedLeftSlot;
    if (!slotEntity) {
      console.warn(
        `[ActorPickupItemComponent] No slot entity for ${data.pickupItemSlot === PickupItemSlot.RightHand ? 'RightHand' : 'LeftHand'}. Set rightHandSlotEntity/leftHandSlotEntity or add a child named RightHandSocket/LeftHandSocket.`,
      );
      return;
    }

    const itemState = new PickupItemState(data.pickupItemEntity, data.pickupItemSlot);

    const gripPoints = data.pickupItemEntity.findChildrenWithName('GripPoint', true);
    if (gripPoints.length > 0) {
      const gripTransform = gripPoints[0].getComponent(TransformComponent);
      if (gripTransform) {
        itemState.gripPositionOffset = gripTransform.localPosition.mul(-1);
        itemState.gripRotationOffset = gripTransform.localRotation.inverse();
      }
    } else {
      console.warn(
        '[ActorPickupItemComponent] Item has no GripPoint child entity. Item will be held at its origin. Add a child entity named "GripPoint" to control grip position/rotation.',
      );
    }

    const physicsBody = data.pickupItemEntity.getComponent(PhysicsBodyComponent);
    if (physicsBody) {
      itemState.originalCollisionEnabled = physicsBody.collisionEnabled;
      itemState.originalIsAffectedByGravity = physicsBody.isAffectedByGravity;

      physicsBody.collisionEnabled = false;
      physicsBody.isAffectedByGravity = false;
    }

    this.pickupItems.set(data.pickupItemSlot, itemState);

    // Sync to networked properties for client replication
    if (data.pickupItemSlot === PickupItemSlot.RightHand) {
      this.netRightHandItem = data.pickupItemEntity;
    } else {
      this.netLeftHandItem = data.pickupItemEntity;
    }

    if (this.debugLogEnabled) {
      console.log(
        `[ActorPickupItemComponent] Picked up item in ${data.pickupItemSlot === PickupItemSlot.RightHand ? 'RightHand' : 'LeftHand'}`,
      );
    }
  }

  dropItem(data: ActorRequestDropData): void {
    if (
      data.dropItemSlot !== PickupItemSlot.RightHand &&
      data.dropItemSlot !== PickupItemSlot.LeftHand
    ) {
      return;
    }

    const itemState = this.pickupItems.get(data.dropItemSlot);
    if (!itemState) {
      return;
    }

    if (itemState.entity.valid) {
      const physicsBody = itemState.entity.getComponent(PhysicsBodyComponent);
      if (
        physicsBody &&
        itemState.originalCollisionEnabled !== null &&
        itemState.originalIsAffectedByGravity !== null
      ) {
        physicsBody.collisionEnabled = itemState.originalCollisionEnabled;
        physicsBody.isAffectedByGravity = itemState.originalIsAffectedByGravity;
      }
    }

    this.pickupItems.delete(data.dropItemSlot);

    // Clear networked reference
    if (data.dropItemSlot === PickupItemSlot.RightHand) {
      this.netRightHandItem = null;
    } else {
      this.netLeftHandItem = null;
    }

    if (this.debugLogEnabled) {
      console.log(
        `[ActorPickupItemComponent] Dropped item from ${data.dropItemSlot === PickupItemSlot.RightHand ? 'RightHand' : 'LeftHand'}`,
      );
    }
  }

  getItemData(): ActorPickupItemData {
    const itemData = new ActorPickupItemData();

    for (const [slot, itemState] of this.pickupItems) {
      itemData.setPickupItem(slot, itemState.entity);
    }

    return itemData;
  }

  // #endregion

  // #region ActorController

  registerActorController(): void {
    if (this.actorLogicComponent) {
      this.actorLogicComponent.registerController(ActorPickupItemControllerTypeId, this);
    }
  }

  unregisterActorController(): void {
    if (this.actorLogicComponent) {
      this.actorLogicComponent.unregisterController(this);
    }
  }

  // #endregion

  // #region Private

  private findHandSlotEntity(...names: string[]): Entity | null {
    for (const name of names) {
      const matches = this.entity.findChildrenWithName(name, true);
      if (matches.length > 0) {
        if (this.debugLogEnabled) {
          console.log(`[ActorPickupItemComponent] Auto-resolved slot via findChildrenWithName: "${name}"`);
        }
        return matches[0];
      }
    }

    if (this.debugLogEnabled) {
      console.warn(
        `[ActorPickupItemComponent] Could not auto-resolve slot entity for names: ${names.join(', ')}`,
      );
    }
    return null;
  }

  // #endregion
}
