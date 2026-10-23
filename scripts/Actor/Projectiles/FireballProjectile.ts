// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {
    component,
    Component,
    editor,
    EventService,
    ExecuteOn,
    MeshComponent,
    NetworkEvent,
    NetworkMode,
    OnEntityCreateEvent,
    OnEntityDestroyEvent,
    OnTriggerEnterEvent,
    OnTriggerEnterEventPayload,
    OnWorldUpdateEvent,
    OnWorldUpdateEventPayload,
    PhysicsBodyComponent,
    property,
    Quaternion,
    serializable,
    subscribe,
    TransformComponent,
    Vec3,
    VfxComponent,
    WorldService,
} from 'meta/worlds';
import type {Entity, Maybe, TemplateAsset} from 'meta/worlds';
import type {IActorAttackPayload} from '../Controllers/Definitions/IActorAttackController';
import type {
    IActorProjectile,
    ActorProjectileHitCallback,
} from '../Controllers/Definitions/IActorProjectile';
import {GameplayHealthComponent} from '../Utilities/GameplayHealthComponent';

/**
 * Payload for {@link OnProjectileSetActiveEvent}. Carries the new active state
 * so every client (and the server) can update its own local view of the
 * projectile's mesh.
 */
@serializable()
export class ProjectileSetActiveEventPayload {
    @property()
    readonly active: boolean = false;
}

/**
 * Broadcast from the projectile's owner (server) whenever the projectile
 * activates or deactivates. Subscribers run {@link ExecuteOn.Everywhere} so the
 * mesh on each client reflects the change — the owner-only `isVisibleSelf` write
 * would otherwise throw "entity not owned" on remote clients.
 */
export const OnProjectileSetActiveEvent = new NetworkEvent(
    'OnProjectileSetActiveEvent',
    ProjectileSetActiveEventPayload,
);

/**
 * Reference {@link IActorProjectile} for {@link ActorProjectileAttackComponent}
 * (projectile mode). Copy this as the starting point for any ranged-attacker
 * projectile (fireball, arrow, bolt, magic missile) — do NOT hand-roll a bespoke
 * physics projectile; the attack controller already pools, aims, leads, and
 * fires instances of this interface.
 *
 * Template requirements:
 *  - Root entity has a TRIGGER PhysicsBodyComponent (hit detection runs through
 *    OnTriggerEnterEvent) and a primitive collider (sphere recommended).
 *  - The travelling VFX (fireball trail/glow) lives as a CHILD entity under the
 *    root so it inherits the projectile transform and travels with the shot.
 *    Size it via VFX parameters (e.g. `global_scale`), not entity transform
 *    scale. The mesh/VFX child is shown/hidden by the replicated active state
 *    below.
 *
 * Networking: the controller spawns this networked + server-owned. Movement,
 * hit detection, and damage run on the owner only; visual state is replicated to
 * every client via {@link OnProjectileSetActiveEvent}; the impact VFX is spawned
 * networked so all players see it. Damage is therefore applied exactly once
 * (owner-side), never per-client.
 */
@component({
    description:
        'Straight-line fireball projectile that implements IActorProjectile for ActorProjectileAttackComponent (projectile mode). Aims at the target body center with optional lead, applies payload damage on a trigger hit (owner-only), replicates its visual state to all clients, and recycles into the controller pool instead of destroying. Root template needs a trigger PhysicsBodyComponent + collider; put the travelling VFX as a child entity (size via VFX params, not transform scale).',
})
export class FireballProjectile extends Component implements IActorProjectile {
    @property()
    @editor({description: 'Projectile travel speed in meters per second. Tunneling caveat: movement is a per-frame kinematic step (speed x frameTime) detected by the trigger volume, so a step larger than the target collider can pass through between frames without firing OnTriggerEnter. Keep speed x (1/minFrameRate) below the smallest target collider radius (e.g. <= ~12 m/s for a 0.4 m target at 30 Hz) — or enlarge the projectile/target trigger — for reliable hits on thin or fast targets.'})
    projectileSpeed: number = 18;

    @property()
    @editor({description: 'Maximum lifetime in seconds before the projectile recycles without hitting anything.'})
    projectileLifetime: number = 3;

