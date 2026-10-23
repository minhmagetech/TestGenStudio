import {
  BasePlayerComponent,
  Component,
  component,
  EventService,
  ExecuteOn,
  OnEntityDestroyEvent,
  OnEntityStartEvent,
  OnPlayerDestroyEvent,
  OnTriggerEnterEvent,
  PlayerService,
  property,
  subscribe,
  TransformComponent,
} from 'meta/worlds';
import type {
  Entity,
  Maybe,
  OnPlayerDestroyEventPayload,
  OnTriggerEnterEventPayload,
} from 'meta/worlds';
import {
  REQUEST_COLLECT_PHASE_ACCEPTED,
  REQUEST_COLLECT_PHASE_ACKNOWLEDGED,
  REQUEST_COLLECT_PHASE_REQUEST,
  ReleaseDeferredCollectibleEvent,
  ReleaseDeferredCollectiblePayload,
  RequestCollectEvent,
  RequestCollectPayload,
  RestoreCollectibleEvent,
  RestoreCollectiblePayload,
} from './CollectibleEvents';

interface EnabledSnapshot {
  readonly entity: Entity;
  readonly enabledSelf: boolean;
}

interface LocalPrediction {
  readonly cosmetic: EnabledSnapshot | null;
  readonly trigger: EnabledSnapshot | null;
}

interface PendingCollectionAttempt {
  readonly collector: Entity;
  readonly attemptId: number;
  readonly prediction: LocalPrediction | null;
  accepted: boolean;
  timeout: ReturnType<typeof setTimeout> | null;
}

const OWNER_STATE_AVAILABLE = 0;
const OWNER_STATE_COMMITTING = 1;
const OWNER_STATE_ACCEPTED = 2;
const MAX_ATTEMPT_ID = 2147483647;
const DEFERRED_HANDLER_START_TIMEOUT_MS = 5000;

/**
 * Trigger-based collectible with local prediction and an owner-authoritative
 * collection verdict.
 *
 * Attach this component to a dynamically spawned root. The verdict is issued
 * by the collectible owner: the server for networked items, the local client
 * for non-networked items. Assign a non-networked child
 * containing only presentation to cosmeticRoot, and optionally a
 * non-networked child holding the trigger collider to triggerRoot. The
 * networked root itself always stays enabled so verdict events keep arriving.
 */
@component()
export class Collectible extends Component {
  /** Non-networked child containing meshes, highlights, and cosmetic VFX. */
  @property()
  cosmeticRoot: Maybe<Entity> = null;

  /**
   * Optional non-networked child holding the trigger collider. Local
   * prediction disables it until the verdict resolves so the item cannot
   * re-fire while awaiting the owner. Never assign the networked root or a
   * networked entity: disabling those replicates or suppresses verdict delivery.
   */
  @property()
  triggerRoot: Maybe<Entity> = null;

  /** Maximum owner-authoritative distance between collector and collectible. */
  @property()
  maximumCollectionDistance: number = 3;

  /** Maximum time a client keeps an unconfirmed cosmetic prediction hidden. */
  @property()
  verdictTimeoutSeconds: number = 5;

  protected transform: Maybe<TransformComponent> = null;

  private pendingAttempt: PendingCollectionAttempt | null = null;
  private expiredAttemptHighWatermark: number = 0;
  private nextAttemptId: number = 1;
  private warnedMissingCosmeticRoot: boolean = false;
  private warnedInvalidTriggerRoot: boolean = false;

  private ownerState: number = OWNER_STATE_AVAILABLE;
  private ownerCollectorKey: string = '';
  private ownerAttemptId: number = 0;
  private ownerUsesDeferredHandler: boolean = false;
  private ownerDeferredHandlerDispatched: boolean = false;
  private ownerDeferredHandlerTimeout: ReturnType<typeof setTimeout> | null = null;
  private ownerDestroyScheduled: boolean = false;
  private rejectedAttemptHighWatermark: Map<string, number> = new Map();

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart(): void {
    this.transform = this.entity.getComponent(TransformComponent);
  }

