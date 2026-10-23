// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import { ActorBlackboard } from 'meta/worlds';
import type { Entity } from 'meta/worlds';

/**
 * Combat target data structure containing entity and status information.
 */
export interface CombatTarget {
    /**
     * The target entity.
     */
    entity: Entity;

    /**
     * Whether the target is dead.
     * Can be set to true to indicate the target is dead but still in the list.
     */
    isDead: boolean;
}

/**
 * Data structure for combat-related information.
 * Contains entities that are valid targets for combat behaviors.
 */
export interface CombatBlackboardData {
    /**
     * List of combat targets with their status.
     * Updated by external detection systems, read by combat behaviors.
     */
    validTargets: CombatTarget[];
}

/**
 * Combat blackboard for managing shared combat target information.
 *
 * External systems (like enemy detection, threat assessment) write target data.
 * Combat behaviors read this data to select and engage targets.
 *
 * Can be used at different scopes:
 * - Global: Shared targets for all Actors
 * - Group: Faction/team-specific targets
 * - Individual: Actor-specific target overrides
 *
 * @example
 * ```typescript
 * // External system registers targets
 * const combatBB = blackboardManager.getBlackboard(
 *   CombatBlackboard,
 *   undefined,
 *   factionId,
 *   BlackboardScope.Group
 * );
 * combatBB?.addTarget(enemyEntity);
 *
 * // Behavior reads targets
 * const combatBB = blackboardManager.getBlackboard(
 *   CombatBlackboard,
 *   actorId,
 *   factionId
 * );
 * const targets = combatBB?.getValidTargets();
 * ```
 */
export class CombatBlackboard extends ActorBlackboard<CombatBlackboardData> {
    constructor() {
        super({
            validTargets: [],
        });
    }

    /**
     * Returns the unique type identifier for this blackboard.
     */
    getTypeName(): string {
        return 'CombatBlackboard';
    }

    /**
     * Adds a target to the valid targets list.
     * Prevents duplicate entries.
     *
     * @param target - Entity to add as a valid combat target
     */
    addTarget(target: Entity): void {
        const existingTarget = this.data.validTargets.find(t => t.entity === target);
        if (!existingTarget) {
            this.data.validTargets.push({
                entity: target,
                isDead: false,
            });
        }
    }

    /**
     * Removes a target from the valid targets list.
     *
     * @param target - Entity to remove from combat targets
     */
    removeTarget(target: Entity): void {
        this.data.validTargets = this.data.validTargets.filter(t => t.entity !== target);
    }

    /**
     * Updates target data with new information.
     *
     * @param target - Entity to update
     * @param data - Partial data to update (only provided fields will be updated)
     * @param addIfNotExists - If true, adds the target if it doesn't exist. Defaults to false.
     */
    updateTarget(target: Entity, data: Partial<Omit<CombatTarget, 'entity'>>, addIfNotExists: boolean = false): void {
        const existingTarget = this.data.validTargets.find(t => t.entity === target);
        if (existingTarget) {
            Object.assign(existingTarget, data);
        } else if (addIfNotExists) {
            this.data.validTargets.push({
                entity: target,
                isDead: data.isDead ?? false,
            });
        }
    }

    /**
     * Gets all valid combat targets (including their status).
     *
     * @returns Array of combat targets
     */
    getValidTargets(): CombatTarget[] {
        return this.data.validTargets;
    }

    /**
     * Gets all target entities (without status information).
     * Useful for backward compatibility.
     *
     * @returns Array of target entities
     */
    getValidTargetEntities(): Entity[] {
        return this.data.validTargets.map(t => t.entity);
    }

    /**
     * Gets all alive target entities.
     *
     * @returns Array of alive target entities
     */
    getAliveTargets(): Entity[] {
        return this.data.validTargets.filter(t => !t.isDead).map(t => t.entity);
    }

    /**
     * Gets the first valid target (primary target).
     *
     * @returns The first target, or undefined if no targets exist
     */
    getPrimaryTarget(): CombatTarget | undefined {
        return this.data.validTargets[0];
    }

    /**
     * Gets the first alive target.
     *
     * @returns The first alive target entity, or undefined if no alive targets exist
     */
    getPrimaryAliveTarget(): Entity | undefined {
        const aliveTarget = this.data.validTargets.find(t => !t.isDead);
        return aliveTarget?.entity;
    }

    /**
     * Checks if there are any valid targets.
     *
     * @returns True if at least one valid target exists
     */
    hasValidTargets(): boolean {
        return this.data.validTargets.length > 0;
    }

    /**
     * Gets the number of valid targets.
     *
     * @returns Count of valid targets
     */
    getTargetCount(): number {
        return this.data.validTargets.length;
    }

    /**
     * Clears all valid targets.
     */
    clearTargets(): void {
        this.data.validTargets = [];
    }

    /**
     * Checks if a specific entity is a valid target.
     *
     * @param target - Entity to check
     * @returns True if the entity is in the valid targets list
     */
    isValidTarget(target: Entity): boolean {
        return this.data.validTargets.some(t => t.entity === target);
    }

    /**
     * Lifecycle hook: called when blackboard is registered.
     */
    override onRegister(): void {
        console.log(`CombatBlackboard registered at ${this.getScopeId() ?? 'unknown'} (scope: ${this.getScope() ?? 'unknown'})`); // logspam-ignore
    }

    /**
     * Lifecycle hook: called when blackboard is unregistered.
     * Clears all targets on cleanup.
     */
    override onUnregister(): void {
        this.clearTargets();
        console.log(`CombatBlackboard unregistered from ${this.getScopeId() ?? 'unknown'}`); // logspam-ignore
    }
}
