// @generated - Actor Framework Scripts v9
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {
    component,
    Component,
    subscribe,
    NetworkingService,
    OnEntityCreateEvent,
    ExecuteOn,
    property,
    editor,
    Service,
} from 'meta/worlds';
import {ActorSdkBlackboardManager} from 'meta/worlds';
import { CombatBlackboard } from '../Core/Blackboard/Implementations/CombatBlackboard';
import { BlackboardScope } from 'meta/worlds';

@component({
    description: 'Base health component that tracks health, applies damage, and reports death to the CombatBlackboard. Extend this for actor-specific health behavior.',
})
export class GameplayHealthComponent extends Component {
    @property()
    @editor({ description: 'Maximum health points for this actor.' })
    maxHealth: number = 10;

    @property()
    @editor({ description: 'Blackboard group ID for faction-based combat target tracking. Leave empty to skip blackboard updates.' })
    blackboardGroupId: string = '';

    public currentHealth: number = 0;
    public isDead = false;
    public isHit = false;

    /** Damage applications this actor has survived-or-died to, counted per instance. */
    public hitCount: number = 0;

    protected blackboardManager = Service.inject(ActorSdkBlackboardManager);

    @subscribe(OnEntityCreateEvent, { execution: ExecuteOn.Everywhere })
    onCreate() {
        this.currentHealth = this.maxHealth;
        // Pooled reuse re-fires this on a recycled instance: a stale isDead
        // would make it permanently immune and silent, and a stale hitCount
        // would report the sum across lives as hits-to-kill.
        this.hitCount = 0;
        this.isDead = false;
        this.isHit = false;
    }

    takeDamage(amount: number) {
        if (this.isDead) {
            return;
        }
        this.currentHealth -= amount;
        const died = this.currentHealth <= 0;
        if (died) {
            this.currentHealth = 0;
            this.isDead = true;
        }
        this.recordDamage(amount, died);
        if (died) {
            console.log(`[GameplayHealthComponent] ${this.entity.name} DIED`);
            this.onDeath();
        }
    }

    /**
     * Records one damage application: bumps the per-instance counter, then
     * emits the hit line and, when the blow was lethal, the death line.
     *
     * SUBCLASSES THAT OVERRIDE takeDamage WITHOUT CALLING super MUST call this.
     * `ActorAnimatedHealthComponent` does exactly that, and it is the component
     * an animated enemy carries -- so an override that skips this makes the
     * actor emit nothing at all, and every downstream hit count reads zero on a
     * world where combat is working.
     *
     * Call it AFTER the health value has been clamped: `emitCombatTelemetry`
     * reads `currentHealth` live, so emitting first puts a negative health on
     * the hit line for an overkill blow -- a value the field never holds.
     */
    protected recordDamage(amount: number, died: boolean) {
        this.hitCount += 1;
        this.emitCombatTelemetry('hit', amount);
        if (died) {
            this.emitCombatTelemetry('death', amount);
        }
    }

    /**
     * Permanent combat telemetry (ALWAYS on, not debug-gated), mirroring
     * ActorSpawner's spawn telemetry. The engine emits no native per-damage line,
     * so this component is the authoritative record of who was hit and how many
     * times. Tooling (the ranged-defender eval's zombies_hit / hit-count checks)
     * parses these from the runtime log, which is the only signal that separates
     * "a projectile was fired" from "a projectile connected".
     *
     * SERVER-ONLY. Damage is applied by the owner of the attacking projectile,
     * which for a networked actor is the server -- but a client-side caller (a
     * predictive hit, a copied derivative) would otherwise emit a duplicate line
     * per connected client and inflate every parsed hit count. The isServerContext
     * gate makes each landed hit exactly one line.
     *
     * Event-driven (once per damage application, not per frame), so it is not an
     * update-loop log. `hits` is this instance's running count, so a parser reads
     * the hits-to-kill directly off the `event=death` line without correlating
     * same-named instances.
     */
    private emitCombatTelemetry(event: 'hit' | 'death', amount: number) {
        if (!NetworkingService.get().isServerContext()) {
            return;
        }
        const name = this.entity?.valid ? this.entity.name : '<destroyed>';
        console.log(
            `[ActorCombatTelemetry] event=${event} target=${name} damage=${amount} hits=${this.hitCount} health=${this.currentHealth}`,
        );
    }

    onDeath() {
        // Update blackboard if configured
        if (this.blackboardGroupId) {
            const combatBlackboard = this.blackboardManager.getBlackboard(
                CombatBlackboard,
                /* actorId */ undefined,
                this.blackboardGroupId,
                BlackboardScope.Group
            );

            if (combatBlackboard) {
                combatBlackboard.updateTarget(this.entity, { isDead: true }, false);
            }
        }

        // Override this method in derived classes to implement additional death behavior
    }
}