  @subscribe(OnEntityDestroyEvent, {execution: ExecuteOn.Everywhere})
  onDestroy(): void {
    this.cancelVerdictTimeout();
    this.cancelDeferredHandlerTimeout();
    this.pendingAttempt = null;
  }

  @subscribe(OnPlayerDestroyEvent, {execution: ExecuteOn.Everywhere})
  onPlayerDestroy(payload: OnPlayerDestroyEventPayload): void {
    if (!this.entity.isOwned()) return;
    if (
      this.ownerState !== OWNER_STATE_ACCEPTED ||
      payload.entity?.toString() !== this.ownerCollectorKey
    ) {
      return;
    }
    if (this.ownerUsesDeferredHandler) {
      if (!this.ownerDeferredHandlerDispatched) {
        this.rememberRejectedAttempt();
        this.releaseOwnerClaim();
      }
      return;
    }
    this.scheduleOwnerDestroy();
  }

  /**
   * Resolves trigger collider children to a player root and starts one local
   * attempt. The collectible owner always decides whether collection succeeds.
   */
  @subscribe(OnTriggerEnterEvent, {execution: ExecuteOn.Everywhere})
  onTriggerEnter(payload: OnTriggerEnterEventPayload): void {
    const actorEntity = payload.actorEntity;
    if (!actorEntity?.valid || this.pendingAttempt != null) return;

    const collector = this.resolveCollector(actorEntity);
    if (collector == null || !this.isValidCollector(collector)) return;
    if (!PlayerService.get().isLocalPlayer(collector)) return;

    // The owner already holds authority, so resolve locally without a request
    // round-trip. This covers non-networked collectibles and any item the
    // local client already owns.
    if (this.entity.isOwned()) {
      this.collectAsOwner(collector);
      return;
    }

    this.beginCollectionAttempt(collector);
  }

  /**
   * Resolves a collection locally on the owning client. Networked proxies
   * still route through beginCollectionAttempt so the owner issues the
   * broadcast verdict.
   */
  private collectAsOwner(collector: Entity): void {
    if (!this.entity.valid || this.entity.isDestroyed() || !this.entity.isOwned()) {
      return;
    }
    if (this.ownerState !== OWNER_STATE_AVAILABLE) return;
    if (!this.validateCollectionAsOwner(collector)) return;

    this.ownerState = OWNER_STATE_COMMITTING;
    this.ownerCollectorKey = collector.toString();
    this.ownerAttemptId = this.allocateAttemptId();

    let committed = false;
    try {
      committed = this.tryCommitCollectionAsOwner(collector);
    } catch (error) {
      console.error(`[Collectible] Authoritative collection commit failed: ${String(error)}`);
    }

    if (!committed) {
      this.releaseOwnerClaim();
      return;
    }

    try {
      this.ownerUsesDeferredHandler = this.deferDestroyToHandler();
    } catch (error) {
      console.error(`[Collectible] Deferred-handler policy failed: ${String(error)}`);
      this.ownerUsesDeferredHandler = false;
    }

    this.ownerState = OWNER_STATE_ACCEPTED;
    try {
      this.onCollected(collector);
    } catch (error) {
      console.error(`[Collectible] onCollected failed: ${String(error)}`);
    }
    if (!this.ownerUsesDeferredHandler) {
      this.scheduleOwnerDestroy();
    }
  }

  /**
   * Resolves the actual collector from a trigger actor. The actor may be a
   * collider child, while BasePlayerComponent lives on the player root.
   */
  protected resolveCollector(actorEntity: Entity): Entity | null {
    if (this.isPlayerCollector(actorEntity)) {
      return actorEntity;
    }

    for (const ancestor of actorEntity.getAncestors()) {
      if (this.isPlayerCollector(ancestor)) {
        return ancestor;
      }
    }

    return null;
  }