    @property()
    @editor({description: 'Meters added to the target anchor so the shot aims at the BODY CENTER, not the feet. A character anchor sits at the feet; aiming there flies low and misses. The 0.9 default is tuned for a HUMANOID-on-flat-ground target — retune per target (e.g. ~0 for a low/flying creature, higher for a tall boss), or aim at an `AimPoint` child entity. NOTE: only this projectile lifts by `targetAimHeight`; the controller orients the initial spawn at the un-lifted target, so this `fire()` is the authority on final aim.'})
    targetAimHeight: number = 0.9;

    @property()
    @editor({description: 'Optional VFX template spawned (networked, so all players see it) at the hit position when the projectile hits its target.'})
    onHitVfx: TemplateAsset | null = null;

    @property()
    @editor({description: 'Seconds before a spawned hit-VFX entity self-destroys. Keep short to avoid leaking networked entities.'})
    onHitVfxLifetime: number = 2;

    @property()
    @editor({description: 'Entity holding the projectile MeshComponent (the visible bolt/fireball). If null, falls back to this script\'s entity.'})
    visuals: Entity | null = null;

    /**
     * Owner-only gate for {@link onUpdate} (movement) and {@link onTriggerEnter}
     * (hit). NOT replicated — clients receive active-state changes via
     * {@link OnProjectileSetActiveEvent} and update their local mesh in
     * {@link onSetActiveEvent}.
     */
    private isActive: boolean = false;

    private direction: Vec3 = Vec3.zero;
    private spawnTime: number = 0;
    private hasHit: boolean = false;
    private currentPayload: IActorAttackPayload | null = null;

    private hitListeners: ActorProjectileHitCallback[] = [];

    // In-flight hit-VFX self-destroy timers, cancelled on entity destroy so a
    // pool-teardown mid-flight does not leave timers firing into a dead closure.
    private pendingVfxTimers: Set<number> = new Set();

    // ── IActorProjectile ────────────────────────────────────────────────

    fire(payload: IActorAttackPayload): void {
        const myTransform = this.entity.getComponent(TransformComponent);
        // Guard `payload.target` even though the interface types it non-null: the
        // controller fires a pooled projectile after an animation delay, by which
        // point the target may have been destroyed. Any early-return MUST recycle
        // the pool slot (setActive(false)) — the controller already advanced its
        // round-robin index, so leaving the slot parked-but-acquired silently
        // drops the next shot.
        const targetTransform = payload.target?.getComponent(TransformComponent);
        if (!payload.target || !myTransform || !targetTransform) {
            console.warn(
                '[FireballProjectile] fire() aborted: target/transform missing; recycling pool slot.',
            );
            this.setActive(false);
            return;
        }

        // Aim at the target BODY CENTER, not its raw anchor (which sits at the
        // feet for a character). Lift the aim by ~the target half-height.
        const aimPoint = targetTransform.worldPosition.add(
            new Vec3(0, this.targetAimHeight, 0),
        );

        // Lead a moving target when its velocity is known. Two-step refinement,
        // matching the controller's computeLeadAimDirection: estimate flight time
        // from the straight-line distance, then refine once against the predicted
        // intercept so projectile and controller size the lead identically.
        const speed = this.projectileSpeed;
        const targetVelocity = payload.targetVelocity;
        let leadAimPoint = aimPoint;
        if (targetVelocity && speed > 0) {
            let leadTime = aimPoint.sub(myTransform.worldPosition).magnitude() / speed;
            const firstGuess = aimPoint.add(targetVelocity.mul(leadTime));
            leadTime = firstGuess.sub(myTransform.worldPosition).magnitude() / speed;
            leadAimPoint = aimPoint.add(targetVelocity.mul(leadTime));
        }

        const toTarget = leadAimPoint.sub(myTransform.worldPosition);
        if (toTarget.magnitudeSquared() < 0.0001) {
            console.warn(
                '[FireballProjectile] fire() aborted: degenerate aim direction; recycling pool slot.',
            );
            this.setActive(false);
            return;
        }
        this.direction = toTarget.normalize();

        this.currentPayload = payload;
        this.spawnTime = WorldService.get().getWorldTime();
        this.hasHit = false;
        this.setActive(true);
    }

