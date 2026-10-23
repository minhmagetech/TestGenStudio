// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {Vec3, TransformComponent} from 'meta/worlds';
import type {Entity} from 'meta/worlds';
import {ActorBehavior} from 'meta/worlds';
import {GotoBehavior} from './GotoBehavior';
import type {ActorController} from 'meta/worlds';
import type {ActorBehaviorManager} from 'meta/worlds';
import type {TargetInfo} from './TargetingBehavior';
import {
  ActorBodyDirectionControllerTypeId,
  type ActorBodyDirectionController,
  ActorBodyDirectionParams,
} from 'meta/worlds';

/**
 * FleeBehavior — The inverse of FollowBehavior. Keeps an actor at least
 * `fleeDistance` meters away from a target entity.
 *
 * When the target is closer than `fleeDistance`, the actor computes a
 * flee point directly away from the target and moves there via
 * GotoBehavior. When the target is far enough away, the behavior goes
 * idle and releases all controllers.
 *
 * A leash system constrains how far the actor can flee from its
 * starting position. When the flee point would exceed the leash
 * radius, it is clamped to the leash boundary.
 *
 * Supports two modes (same pattern as FollowBehavior):
 *
 * - **Composite mode** (`targetInfo` provided): Reads target position
 *   and velocity from a shared TargetInfo written by a targeting
 *   sub-behavior (e.g. TargetTaggedEntityBehavior). Use inside a
 *   CompositeBehavior like FleeTaggedEntityBehavior.
 *
 * - **Standalone mode** (`targetInfo` is null): Uses `targetEntity`
 *   directly. Simpler setup when the target entity is known.
 */
export class FleeBehavior extends ActorBehavior {
  override name: string = 'FleeBehavior';

  // ── Target ──────────────────────────────────────────────────────────

  /**
   * The entity to flee from. Used in standalone mode.
   * In composite mode, the target is read from targetInfo instead.
   */
  targetEntity: Entity | null = null;

  /**
   * Shared target info from a parent CompositeBehavior.
   * When provided, target position is read from here (composite mode).
   * When null, standalone mode is used (reads targetEntity directly).
   */
  targetInfo: TargetInfo | null = null;

  // ── Distance ────────────────────────────────────────────────────────

  /**
   * Minimum safe distance (meters) to maintain from the target. When
   * the target is closer than this, the actor flees directly away until
   * it reaches this distance. When the target is further, the actor
   * idles and releases controllers.
   */
  fleeDistance: number = 10.0;

  /**
   * Movement speed (m/s) while fleeing.
   */
  fleeSpeed: number = 6.0;

  /**
   * Distance (meters) at which the actor considers itself arrived at
   * the flee point and stops moving.
   */
  arrivalDistance: number = 1.0;

  // ── Leash ───────────────────────────────────────────────────────────

  /**
   * Maximum distance (meters) the actor is allowed to flee from its
   * starting position (the "anchor"). If the computed flee point would
   * exceed this, it is clamped to the leash boundary.
   *
   * Set to 0 to disable leashing (actor can flee infinitely far).
   *
   * When the leash prevents the actor from reaching full fleeDistance,
   * it flees as far as the leash allows. The actor will not leave its
   * leash zone even if the target is right on top of it.
   */
  leashRadius: number = 0;

  // ── Body direction ─────────────────────────────────────────────────

  /**
   * If true, the actor rotates to face the direction it is moving
   * (away from the target). If false, rotation is not controlled.
   */
  rotateTowardsMovement: boolean = true;

  /**
   * Angular speed (radians/sec) for body rotation while fleeing.
   * 3.14 ≈ 180 deg/s.
   */
  bodyDirectionAngularSpeed: number = 3.14;

  // ── GotoBehavior pass-through ──────────────────────────────────────

  repathInterval: number = 0.2;
  distanceToStop: number = 0.1;

  // ── Internal state ─────────────────────────────────────────────────

  /** Position where the behavior was initialized (leash center). */
  private anchorPosition: Vec3 = new Vec3(0, 0, 0);

  /** Whether the actor is currently fleeing (target within range). */
  private isFleeing: boolean = false;

  /** Internal GotoBehavior for movement to the flee point. */
  private gotoBehavior: GotoBehavior | null = null;

  /** Cached TransformComponent of the actor entity. */
  private actorTransform: TransformComponent | null = null;

  /** Direction the actor should face while fleeing (XZ plane). */
  private desiredBodyDirection: Vec3 | null = null;

  // ── Lifecycle ──────────────────────────────────────────────────────

  override initialize(behaviorManager: ActorBehaviorManager): void {
    super.initialize(behaviorManager);

    this.actorTransform = this.getEntity().getComponent(TransformComponent);
    const startPos =
      this.actorTransform?.worldPosition ?? new Vec3(0, 0, 0);

    // Record leash anchor at initialization position
    this.anchorPosition = new Vec3(startPos.x, startPos.y, startPos.z);

    // Create internal GotoBehavior for movement
    this.gotoBehavior = new GotoBehavior();
    this.gotoBehavior.basePriority = this.basePriority;
    this.gotoBehavior.desiredSpeed = this.fleeSpeed;
    this.gotoBehavior.targetPosition = startPos;
    this.gotoBehavior.repathInterval = this.repathInterval;
    this.gotoBehavior.distanceToStop = this.distanceToStop;
    // Flee reassigns the target every frame; repath on the interval only.
    this.gotoBehavior.repathOnTargetChange = false;
    // FleeBehavior owns body direction itself; the nested goto must not also
    // claim the body-direction controller and fight it.
    this.gotoBehavior.shouldFaceDirection = false;
    this.gotoBehavior.initialize(this.behaviorManager!);

    this.isFleeing = false;
  }

