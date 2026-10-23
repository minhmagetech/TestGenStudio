import {
  component,
  Component,
  subscribe,
  OnEntityStartEvent,
  ExecuteOn,
} from 'meta/worlds';
import type { Entity } from 'meta/worlds';
import { TriggerVolumeEnterEvent, TriggerVolumeEnterPayload } from './TriggerVolumeEvents';

/**
 * Base class for trigger volumes that respond to entity entry.
 *
 * Listens for TriggerVolumeEnterEvent sent by a TriggerVolumeDetection subclass
 * on the detecting entity. Subclasses should override `onEntityEntered()` to
 * implement custom trigger behavior.
 *
 * Component Attachment: Root entity of trigger volume template
 * Component Networking: Networked (server-owned)
 * Component Ownership: Server
 *
 * How it works:
 * 1. A detecting entity (player, pet, NPC, etc.) has a TriggerVolumeDetection subclass attached
 * 2. That entity enters this trigger volume's collider
 * 3. The detection script sends TriggerVolumeEnterEvent TO this entity
 * 4. This script receives the event and calls onEntityEntered()
 *
 * Setup:
 * 1. Create trigger volume template with this script (or subclass) on root
 * 2. Add PhysicsBodyComponent (type: Trigger) to root
 * 3. Add Collider child with ColliderBoxComponent or ColliderSphereComponent
 * 4. Ensure detecting entities have a TriggerVolumeDetection subclass attached
 */
@component()
export class TriggerVolume extends Component {
  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart() {
    // Initialize component
  }

  @subscribe(TriggerVolumeEnterEvent, {execution: ExecuteOn.Owner})
  onTriggerVolumeEnter(payload: TriggerVolumeEnterPayload) {
    const otherEntity = payload.targetEntity;
    if (!otherEntity) return;

    if (!this.isValidTarget(otherEntity)) return;

    this.onEntityEntered(otherEntity);
  }

  // =============================================================================
  // OVERRIDE THESE METHODS - Customize trigger behavior
  // =============================================================================

  /**
   * Determine if an entity is a valid target for this trigger volume.
   *
   * @param entity - The entity that entered the trigger volume
   * @returns true if the entity should trigger this volume
   */
  protected isValidTarget(entity: Entity): boolean {
    return true;
  }

  /**
   * Called when a valid entity enters the trigger volume.
   *
   * OVERRIDE THIS METHOD to implement your trigger behavior.
   *
   * @param entity - The entity that entered the volume
   */
  protected onEntityEntered(entity: Entity): void {
    console.log(`[TriggerVolume] Entity entered: ${entity.name}`);
  }
}
