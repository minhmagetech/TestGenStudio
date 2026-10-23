// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {Vec3, TransformComponent} from 'meta/worlds';
import {ActorBehavior} from 'meta/worlds';
import {GotoBehavior} from './GotoBehavior';
import type {ActorController} from 'meta/worlds';
import type {ActorBehaviorManager} from 'meta/worlds';
import {
  ActorBodyDirectionControllerTypeId,
  type ActorBodyDirectionController,
  ActorBodyDirectionParams,
} from 'meta/worlds';

/**
 * IdleWanderBehavior — Makes an actor wander randomly around a region.
 *
 * The actor alternates between idle pauses and short walks to random
 * nearby positions. A leash system optionally constrains how far the
 * actor can drift from its starting position.
 *
 * Flow:
 *  1. Actor starts idle, waits a random duration (wanderIntervalMin..wanderIntervalMax)
 *  2. Picks a random point (wanderRadiusMin..wanderRadiusMax) meters away
 *  3. If leash is enabled, clamps the point to stay within leashRadius of the anchor
 *  4. Walks to the point at wanderSpeed
 *  5. On arrival (within arrivalDistance), returns to step 1
 *
 * Commonly the low-priority default in a composed NPC (wander until something
 * higher-priority takes over). To alternate it with another behavior on a timer
 * or condition, keep both registered and gate by priority — never add/remove on
 * a timer from an `OnWorldUpdateEvent` component. See the
 * `working-with-actor-behaviors` skill, "Timed / Periodic Switching".
 */
export class IdleWanderBehavior extends ActorBehavior {
  override name: string = 'IdleWanderBehavior';

  // ── Timing ──────────────────────────────────────────────────────────

  /**
   * Minimum seconds to wait at the current spot before picking a new
   * wander target. The actual wait is randomized between min and max.
   */
  wanderIntervalMin: number = 5.0;

  /**
   * Maximum seconds to wait at the current spot before picking a new
   * wander target. The actual wait is randomized between min and max.
   */
  wanderIntervalMax: number = 10.0;

  // ── Distance ────────────────────────────────────────────────────────

  /**
   * Minimum distance (meters) from the actor's current position when
   * picking a new wander target. Avoids trivially short walks.
   */
  wanderRadiusMin: number = 5.0;

  /**
   * Maximum distance (meters) from the actor's current position when
   * picking a new wander target.
   */
  wanderRadiusMax: number = 7.0;

  // ── Leash ───────────────────────────────────────────────────────────

  /**
   * Maximum distance (meters) the actor is allowed to wander from its
   * starting position (the "anchor"). If a randomly picked target would
   * exceed this distance, it is clamped back onto the leash boundary.
   *
   * Set to 0 to disable leashing (actor can wander infinitely far).
   *
   * Example: leashRadius = 20 means the actor will never be more than
   * 20 m from where it first started wandering.
   */
  leashRadius: number = 20.0;

  // ── Movement ────────────────────────────────────────────────────────

  /**
   * Movement speed (m/s) while walking to a wander target.
   */
  wanderSpeed: number = 2.0;

  /**
   * Distance (meters) at which the actor is considered to have arrived
   * at the wander target and should stop and begin idling.
   */
  arrivalDistance: number = 1.0;

  /**
   * If true, the actor rotates to face the direction it is walking.
   */
  rotateTowardsMovement: boolean = true;

  /**
   * Angular speed (radians/sec) for body rotation while walking.
   * 3.14 ≈ 180 deg/s — a full about-face in one second.
   */
  bodyDirectionAngularSpeed: number = 3.14;

  // ── Internal state ─────────────────────────────────────────────────

  /** The position where this behavior was first initialized (leash center). */
  private anchorPosition: Vec3 = new Vec3(0, 0, 0);

  /** Countdown timer for the current idle pause. */
  private idleTimer: number = 0;

  /** true = idling at current spot, false = walking to target. */
  private isIdle: boolean = true;

  /** Internal GotoBehavior used for pathfollowing to the wander target. */
  private gotoBehavior: GotoBehavior | null = null;

  /** Cached TransformComponent of the actor entity. */
  private actorTransform: TransformComponent | null = null;

  /** The position we are currently walking toward. */
  private currentTarget: Vec3 = new Vec3(0, 0, 0);

  /** Direction the actor should face while walking (XZ plane). */
  private desiredBodyDirection: Vec3 | null = null;

  // ── Lifecycle ──────────────────────────────────────────────────────