  /**
   * Defines additional collector restrictions. The base implementation accepts
   * player roots; owner validation always enforces BasePlayerComponent even if
   * an override omits that check.
   */
  protected isValidCollector(entity: Entity): boolean {
    return entity.getComponent(BasePlayerComponent) != null;
  }

  private isPlayerCollector(entity: Entity): boolean {
    return (
      entity.getComponent(BasePlayerComponent) != null &&
      this.isValidCollector(entity)
    );
  }

  /**
   * Applies requester-side feedback after the owner accepts collection.
   * Keep authoritative mutations in tryCommitCollectionAsOwner().
   */
  protected onCollected(_collector: Entity): void {}

  /**
   * Controls local prediction only. Returning false leaves cosmetics visible
   * and the trigger active while the request still goes to the owner for an
   * authoritative verdict.
   */
  protected canCollectLocally(_collector: Entity): boolean {
    return true;
  }

  /**
   * Performs collectible-specific authoritative work after base validation.
   * Runs on the collectible owner (server for networked items, local client
   * for non-networked items). Return false without committing side effects
   * to reject the collection.
   */
  protected tryCommitCollectionAsOwner(_collector: Entity): boolean {
    // Legacy overrides of tryCommitCollectionOnServer still apply.
    return this.tryCommitCollectionOnServer(_collector);
  }

  /**
   * @deprecated Override tryCommitCollectionAsOwner instead. Kept so existing
   * subclasses continue to work; the owner verdict calls through to it.
   */
  protected tryCommitCollectionOnServer(_collector: Entity): boolean {
    return true;
  }

  /**
   * Compatibility path for handlers that commit after base acceptance, such as
   * the current inventory bridge. The handler must destroy or restore the item.
   */
  protected deferDestroyToHandler(): boolean {
    return false;
  }

  private beginCollectionAttempt(collector: Entity): void {
    const attemptId = this.allocateAttemptId();
    const prediction = this.canCollectLocally(collector)
      ? this.applyLocalPrediction()
      : null;

    this.pendingAttempt = {
      collector,
      attemptId,
      prediction,
      accepted: false,
      timeout: null,
    };

    const timeoutMilliseconds = Math.max(0, this.verdictTimeoutSeconds) * 1000;
    if (timeoutMilliseconds > 0) {
      this.pendingAttempt.timeout = setTimeout(() => {
        const pending = this.pendingAttempt;
        if (pending == null || pending.attemptId !== attemptId || pending.accepted) {
          return;
        }
        this.restorePrediction(pending.prediction);
        this.expiredAttemptHighWatermark = Math.max(
          this.expiredAttemptHighWatermark,
          pending.attemptId,
        );
        this.pendingAttempt = null;
        console.warn('[Collectible] Collection verdict timed out; prediction restored');
      }, timeoutMilliseconds);
    }

    this.sendRequestToOwner({
      phase: REQUEST_COLLECT_PHASE_REQUEST,
      collector,
      attemptId,
      deferredHandler: false,
    });
  }

  private allocateAttemptId(): number {
    const attemptId = this.nextAttemptId;
    this.nextAttemptId = attemptId >= MAX_ATTEMPT_ID ? 1 : attemptId + 1;
    return attemptId;
  }

  /** Handles both the client request and the owner's accepted broadcast. */
  @subscribe(RequestCollectEvent, {execution: ExecuteOn.Everywhere})
  onRequestCollect(payload: RequestCollectPayload): void {
    if (payload.phase === REQUEST_COLLECT_PHASE_REQUEST) {
      this.handleRequestAsOwner(payload);
      return;
    }
    if (payload.phase === REQUEST_COLLECT_PHASE_ACKNOWLEDGED) {
      this.handleAcknowledgedAsOwner(payload);
      return;
    }
    if (payload.phase !== REQUEST_COLLECT_PHASE_ACCEPTED) return;

    this.handleAcceptedOnRequestingClient(payload);
  }

