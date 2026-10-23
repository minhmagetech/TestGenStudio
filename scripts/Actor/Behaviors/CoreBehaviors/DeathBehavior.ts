// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import { ActorHealthControllerTypeId, type ActorHealthController } from "meta/worlds";
import { ActorCollisionControllerTypeId, type ActorCollisionController, ActorCollisionParams } from "meta/worlds";
import { ActorMovementControllerTypeId, ActorMoveParams, type ActorMovementController } from "meta/worlds";
import { ActorPickupItemControllerTypeId, type ActorPickupItemController, ActorRequestDropData, PickupItemSlot } from "meta/worlds";
import { ActorBehavior } from "meta/worlds";
import type { ActorController } from "meta/worlds";

/**
 * Behavior that monitors the health controller and takes over all controllers
 * when the actor dies. Optionally destroys the entity after a configurable delay
 * and can disable collision on death.
 */
export class DeathBehavior extends ActorBehavior {
    /** Seconds after death before the entity is destroyed. Set to -1 to disable auto-despawn. */
    despawnTimer: number = -1;

    /**
     * If true, disables collision on death.
     * WARNING: This removes ground support and may cause the entity to sink.
     * Only enable if you want the entity to fall through the floor on death.
     */
    disableCollisionOnDeath: boolean = false;

    /** If true, drops all held items (both hands) when the actor dies. */
    dropItemsOnDeath: boolean = false;

    /**
     * Priority used when dead. Must be higher than all other behaviors to ensure
     * the dead actor stops moving, attacking, and animating.
     */
    private static readonly deadPriority = 1000;

    private isDead: boolean = false;
    private itemsDropped: boolean = false;
    private timeElapsedSinceDeath: number = 0;


    update(deltaTime: number): void {
        const healthControllers = this.behaviorManager?.getControllers<ActorHealthController>(
            ActorHealthControllerTypeId,
        );
        healthControllers?.forEach(healthController => {
            const data = healthController.getHealthData();
            if (data.isDead && !this.isDead) {
                this.isDead = true;
            }
        });

        if (this.isDead && this.despawnTimer > 0) {
            this.timeElapsedSinceDeath += deltaTime;

            if (this.timeElapsedSinceDeath >= this.despawnTimer) {
                const entity = this.getEntity();
                if (!entity.isDestroyed()) {
                    entity.destroy();
                }
            }
        }
    }

    override getControllerUsePriority(controllerType: string): number {
        if (this.isDead) {
            // Only claim the pickup controller if we need to drop items and haven't yet.
            // Once items are dropped (or dropItemsOnDeath is false), return -1 to release
            // the controller — no other behavior should need it post-death, but releasing
            // it keeps the priority model clean and avoids silently blocking cleanup behaviors.
            if (controllerType == ActorPickupItemControllerTypeId) {
                if (!this.dropItemsOnDeath || this.itemsDropped) {
                    return -1;
                }
            }
            return DeathBehavior.deadPriority;
        }

        return super.getControllerUsePriority(controllerType);
    }

    override useController(controllerType: string, controller: ActorController): void {
        if (controllerType == ActorCollisionControllerTypeId && this.disableCollisionOnDeath) {
            const params = new ActorCollisionParams();
            params.collisionEnabled = false;
            (controller as ActorCollisionController).setCollisionParams(params);
        }

        // Stop movement when dead — zero velocity prevents sliding/drifting
        if (controllerType == ActorMovementControllerTypeId) {
            (controller as ActorMovementController).moveToPosition(new ActorMoveParams(null, null));
        }

        if (controllerType == ActorPickupItemControllerTypeId && this.isDead && this.dropItemsOnDeath && !this.itemsDropped) {
            const pickupController = controller as ActorPickupItemController;
            pickupController.dropItem(new ActorRequestDropData(PickupItemSlot.RightHand));
            pickupController.dropItem(new ActorRequestDropData(PickupItemSlot.LeftHand));
            this.itemsDropped = true;
        }
    }
}