  override initialize(
    behaviorManager: ActorBehaviorManager,
  ): void {
    super.initialize(behaviorManager);

    this.actorTransform = this.getEntity().getComponent(TransformComponent);
    const startPos =
      this.actorTransform?.worldPosition ?? new Vec3(0, 0, 0);

    // Record the leash anchor as the actor's position at initialization
    this.anchorPosition = new Vec3(startPos.x, startPos.y, startPos.z);

    // Create internal GotoBehavior for movement
    this.gotoBehavior = new GotoBehavior();
    this.gotoBehavior.basePriority = this.basePriority;
    this.gotoBehavior.desiredSpeed = this.wanderSpeed;
    this.gotoBehavior.targetPosition = startPos;
    this.gotoBehavior.distanceToStop = this.arrivalDistance * 0.5;
    // IdleWanderBehavior owns body direction itself; the nested goto must not
    // also claim the body-direction controller and fight it.
    this.gotoBehavior.shouldFaceDirection = false;
    this.gotoBehavior.initialize(this.behaviorManager!);

    // Start in idle state with a random wait
    this.isIdle = true;
    this.idleTimer = this.randomRange(
      this.wanderIntervalMin,
      this.wanderIntervalMax,
    );
  }

  override update(deltaTime: number): void {
    if (!this.gotoBehavior || !this.actorTransform) {
      return;
    }

    if (this.isIdle) {
      // ── Idle: count down, then pick a new target ──
      this.idleTimer -= deltaTime;
      if (this.idleTimer <= 0) {
        this.pickNewTarget();
        this.isIdle = false;
      }
      return;
    }

    // ── Walking: check arrival ──
    const actorPos = this.actorTransform.worldPosition;
    const dx = this.currentTarget.x - actorPos.x;
    const dz = this.currentTarget.z - actorPos.z;
    const horizontalDist = Math.sqrt(dx * dx + dz * dz);

    if (horizontalDist <= this.arrivalDistance) {
      // Arrived — go back to idle
      this.isIdle = true;
      this.idleTimer = this.randomRange(
        this.wanderIntervalMin,
        this.wanderIntervalMax,
      );
      this.desiredBodyDirection = null;
      return;
    }

    // Update body direction to face the walk direction.
    // The body direction controller expects the world-space direction the
    // actor should face — i.e. actor → target.
    if (this.rotateTowardsMovement && horizontalDist > 0.001) {
      this.desiredBodyDirection = new Vec3(dx, 0, dz).normalize();
    }

    // Drive GotoBehavior toward the target
    this.gotoBehavior.targetPosition = this.currentTarget;
    this.gotoBehavior.desiredSpeed = this.wanderSpeed;
    this.gotoBehavior.update(deltaTime);
  }

  // ── Target picking ─────────────────────────────────────────────────

  /**
   * Picks a random position on the XZ plane relative to the actor's
   * current position, within the configured radius range. If leashing
   * is enabled and the candidate exceeds leashRadius from the anchor,
   * the point is clamped back onto the leash boundary.
   */
  private pickNewTarget(): void {
    if (!this.actorTransform) {
      return;
    }

    const actorPos = this.actorTransform.worldPosition;

    // Random angle in [0, 2π) and distance in [wanderRadiusMin, wanderRadiusMax]
    const angle = Math.random() * Math.PI * 2;
    const distance = this.randomRange(this.wanderRadiusMin, this.wanderRadiusMax);

    let candidateX = actorPos.x + Math.cos(angle) * distance;
    let candidateZ = actorPos.z + Math.sin(angle) * distance;

    // Leash clamping: ensure candidate stays within leashRadius of anchor
    if (this.leashRadius > 0) {
      const offsetX = candidateX - this.anchorPosition.x;
      const offsetZ = candidateZ - this.anchorPosition.z;
      const distFromAnchor = Math.sqrt(offsetX * offsetX + offsetZ * offsetZ);

      if (distFromAnchor > this.leashRadius) {
        // Scale the offset vector down to leashRadius length
        const scale = this.leashRadius / distFromAnchor;
        candidateX = this.anchorPosition.x + offsetX * scale;
        candidateZ = this.anchorPosition.z + offsetZ * scale;
      }
    }

    // Keep the same Y as the actor (XZ-plane wander only)
    this.currentTarget = new Vec3(candidateX, actorPos.y, candidateZ);

    if (this.gotoBehavior) {
      this.gotoBehavior.targetPosition = this.currentTarget;
    }
  }

  // ── Controller delegation ──────────────────────────────────────────

  override getControllerUsePriority(controllerType: string): number {
    // While idle, don't claim any controllers
    if (this.isIdle || !this.gotoBehavior) {
      return super.getControllerUsePriority(controllerType);
    }

    // Claim body direction controller if we want to face the walk direction
    if (
      controllerType === ActorBodyDirectionControllerTypeId &&
      this.desiredBodyDirection
    ) {
      return this.basePriority;
    }

    // Delegate movement controller to GotoBehavior
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

  // ── Helpers ────────────────────────────────────────────────────────

  /** Returns a random value in [min, max]. */
  private randomRange(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }
}
