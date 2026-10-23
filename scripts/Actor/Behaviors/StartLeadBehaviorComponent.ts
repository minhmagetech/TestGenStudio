// @generated - Actor Framework Scripts v7
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {
  component,
  property,
  TransformComponent,
  type Entity,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {LeadBehavior} from './LeadBehavior';
import {BehaviorStarterComponent} from './BehaviorStarterComponent';

/**
 * Automatically starts a lead behavior for a given Actor.
 * The Actor will walk toward a destination while monitoring the player's proximity.
 */
@component()
export class StartLeadBehaviorComponent extends BehaviorStarterComponent {
  @property()
  destination: Entity | null = null;

  @property()
  destinationTag: string = '';

  @property()
  leadSpeed: number = 2.0;

  @property()
  arrivalThreshold: number = 1.0;

  @property()
  maxPlayerDistance: number = 8.0;

  @property()
  resumePlayerDistance: number = 4.0;

  @property()
  followClosestPlayer: boolean = true;

  @property()
  targetPlayer: Entity | null = null;

  @property()
  use2DDistance: boolean = true;

  @property()
  basePriority: number = 5;

  protected override locomotionStarterName(): string {
    return 'StartLeadBehaviorComponent';
  }

  override startBehavior(): void {
    if (!this.controlledActor) {
      console.error('StartLeadBehaviorComponent: Controlled Actor not set!');
      return;
    }
    const actorLogic = this.controlledActor.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error('StartLeadBehaviorComponent: No ActorSdkLogicComponent on controlled Actor!');
      return;
    }

    const leadBehavior = new LeadBehavior();
    leadBehavior.leadSpeed = this.leadSpeed;
    leadBehavior.arrivalThreshold = this.arrivalThreshold;
    leadBehavior.maxPlayerDistance = this.maxPlayerDistance;
    leadBehavior.resumePlayerDistance = this.resumePlayerDistance;
    leadBehavior.followClosestPlayer = this.followClosestPlayer;
    leadBehavior.targetPlayer = this.targetPlayer;
    leadBehavior.use2DDistance = this.use2DDistance;
    leadBehavior.basePriority = this.basePriority;

    // Tag-based mode: resolve destination dynamically at initialize time
    if (this.destinationTag.length > 0) {
      leadBehavior.destinationTag = this.destinationTag;
    } else if (this.destination) {
      const destTransform = this.destination.getComponent(TransformComponent);
      if (!destTransform) {
        console.warn('StartLeadBehaviorComponent: destination entity has no TransformComponent');
        return;
      }
      leadBehavior.destination = destTransform.worldPosition;
    } else {
      console.warn('StartLeadBehaviorComponent: no destination entity or destinationTag set!');
      return;
    }

    actorLogic.addBehavior(leadBehavior, this.removeDuplicates);
  }
}
