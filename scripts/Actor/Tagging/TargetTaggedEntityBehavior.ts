// @generated - Actor Framework Scripts v8
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {Vec3, TransformComponent, type Entity} from 'meta/worlds';
import {ActorBehavior} from 'meta/worlds';
import type {ActorBehaviorManager} from 'meta/worlds';
import {TargetInfo} from '../Behaviors/TargetingBehavior';
import {BlackboardScope} from 'meta/worlds';
import {ActorTaggingBlackboard} from 'meta/worlds';

/**
 * Acquires and tracks the closest entity matching a given tag, writing
 * smoothed position, velocity, and predicted position data to a shared
 * TargetInfo object.
 *
 * Designed to run inside a CompositeBehavior at the highest internal
 * priority so that target data is established before other sub-behaviors
 * (e.g. FollowBehavior) execute.
 *
 * Does not use any controllers (getControllerUsePriority always returns -1).
 */
export class TargetTaggedEntityBehavior extends ActorBehavior {
  override name: string = 'TargetTaggedEntityBehavior';

  /**
   * The tags to query for (e.g. ["enemy"], ["player", "enemy"]).
   * The closest entity matching any tag is selected.
   *
   * ⚠️ Consumer half only. The target entity must ALSO carry a matching
   * `ActorSdkTagComponent` (set its `tags` property to the same case-sensitive
   * string, or register the entity via `ActorTaggingBlackboard.registerTags`);
   * players are auto-tagged "player". Otherwise this resolves no target. See the
   * Tag Targeting Contract in implementing-actor-behaviors.
   */
  targetTags: string[] = [];

  /**
   * Time constant for position smoothing in seconds.
   */
  positionSmoothingTimeConstant: number = 0.3;

  /**
   * Time constant for velocity smoothing in seconds.
   */
  velocitySmoothingTimeConstant: number = 0.5;

  /**
   * How far ahead to predict the target's position in seconds.
   */
  velocityPredictionTime: number = 0.5;

  /**
   * The shared TargetInfo object this behavior writes to.
   * Must be set by the parent CompositeBehavior before initialize().
   */
  targetInfo: TargetInfo = new TargetInfo();

  /**
   * Maximum range in meters for target acquisition and retention.
   * Targets beyond this distance are ignored. Set to 0 or negative to disable.
   */
  maxRange: number = 0;

  /**
   * Optional forced target override. When set (non-null), resolveTarget()
   * returns this entity directly instead of querying the ActorTaggingBlackboard.
   */
  forcedTargetOverride: Entity | null = null;

  /**
   * Grace period in seconds before warning that `targetTags` resolved zero
   * tagged entities. Gives producer `ActorSdkTagComponent`s time to register on
   * their own OnEntityStartEvent before we conclude none exist. See the Tag
   * Targeting Contract in implementing-actor-behaviors.
   */
  noProducerGraceSeconds: number = 3;

  protected actorTransform: TransformComponent | null = null;
  protected smoothedTargetPos: Vec3 | null = null;
  protected previousSmoothedTargetPos: Vec3 | null = null;
  protected rawVelocity: Vec3 = new Vec3(0, 0, 0);
  protected internalSmoothedVelocity: Vec3 = new Vec3(0, 0, 0);

  // ── Tag-resolution observability (latched one-shot diagnostics) ─────
  /**
   * Total tagged entities the blackboard returned on the last resolveTarget()
   * call, BEFORE range filtering. 0 with a non-empty `targetTags` means no
   * producer registered the tag at runtime (see Tag Targeting Contract).
   */
  private lastTaggedCandidateCount: number = 0;
  private noProducerElapsed: number = 0;
  private hasLoggedAcquire: boolean = false;
  private hasWarnedNoProducer: boolean = false;

  override initialize(behaviorManager: ActorBehaviorManager): void {
    super.initialize(behaviorManager);
    this.actorTransform = this.getEntity().getComponent(TransformComponent);
  }

