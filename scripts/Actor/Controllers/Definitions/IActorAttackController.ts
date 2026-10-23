// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import type { Entity, Vec3 } from "meta/worlds";
import type { ActorController } from "meta/worlds";

export interface IActorAttackPayload {
    target: Entity;
    damage: number | undefined;
    attackRange: number | undefined;
    /**
     * Smoothed world-space velocity of the target (meters/second) sampled when
     * the attack is issued, or `null`/`undefined` when unknown.
     *
     * A ranged controller uses this to lead a moving target — aiming at where
     * the target will be rather than where it is now. When absent (or zero) the
     * controller fires straight at the target's current position.
     */
    targetVelocity?: Vec3 | null;
}

export interface IActorAttackController extends ActorController {
    attack(payload: IActorAttackPayload): void;
    canAttack(): boolean;
}

export const IActorAttackControllerTypeId = 'IActorAttackController';
