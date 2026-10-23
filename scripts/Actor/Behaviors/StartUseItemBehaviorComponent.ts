// @generated - Actor Framework Scripts v7
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {
  component,
  property,
  editor,
  type Entity,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {UseItemBehavior} from './UseItemBehavior';
import {BehaviorStarterComponent} from './BehaviorStarterComponent';
import {PickupItemSlot} from 'meta/worlds';

@component()
export class StartUseItemBehaviorComponent extends BehaviorStarterComponent {
  @property()
  @editor({description: 'The target entity to use the item on.'})
  targetEntity: Entity | null = null;

  @property()
  @editor({description: 'Distance from target at which the item is used.'})
  useRange: number = 2.0;

  @property()
  @editor({description: 'Movement speed toward the target.'})
  moveSpeed: number = 5.0;

  @property()
  @editor({description: 'If true, the item is dropped after use.'})
  dropAfterUse: boolean = true;

  @property()
  @editor({description: 'If true, the item entity is destroyed after use.'})
  destroyItemAfterUse: boolean = false;

  @property()
  @editor({description: 'If true, the target entity is destroyed after use.'})
  destroyTargetAfterUse: boolean = false;

  @property()
  basePriority: number = 30;

  // UseItemBehavior walks to the target via GotoBehavior before using it.
  protected override locomotionStarterName(): string {
    return 'StartUseItemBehaviorComponent';
  }

  override startBehavior(): void {
    if (!this.controlledActor) {
      console.error('StartUseItemBehaviorComponent: Controlled Actor not set!');
      return;
    }
    const actorLogic = this.controlledActor.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error('StartUseItemBehaviorComponent: No ActorSdkLogicComponent on controlled Actor!');
      return;
    }

    if (!this.targetEntity) {
      console.warn('StartUseItemBehaviorComponent: No target entity set!');
      return;
    }

    const useItemBehavior = new UseItemBehavior();
    useItemBehavior.targetEntity = this.targetEntity;
    useItemBehavior.useSlot = PickupItemSlot.RightHand;
    useItemBehavior.useRange = this.useRange;
    useItemBehavior.moveSpeed = this.moveSpeed;
    useItemBehavior.dropAfterUse = this.dropAfterUse;
    useItemBehavior.destroyItemAfterUse = this.destroyItemAfterUse;
    useItemBehavior.destroyTargetAfterUse = this.destroyTargetAfterUse;
    useItemBehavior.basePriority = this.basePriority;

    actorLogic.addBehavior(useItemBehavior, this.removeDuplicates);
  }
}