  private handleRequestAsOwner(payload: RequestCollectPayload): void {
    if (!this.entity.valid || this.entity.isDestroyed() || !this.entity.isOwned()) return;

    const collector = payload.collector;
    // An uncorrelatable request cannot receive a safe restore. In particular,
    // null + zero is reserved for legacy deferred-handler restoration.
    if (collector == null || payload.attemptId <= 0) return;

    const collectorKey = collector.toString();
    if (this.ownerState !== OWNER_STATE_AVAILABLE) {
      const matchesClaim =
        this.ownerCollectorKey === collectorKey &&
        this.ownerAttemptId === payload.attemptId;
      if (matchesClaim && this.ownerState === OWNER_STATE_ACCEPTED) {
        this.broadcastAccepted(payload);
      } else if (!matchesClaim) {
        this.rejectRequest(payload);
      }
      return;
    }

    const rejectedThrough = this.rejectedAttemptHighWatermark.get(collectorKey) ?? 0;
    if (payload.attemptId <= rejectedThrough) {
      this.rejectRequest(payload);
      return;
    }

    if (!this.validateCollectionAsOwner(collector)) {
      this.rejectRequest(payload);
      return;
    }

    this.ownerState = OWNER_STATE_COMMITTING;
    this.ownerCollectorKey = collectorKey;
    this.ownerAttemptId = payload.attemptId;

    let committed = false;
    try {
      committed = this.tryCommitCollectionAsOwner(collector);
    } catch (error) {
      console.error(`[Collectible] Authoritative collection commit failed: ${String(error)}`);
    }

    if (!committed) {
      this.releaseOwnerClaim();
      this.rejectRequest(payload);
      return;
    }

    try {
      this.ownerUsesDeferredHandler = this.deferDestroyToHandler();
    } catch (error) {
      // The authoritative commit already succeeded, so preserve that verdict and
      // fall back to base-owned destruction instead of reporting a false reject.
      console.error(`[Collectible] Deferred-handler policy failed: ${String(error)}`);
      this.ownerUsesDeferredHandler = false;
    }

    this.ownerState = OWNER_STATE_ACCEPTED;
    if (this.ownerUsesDeferredHandler) {
      this.ownerDeferredHandlerTimeout = setTimeout(() => {
        if (
          this.ownerState === OWNER_STATE_ACCEPTED &&
          !this.ownerDeferredHandlerDispatched
        ) {
          this.rememberRejectedAttempt();
          this.releaseOwnerClaim();
        }
      }, DEFERRED_HANDLER_START_TIMEOUT_MS);
    }
    this.broadcastAccepted(payload);
  }

  private validateCollectionAsOwner(collector: Entity): boolean {
    if (!collector.valid || collector.isDestroyed()) return false;
    if (collector.getComponent(BasePlayerComponent) == null) return false;
    if (!this.isValidCollector(collector)) return false;

    const collectibleTransform =
      this.transform ?? this.entity.getComponent(TransformComponent);
    const collectorTransform = collector.getComponent(TransformComponent);
    if (collectibleTransform == null || collectorTransform == null) return false;

    const maximumDistance = Math.max(0, this.maximumCollectionDistance);
    return collectibleTransform.worldPosition.distance(
      collectorTransform.worldPosition,
    ) <= maximumDistance;
  }

  private rejectRequest(payload: RequestCollectPayload): void {
    if (this.entity.isOwned() && payload.collector != null) {
      const collectorKey = payload.collector.toString();
      const rejectedThrough = this.rejectedAttemptHighWatermark.get(collectorKey) ?? 0;
      this.rejectedAttemptHighWatermark.set(
        collectorKey,
        Math.max(rejectedThrough, payload.attemptId),
      );
    }
    this.sendRestoreToEveryone({
      collector: payload.collector,
      attemptId: payload.attemptId,
      restored: true,
    });
  }

  private broadcastAccepted(payload: RequestCollectPayload): void {
    const accepted = {
      phase: REQUEST_COLLECT_PHASE_ACCEPTED,
      collector: payload.collector,
      attemptId: payload.attemptId,
      deferredHandler: this.ownerUsesDeferredHandler,
    };
    if (this.entity.networked) {
      EventService.sendToEveryone(RequestCollectEvent, accepted, this.entity);
      return;
    }
    EventService.sendLocally(RequestCollectEvent, accepted, {
      eventTarget: this.entity,
    });
  }

