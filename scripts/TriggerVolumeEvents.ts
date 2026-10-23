import {
  NetworkEvent,
  serializable,
  property,
} from 'meta/worlds';
import type { Entity, Maybe } from 'meta/worlds';

/**
 * Payload for the TriggerVolumeEnterEvent containing the entity that entered the trigger.
 *
 * This is defined in a separate file to avoid circular dependencies between
 * TriggerVolumeDetection and TriggerVolume scripts.
 */
@serializable()
export class TriggerVolumeEnterPayload {
  @property()
  public readonly targetEntity: Maybe<Entity> = null;
}

/**
 * Network event fired when an entity enters a trigger volume.
 * Sent from the detecting entity to the trigger volume entity.
 *
 * The detecting entity can be any client-authoritative entity
 * that has a TriggerVolumeDetection subclass attached.
 *
 * This is defined in a separate file to avoid circular dependencies between
 * TriggerVolumeDetection and TriggerVolume scripts.
 */
export const TriggerVolumeEnterEvent = new NetworkEvent(
  'TriggerVolumeEnterEvent', TriggerVolumeEnterPayload
);
