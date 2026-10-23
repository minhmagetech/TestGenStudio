// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {
    component,
    Component,
    OnEntityCreateEvent,
    OnEntityDestroyEvent,
    subscribe,
    PhysicsBodyComponent,
    ExecuteOn,
} from 'meta/worlds';

import {ActorSdkLogicComponent} from 'meta/worlds';
import {
    ActorCollisionControllerTypeId,
    type ActorCollisionController,
    ActorCollisionParams,
} from 'meta/worlds';

/**
 * ActorPhysicsComponent is a standalone controller for toggling an Actor's
 * collision and gravity via the ActorCollisionController interface.
 *
 * When collisions are disabled it also turns off gravity and locks the Y
 * translation axis so the entity does not fall through or float above the
 * world. Re-enabling collisions restores collision, gravity, and the
 * original translation lock state.
 *
 * Component Attachment: Attached to any Actor entity that has a PhysicsBodyComponent
 * Component Networking: Networked
 * Component Ownership: Entity owner (server for enemies)
 */
@component()
export class ActorPhysicsComponent extends Component implements ActorCollisionController {
    private physicsBodyComponent: PhysicsBodyComponent | null = null;
    private actorLogicComponent: ActorSdkLogicComponent | null = null;
    private originalLockedTranslationAxes: number = 0;
    private originalLockedRotationAxes: number = 0;

    @subscribe(OnEntityCreateEvent, { execution: ExecuteOn.Everywhere })
    onCreate() {
        this.physicsBodyComponent = this.entity.getComponent(PhysicsBodyComponent);
        this.actorLogicComponent = this.entity.getComponent(ActorSdkLogicComponent);

        if (this.physicsBodyComponent) {
            this.originalLockedTranslationAxes = this.physicsBodyComponent.lockedTranslationAxes;
            this.originalLockedRotationAxes = this.physicsBodyComponent.lockedRotationAxes;
        }

        this.registerActorController();
    }

    @subscribe(OnEntityDestroyEvent)
    onDestroy() {
        this.unregisterActorController();
    }

    // ==================== ActorCollisionController ====================

    setCollisionParams(params: ActorCollisionParams): void {
        if (!this.physicsBodyComponent) {
            return;
        }

        this.physicsBodyComponent.collisionEnabled = params.collisionEnabled;
        this.physicsBodyComponent.isAffectedByGravity = params.collisionEnabled;

        if (params.collisionEnabled) {
            this.physicsBodyComponent.lockedTranslationAxes = this.originalLockedTranslationAxes;
            this.physicsBodyComponent.lockedRotationAxes = this.originalLockedRotationAxes;
        } else {
            // Lock Y translation (bit 1) to prevent floating when gravity is off
            this.physicsBodyComponent.lockedTranslationAxes = this.originalLockedTranslationAxes | 2;
            // Lock Y rotation (bit 1) to prevent spinning when collision is off
            this.physicsBodyComponent.lockedRotationAxes = this.originalLockedRotationAxes | 2;
        }
    }

    // ==================== ActorController ====================

    registerActorController(): void {
        this.actorLogicComponent?.registerController(ActorCollisionControllerTypeId, this);
    }

    unregisterActorController(): void {
        this.actorLogicComponent?.unregisterController(this);
    }
}
