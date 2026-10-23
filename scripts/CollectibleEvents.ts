import {
  LocalEvent,
  NetworkEvent,
  property,
  serializable,
} from 'meta/worlds';
import type {Entity, Maybe} from 'meta/worlds';

export const REQUEST_COLLECT_PHASE_REQUEST = 0;
export const REQUEST_COLLECT_PHASE_ACCEPTED = 1;
export const REQUEST_COLLECT_PHASE_ACKNOWLEDGED = 2;

/**
 * Correlates a client request with the owner's accepted verdict.
 *
 * Request and acknowledged phases are sent to the collectible owner. Accepted
 * phase is sent by the owner to every proxy of the collectible. Local-only
 * collectibles deliver all phases through local event delivery.
 */
@serializable()
export class RequestCollectPayload {
  @property()
  public readonly phase: number = REQUEST_COLLECT_PHASE_REQUEST;

  @property()
  public readonly collector: Maybe<Entity> = null;

  @property()
  public readonly attemptId: number = 0;

  @property()
  public readonly deferredHandler: boolean = false;
}

export const RequestCollectEvent = new NetworkEvent(
  'RequestCollectEvent',
  RequestCollectPayload,
);

/**
 * Correlates a rejected collection with the client that predicted it.
 *
 * Null collector plus attempt ID zero is reserved for legacy deferred handlers
 * that cannot yet propagate correlation data.
 */
@serializable()
export class RestoreCollectiblePayload {
  @property()
  public readonly collector: Maybe<Entity> = null;

  @property()
  public readonly attemptId: number = 0;

  @property()
  public readonly restored: boolean = true;
}

/**
 * Owner verdict that leaves the collectible available for another attempt.
 * The event is broadcast to every proxy; only the matching requester restores
 * its local cosmetic prediction.
 */
export const RestoreCollectibleEvent = new NetworkEvent(
  'RestoreCollectibleEvent',
  RestoreCollectiblePayload,
);

/**
 * Payload for the deferred-handler release path.
 *
 * Carries the collectible source entity whose authoritative claim must be
 * released on the owner after a deferred handler (e.g. the inventory bridge)
 * rejects its post-accept work. Sent server-locally via
 * `EventService.sendLocally` — only the owner's own Collectible releases its
 * claim; the networked `RestoreCollectibleEvent` broadcast separately restores
 * the requester's cosmetic prediction.
 */
@serializable()
export class ReleaseDeferredCollectiblePayload {
  @property()
  public readonly source: Maybe<Entity> = null;
}

/**
 * Server-local release for a deferred collection claim.
 *
 * A handler that overrode `deferDestroyToHandler()` sends this locally on the
 * server when its work is refused, so the owner's `Collectible` releases the
 * authoritative claim and the item becomes collectable again. A `LocalEvent`
 * because it never crosses the network: only the server-owned Collectible
 * needs to mutate its owner state.
 */
export const ReleaseDeferredCollectibleEvent = new LocalEvent(
  'ReleaseDeferredCollectibleEvent',
  ReleaseDeferredCollectiblePayload,
);
