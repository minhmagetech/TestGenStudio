// @generated - Actor Framework Scripts v5
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
    OnEntityStartEvent,
    property,
    subscribe,
    subscribePropertyChange,
    WorldService,
    NetworkMode,
    ExecuteOn,
    MeshComponent,
    Quaternion,
    type Entity,
    type TemplateAsset,
    TransformComponent,
    Vec3,
} from 'meta/worlds';
import {IActorAttackControllerTypeId, type IActorAttackController, type IActorAttackPayload} from '../Definitions/IActorAttackController';
import type {IActorProjectile} from '../Definitions/IActorProjectile';
import {ActorSdkLogicComponent} from 'meta/worlds';
import {resolveAnimatorComponent} from '../../Utilities/ResolveAnimatorComponent';
import {GameplayHealthComponent} from '../../Utilities/GameplayHealthComponent';

enum AttackAnimState {
    Idle = 0,
    Attacking = 1,
}

interface PooledProjectile {
    entity: Entity;
    projectile: IActorProjectile;
}

/**
 * Attack controller that plays an attack animation and fires a projectile
 * from a pre-spawned object pool.
 *
 * On create, the controller spawns {@link poolSize} projectile entities from
 * {@link projectileTemplate} and keeps them inactive. On attack, it pulls the
 * next projectile round-robin, repositions it to the spawn offset, and calls
 * {@link IActorProjectile.fire}.
 *
 * The projectile template must contain a Component that implements
 * {@link IActorProjectile}.
 *
 * Set attackTransitionName and idleTransitionName to match the "TypeScript Name"
 * fields on your AnimGraph transitions.
 */
@component({
    description: 'Attack controller that plays an attack animation and fires projectiles from a pre-spawned object pool. The projectile template must have a component implementing IActorProjectile.',
})
export class ActorProjectileAttackComponent extends Component implements IActorAttackController {
    @property()
    @editor({description: 'Minimum cooldown in seconds between attacks.'})
    minTimeBetweenAttacks: number = 2;

    @property()
    @editor({description: 'Damage dealt per projectile hit.'})
    damageAmount: number = 1;

    @property()
    @editor({description: 'Delay in seconds after attack starts before the projectile is fired. Align with the animation release point.'})
    projectileSpawnDelay: number = 0.5;

    @property()
    @editor({description: 'Duration in seconds of the attack animation.'})
    attackAnimationDuration: number = 1.0;

    @property()
    @editor({description: 'Additional delay in seconds after the attack animation before returning to idle.'})
    idleTransitionDelay: number = 0.5;

    @property()
    @editor({description: 'AnimGraph transition name to trigger when attacking.'})
    attackTransitionName: string = 'Attack';

    @property()
    @editor({description: 'AnimGraph transition name to trigger when returning to idle.'})
    idleTransitionName: string = 'Idle';

    @property()
    @editor({description: 'Projectile template to spawn. Must have a component implementing ActorProjectile. Any VFX should live as a CHILD entity inside this template so it travels with the projectile — the controller teleports/fires the projectile root entity and only its children follow; a separate or unparented VFX stays at the muzzle. Give that VFX child a VfxPlatformComponent (the asset + global_scale live there), and drive VfxComponent.play()/stop() from the projectile fire()/onHit() rather than autoPlay (the pool spawns many projectiles off-screen). Set the VFX size via VFX parameters (e.g. global_scale), NOT entity transform scale — entity scaling does not affect VFX particles, and marketplace fireball/explosion effects are authored large so they look huge at default scale.'})
    projectileTemplate: TemplateAsset | null = null;

    @property()
    @editor({description: 'Actor-LOCAL muzzle offset (x=right, y=up, z=forward; local forward is -Z in MHE, so the forward component is NEGATIVE - default z=-0.5), rotated by the caster facing at fire time. Defaults to mid-body + forward (z more negative than the collider radius) so it clears the caster (no underground/self-collide); prefer the exact firing point (muzzle, wand tip, dragon mouth) when one exists.'})
    projectileSpawnOffset: Vec3 = new Vec3(0, 1.5, -0.5);

    @property()
    @editor({description: 'Number of projectiles to pre-spawn in the object pool.'})
    poolSize: number = 15;

    @property()
    @editor({description: 'Enable debug logging to console.'})
    debugLogEnabled: boolean = true;

    @property()
    @editor({description: 'Lead a moving target. Off by default; enable it when setting up a ranged attacker that fires at moving targets. When enabled, the projectile aims at where the target will be (predicted from the target velocity at fire time), instead of its current position, so moving targets are hit without homing. The lead distance is sized from the projectile speed reported by the projectile component ActorProjectile.getSpeed(); if the projectile does not report a speed, a fixed short lead is used. Leave off for hitscan-style or non-tracking shots.'})
    leadTargetPrediction: boolean = false;

