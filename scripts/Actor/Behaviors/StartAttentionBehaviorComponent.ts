// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {
  component,
  type Entity,
  property,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {AttentionBehavior, AttentionTargetMode} from './AttentionBehavior';
import {BehaviorStarterComponent} from './BehaviorStarterComponent';

/**
 * Automatically starts attention behavior for a given Actor.
 * The Actor will idly look at nearby players or a specific target entity,
 * and perform idle gaze when no targets are in range.
 */
@component()
export class StartAttentionBehaviorComponent extends BehaviorStarterComponent {
  @property()
  attentionRange: number = 10.0;

  @property()
  lookSpeed: number = 0.15;

  @property()
  idleLookSpeed: number = 0.05;

  @property()
  targetNearestPlayer: boolean = true;

  @property()
  targetEntity: Entity | null = null;

  @property()
  idleGazeEnabled: boolean = true;

  @property()
  idleGazeMinInterval: number = 2.0;

  @property()
  idleGazeMaxInterval: number = 5.0;

  @property()
  idleGazeMaxAngle: number = 45.0;

  @property()
  targetHeightOffset: number = 1.5;

  @property()
  basePriority: number = 0;

  override startBehavior(): void {
    if (!this.controlledActor) {
      console.error('StartAttentionBehaviorComponent: Controlled Actor not set!');
      return;
    }
    const actorLogic = this.controlledActor.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error('StartAttentionBehaviorComponent: No ActorSdkLogicComponent on controlled Actor!');
      return;
    }

    const attentionBehavior = new AttentionBehavior();
    attentionBehavior.attentionRange = this.attentionRange;
    attentionBehavior.lookSpeed = this.lookSpeed;
    attentionBehavior.idleLookSpeed = this.idleLookSpeed;
    attentionBehavior.idleGazeEnabled = this.idleGazeEnabled;
    attentionBehavior.idleGazeMinInterval = this.idleGazeMinInterval;
    attentionBehavior.idleGazeMaxInterval = this.idleGazeMaxInterval;
    attentionBehavior.idleGazeMaxAngle = this.idleGazeMaxAngle;
    attentionBehavior.targetHeightOffset = this.targetHeightOffset;
    attentionBehavior.basePriority = this.basePriority;

    if (this.targetNearestPlayer) {
      attentionBehavior.targetMode = AttentionTargetMode.NearestPlayer;
    } else {
      attentionBehavior.targetMode = AttentionTargetMode.SpecificEntity;
      attentionBehavior.targetEntity = this.targetEntity;
    }

    actorLogic.addBehavior(attentionBehavior, this.removeDuplicates);
  }
}