  private handleAcknowledgedAsOwner(payload: RequestCollectPayload): void {
    if (!this.entity.isOwned()) return;
    if (!this.matchesOwnerClaim(payload) || this.ownerUsesDeferredHandler) return;
    this.scheduleOwnerDestroy();
  }

  private matchesOwnerClaim(payload: RequestCollectPayload): boolean {
    return (
      this.entity.isOwned() &&
      this.ownerState === OWNER_STATE_ACCEPTED &&
      payload.collector != null &&
      payload.collector.toString() === this.ownerCollectorKey &&
      payload.attemptId === this.ownerAttemptId
    );
  }

  private scheduleOwnerDestroy(): void {
    if (
      this.ownerUsesDeferredHandler ||
      this.ownerState !== OWNER_STATE_ACCEPTED ||
      this.ownerDestroyScheduled
    ) {
      return;
    }

    this.ownerDestroyScheduled = true;
    const collectible = this.entity;
    setTimeout(() => {
      if (
        collectible.valid &&
        collectible.isOwned() &&
        !collectible.isDestroyed()
      ) {
        collectible.destroy();
      }
    }, 0);
  }

  private handleAcceptedOnRequestingClient(payload: RequestCollectPayload): void {
    const collector = payload.collector;
    if (collector == null || !PlayerService.get().isLocalPlayer(collector)) return;

    const pending = this.pendingAttempt;
    if (pending == null || pending.attemptId !== payload.attemptId) {
      if (payload.attemptId <= this.expiredAttemptHighWatermark) {
        this.resolveExpiredAcceptance(payload, collector);
      }
      return;
    }
    if (pending.accepted) {
      this.acknowledgeAccepted(collector, payload.attemptId);
      return;
    }

    pending.accepted = true;
    this.cancelVerdictTimeout();

    const usesDeferredHandler = payload.deferredHandler;
    if (usesDeferredHandler) {
      // Mark the external handler as dispatched before invoking project code.
      // A throwing callback sends a correlated restore below.
      this.acknowledgeAccepted(collector, payload.attemptId);
    } else {
      this.pendingAttempt = null;
    }

    let callbackSucceeded = false;
    try {
      this.onCollected(collector);
      callbackSucceeded = true;
    } catch (error) {
      console.error(`[Collectible] onCollected failed: ${String(error)}`);
    }

    if (!callbackSucceeded && usesDeferredHandler) {
      this.restorePrediction(pending.prediction);
      this.pendingAttempt = null;
      this.sendRestoreToOwner({
        collector,
        attemptId: payload.attemptId,
        restored: true,
      });
      return;
    }

    if (!usesDeferredHandler) {
      this.acknowledgeAccepted(collector, payload.attemptId);
    }
  }

  private resolveExpiredAcceptance(
    payload: RequestCollectPayload,
    collector: Entity,
  ): void {
    if (payload.deferredHandler) {
      this.sendRestoreToOwner({
        collector,
        attemptId: payload.attemptId,
        restored: true,
      });
      return;
    }
    this.acknowledgeAccepted(collector, payload.attemptId);
  }

  private acknowledgeAccepted(collector: Entity, attemptId: number): void {
    this.sendRequestToOwner({
      phase: REQUEST_COLLECT_PHASE_ACKNOWLEDGED,
      collector,
      attemptId,
      deferredHandler: false,
    });
  }

  /**
   * Delivers a request-phase event to the collectible owner. Networked
   * collectibles route to the owning client; local-only collectibles deliver
   * to local listeners because network sends do not transmit off-entity.
   */
  private sendRequestToOwner(payload: {
    phase: number;
    collector: Maybe<Entity>;
    attemptId: number;
    deferredHandler: boolean;
  }): void {
    if (this.entity.networked) {
      EventService.sendToOwner(RequestCollectEvent, payload, this.entity);
      return;
    }
    EventService.sendLocally(RequestCollectEvent, payload, {
      eventTarget: this.entity,
    });
  }