  override update(deltaTime: number): void {
    const currentTarget = this.resolveTarget();
    this.updateTagObservability(deltaTime, currentTarget);

    if (!currentTarget || currentTarget.isDestroyed()) {
      this.targetInfo.isValid = false;
      this.targetInfo.targetEntity = null;
      this.resetSmoothing();
      return;
    }

    const targetTransform = currentTarget.getComponent(TransformComponent);
    if (!targetTransform) {
      this.targetInfo.isValid = false;
      return;
    }

    const rawPos = targetTransform.worldPosition;

    const smoothedPos = this.smoothTargetPosition(rawPos, deltaTime);
    this.updateTargetVelocity(smoothedPos, deltaTime);
    const predictedPos = this.computePredictedPosition(smoothedPos);

    this.targetInfo.targetEntity = currentTarget;
    this.targetInfo.rawPosition = rawPos;
    this.targetInfo.smoothedPosition = smoothedPos;
    this.targetInfo.smoothedVelocity = this.internalSmoothedVelocity;
    this.targetInfo.predictedPosition = predictedPos;
    this.targetInfo.isValid = true;
  }

  override getControllerUsePriority(_controllerType: string): number {
    return -1;
  }

  // ── Target Resolution ───────────────────────────────────────────────

  /**
   * Finds the closest entity matching any tag in `targetTags` from the
   * global ActorTaggingBlackboard, excluding the owning entity itself.
   */
  protected resolveTarget(): Entity | null {
    // Forced override takes precedence over the blackboard query.
    if (this.forcedTargetOverride && !this.forcedTargetOverride.isDestroyed()) {
      return this.forcedTargetOverride;
    }

    if (!this.behaviorManager || !this.actorTransform || this.targetTags.length === 0) {
      return null;
    }

    // Reset up front so the null-blackboard early return below leaves a 0 count
    // (no blackboard => nothing registered) rather than a stale value.
    this.lastTaggedCandidateCount = 0;

    const taggingBB = this.behaviorManager.actorBlackboardManager.getBlackboard(
      ActorTaggingBlackboard,
      /* actorId */ undefined,
      /* groupId */ undefined,
      BlackboardScope.Global,
    );

    if (!taggingBB) {
      return null;
    }

    const actorPos = this.actorTransform.worldPosition;
    const selfEntity = this.getEntity();
    const maxRangeSq = this.maxRange > 0 ? this.maxRange * this.maxRange : Infinity;

    let closestEntity: Entity | null = null;
    let closestDistSq = Infinity;
    let taggedCount = 0;

    for (const tag of this.targetTags) {
      const tagged = taggingBB.getTaggedEntities(tag);
      taggedCount += tagged.length;

      for (const entry of tagged) {
        if (entry.entity === selfEntity) {
          continue;
        }

        const transform = entry.entity.getComponent(TransformComponent);
        if (!transform) {
          continue;
        }

        const pos = transform.worldPosition;
        const dx = pos.x - actorPos.x;
        const dy = pos.y - actorPos.y;
        const dz = pos.z - actorPos.z;
        const distSq = dx * dx + dy * dy + dz * dz;

        if (distSq <= maxRangeSq && distSq < closestDistSq) {
          closestDistSq = distSq;
          closestEntity = entry.entity;
        }
      }
    }

    this.lastTaggedCandidateCount = taggedCount;
    return closestEntity;
  }