    /**
     * Subscribe to hit events. CONTRACT: listeners fire ONLY on a real hit (see
     * {@link applyHit}). A missed or lifetime-expired shot recycles WITHOUT
     * invoking `onHit` — drive any per-shot/miss cleanup from a separate signal.
     */
    onHit(callback: ActorProjectileHitCallback): () => void {
        this.hitListeners.push(callback);
        return () => {
            this.hitListeners = this.hitListeners.filter(c => c !== callback);
        };
    }

    getSpeed(): number {
        return this.projectileSpeed;
    }

    // ── Pool recycle / active state ─────────────────────────────────────

    /**
     * Activates / deactivates the projectile. Owner-side it flips the
     * movement+hit gate and the trigger collider directly (owner-restricted
     * properties), then broadcasts so every client toggles its own local mesh.
     * Recycle calls `setActive(false)` — NEVER `entity.destroy()`, which would
     * remove the projectile from the controller's index-reused pool.
     *
     * Owner-only: it writes the owner-restricted `collisionEnabled` and broadcasts
     * the active-state event (the broadcast must originate from the single
     * authority). All callers are already owner-gated; the guard locks the
     * contract so a copied derivative cannot regress it.
     */
    private setActive(active: boolean): void {
        if (!this.entity.isOwned()) {
            return;
        }
        this.isActive = active;
        this.applyPhysicsState(active);
        if (!active) {
            // Scrub per-shot state on recycle so a parked pooled instance does not
            // pin the previous target Entity, and a re-fire starts clean.
            this.currentPayload = null;
            this.hasHit = false;
            this.direction = Vec3.zero;
        }
        EventService.sendToEveryone(OnProjectileSetActiveEvent, {active}, this.entity);
    }

    @subscribe(OnEntityCreateEvent, {execution: ExecuteOn.Everywhere})
    onCreate() {
        // Pooled projectiles are pre-spawned parked off-screen and only made
        // visible on fire(). The controller hides the mesh owner-side at spawn,
        // but that write does not reach remote clients — so without this every
        // parked pool entity would render on remote clients until its first fire.
        // Hide locally on every client at create; the replicated active-state
        // event reveals it on fire.
        this.applyMeshState(false);
    }

    @subscribe(OnEntityDestroyEvent)
    onDestroy() {
        // Cancel any in-flight hit-VFX self-destroy timers so they do not fire
        // after this projectile (and its closures) are gone at pool teardown.
        for (const timerId of this.pendingVfxTimers) {
            clearTimeout(timerId);
        }
        this.pendingVfxTimers.clear();
    }

    @subscribe(OnProjectileSetActiveEvent, {execution: ExecuteOn.Everywhere})
    onSetActiveEvent(payload: ProjectileSetActiveEventPayload) {
        this.applyMeshState(payload.active);
    }