  /**
   * Delivers a restore verdict to the requesting owner. Local-only
   * collectibles stay on the local event bus.
   */
  private sendRestoreToOwner(payload: {
    collector: Maybe<Entity>;
    attemptId: number;
    restored: boolean;
  }): void {
    if (this.entity.networked) {
      EventService.sendToOwner(RestoreCollectibleEvent, payload, this.entity);
      return;
    }
    EventService.sendLocally(RestoreCollectibleEvent, payload, {
      eventTarget: this.entity,
    });
  }

  /**
   * Broadcasts a restore verdict. Only the owner may broadcast on networked
   * collectibles; local-only collectibles stay on the local event bus.
   */
  private sendRestoreToEveryone(payload: {
    collector: Maybe<Entity>;
    attemptId: number;
    restored: boolean;
  }): void {
    if (this.entity.networked) {
      EventService.sendToEveryone(
        RestoreCollectibleEvent,
        payload,
        this.entity,
      );
      return;
    }
    EventService.sendLocally(RestoreCollectibleEvent, payload, {
      eventTarget: this.entity,
    });
  }

  /** Called by a trusted owner-side handler before starting deferred work. */
  beginDeferredCollectionHandler(): boolean {
    if (!this.entity.isOwned()) return false;
    if (
      this.ownerState !== OWNER_STATE_ACCEPTED ||
      !this.ownerUsesDeferredHandler ||
      this.ownerDeferredHandlerDispatched
    ) {
      return false;
    }
    this.ownerDeferredHandlerDispatched = true;
    this.cancelDeferredHandlerTimeout();
    return true;
  }

  /** Called by a trusted owner-side handler when deferred work rejects. */
  releaseDeferredCollectionHandler(): void {
    if (!this.entity.isOwned()) return;
    if (
      this.ownerState !== OWNER_STATE_ACCEPTED ||
      !this.ownerUsesDeferredHandler ||
      !this.ownerDeferredHandlerDispatched
    ) {
      return;
    }
    this.rememberRejectedAttempt();
    this.releaseOwnerClaim();
  }

  /**
   * Releases the authoritative claim after a deferred handler rejects its
   * post-accept work. The handler sends this locally on the server (paired
   * with a `RestoreCollectibleEvent` broadcast for the requester's cosmetics);
   * without it the owner claim stays held and the item is never collectable
   * again. Fires only on the targeted entity's own Collectible — a stale or
   * mistargeted release is ignored by the state guards in
   * `releaseDeferredCollectionHandler()`.
   */
  @subscribe(ReleaseDeferredCollectibleEvent, {execution: ExecuteOn.Everywhere})
  onReleaseDeferredCollectible(_payload: ReleaseDeferredCollectiblePayload): void {
    this.releaseDeferredCollectionHandler();
  }

  /** Restores a rejected prediction only on the matching requesting client. */
  @subscribe(RestoreCollectibleEvent, {execution: ExecuteOn.Everywhere})
  onRestoreCollectible(payload: RestoreCollectiblePayload): void {
    const pending = this.pendingAttempt;
    if (pending == null) return;

    const isLegacyRestore = payload.collector == null && payload.attemptId === 0;
    const isCorrelatedRestore =
      payload.collector != null &&
      PlayerService.get().isLocalPlayer(payload.collector) &&
      pending.attemptId === payload.attemptId;
    if (!isCorrelatedRestore && !(isLegacyRestore && pending.accepted)) return;

    this.cancelVerdictTimeout();
    this.restorePrediction(pending.prediction);
    this.pendingAttempt = null;
  }

  private rememberRejectedAttempt(): void {
    const rejectedThrough =
      this.rejectedAttemptHighWatermark.get(this.ownerCollectorKey) ?? 0;
    this.rejectedAttemptHighWatermark.set(
      this.ownerCollectorKey,
      Math.max(rejectedThrough, this.ownerAttemptId),
    );
  }

