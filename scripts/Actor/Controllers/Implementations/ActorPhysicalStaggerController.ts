// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {
    AnimatorComponent,
    component,
    Component,
    subscribe,
    OnEntityCreateEvent,
    OnEntityDestroyEvent,
    OnWorldUpdateEvent,
    OnWorldUpdateEventPayload,
    property,
    editor,
    Vec3,
    TransformComponent,
    PhysicsBodyComponent,
    ExecuteOn,
    type Entity,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import { resolveAnimatorComponent } from '../../Utilities/ResolveAnimatorComponent';
import {
    ActorStaggerControllerTypeId,
    ActorStaggerParams,
    type ActorStaggerController,
} from 'meta/worlds';

/**
 * Physics-based stagger controller that applies a knockback impulse and
 * plays a hit animation when triggered by StaggerBehavior.
 *
 * This controller is a passive executor — it does not detect hits itself.
 * StaggerBehavior polls the health controller for hit state and calls
 * into this controller via the behavior manager's useController() path.
 *
 * When StaggerBehavior sets stagger params, this controller applies:
 * 1. An instantaneous velocity impulse pushing the NPC backward
 *    (opposite of the actor's forward direction, i.e. away from attacker)
 * 2. A hit animation trigger via the AnimatorComponent
 *
 * The knockback impulse is applied once and physics handles deceleration
 * via the PhysicsBodyComponent's built-in friction/damping. No per-frame
 * velocity override is needed, avoiding conflicts with
 * ActorTransformMoveComponent (which StaggerBehavior already prevents
 * from issuing movement commands by claiming the movement controller
 * at high priority).
 */
@component({
    description: 'Physics-based stagger controller. Applies knockback impulse and hit animation when StaggerBehavior triggers a stagger.',
})
export class ActorPhysicalStaggerController extends Component implements ActorStaggerController {
    @property()
    @editor({ description: 'AnimGraph transition name for hit reaction.' })
    hitTransitionName: string = 'Hit';

    @property()
    @editor({ description: 'AnimGraph transition name to return to after stagger.' })
    idleTransitionName: string = 'Idle';

    @property()
    @editor({ description: 'Enable debug logging.' })
    debugLogEnabled: boolean = false;

    /**
     * Optional entity to get the AnimatorComponent from.
     * If set, the AnimatorComponent will be retrieved from this entity.
     * If null, falls back to this.entity, then to child entities.
     */
    @property()
    @editor({ description: 'Optional entity containing the AnimatorComponent. If null, searches this entity and children.' })
    animatedEntity: Entity | null = null;

    private actorLogicComponent: ActorSdkLogicComponent | null = null;
    private animatorComponent: AnimatorComponent | null = null;
    private transformComponent: TransformComponent | null = null;
    private physicsBodyComponent: PhysicsBodyComponent | null = null;

    // Stagger params from StaggerBehavior
    private paramsInitialized: boolean = false;
    private knockbackForce: number = 5;
    private staggerDuration: number = 0.3;

    // Active stagger state
    private isStaggerActive: boolean = false;
    private staggerElapsed: number = 0;

    @subscribe(OnEntityCreateEvent, { execution: ExecuteOn.Everywhere })
    onCreate() {
        this.transformComponent = this.entity.getComponent(TransformComponent);
        this.physicsBodyComponent = this.entity.getComponent(PhysicsBodyComponent);
        this.actorLogicComponent = this.entity.getComponent(ActorSdkLogicComponent);
        this.animatorComponent = null;

        if (this.entity.isOwned()) {
            this.registerActorController();
        }
    }

    @subscribe(OnEntityDestroyEvent)
    onDestroy() {
        this.unregisterActorController();
    }

    @subscribe(OnWorldUpdateEvent, { execution: ExecuteOn.Owner })
    onUpdate(payload: OnWorldUpdateEventPayload) {
        if (!this.isStaggerActive) {
            return;
        }

        this.staggerElapsed += payload.deltaTime;

        if (this.staggerElapsed >= this.staggerDuration) {
            this.isStaggerActive = false;
            this.triggerTransition(this.idleTransitionName);
            this.logStaggerEnded();
        }
    }

    /**
     * Logs stagger completion. Opt-in via `debugLogEnabled` (off by default).
     */
    private logStaggerEnded(): void {
        if (this.debugLogEnabled) {
            console.log(`[PhysicalStaggerCtrl] Stagger ended`);
        }
    }

    // ── ActorStaggerController ──────────────────────────────────────

    areStaggerParamsInitialized(): boolean {
        return this.paramsInitialized;
    }

    setStaggerParams(params: ActorStaggerParams): void {
        this.knockbackForce = params.knockbackForce;
        this.staggerDuration = params.staggerDuration;
        this.paramsInitialized = true;

        // Apply the knockback immediately when params are set.
        // StaggerBehavior calls setStaggerParams() once on first
        // useController(), signaling the start of a stagger.
        this.applyKnockback();

        if (this.debugLogEnabled) {
            console.log(`[PhysicalStaggerCtrl] Params set and knockback applied: force=${this.knockbackForce}, duration=${this.staggerDuration}`);
        }
    }

    // ── Knockback ────────────────────────────────────────────────────

    /**
     * Applies a one-shot velocity impulse pushing the NPC backward.
     * The actor is typically facing its attacker, so the knockback
     * direction is the opposite of the actor's forward vector.
     *
     * The impulse is applied once — physics friction/damping handles
     * deceleration naturally, avoiding per-frame velocity conflicts
     * with ActorTransformMoveComponent.
     */
    private applyKnockback(): void {
        if (!this.transformComponent || !this.physicsBodyComponent) {
            return;
        }

        // Push the NPC backward (opposite of forward direction)
        const forward = this.transformComponent.worldForward;
        const knockbackDir = new Vec3(-forward.x, 0, -forward.z);
        const magnitude = Math.sqrt(knockbackDir.x * knockbackDir.x + knockbackDir.z * knockbackDir.z);

        if (magnitude < 0.001) {
            return;
        }

        const normalizedDir = knockbackDir.mul(1 / magnitude);
        const impulse = normalizedDir.mul(this.knockbackForce);

        // Apply impulse, preserving vertical velocity (gravity)
        this.physicsBodyComponent.linearVelocity = new Vec3(
            impulse.x,
            this.physicsBodyComponent.linearVelocity.y,
            impulse.z,
        );

        this.isStaggerActive = true;
        this.staggerElapsed = 0;

        // Trigger hit animation
        this.triggerTransition(this.hitTransitionName);

        if (this.debugLogEnabled) {
            console.log(`[PhysicalStaggerCtrl] Knockback: dir=(${normalizedDir.x.toFixed(2)}, ${normalizedDir.z.toFixed(2)}), force=${this.knockbackForce}`);
        }
    }

    // ── Animation ────────────────────────────────

    private resolveAnimator(): AnimatorComponent | null {
        if (this.animatorComponent) {
            return this.animatorComponent;
        }
        this.animatorComponent = resolveAnimatorComponent(this.entity, this.animatedEntity);
        return this.animatorComponent;
    }

    private triggerTransition(transitionName: string): void {
        const animator = this.resolveAnimator();
        if (animator) {
            animator.requestTransition(transitionName);
        }
    }

    // ── Controller Registration ──────────────────────────────────────

    registerActorController(): void {
        this.actorLogicComponent?.registerController(ActorStaggerControllerTypeId, this);
    }

    unregisterActorController(): void {
        this.actorLogicComponent?.unregisterController(this);
    }
}