    @property({isNetworked: true})
    @editor({show: false})
    attackAnimState: number = AttackAnimState.Idle;

    /**
     * Optional entity to get the AnimatorComponent from.
     * If set, the AnimatorComponent will be retrieved from this entity.
     * If null, falls back to this.entity, then to child entities.
     */
    @property()
    @editor({description: 'Optional entity containing the AnimatorComponent. If null, searches this entity and children.'})
    animatedEntity: Entity | null = null;

    private animatorComponent: AnimatorComponent | null = null;
    private lastAttackTime = 0;
    private isAttacking = false;
    private attackResetTimeoutId: number | null = null;
    private projectileFireTimeoutId: number | null = null;

    // Lead horizon (seconds) used when the projectile does not report a speed
    // via getSpeed(). Matches the targeting stack's default velocityPredictionTime.
    private static readonly fallbackLeadTimeSeconds = 0.5;

    // Max |aimDir · Vec3.up| (aimDir is unit length) for which Quaternion.lookRotation
    // stays well-conditioned. Above this the aim is within ~2.6° of vertical, where
    // lookRotation(aimDir, Vec3.up) degenerates (NaN), so we keep the caster facing.
    private static readonly maxAimUpAlignment = 0.999;

    // ── Object Pool ─────────────────────────────────────────────────────
    private pool: PooledProjectile[] = [];
    private nextPoolIndex: number = 0;

    @subscribe(OnEntityCreateEvent, {execution: ExecuteOn.Everywhere})
    onCreate() {
        this.animatorComponent = null;

        if (this.entity.isOwned()) {
            this.registerActorController();
        }

        if (this.debugLogEnabled) {
            const side = this.entity.isOwned() ? 'OWNER' : 'CLIENT';
            console.log(`[ActorProjectileAttackComponent] [${side}] Initialized on '${this.entity.name}'`);
        }
    }

    @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
    onStart() {
        this.initializePool();
    }

    @subscribe(OnEntityDestroyEvent)
    onDestroy() {
        if (this.attackResetTimeoutId) {
            clearTimeout(this.attackResetTimeoutId);
        }
        if (this.projectileFireTimeoutId) {
            clearTimeout(this.projectileFireTimeoutId);
        }
        this.destroyPool();
        this.unregisterActorController();
    }