  /**
   * Emits one-shot diagnostics that make tag targeting observable in ASCP/anvil
   * traces (the authoring build-verify loop cannot see runtime resolution):
   *  - `[TargetTaggedEntity] acquired` the first frame a target resolves;
   *  - `[TargetTaggedEntity] no producer` once, if `targetTags` are configured but
   *    the blackboard yields zero tagged entities for `noProducerGraceSeconds`
   *    (the producer `ActorSdkTagComponent` never registered at runtime — see the
   *    Tag Targeting Contract). A non-zero candidate count merely out of range is a
   *    distance problem, not a tagging one, and is intentionally left silent.
   * Both logs are latched so each fires at most once per behavior instance. The
   * warning is additionally suppressed once a target has ever resolved: pickup,
   * delivery, and kills legitimately drain the tag to zero, and reporting that as
   * missing producer wiring would be a false positive in the common terminal state.
   */
  protected updateTagObservability(deltaTime: number, currentTarget: Entity | null): void {
    if (this.forcedTargetOverride || this.targetTags.length === 0) {
      return;
    }

    if (currentTarget) {
      if (!this.hasLoggedAcquire) {
        this.hasLoggedAcquire = true;
        console.log(
          `[TargetTaggedEntity] acquired target for targetTags=[${this.targetTags.join(', ')}]`,
        );
      }
      this.noProducerElapsed = 0;
      return;
    }

    // A prior acquisition proves the producer was wired, so a later drop to zero
    // is consumption or destruction, not the missing-tag failure this warns about.
    if (
      this.hasLoggedAcquire ||
      this.lastTaggedCandidateCount > 0 ||
      this.hasWarnedNoProducer
    ) {
      return;
    }

    this.noProducerElapsed += deltaTime;
    if (this.noProducerElapsed >= this.noProducerGraceSeconds) {
      this.hasWarnedNoProducer = true;
      console.warn(
        `[TargetTaggedEntity] no producer: targetTags=[${this.targetTags.join(', ')}] ` +
          `resolved 0 tagged entities after ${this.noProducerGraceSeconds}s — the target is ` +
          `missing an ActorSdkTagComponent with a matching tag (Tag Targeting Contract).`,
      );
    }
  }

  // ── Smoothing & Prediction ──────────────────────────────────────────

  protected smoothTargetPosition(reportedPos: Vec3, deltaTime: number): Vec3 {
    if (this.smoothedTargetPos === null) {
      this.smoothedTargetPos = reportedPos;
      return this.smoothedTargetPos;
    }

    const f = 1 - Math.exp(-deltaTime / this.positionSmoothingTimeConstant);

    this.smoothedTargetPos = new Vec3(
      this.smoothedTargetPos.x + (reportedPos.x - this.smoothedTargetPos.x) * f,
      this.smoothedTargetPos.y + (reportedPos.y - this.smoothedTargetPos.y) * f,
      this.smoothedTargetPos.z + (reportedPos.z - this.smoothedTargetPos.z) * f,
    );

    return this.smoothedTargetPos;
  }

  protected updateTargetVelocity(smoothedPos: Vec3, deltaTime: number): void {
    if (this.previousSmoothedTargetPos === null || deltaTime <= 0) {
      this.previousSmoothedTargetPos = smoothedPos;
      this.rawVelocity = new Vec3(0, 0, 0);
      this.internalSmoothedVelocity = new Vec3(0, 0, 0);
      return;
    }

    const displacement = smoothedPos.sub(this.previousSmoothedTargetPos);
    this.rawVelocity = displacement.mul(1 / deltaTime);

    const f = 1 - Math.exp(-deltaTime / this.velocitySmoothingTimeConstant);
    this.internalSmoothedVelocity = new Vec3(
      this.internalSmoothedVelocity.x + (this.rawVelocity.x - this.internalSmoothedVelocity.x) * f,
      this.internalSmoothedVelocity.y + (this.rawVelocity.y - this.internalSmoothedVelocity.y) * f,
      this.internalSmoothedVelocity.z + (this.rawVelocity.z - this.internalSmoothedVelocity.z) * f,
    );

    this.previousSmoothedTargetPos = smoothedPos;
  }

  protected computePredictedPosition(smoothedPos: Vec3): Vec3 {
    if (this.velocityPredictionTime <= 0) {
      return smoothedPos;
    }

    const offset = this.internalSmoothedVelocity.mul(this.velocityPredictionTime);
    return smoothedPos.add(offset);
  }

  protected resetSmoothing(): void {
    this.smoothedTargetPos = null;
    this.previousSmoothedTargetPos = null;
    this.rawVelocity = new Vec3(0, 0, 0);
    this.internalSmoothedVelocity = new Vec3(0, 0, 0);
  }
}