  override update(deltaTime: number): void {
    if (!this.gotoBehavior || !this.actorTransform) {
      return;
    }

    if (this.targetInfo) {
      this.updateComposite(deltaTime);
    } else {
      this.updateStandalone(deltaTime);
    }
  }

  // ── Composite mode ─────────────────────────────────────────────────

  /**
   * Reads target position from shared TargetInfo (written by a
   * targeting sub-behavior like TargetTaggedEntityBehavior).
   */
  private updateComposite(deltaTime: number): void {
    if (!this.targetInfo!.isValid) {
      this.isFleeing = false;
      this.desiredBodyDirection = null;
      return;
    }

    // Use smoothed position from the targeting sub-behavior
    const targetPos = this.targetInfo!.smoothedPosition;
    this.computeAndFlee(targetPos, deltaTime);
  }

  // ── Standalone mode ────────────────────────────────────────────────

  /**
   * Reads target position directly from targetEntity.
   */
  private updateStandalone(deltaTime: number): void {
    if (!this.targetEntity || this.targetEntity.isDestroyed()) {
      this.isFleeing = false;
      this.desiredBodyDirection = null;
      return;
    }

    const targetTransform = this.targetEntity.getComponent(TransformComponent);
    if (!targetTransform) {
      this.isFleeing = false;
      this.desiredBodyDirection = null;
      return;
    }

    const targetPos = targetTransform.worldPosition;
    this.computeAndFlee(targetPos, deltaTime);
  }

  // ── Core flee logic ────────────────────────────────────────────────

  /**
   * Shared flee computation used by both modes.
   * Checks distance, computes flee point, clamps to leash, drives movement.
   */
  private computeAndFlee(targetPos: Vec3, deltaTime: number): void {
    const actorPos = this.actorTransform!.worldPosition;

    // Horizontal distance to target (XZ plane)
    const dx = actorPos.x - targetPos.x;
    const dz = actorPos.z - targetPos.z;
    const distToTarget = Math.sqrt(dx * dx + dz * dz);

    if (distToTarget >= this.fleeDistance) {
      // Safe distance — stop fleeing, release controllers
      this.isFleeing = false;
      this.desiredBodyDirection = null;
      return;
    }

    // ── Too close: compute flee point ──
    this.isFleeing = true;

    // Direction from target to actor (the "away" direction)
    let awayX: number;
    let awayZ: number;

    if (distToTarget > 0.001) {
      awayX = dx / distToTarget;
      awayZ = dz / distToTarget;
    } else {
      // Actor is on top of the target — pick an arbitrary direction
      awayX = 1;
      awayZ = 0;
    }

    // Flee point: fleeDistance meters away from target, in the away direction
    let fleeX = targetPos.x + awayX * this.fleeDistance;
    let fleeZ = targetPos.z + awayZ * this.fleeDistance;

    // Leash clamping: keep flee point within leashRadius of anchor
    if (this.leashRadius > 0) {
      const offsetX = fleeX - this.anchorPosition.x;
      const offsetZ = fleeZ - this.anchorPosition.z;
      const distFromAnchor = Math.sqrt(offsetX * offsetX + offsetZ * offsetZ);

      if (distFromAnchor > this.leashRadius) {
        const scale = this.leashRadius / distFromAnchor;
        fleeX = this.anchorPosition.x + offsetX * scale;
        fleeZ = this.anchorPosition.z + offsetZ * scale;
      }
    }

    const fleePoint = new Vec3(fleeX, actorPos.y, fleeZ);

    // Update body direction to face movement direction.
    // The body direction controller expects the world-space direction the
    // actor should face — i.e. actor → flee point.
    if (this.rotateTowardsMovement) {
      const moveDx = fleePoint.x - actorPos.x;
      const moveDz = fleePoint.z - actorPos.z;
      const moveDist = Math.sqrt(moveDx * moveDx + moveDz * moveDz);

      if (moveDist > 0.001) {
        this.desiredBodyDirection = new Vec3(moveDx, 0, moveDz).normalize();
      }
    }

    // Drive GotoBehavior toward the flee point
    this.gotoBehavior!.targetPosition = fleePoint;
    this.gotoBehavior!.desiredSpeed = this.fleeSpeed;
    this.gotoBehavior!.update(deltaTime);
  }

  // ── Controller delegation ──────────────────────────────────────────

  override getControllerUsePriority(controllerType: string): number {
    if (!this.isFleeing || !this.gotoBehavior) {
      return super.getControllerUsePriority(controllerType);
    }

    if (
      controllerType === ActorBodyDirectionControllerTypeId &&
      this.desiredBodyDirection
    ) {
      return this.basePriority;
    }

    return this.gotoBehavior.getControllerUsePriority(controllerType);
  }

  override useController(
    controllerType: string,
    controller: ActorController,
  ): void {
    if (
      controllerType === ActorBodyDirectionControllerTypeId &&
      this.desiredBodyDirection
    ) {
      (controller as ActorBodyDirectionController).rotateBodyTo(
        new ActorBodyDirectionParams(
          this.desiredBodyDirection,
          this.bodyDirectionAngularSpeed,
        ),
      );
    }

    if (this.gotoBehavior) {
      this.gotoBehavior.useController(controllerType, controller);
    }
  }
}
