// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {
  Vec3,
  TransformComponent,
  PlayerService,
  type Entity,
} from 'meta/worlds';
import {ActorBehavior} from 'meta/worlds';
import type {ActorBehaviorManager} from 'meta/worlds';
import type {ActorController} from 'meta/worlds';
import {
  ActorLookControllerTypeId,
  type ActorLookController,
  ActorLookParams,
} from 'meta/worlds';

/**
 * Target selection mode for the AttentionBehavior.
 */
export enum AttentionTargetMode {
  /** Automatically targets the nearest player within range */
  NearestPlayer,
  /** Targets a specific entity set via targetEntity */
  SpecificEntity,
}

/**
 * AttentionBehavior - Makes an Actor idly pay attention to nearby targets.
 *
 * When a target is in range, the Actor looks at it via ActorLookController.
 * When no target is in range, performs idle gaze — periodically looking in
 * random directions to appear alive.
 *
 * Claims ActorLookController at low priority (default 0) so that combat,
 * death, or other higher-priority behaviors can override the look direction.
 */
export class AttentionBehavior extends ActorBehavior {
  /** Target selection mode */
  targetMode: AttentionTargetMode = AttentionTargetMode.NearestPlayer;

  /** Specific entity to look at (only used with SpecificEntity mode) */
  targetEntity: Entity | null = null;

  /** Maximum distance (meters) to detect attention targets */
  attentionRange: number = 10.0;

  /** Speed of look interpolation when tracking a target (0-1 per frame) */
  lookSpeed: number = 0.15;

  /** Speed of look interpolation for idle gaze (0-1 per frame) */
  idleLookSpeed: number = 0.05;

  /** Whether to perform idle gaze when no target is in range */
  idleGazeEnabled: boolean = true;

  /** Minimum seconds between idle gaze direction changes */
  idleGazeMinInterval: number = 2.0;

  /** Maximum seconds between idle gaze direction changes */
  idleGazeMaxInterval: number = 5.0;

  /** Maximum horizontal angle (degrees) for idle gaze from forward */
  idleGazeMaxAngle: number = 45.0;

  /** Height offset added to target position for look-at (accounts for actor height) */
  targetHeightOffset: number = 1.5;

  // Internal state
  private currentTarget: Entity | null = null;
  private hasTarget: boolean = false;
  private idleGazeTimer: number = 0;
  private idleGazeInterval: number = 3.0;
  private idleGazeDirection: Vec3 | null = null;
  private actorTransform: TransformComponent | null = null;

  override initialize(behaviorManager: ActorBehaviorManager): void {
    super.initialize(behaviorManager);
    this.actorTransform = this.getEntity().getComponent(TransformComponent);
    this.resetIdleGazeTimer();
  }

  override update(deltaTime: number): void {
    this.updateTarget();

    if (this.hasTarget) {
      // Reset idle gaze timer while tracking a target
      this.resetIdleGazeTimer();
    } else if (this.idleGazeEnabled) {
      this.updateIdleGaze(deltaTime);
    }
  }

  override getControllerUsePriority(controllerType: string): number {
    if (controllerType === ActorLookControllerTypeId) {
      // Always claim look controller — idle gaze or target tracking
      if (this.hasTarget || (this.idleGazeEnabled && this.idleGazeDirection != null)) {
        return this.basePriority;
      }
    }
    return -1;
  }

  override useController(controllerType: string, controller: ActorController): void {
    if (controllerType !== ActorLookControllerTypeId) {
      return;
    }

    const lookController = controller as ActorLookController;

    if (this.hasTarget && this.currentTarget) {
      const targetTransform = this.currentTarget.getComponent(TransformComponent);
      if (targetTransform) {
        const targetPos = targetTransform.worldPosition;
        // Offset upward to look at head/center of target, not feet
        const lookAtPos = new Vec3(targetPos.x, targetPos.y + this.targetHeightOffset, targetPos.z);
        lookController.setLookTarget(ActorLookParams.fromTarget(lookAtPos, this.lookSpeed));
      }
    } else if (this.idleGazeEnabled && this.idleGazeDirection) {
      lookController.setLookTarget(ActorLookParams.fromDirection(this.idleGazeDirection, this.idleLookSpeed));
    } else {
      lookController.resetToDefaultLook();
    }
  }

  override onRemove(): void {
    this.currentTarget = null;
    this.hasTarget = false;
    this.idleGazeDirection = null;
  }

  // #region Private

  private updateTarget(): void {
    if (this.targetMode === AttentionTargetMode.SpecificEntity) {
      if (this.targetEntity && this.isEntityInRange(this.targetEntity)) {
        this.currentTarget = this.targetEntity;
        this.hasTarget = true;
      } else {
        this.currentTarget = null;
        this.hasTarget = false;
      }
      return;
    }

    // NearestPlayer mode
    const nearestPlayer = this.findNearestPlayerInRange();
    if (nearestPlayer) {
      this.currentTarget = nearestPlayer;
      this.hasTarget = true;
    } else {
      this.currentTarget = null;
      this.hasTarget = false;
    }
  }

  private findNearestPlayerInRange(): Entity | null {
    if (!this.actorTransform) {
      return null;
    }

    const actorPos = this.actorTransform.worldPosition;
    const players = PlayerService.get().getAllPlayers();

    let closestPlayer: Entity | null = null;
    let closestDistance = this.attentionRange;

    for (const player of players) {
      if (!player || !player.valid) continue;

      const playerTransform = player.getComponent(TransformComponent);
      if (!playerTransform) continue;

      const playerPos = playerTransform.worldPosition;
      const distance = actorPos.sub(playerPos).magnitude();

      if (distance < closestDistance) {
        closestDistance = distance;
        closestPlayer = player;
      }
    }

    return closestPlayer;
  }

  private isEntityInRange(entity: Entity): boolean {
    if (!this.actorTransform || !entity.valid) {
      return false;
    }

    const entityTransform = entity.getComponent(TransformComponent);
    if (!entityTransform) {
      return false;
    }

    const distance = this.actorTransform.worldPosition.sub(entityTransform.worldPosition).magnitude();
    return distance <= this.attentionRange;
  }

  private updateIdleGaze(deltaTime: number): void {
    this.idleGazeTimer += deltaTime;

    if (this.idleGazeTimer >= this.idleGazeInterval) {
      this.generateNewIdleGazeDirection();
      this.resetIdleGazeTimer();
    }
  }

  private generateNewIdleGazeDirection(): void {
    const maxAngleRad = this.idleGazeMaxAngle * (Math.PI / 180);
    const horizontalAngle = (Math.random() * 2 - 1) * maxAngleRad;
    const verticalAngle = (Math.random() * 2 - 1) * maxAngleRad * 0.3; // Less vertical range

    this.idleGazeDirection = new Vec3(
      Math.sin(horizontalAngle),
      Math.sin(verticalAngle),
      -Math.cos(horizontalAngle),
    ).normalize();
  }

  private resetIdleGazeTimer(): void {
    this.idleGazeTimer = 0;
    this.idleGazeInterval =
      this.idleGazeMinInterval +
      Math.random() * (this.idleGazeMaxInterval - this.idleGazeMinInterval);
  }

  // #endregion
}
