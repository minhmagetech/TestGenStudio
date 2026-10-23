// @generated - Actor Framework Scripts v12
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {
    AnimatorComponent,
    component,
    Component,
    editor,
    OnEntityCreateEvent,
    OnEntityDestroyEvent,
    property,
    subscribe,
    subscribePropertyChange,
    WorldService,
    ExecuteOn,
    type Entity,
} from 'meta/worlds';
import { IActorAttackControllerTypeId, type IActorAttackController, type IActorAttackPayload } from '../Definitions/IActorAttackController';
import {ActorSdkLogicComponent} from 'meta/worlds';
import { resolveAnimatorComponent } from '../../Utilities/ResolveAnimatorComponent';
import { GameplayHealthComponent } from '../../Utilities/GameplayHealthComponent';
enum AttackAnimState {
    Idle = 0,
    Attacking = 1,
}

/**
 * Attack controller for animated Actor entities.
 * Uses a replicated attackAnimState property to synchronize animation
 * transitions across all clients via AnimatorComponent.requestTransition().
 *
 * Set attackTransitionName and idleTransitionName to match the "TypeScript Name"
 * fields on your AnimGraph transitions.
 */
@component({
    description: 'Attack controller for animated actors. Synchronizes attack animations across clients via networked properties and triggers AnimGraph transitions.',
})
export class ActorAnimatedAttackComponent extends Component implements IActorAttackController {
    @property()
    @editor({ description: 'Minimum cooldown in seconds between attacks. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly to `2`.' })
    minTimeBetweenAttacks: number = 2;

    @property()
    @editor({ description: 'Damage dealt per attack to the target. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly to `1`.' })
    damageAmount: number = 1;

    @property()
    @editor({ description: 'Delay in seconds before damage is applied after attack starts. Set equal to attackAnimationDuration to apply damage at the end of the attack. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly to `1.0`.' })
    damageDelaySeconds: number = 1.0;

    @property()
    @editor({ description: 'Duration in seconds of the attack animation. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly to `1.0` (a `0` causes the attack to fire instantly and never return to idle).' })
    attackAnimationDuration: number = 1.0;

    @property()
    @editor({ description: 'Additional delay in seconds after the attack animation before returning to idle. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly to `0.5`.' })
    idleTransitionDelay: number = 0.5;

    @property()
    @editor({ description: 'AnimGraph transition name to trigger when attacking. Must match the TypeScript Name on the Idle→Attack transition. 🚨 Template gotcha: stored as `""` on a template instance — set explicitly to `"Attack"` (an empty string triggers no AnimGraph transition).' })
    attackTransitionName: string = 'Attack';

    @property()
    @editor({ description: 'AnimGraph transition name to trigger when returning to idle. Must match the TypeScript Name on the Attack→Idle transition. 🚨 Template gotcha: stored as `""` on a template instance — set explicitly to `"Idle"`.' })
    idleTransitionName: string = 'Idle';

    @property()
    @editor({ description: 'Enable debug logging to console.' })
    debugLogEnabled: boolean = true;

    /**
     * Replicated animation state. When the owner changes this value,
     * all clients receive the update via `@subscribePropertyChange` and
     * trigger the corresponding AnimGraph transition locally.
     */
    @property({ isNetworked: true })
    @editor({ show: false })
    attackAnimState: number = AttackAnimState.Idle;

    /**
     * Optional entity to get the AnimatorComponent from.
     * If set, the AnimatorComponent will be retrieved from this entity.
     * If null, falls back to this.entity, then to child entities.
     */
    @property()
    @editor({ description: 'Optional entity containing the AnimatorComponent. If null, searches this entity and children.' })
    animatedEntity: Entity | null = null;

    private animatorComponent: AnimatorComponent | null = null;
    private lastAttackTime = 0;
    private isAttacking = false;
    private attackResetTimeoutId: number | null = null;
    // In-flight damage timers, tracked as a set so a re-entrant attack() (which
    // can happen when damageDelaySeconds >= attackAnimationDuration +
    // idleTransitionDelay, letting the reset timer flip isAttacking back before
    // the damage lands) never orphans an earlier, still-pending, uncancellable
    // timer. Mirrors FireballProjectile's pendingVfxTimers. Cleared on
    // cancel/destroy so a timer cannot fire into a torn-down closure.
    private pendingDamageTimers: Set<number> = new Set();

