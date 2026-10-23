// @generated - Actor Framework Scripts v7
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {
  component,
  property,
  editor,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {BehaviorStarterComponent} from '../Behaviors/BehaviorStarterComponent';
import {SearchAndPickupBehavior} from './SearchAndPickupBehavior';
import {PickupItemSlot} from 'meta/worlds';

/**
 * Automatically starts a SearchAndPickupBehavior for a given Actor.
 * The Actor will find the closest entity with the specified tag,
 * walk toward it, and pick it up when in range.
 */
@component()
export class StartSearchAndPickupBehaviorComponent extends BehaviorStarterComponent {
  @property()
  @editor({description: 'Comma-separated tags to search for (e.g. "sword", "sword, key").'})
  targetTags: string = '';

  @property()
  @editor({description: 'Distance (meters) at which pickup is triggered.'})
  pickupRange: number = 2.0;

  @property()
  @editor({description: 'Movement speed in m/s.'})
  followSpeed: number = 5.0;

  @property()
  @editor({description: 'Which hand to use for pickup.'})
  pickupSlot: PickupItemSlot = PickupItemSlot.RightHand;

  @property()
  @editor({description: 'If true, keeps searching for more items after pickup.'})
  persistent: boolean = false;

  @property()
  @editor({description: 'Seconds to wait before starting.'})
  startDelay: number = 2.0;

  @property()
  basePriority: number = 20;

  protected override locomotionStarterName(): string {
    return 'StartSearchAndPickupBehaviorComponent';
  }

  override startBehavior(): void {
    if (!this.controlledActor) {
      console.error('StartSearchAndPickupBehaviorComponent: Controlled Actor not set!');
      return;
    }
    const actorLogic = this.controlledActor.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error('StartSearchAndPickupBehaviorComponent: No ActorSdkLogicComponent on controlled Actor!');
      return;
    }

    if (!this.targetTags || this.targetTags.length === 0) {
      console.error('StartSearchAndPickupBehaviorComponent: No targetTags specified!');
      return;
    }

    const behavior = new SearchAndPickupBehavior();
    behavior.targetTags = this.targetTags.split(',').map(t => t.trim()).filter(t => t.length > 0);
    behavior.pickupRange = this.pickupRange;
    behavior.followSpeed = this.followSpeed;
    behavior.pickupSlot = this.pickupSlot;
    behavior.persistent = this.persistent;
    behavior.startDelay = this.startDelay;
    behavior.basePriority = this.basePriority;

    actorLogic.addBehavior(behavior, this.removeDuplicates);
  }
}