    @subscribePropertyChange('attackAnimState')
    onAttackAnimStateChanged() {
        if (this.debugLogEnabled) {
            const side = this.entity.isOwned() ? 'OWNER' : 'CLIENT';
            console.log(`[ActorProjectileAttackComponent] [${side}] attackAnimState changed to ${this.attackAnimState}`);
        }

        if (this.attackAnimState === AttackAnimState.Attacking) {
            this.triggerTransition(this.attackTransitionName);
        } else {
            this.triggerTransition(this.idleTransitionName);
        }
    }

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
                console.warn(`[ActorProjectileAttackComponent] Cannot trigger '${transitionName}' — no AnimatorComponent`);
            }
            return;
        }

        if (this.debugLogEnabled) {
            console.log(`[ActorProjectileAttackComponent] requestTransition('${transitionName}')`);
        }
        animator.requestTransition(transitionName);
    }

    attack(payload: IActorAttackPayload): void {
        const {target} = payload;
        const effectiveDamage = payload.damage ?? this.damageAmount;

        const myHealth = this.entity.getComponent(GameplayHealthComponent);
        if (myHealth && myHealth.isDead) {
            return;
        }

        const targetHealth = target.getComponent(GameplayHealthComponent);
        if (targetHealth && targetHealth.isDead) {
            return;
        }

        if (!this.isAttacking) {
            this.isAttacking = true;
            this.lastAttackTime = WorldService.get().getWorldTime();

            // Trigger attack animation on all clients
            this.attackAnimState = AttackAnimState.Attacking;

            // Fire projectile after delay (aligned with animation release point)
            this.projectileFireTimeoutId = setTimeout(() => {
                this.fireNextProjectile({
                    target,
                    damage: effectiveDamage,
                    attackRange: payload.attackRange,
                    targetVelocity: payload.targetVelocity,
                });
                this.projectileFireTimeoutId = null;
            }, this.projectileSpawnDelay * 1000);

            // Return to idle after animation completes
            const totalDelay = (this.attackAnimationDuration + this.idleTransitionDelay) * 1000;
            this.attackResetTimeoutId = setTimeout(() => {
                this.attackAnimState = AttackAnimState.Idle;
                this.isAttacking = false;
                this.attackResetTimeoutId = null;
            }, totalDelay);
        }
    }

    canAttack(): boolean {
        const myHealth = this.entity.getComponent(GameplayHealthComponent);
        if (myHealth && myHealth.isDead) {
            return false;
        }
        const currentTime = WorldService.get().getWorldTime();
        if (currentTime - this.lastAttackTime > this.minTimeBetweenAttacks) {
            return true;
        }
        return false;
    }

    cancelAttack(): void {
        if (!this.isAttacking) return;
        if (this.attackResetTimeoutId) {
            clearTimeout(this.attackResetTimeoutId);
            this.attackResetTimeoutId = null;
        }
        if (this.projectileFireTimeoutId) {
            clearTimeout(this.projectileFireTimeoutId);
            this.projectileFireTimeoutId = null;
        }
        this.attackAnimState = AttackAnimState.Idle;
        this.isAttacking = false;
    }

    registerActorController(): void {
        const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
        if (actorLogic) {
            actorLogic.registerController(IActorAttackControllerTypeId, this);
            if (this.debugLogEnabled) {
                console.log(`[ActorProjectileAttackComponent] Registered attack controller for ${this.entity.name}`);
            }
        } else {
            console.warn(`[ActorProjectileAttackComponent] No ActorSdkLogicComponent found on ${this.entity.name}`);
        }
    }

    unregisterActorController(): void {
        const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
        if (actorLogic) {
            actorLogic.unregisterController(this);
        }
    }

    // ── Object Pool ─────────────────────────────────────────────────────

    private initializePool(): void {
        if (!this.projectileTemplate) {
            console.warn('[ActorProjectileAttackComponent] No projectileTemplate assigned — pool not created');
            return;
        }

        let spawned = 0;
        for (let i = 0; i < this.poolSize; i++) {
            void WorldService.get().spawnTemplate({
                templateAsset: this.projectileTemplate,
                networkMode: NetworkMode.Networked,
                position: new Vec3(0, -1000, 0), // Park off-screen
            }).then((spawnedEntity: Entity) => {
                if (!spawnedEntity || spawnedEntity.isDestroyed()) {
                    return;
                }

                const projectile = this.findProjectileComponent(spawnedEntity);
                if (projectile) {
                    // Hide projectile until it's fired from the pool
                    const meshComp = spawnedEntity.getComponent(MeshComponent);
                    if (meshComp) {
                        meshComp.isVisibleSelf = false;
                    }
                    this.pool.push({entity: spawnedEntity, projectile});
                } else {
                    console.warn('[ActorProjectileAttackComponent] Spawned projectile has no ActorProjectile component');
                }

                spawned++;
                if (spawned === this.poolSize) {
                    if (this.debugLogEnabled) {
                        console.log(`[ActorProjectileAttackComponent] Pool ready: ${this.pool.length} projectiles`);
                    }
                }
            });
        }
    }

    private destroyPool(): void {
        for (const entry of this.pool) {
            if (entry.entity && !entry.entity.isDestroyed()) {
                entry.entity.destroy();
            }
        }
        this.pool = [];
        this.nextPoolIndex = 0;
    }

    private fireNextProjectile(payload: IActorAttackPayload): void {
        if (this.pool.length === 0) {
            if (this.debugLogEnabled) {
                console.warn('[ActorProjectileAttackComponent] Pool is empty — cannot fire');
            }
            return;
        }

        const entry = this.pool[this.nextPoolIndex];
        this.nextPoolIndex = (this.nextPoolIndex + 1) % this.pool.length;

        if (entry.entity.isDestroyed()) {
            if (this.debugLogEnabled) {
                console.warn('[ActorProjectileAttackComponent] Pool entry destroyed — skipping');
            }
            return;
        }

        // Reposition projectile to the spawn offset
        const transform = this.entity.getComponent(TransformComponent);
        if (!transform) {
            return;
        }

        const worldPos = transform.worldPosition;
        const worldRot = transform.worldRotation;
        // projectileSpawnOffset is actor-local. Rotate it into world space so the
        // forward component clears the caster in the direction the projectile
        // travels — a raw world-space add spawns inside/behind the caster once it
        // turns. First offset along the caster facing to size the lead; once the
        // travel direction is known we re-offset along it (below).
        const facingOffset = worldRot.mulVec3(this.projectileSpawnOffset);
        const facingSpawnPos = new Vec3(
            worldPos.x + facingOffset.x,
            worldPos.y + facingOffset.y,
            worldPos.z + facingOffset.z,
        );

        // By default the projectile flies along the caster's facing — straight
        // at the target's current position. When lead prediction is enabled and
        // the target's velocity is known, aim at the predicted intercept point
        // instead, so a moving target is hit without homing.
        let aimRot = worldRot;
        const targetVelocity = payload.targetVelocity;
        if (this.leadTargetPrediction && payload.target && targetVelocity) {
            const targetTransform = payload.target.getComponent(TransformComponent);
            if (targetTransform) {
                const aimDir = this.computeLeadAimDirection(
                    facingSpawnPos,
                    targetTransform.worldPosition,
                    targetVelocity,
                    entry.projectile.getSpeed?.() ?? 0,
                );
                // Quaternion.lookRotation degenerates when aimDir is (anti)parallel
                // to its up reference (Vec3.up) — a target directly overhead/below
                // would yield a NaN rotation. aimDir is unit length and Vec3.up is
                // (0,1,0), so |aimDir.y| is its alignment with up; for near-vertical
                // shots keep the caster facing instead.
                if (
                    aimDir &&
                    Math.abs(aimDir.y) < ActorProjectileAttackComponent.maxAimUpAlignment
                ) {
                    aimRot = Quaternion.lookRotation(aimDir, Vec3.up);
                }
            }
        }

        // Offset the muzzle along the actual travel direction (aimRot) so the
        // spawn clears the caster along the flight path, not just the caster
        // facing — otherwise a large lead angle starts the projectile in front of
        // the old facing while it flies off at an angle, clipping the caster. When
        // not leading, aimRot === worldRot so this equals facingSpawnPos.
        const spawnOffset = aimRot.mulVec3(this.projectileSpawnOffset);
        const spawnPos = new Vec3(
            worldPos.x + spawnOffset.x,
            worldPos.y + spawnOffset.y,
            worldPos.z + spawnOffset.z,
        );

        const projectileTransform = entry.entity.getComponent(TransformComponent);
        if (projectileTransform) {
            // Spawn facing the aim rotation so fire() flies toward the target —
            // lead-predicted when the target is moving, straight otherwise.
            projectileTransform.teleportTo(spawnPos, aimRot);
            if (this.debugLogEnabled) {
                const ledSuffix = aimRot !== worldRot ? ' (leading moving target)' : '';
                console.log(`[ActorProjectileAttackComponent] Spawned projectile at (${spawnPos.x.toFixed(2)}, ${spawnPos.y.toFixed(2)}, ${spawnPos.z.toFixed(2)}) from caster at (${worldPos.x.toFixed(2)}, ${worldPos.y.toFixed(2)}, ${worldPos.z.toFixed(2)})${ledSuffix}`);
            }
        } else if (this.debugLogEnabled) {
            console.warn('[ActorProjectileAttackComponent] No TransformComponent on projectile — teleport skipped; projectile fired from its current position');
        }

        entry.projectile.fire(payload);
    }

    /**
     * Computes the normalized world-space aim direction that leads a moving
     * target, or null when the aim point is effectively on top of the muzzle.
     *
     * First-order lead: aimPoint = targetPos + velocity · leadTime, matching the
     * targeting stack's predicted-position model. When the projectile reports a
     * speed (> 0) the lead time is sized to the actual flight time
     * (distance ÷ speed, refined one step toward the true intercept); otherwise
     * a fixed fallback horizon is used. A stationary target (zero velocity)
     * resolves to aiming straight at its current position.
     *
     * Assumes a straight-line (non-ballistic) projectile, consistent with the
     * player projectile path.
     */
    private computeLeadAimDirection(
        spawnPos: Vec3,
        targetPos: Vec3,
        targetVelocity: Vec3,
        projectileSpeed: number,
    ): Vec3 | null {
        let leadTime: number;
        if (projectileSpeed > 0) {
            leadTime = targetPos.sub(spawnPos).magnitude() / projectileSpeed;
            const firstGuess = targetPos.add(targetVelocity.mul(leadTime));
            leadTime = firstGuess.sub(spawnPos).magnitude() / projectileSpeed;
        } else {
            leadTime = ActorProjectileAttackComponent.fallbackLeadTimeSeconds;
        }

        const aimPoint = targetPos.add(targetVelocity.mul(leadTime));
        const aimDir = aimPoint.sub(spawnPos);
        return aimDir.magnitude() > 0.0001 ? aimDir.normalize() : null;
    }

    /**
     * Searches an entity for a component implementing IActorProjectile.
     * Uses duck-type check since MHS does not support getComponent by interface.
     */
    private findProjectileComponent(entity: Entity): IActorProjectile | null {
        const components = entity.getComponents(Component);
        for (const comp of components) {
            const candidate = comp as unknown as IActorProjectile;
            if (typeof candidate.fire === 'function' && typeof candidate.onHit === 'function') {
                return candidate;
            }
        }
        return null;
    }
}