    @subscribe(OnEntityCreateEvent, { execution: ExecuteOn.Everywhere })
    onCreate() {
        this.animatorComponent = null;

        if (this.entity.isOwned()) {
            this.registerActorController();
        }

        if (this.debugLogEnabled) {
            const side = this.entity.isOwned() ? 'OWNER' : 'CLIENT';
            console.log(`[ActorAnimatedAttackComponent] [${side}] Initialized on '${this.entity.name}'`);
        }
    }

    @subscribe(OnEntityDestroyEvent)
    onDestroy() {
        if (this.attackResetTimeoutId) {
            clearTimeout(this.attackResetTimeoutId);
        }
        for (const timerId of this.pendingDamageTimers) {
            clearTimeout(timerId);
        }
        this.pendingDamageTimers.clear();
        this.unregisterActorController();
    }

    /**
     * Fires on ALL clients when the owner changes attackAnimState.
     * Each client triggers the appropriate AnimGraph transition locally.
     */
    @subscribePropertyChange('attackAnimState')
    onAttackAnimStateChanged() {
        if (this.debugLogEnabled) {
            const side = this.entity.isOwned() ? 'OWNER' : 'CLIENT';
            console.log(`[ActorAnimatedAttackComponent] [${side}] attackAnimState changed to ${this.attackAnimState}`);
        }

        if (this.attackAnimState === AttackAnimState.Attacking) {
            this.triggerTransition(this.attackTransitionName);
        } else {
            this.triggerTransition(this.idleTransitionName);
        }
    }

    /**
     * Resolves the AnimatorComponent lazily on first use using the
     * standard fallback chain (`animatedEntity` → this entity → children).
     */
    private resolveAnimator(): AnimatorComponent | null {
        if (this.animatorComponent) {
            return this.animatorComponent;
        }
        this.animatorComponent = resolveAnimatorComponent(this.entity, this.animatedEntity);
        return this.animatorComponent;
    }

    private triggerTransition(transitionName: string): void {
        const animator = this.resolveAnimator();
        if (!animator) {
            if (this.debugLogEnabled) {
                console.warn(`[ActorAnimatedAttackComponent] Cannot trigger '${transitionName}' — no AnimatorComponent`);
            }
            return;
        }

        if (this.debugLogEnabled) {
            console.log(`[ActorAnimatedAttackComponent] requestTransition('${transitionName}')`);
        }
        animator.requestTransition(transitionName);
    }

    attack(payload: IActorAttackPayload): void {
        const {target} = payload;

        // Cheap re-entrancy guard first — the behavior layer can call this every
        // frame while an attack is already in flight.
        if (this.isAttacking) {
            return;
        }

        // A dead attacker stops attacking, and a dead target takes no further
        // hits — the same authority the projectile sibling
        // (ActorProjectileAttackComponent) enforces. Null-tolerant: a missing
        // health component never blocks the attack, and an invalid target is
        // guarded before it is dereferenced.
        const attackerHealth = this.entity.getComponent(GameplayHealthComponent);
        if (attackerHealth && attackerHealth.isDead) {
            return;
        }
        if (target && target.valid) {
            const targetHealth = this.resolveTargetHealth(target);
            if (targetHealth && targetHealth.isDead) {
                return;
            }
        }

        this.isAttacking = true;
        this.lastAttackTime = WorldService.get().getWorldTime();

        this.attackAnimState = AttackAnimState.Attacking;

        // Damage per hit prefers the attacking behavior's value (payload.damage,
        // set by EngageCombatBehavior/AttackEntityInRangeBehavior) and falls back
        // to this controller's own damageAmount for standalone use.
        const damage = payload.damage ?? this.damageAmount;
        // Land the hit on the animation's contact frame. A zero/negative delay
        // means "hit immediately" and is applied synchronously — this also keeps
        // the melee damage path unit-testable without fake timers.
        if (this.damageDelaySeconds > 0) {
            const timerId = setTimeout(() => {
                this.pendingDamageTimers.delete(timerId);
                this.dealDamage(target, damage);
            }, this.damageDelaySeconds * 1000);
            this.pendingDamageTimers.add(timerId);
        } else {
            this.dealDamage(target, damage);
        }

        const totalDelay = (this.attackAnimationDuration + this.idleTransitionDelay) * 1000;
        this.attackResetTimeoutId = setTimeout(() => {
            this.attackAnimState = AttackAnimState.Idle;
            this.isAttacking = false;
            this.attackResetTimeoutId = null;
        }, totalDelay);
    }

