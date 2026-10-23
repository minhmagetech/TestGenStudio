// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import { Vec3, TransformComponent, type Entity } from 'meta/worlds';
import { ActorBehavior } from 'meta/worlds';
import type { ActorBehaviorManager } from 'meta/worlds';

/**
 * Shared data object for target information.
 * Created by a parent CompositeBehavior and shared across sub-behaviors.
 * TargetingBehavior writes to it; FollowBehavior and MeleeAttackBehavior read from it.
 */
export class TargetInfo {
  targetEntity: Entity | null = null;
  rawPosition: Vec3 = new Vec3(0, 0, 0);
  smoothedPosition: Vec3 = new Vec3(0, 0, 0);
  smoothedVelocity: Vec3 = new Vec3(0, 0, 0);
  predictedPosition: Vec3 = new Vec3(0, 0, 0);
  isValid: boolean = false;
}

/**
 * TargetingBehavior acquires and tracks a target, writing smoothed position,
 * velocity, and predicted position data to a shared TargetInfo object.
 *
 * Designed to run inside a CompositeBehavior at the highest internal priority
 * so that target data is established before other sub-behaviors execute.
 *
 * Does not use any controllers (getControllerUsePriority always returns -1).
 */
export class TargetingBehavior extends ActorBehavior {
  override name: string = 'TargetingBehavior';

  /**
   * Which faction to target (e.g. "playerFaction").
   * Used when querying CombatBlackboard for targets.
   */
  targetFactionId: string = 'playerFaction';

  /**
   * Optional static target entity override.
   * When set, skips CombatBlackboard query and tracks this entity directly.
   */
  targetEntity: Entity | null = null;

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

  protected actorTransform: TransformComponent | null = null;
  protected smoothedTargetPos: Vec3 | null = null;
  protected previousSmoothedTargetPos: Vec3 | null = null;
  protected rawVelocity: Vec3 = new Vec3(0, 0, 0);
  protected internalSmoothedVelocity: Vec3 = new Vec3(0, 0, 0);

  override initialize(behaviorManager: ActorBehaviorManager): void {
    super.initialize(behaviorManager);
    this.actorTransform = this.getEntity().getComponent(TransformComponent);
  }

  override update(deltaTime: number): void {
    const currentTarget = this.resolveTarget();

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

  /**
   * Resolves the current target entity.
   * Uses the static targetEntity property.
   * Override this method in subclasses to implement custom target resolution
   * (e.g., querying a blackboard, finding nearest entity by tag).
   */
  protected resolveTarget(): Entity | null {
    if (this.targetEntity && !this.targetEntity.isDestroyed()) {
      return this.targetEntity;
    }
    return null;
  }

  protected smoothTargetPosition(reportedPos: Vec3, deltaTime: number): Vec3 {
    if (this.smoothedTargetPos === null) {
      this.smoothedTargetPos = reportedPos;
      return this.smoothedTargetPos;
    }

    const smoothingFactor = 1 - Math.exp(-deltaTime / this.positionSmoothingTimeConstant);

    this.smoothedTargetPos = new Vec3(
      this.smoothedTargetPos.x + (reportedPos.x - this.smoothedTargetPos.x) * smoothingFactor,
      this.smoothedTargetPos.y + (reportedPos.y - this.smoothedTargetPos.y) * smoothingFactor,
      this.smoothedTargetPos.z + (reportedPos.z - this.smoothedTargetPos.z) * smoothingFactor,
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

    const smoothingFactor = 1 - Math.exp(-deltaTime / this.velocitySmoothingTimeConstant);
    this.internalSmoothedVelocity = new Vec3(
      this.internalSmoothedVelocity.x + (this.rawVelocity.x - this.internalSmoothedVelocity.x) * smoothingFactor,
      this.internalSmoothedVelocity.y + (this.rawVelocity.y - this.internalSmoothedVelocity.y) * smoothingFactor,
      this.internalSmoothedVelocity.z + (this.rawVelocity.z - this.internalSmoothedVelocity.z) * smoothingFactor,
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
