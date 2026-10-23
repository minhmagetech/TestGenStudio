// @generated - Actor Framework Scripts v10
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {
    component,
    Component,
    OnEntityCreateEvent,
    subscribe,
    property,
    editor,
    Vec3,
    TransformComponent,
    OnEntityDestroyEvent,
    OnWorldUpdateEvent,
    OnWorldUpdateEventPayload,
    ExecuteOn,
    Quaternion,
    type Entity,
    CharacterControllerBase,
} from 'meta/worlds';

import {ActorSdkLogicComponent} from 'meta/worlds';
import { ActorMovementControllerTypeId, type ActorMovementController, ActorMoveParams } from 'meta/worlds';
import { ActorBodyDirectionControllerTypeId, type ActorBodyDirectionController, ActorBodyDirectionParams } from 'meta/worlds';

@component()
export class ActorTransformMoveComponent extends Component implements ActorMovementController, ActorBodyDirectionController {
    @property()
    @editor({ description: 'Optional entity containing a KinematicCharacterComponent. If null, TransformComponent is set directly instead.' })
    kinematicCharacterEntity: Entity | null = null;

    transformComponent: TransformComponent | null = null;
    actorLogicComponent: ActorSdkLogicComponent | null = null;
    kcc: CharacterControllerBase | null = null;

    protected targetPosition: Vec3 | null = null;
    protected desiredSpeed: number = 0;

    protected targetRotation: Quaternion | null = null;
    protected wantedAngularSpeed: number = 0;

    /** When true, all movement and rotation updates are skipped and new commands are rejected. */
    public frozen: boolean = false;

    @subscribe(OnEntityCreateEvent, { execution: ExecuteOn.Owner })
    onCreate() {
        this.transformComponent = this.entity.getComponent(TransformComponent);
        this.actorLogicComponent = this.entity.getComponent(ActorSdkLogicComponent);
        this.kcc = this.kinematicCharacterEntity?.getComponent(CharacterControllerBase) ?? null;

        if (!this.kinematicCharacterEntity || this.kcc != null) {
            this.registerActorController();
        } else {
            // Don't register the controller in an error case so it doesn't just silently fall back to TransformComponent.
            console.error('ActorTransformMoveComponent: kinematicCharacterEntity must have a KinematicCharacterComponent');
        }
    }

    @subscribe(OnEntityDestroyEvent)
    onDestroy() {
        this.unregisterActorController();
    }

    @subscribe(OnWorldUpdateEvent, { execution: ExecuteOn.Owner })
    onUpdate(params: OnWorldUpdateEventPayload) {
        if (this.frozen) return;

        if (this.targetPosition && this.transformComponent) {
            this.updateMovement(params.deltaTime);
        }

        if (this.targetRotation && this.transformComponent) {
            this.updateBodyRotation(params.deltaTime);
        }
    }

    protected updateBodyRotation(deltaTime: number): void {
        if (!this.transformComponent || !this.targetRotation) {
            return;
        }

        const currentRotation = this.transformComponent.worldRotation;
        const angularDistance = this.getAngularDistance(currentRotation, this.targetRotation);

        if (angularDistance < 0.01) {
            this.transformComponent.worldRotation = this.targetRotation;
            this.targetRotation = null;
            return;
        }

        const rotationAmount = Math.min(this.wantedAngularSpeed * deltaTime, angularDistance);
        const t = rotationAmount / angularDistance;
        const newRotation = Quaternion.slerp(currentRotation, this.targetRotation, t);
        this.transformComponent.worldRotation = newRotation;
    }

    protected getAngularDistance(from: Quaternion, to: Quaternion): number {
        const dot = Math.abs(from.x * to.x + from.y * to.y + from.z * to.z + from.w * to.w);
        const clampedDot = Math.min(1.0, dot);
        return 2 * Math.acos(clampedDot);
    }

    protected directionToQuaternion(direction: Vec3): Quaternion {
        // Engine forward is local -Z, so a yaw rotation θ produces world
        // forward (-sin θ, 0, -cos θ). Solving forward = direction gives
        // yaw = atan2(-direction.x, -direction.z).
        const normalizedDirection = direction.normalize();
        const yawAngle = Math.atan2(-normalizedDirection.x, -normalizedDirection.z);
        return Quaternion.fromAxisAngle(Vec3.up, yawAngle);
    }

    protected updateMovement(deltaTime: number): void {
        if (!this.transformComponent || !this.targetPosition) {
            return;
        }

        // The KCC integrates its own entity's transform during kPrePhysics; this
        // entity's transform only catches up on the next frame's
        // syncCharacterTransform. Differencing against the stale transform makes
        // the position error satisfy e[n] = e[n-1] - e[n-2] — an undamped
        // oscillation that never converges on the target.
        const currentPosition = this.kcc
            ? this.kcc.simulatedPosition
            : this.transformComponent.worldPosition;

        const up = this.transformComponent.worldUp;
        let toTarget = this.targetPosition.sub(currentPosition);
        if (this.kcc) {
            // Remove vertical component if KCC is enabled, since it will be handled by gravity / stair stepping.
            toTarget = toTarget.sub(up.mul(toTarget.dot(up)));
        }

        const distanceToTarget = toTarget.magnitude();
        const maxMovement = this.desiredSpeed * deltaTime;

        if (distanceToTarget <= maxMovement) {
            if (this.kcc) {
                this.kcc.addMoveDelta(toTarget);
            } else {
                this.transformComponent.worldPosition = this.targetPosition;
            }
            this.targetPosition = null;
        } else {
            const direction = toTarget.normalize();
            const displacement = direction.mul(maxMovement);
            if (this.kcc) {
                this.kcc.addMoveDelta(displacement);
            } else {
                this.transformComponent.worldPosition = currentPosition.add(displacement);
            }
        }
    }

    //// ActorMovementController
    moveToPosition(params: ActorMoveParams): void {
        if (this.frozen || !this.transformComponent) {
            return;
        }

        if (!params.desiredPosition) {
            this.stopMovement();
            return;
        }

        this.targetPosition = params.desiredPosition;
        this.desiredSpeed = params.desiredSpeed ?? 0;
    }

    stopMovement(): void {
        this.targetPosition = null;
        this.desiredSpeed = 0;
    }

    //// ActorBodyDirectionController
    rotateBodyTo(params: ActorBodyDirectionParams): void {
        if (this.frozen || !this.transformComponent) {
            return;
        }

        const direction = params.desiredBodyDirection.normalize();
        this.targetRotation = this.directionToQuaternion(direction);
        this.wantedAngularSpeed = params.angularSpeed ?? 0;
    }

    stopRotation(): void {
        this.targetRotation = null;
        this.wantedAngularSpeed = 0;
    }

    //// ActorController
    registerActorController(): void {
        this.actorLogicComponent!.registerController(ActorMovementControllerTypeId, this);
        this.actorLogicComponent!.registerController(ActorBodyDirectionControllerTypeId, this);
    }

    unregisterActorController(): void {
        this.actorLogicComponent!.unregisterController(this);
    }
}