    /**
     * Applies an attack's damage to the target's health, owner-authoritatively.
     *
     * Mirrors the projectile hit path (`FireballProjectile.applyHit`): resolve a
     * `GameplayHealthComponent` on the target root or any descendant and call
     * `takeDamage`. This is what makes a melee actor actually reduce a target's
     * health — a stock target with a `GameplayHealthComponent` and a collider
     * (including a static structure like a castle) takes damage with no per-frame
     * proximity/damage loop authored on the attacker.
     */
    dealDamage(target: Entity, amount: number): void {
        if (!target || !target.valid || amount <= 0) {
            return;
        }
        // A delayed hit can land after this attacker was despawned (e.g. the pool
        // recycled it, or a lethal counter-hit killed it first). Guard the
        // attacker before touching isOwned() so a pending timer never dereferences
        // a torn-down entity.
        if (!this.entity || !this.entity.valid) {
            return;
        }
        // Apply damage on the attacker's owner only, so a networked NPC does not
        // multi-count a single hit across clients (same authority rule the
        // projectile path enforces with ExecuteOn.Owner).
        if (!this.entity.isOwned()) {
            return;
        }
        const health = this.resolveTargetHealth(target);
        if (!health) {
            if (this.debugLogEnabled) {
                console.warn(`[ActorAnimatedAttackComponent] Target '${target.name}' has no GameplayHealthComponent — no damage applied`);
            }
            return;
        }
        // The scheduling→firing delay can outlive a death: the attacker may have
        // been killed mid-delay, or the target may have died to another source in
        // the window. Re-check both so a queued hit never lands after a death.
        const attackerHealth = this.entity.getComponent(GameplayHealthComponent);
        if ((attackerHealth && attackerHealth.isDead) || health.isDead) {
            return;
        }
        health.takeDamage(amount);
        if (this.debugLogEnabled) {
            console.log(`[ActorAnimatedAttackComponent] Attack hit '${target.name}' for ${amount} (health now ${health.currentHealth})`);
        }
    }

    private resolveTargetHealth(target: Entity): GameplayHealthComponent | null {
        return (
            target.getComponent(GameplayHealthComponent) ??
            target
                .getChildrenWithComponent(GameplayHealthComponent, true)[0]
                ?.getComponent(GameplayHealthComponent) ??
            null
        );
    }

    canAttack(): boolean {
        const attackerHealth = this.entity.getComponent(GameplayHealthComponent);
        if (attackerHealth && attackerHealth.isDead) {
            return false;
        }
        const currentTime = WorldService.get().getWorldTime();
        return currentTime - this.lastAttackTime > this.minTimeBetweenAttacks;
    }

    cancelAttack(): void {
        // Drain timers unconditionally: when damageDelaySeconds exceeds the
        // attack-reset window, the reset timer has already flipped isAttacking
        // back to false while a damage timer is still pending — an early-return on
        // isAttacking would leak that timer and land a stray hit after cancel.
        if (this.attackResetTimeoutId) {
            clearTimeout(this.attackResetTimeoutId);
            this.attackResetTimeoutId = null;
        }
        for (const timerId of this.pendingDamageTimers) {
            clearTimeout(timerId);
        }
        this.pendingDamageTimers.clear();
        if (this.isAttacking) {
            this.attackAnimState = AttackAnimState.Idle;
            this.isAttacking = false;
        }
    }

    registerActorController(): void {
        const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
        if (actorLogic) {
            actorLogic.registerController(IActorAttackControllerTypeId, this);
            if (this.debugLogEnabled) {
                console.log(`[ActorAnimatedAttackComponent] Registered attack controller for ${this.entity.name}`);
            }
        } else {
            console.warn(`[ActorAnimatedAttackComponent] No ActorSdkLogicComponent found on ${this.entity.name}`);
        }
    }

    unregisterActorController(): void {
        const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
        if (actorLogic) {
            actorLogic.unregisterController(this);
        }
    }
}
