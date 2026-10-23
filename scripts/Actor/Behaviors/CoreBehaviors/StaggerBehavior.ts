// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import type {TemplateAsset} from 'meta/worlds';
import {ActorBehavior} from 'meta/worlds';
import type {ActorController} from 'meta/worlds';
import {
  ActorMovementControllerTypeId,
  ActorMoveParams,
  type ActorMovementController,
} from 'meta/worlds';
import {ActorBodyDirectionControllerTypeId} from 'meta/worlds';
import {IActorAttackControllerTypeId} from '../../Controllers/Definitions/IActorAttackController';
import {
  ActorStaggerControllerTypeId,
  ActorStaggerParams,
  type ActorStaggerController,
} from 'meta/worlds';
import {
  ActorHealthControllerTypeId,
  type ActorHealthController,
} from 'meta/worlds';

/**
 * StaggerBehavior temporarily prevents the Actor from moving, rotating, or attacking
 * when damage is received.
 *
 * This behavior:
 * - Polls the ActorHealthController for hit state changes
 * - Takes over Move, BodyDirection, Attack, and Stagger controller priorities during stagger
 * - Does nothing with Move/BodyDirection/Attack controllers (the Actor stands still)
 * - Pushes stagger parameters to the ActorStaggerController on first use
 * - Automatically ends after staggerDuration completes
 * - Cannot re-activate until staggerCooldown time passes after recovery
 *
 * The behavior uses a high base priority (default 100) to override other behaviors
 * like FollowBehavior or AttackEntityInRangeBehavior during the stagger window.
 */
export class StaggerBehavior extends ActorBehavior {
  /**
   * The knockback force applied to the Actor when hit, in meters per second.
   * Reserved for future use.
   */
  knockbackForce: number = 5;

  /**
   * The duration the Actor is staggered and unable to perform actions, in seconds.
   */
  staggerDuration: number = 0.3;

  /**
   * Time after recovery before the Actor can be staggered again, in seconds.
   */
  staggerCooldown: number = 0.5;

  /**
   * Time to reach the knockback destination, in seconds.
   * Reserved for future use.
   */
  knockbackMoveTime: number = 0.15;

  /**
   * Template asset for hit impact VFX spawned when enemy takes damage.
   */
  hitImpactVfx: TemplateAsset | null = null;

  protected isStaggerActive: boolean = false;
  protected staggerEndTime: number = 0;
  protected nextStaggerAllowedTime: number = 0;
  protected currentTime: number = 0;
  private wasHit: boolean = false;

  override update(deltaTime: number): void {
    this.currentTime += deltaTime;

    // Poll the health controller for hit state via the behavior manager
    const healthControllers = this.behaviorManager?.getControllers<ActorHealthController>(
      ActorHealthControllerTypeId,
    );
    healthControllers?.forEach(healthController => {
      const data = healthController.getHealthData();
      if (data.isHit && !this.wasHit) {
        this.onHitDetected();
      }
      this.wasHit = data.isHit;
    });

    if (this.isStaggerActive && this.currentTime >= this.staggerEndTime) {
      this.isStaggerActive = false;
    }
  }

  override getControllerUsePriority(controllerType: string): number {
    if (controllerType === ActorStaggerControllerTypeId) {
      return this.basePriority;
    }

    if (!this.isStaggerActive) {
      return -1;
    }

    if (
      controllerType === ActorMovementControllerTypeId ||
      controllerType === ActorBodyDirectionControllerTypeId ||
      controllerType === IActorAttackControllerTypeId
    ) {
      return this.basePriority;
    }

    return -1;
  }

  override useController(
    controllerType: string,
    controller: ActorController,
  ): void {
    if (controllerType === ActorStaggerControllerTypeId) {
      const staggerController = controller as ActorStaggerController;
      if (!staggerController.areStaggerParamsInitialized()) {
        staggerController.setStaggerParams(
          new ActorStaggerParams(
            this.knockbackForce,
            this.staggerDuration,
            this.staggerCooldown,
            this.knockbackMoveTime,
            this.hitImpactVfx,
          ),
        );
      }
    }

    if (controllerType === ActorMovementControllerTypeId) {
      (controller as ActorMovementController).moveToPosition(
        new ActorMoveParams(null, null),
      );
    }

    // BodyDirection: claiming the controller at high priority is sufficient
    // to prevent other behaviors from rotating the Actor.
    // Attack: intentionally empty — stagger means the Actor does not attack.
  }

  protected onHitDetected(): void {
    if (this.currentTime < this.nextStaggerAllowedTime) {
      return;
    }

    this.isStaggerActive = true;
    this.staggerEndTime = this.currentTime + this.staggerDuration;
    this.nextStaggerAllowedTime =
      this.currentTime + this.staggerDuration + this.staggerCooldown;
  }
}
