// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import type {Entity} from 'meta/worlds';
import type {IActorAttackPayload} from './IActorAttackController';

export interface IActorProjectileHitPayload {
    /** The entity that was hit by the projectile. */
    hitEntity: Entity;
}

export type ActorProjectileHitCallback = (payload: IActorProjectileHitPayload) => void;

/**
 * Interface for projectile entities that can be fired by an attack controller.
 *
 * Implement this on a Component attached to a projectile template.
 * The attack controller calls {@link fire} to launch the projectile and
 * subscribes to {@link onHit} to be notified when the projectile collides
 * with an entity.
 *
 * NETWORKING: pooled projectiles are spawned networked and server-owned, so
 * movement, hit detection, and damage must run on the OWNER only
 * (`ExecuteOn.Owner`) — applying damage per-client multi-counts it. Replicate
 * VISUAL state (mesh on/off) by broadcasting a `NetworkEvent` from the owner
 * and toggling `MeshComponent.isVisibleSelf` in an `ExecuteOn.Everywhere`
 * handler so each client updates its own local view; a non-owner write to a
 * networked entity's property throws "entity not owned". Broadcast impact VFX
 * to all clients (a `NetworkMode.LocalOnly` impact spawned on the owner is
 * invisible to remote players). See the bundled `FireballProjectile` reference.
 */
export interface IActorProjectile {
    /**
     * Launch the projectile toward {@link IActorAttackPayload.target}.
     *
     * REQUIRED — derive the direction from the target, not the projectile's own
     * rotation. A spawned projectile faces the caster, so velocity from
     * `worldForward`/`worldRotation` flies where the caster faces (flat and
     * stale) and misses on any height difference or mid-turn.
     *
     * REQUIRED — aim at the target's BODY CENTER, not its raw anchor. A
     * character's `worldPosition` is its origin, which sits at the FEET; aiming
     * there flies low and misses. Lift the aim by ~the target's half-height (a
     * configured `targetAimHeight`, or an `AimPoint` child entity when present).
     *
     * OPTIONAL — lead a moving target: when `payload.targetVelocity` is set,
     * shift the aim point by `targetVelocity * (distance / speed)`. Implement
     * {@link getSpeed} to return the same speed so the firing controller's lead
     * sizing matches.
     *
     *     const targetT = payload.target.getComponent(TransformComponent);
     *     const aimPoint = targetT.worldPosition.add(new Vec3(0, this.targetAimHeight, 0));
     *     const flightTime = aimPoint.sub(this.transform.worldPosition).magnitude() / this.speed;
     *     const lead = payload.targetVelocity ? payload.targetVelocity.mul(flightTime) : Vec3.zero;
     *     const dir = aimPoint.add(lead).sub(this.transform.worldPosition).normalize();
     *     physicsBody.linearVelocity = dir.mul(this.speed); // full 3D aim
     *
     *     // WRONG — aims at the feet anchor and never leads:
     *     // const dir = targetT.worldPosition.sub(this.transform.worldPosition).normalize();
     *     // WRONG — ignores payload.target, flies along caster facing:
     *     // physicsBody.linearVelocity = this.transform.worldForward.mul(speed);
     */
    fire(payload: IActorAttackPayload): void;

    /**
     * Subscribe to hit events. The callback is invoked when the projectile
     * collides with or reaches an entity.
     *
     * @returns An unsubscribe function to remove the listener.
     */
    onHit(callback: ActorProjectileHitCallback): () => void;

    /**
     * Optional. Returns the projectile's travel speed in meters/second.
     *
     * A firing controller uses this to size the lead when aiming at a moving
     * target (lead time ≈ distance ÷ speed). Implement it to return the same
     * speed your `fire()` applies to the projectile. When omitted, the
     * controller falls back to a fixed short lead horizon, which is less
     * accurate at long range or for fast/slow projectiles.
     *
     * @returns The projectile speed in meters/second.
     */
    getSpeed?(): number;
}