    @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Owner})
    onUpdate(params: OnWorldUpdateEventPayload) {
        if (!this.isActive) {
            return;
        }

        if (WorldService.get().getWorldTime() - this.spawnTime >= this.projectileLifetime) {
            this.setActive(false);
            return;
        }

        const transform = this.entity.getComponent(TransformComponent);
        if (!transform) {
            return;
        }
        const step = this.direction.mul(this.projectileSpeed * params.deltaTime);
        transform.worldPosition = transform.worldPosition.add(step);
    }

    // ── Hit detection + damage (owner-only) ─────────────────────────────

    @subscribe(OnTriggerEnterEvent, {execution: ExecuteOn.Owner})
    onTriggerEnter(payload: OnTriggerEnterEventPayload) {
        if (!this.isActive || this.hasHit || !this.currentPayload) {
            return;
        }

        const hitEntity = payload.actorEntity;
        // Only the entity this shot was fired at (or a child collider of it)
        // counts — ignore walls, the caster, and other actors.
        if (!hitEntity || !this.isEntityOrParent(hitEntity, this.currentPayload.target)) {
            return;
        }

        this.hasHit = true;
        this.applyHit(this.currentPayload.target);
        this.setActive(false);
    }

    private applyHit(targetRoot: Entity): void {
        const damage = this.currentPayload?.damage ?? 0;
        const health = this.tryGetHealthComponent(targetRoot);
        if (health && damage > 0) {
            health.takeDamage(damage);
        }

        if (this.onHitVfx) {
            const hitPos =
                targetRoot.getComponent(TransformComponent)?.worldPosition ??
                this.entity.getComponent(TransformComponent)?.worldPosition ??
                Vec3.zero;
            // Networked so every player sees the impact, then self-destroy so the
            // hit VFX does not leak as a permanent networked entity.
            void WorldService.get()
                .spawnTemplate({
                    templateAsset: this.onHitVfx,
                    networkMode: NetworkMode.Networked,
                    position: hitPos,
                    rotation: Quaternion.identity,
                })
                .then((vfx: Entity) => {
                    // If the projectile entity was destroyed (pool teardown) while
                    // the spawn was in flight, onDestroy already cleared the timer
                    // set — drop the orphaned VFX and don't schedule a new timer.
                    // Check isDestroyed(), NOT isActive: a normal hit calls
                    // setActive(false) synchronously right after applyHit(), so by
                    // the time this microtask runs isActive is already false and an
                    // !isActive guard would destroy the impact VFX on every hit.
                    if (this.entity.isDestroyed()) {
                        if (vfx && !vfx.isDestroyed()) {
                            vfx.destroy();
                        }
                        return;
                    }
                    const timerId = setTimeout(() => {
                        this.pendingVfxTimers.delete(timerId);
                        if (vfx && !vfx.isDestroyed()) {
                            vfx.destroy();
                        }
                    }, this.onHitVfxLifetime * 1000);
                    this.pendingVfxTimers.add(timerId);
                })
                .catch((err: unknown) => {
                    // A misconfigured onHitVfx asset must not surface as an
                    // unhandled rejection on every hit.
                    console.warn(
                        `[FireballProjectile] hit VFX spawn failed: ${String(err)}`,
                    );
                });
        }

        for (const listener of this.hitListeners) {
            listener({hitEntity: targetRoot});
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    /**
     * Walks up the parent chain so a collision reported against a child collider
     * (e.g. the target's "Collider" child) still resolves to the target root.
     */
    private isEntityOrParent(entity: Entity, target: Maybe<Entity>): boolean {
        if (!target) {
            return false;
        }
        let current: Entity | null = entity;
        while (current) {
            if (current === target) {
                return true;
            }
            current = current.parent;
        }
        return false;
    }

    private tryGetHealthComponent(entity: Entity): GameplayHealthComponent | null {
        // Recurse (second arg `true`): real character rigs nest the health
        // component deeper than a direct child, so a shallow lookup would silently
        // skip damage. Matches the canonical CharacterController lookup.
        return (
            entity.getComponent(GameplayHealthComponent) ??
            entity.getChildrenWithComponent(GameplayHealthComponent, true)[0]?.getComponent(
                GameplayHealthComponent,
            ) ??
            null
        );
    }

    /**
     * Shows/hides the projectile's visible representation locally on every
     * client. A fireball's body is usually a child VfxComponent, and
     * MeshComponent.isVisibleSelf does NOT affect VFX particles — toggling only
     * the mesh leaves a recycled projectile emitting at its last impact
     * position until the pool slot is re-fired. So also drive each child VFX via
     * play()/stop() (matching the no-autoPlay guidance). Deliberately does NOT
     * write visuals.enabledSelf: enabledSelf is a permission-gated replicated
     * property and this runs on the Everywhere handler, where a non-owner write
     * would error.
     */
    private applyMeshState(active: boolean): void {
        const mesh = (this.visuals ?? this.entity).getComponent(MeshComponent);
        if (mesh) {
            mesh.isVisibleSelf = active;
        }

        for (const vfxChild of this.entity.getChildrenWithComponent(VfxComponent, true)) {
            const vfx = vfxChild.getComponent(VfxComponent);
            if (active) {
                vfx?.play();
            } else {
                vfx?.stop();
            }
        }
    }

    /** Toggles the trigger collider — owner-only (collisionEnabled is owner-restricted). */
    private applyPhysicsState(active: boolean): void {
        const physics = this.entity.getComponent(PhysicsBodyComponent);
        if (physics) {
            physics.collisionEnabled = active;
        }
    }
}
