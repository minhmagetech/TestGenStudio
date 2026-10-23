import {
  component,
  Component,
  subscribe,
  OnTriggerEnterEvent,
  OnTriggerEnterEventPayload,
  ExecuteOn,
} from 'meta/worlds';
import type { Entity } from 'meta/worlds';
import { TriggerVolumeEnterEvent } from './TriggerVolumeEvents';

/**
 * Client-authoritative trigger volume detection.
 *
 * Attach to any client-authoritative entity that should detect trigger volumes
 * (e.g., player, pet, NPC, vehicle). When the entity enters a trigger volume,
 * sends a TriggerVolumeEnterEvent to the trigger volume entity for processing.
 *
 * Component Attachment: The entity that owns the `PhysicsBodyComponent` on the
 *   detecting template. This is usually the root, but NOT always — see warning
 *   below.
 * Component Networking: Networked
 * Component Ownership: Player client owned
 *
 * ⚠️ CRITICAL — Attach to the PhysicsBodyComponent host, not the root.
 * `OnTriggerEnterEvent` has `ListenerTarget.Entity` and fires only on the
 * entity that owns the `PhysicsBodyComponent`. It does NOT bubble up to
 * ancestors. If the detecting template puts physics on a sub-entity (e.g.,
 * `Base_AI_Template/Templates/PlayerCharacter.hstf` → `KinematicCharacter`
 * child), attach this script to that sub-entity, not the root. Inspect with
 * `get_scene_hierarchy` before attaching.
 *
 * Why attach to the detecting entity?
 * - Client-authoritative entities detect collisions immediately on their owning client
 * - Better responsiveness with no network latency for collision detection
 * - The detecting entity is the one that "enters" the trigger volume
 *
 * Examples:
 * - Player entering a death pit → attach to the player's PhysicsBody-host entity
 * - Pet entering a feeding zone → attach to the pet's PhysicsBody-host entity
 * - NPC entering a patrol boundary → attach to the NPC's PhysicsBody-host entity
 *
 * Setup:
 * 1. Create a subclass and attach it to the PhysicsBody-host entity of your
 *    detecting template (verify with `get_scene_hierarchy`)
 * 2. Ensure trigger volume entities have PhysicsBodyComponent (type: Trigger)
 * 3. Ensure trigger volume entities have the TriggerVolume script attached
 * 4. Ensure the detecting template has `Networkable = true` if you plan to
 *    cross tiers via `@rpc` or `sendEventToOwner` from the trigger handler
 */
@component()
export class TriggerVolumeDetection extends Component {
  @subscribe(OnTriggerEnterEvent, {execution: ExecuteOn.Owner})
  onTriggerEnter(payload: OnTriggerEnterEventPayload) {
    // payload.triggerEntity is the trigger entity we entered (the trigger volume).
    // IMPORTANT: This may be a child entity (e.g., the physics collider) rather
    // than the root entity with the TriggerVolume script. Walk up ancestors to
    // find the actual trigger volume entity.
    const triggerEntity = payload.triggerEntity;
    if (!triggerEntity) return;

    const triggerVolumeEntity = this.resolveTriggerVolume(triggerEntity);
    if (!triggerVolumeEntity) return;

    // Send network event TO the trigger volume entity, identifying this entity as the one that entered
    triggerVolumeEntity.sendEventToOwner(TriggerVolumeEnterEvent, {
      targetEntity: this.entity,
    });
  }

  /**
   * Resolves the actual trigger volume entity from a trigger entity.
   *
   * The trigger entity may be a child (e.g., a physics collider child).
   * This method checks the entity itself first, then walks up ancestors
   * to find an entity that passes isValidTriggerVolume().
   */
  private resolveTriggerVolume(triggerEntity: Entity): Entity | null {
    if (this.isValidTriggerVolume(triggerEntity)) {
      return triggerEntity;
    }

    for (const ancestor of triggerEntity.getAncestors()) {
      if (this.isValidTriggerVolume(ancestor)) {
        return ancestor;
      }
    }

    return null;
  }

  // =============================================================================
  // OVERRIDE THESE METHODS - Customize detection behavior
  // =============================================================================

  /**
   * Determine if an entity is a valid trigger volume to react to.
   *
   * Override to filter which trigger entities should be processed.
   *
   * @param entity - The trigger entity that was entered
   * @returns true if this trigger should be processed
   */
  protected isValidTriggerVolume(entity: Entity): boolean {
    return true;
  }
}