  private releaseOwnerClaim(): void {
    this.ownerState = OWNER_STATE_AVAILABLE;
    this.ownerCollectorKey = '';
    this.ownerAttemptId = 0;
    this.ownerUsesDeferredHandler = false;
    this.ownerDeferredHandlerDispatched = false;
    this.ownerDestroyScheduled = false;
  }

  /**
   * Applies local prediction on the requesting client: hides visuals and
   * deactivates the trigger until the owner verdict, timeout, or rejection
   * resolves. Only non-networked entities are touched, so nothing replicates
   * and verdict subscriptions on the networked root keep firing.
   */
  private applyLocalPrediction(): LocalPrediction | null {
    const cosmetic = this.snapshotAndDisable(this.cosmeticRoot, 'cosmeticRoot');
    const trigger = this.snapshotAndDisableTrigger();
    if (cosmetic == null && trigger == null) return null;
    return {cosmetic, trigger};
  }

  private snapshotAndDisable(
    target: Maybe<Entity>,
    label: string,
  ): EnabledSnapshot | null {
    if (target == null || !target.valid || target.isDestroyed()) {
      if (!this.warnedMissingCosmeticRoot) {
        console.warn(
          '[Collectible] Assign a valid non-networked cosmeticRoot for local prediction',
        );
        this.warnedMissingCosmeticRoot = true;
      }
      return null;
    }
    if (this.isPredictionUnsafe(target)) return null;

    const snapshot = {
      entity: target,
      enabledSelf: target.enabledSelf,
    };
    target.enabledSelf = false;
    return snapshot;
  }

  /**
   * Snapshots and disables the trigger child. The root-hosted trigger stays
   * live when no separate triggerRoot is assigned; re-entry is then blocked
   * by the pending-attempt guard.
   */
  private snapshotAndDisableTrigger(): EnabledSnapshot | null {
    const triggerRoot = this.triggerRoot;
    if (triggerRoot == null) return null;
    if (!triggerRoot.valid || triggerRoot.isDestroyed()) return null;
    if (this.isPredictionUnsafe(triggerRoot)) {
      if (!this.warnedInvalidTriggerRoot) {
        console.warn(
          '[Collectible] triggerRoot must be a non-networked entity distinct from the collectible root; skipping trigger prediction',
        );
        this.warnedInvalidTriggerRoot = true;
      }
      return null;
    }

    const snapshot = {
      entity: triggerRoot,
      enabledSelf: triggerRoot.enabledSelf,
    };
    triggerRoot.enabledSelf = false;
    return snapshot;
  }

  /**
   * Prediction must never touch the networked root or a networked entity.
   * The root hosts the verdict subscriptions, and enabledSelf on a networked
   * entity replicates the prediction to every client.
   */
  private isPredictionUnsafe(target: Entity): boolean {
    return target === this.entity || target.networked;
  }

  private restorePrediction(prediction: LocalPrediction | null): void {
    if (prediction == null) return;
    this.restoreSnapshot(prediction.cosmetic);
    this.restoreSnapshot(prediction.trigger);
  }

  private restoreSnapshot(snapshot: EnabledSnapshot | null): void {
    if (
      snapshot == null ||
      !snapshot.entity.valid ||
      snapshot.entity.isDestroyed()
    ) {
      return;
    }
    snapshot.entity.enabledSelf = snapshot.enabledSelf;
  }

  private cancelVerdictTimeout(): void {
    const timeout = this.pendingAttempt?.timeout;
    if (timeout != null) {
      clearTimeout(timeout);
      if (this.pendingAttempt != null) {
        this.pendingAttempt.timeout = null;
      }
    }
  }

  private cancelDeferredHandlerTimeout(): void {
    if (this.ownerDeferredHandlerTimeout != null) {
      clearTimeout(this.ownerDeferredHandlerTimeout);
      this.ownerDeferredHandlerTimeout = null;
    }
  }
}
