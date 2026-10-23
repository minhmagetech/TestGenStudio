// @generated - Actor Framework Scripts v12
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {
  AnimatorComponent,
  Component,
  component,
  editor,
  property,
  subscribe,
  ExecuteOn,
  OnEntityCreateEvent,
  OnWorldUpdateEvent,
  TransformComponent,
  Vec3,
  type Entity,
} from 'meta/worlds';
import type {OnWorldUpdateEventPayload} from 'meta/worlds';
import {resolveAnimatorComponent} from '../../Utilities/ResolveAnimatorComponent';

/**
 * ActorAnimatedMovementController — Drives animation graph variables for NPC locomotion
 * by measuring actual entity displacement each frame.
 *
 * Unlike the player's AnimationController (which reads input from MovementAbility),
 * this controller observes the entity's world position delta, smooths it over a
 * configurable frame window, and writes the same variables the animation graph
 * expects directly to `AnimatorComponent`: Speed, MovementDirectionYaw, IsGrounded,
 * IsJumping, ShouldStrafe.
 *
 * This makes it work with any movement source (Actor Framework behaviors, physics,
 * scripted paths) without coupling to a specific input provider.
 *
 * The `AnimatorComponent` is resolved via the standard fallback chain:
 * `animatedEntity` → this entity → first child with an `AnimatorComponent`.
 *
 * Animation Variables Set (via AnimatorComponent.setGraphVariable):
 * - Speed: Raw magnitude of the horizontal velocity vector (not decomposed)
 * - MovementDirectionYaw: Angle (-180 to 180) of movement relative to entity facing
 * - IsGrounded: Whether the entity is on the ground (default true, set via API)
 * - IsJumping: Whether the entity is jumping (default false, set via API)
 * - ShouldStrafe: Enables strafe blend mode in the animation graph (set to true)
 */
@component({
  description:
    'NPC animation controller that drives AnimatorComponent graph variables from observed entity movement with frame smoothing',
})
export class ActorAnimatedMovementController extends Component {
  /**
   * Number of frames to average velocity over for smoothing.
   * Higher values = smoother but less responsive.
   * Lower values = more responsive but potentially jittery.
   *
   * 🚨 Template gotcha: a template instance stores `0` here even though the
   * field initializer is `10`. Set `10` explicitly.
   */
  @property()
  public smoothingFrameCount: number = 10;

  /**
   * Maximum speed before clamping (m/s).
   * Prevents spikes from teleportation or physics glitches.
   *
   * 🚨 Template gotcha: stored as `0` on a template instance — a `0` clamps
   * all motion to zero. Set `10.0` explicitly.
   */
  @property()
  public maxSpeedClamp: number = 10.0;

  /**
   * Multiplier applied to calculated speed before posting to the AnimatorComponent.
   * Useful for tuning animation blend thresholds.
   *
   * 🚨 Template gotcha: stored as `0` on a template instance — a `0` freezes
   * locomotion animation entirely. Set `1.0` explicitly.
   */
  @property()
  public speedMultiplier: number = 1.0;

  /**
   * Speeds below this threshold are treated as zero.
   * Prevents micro-movements from triggering locomotion animations.
   *
   * 🚨 Template gotcha: stored as `0` on a template instance, which disables
   * the micro-movement filter. Set `0.01` explicitly.
   */
  @property()
  public minSpeedThreshold: number = 0.01;

  @property()
  public debugLogEnabled: boolean = false;

  /**
   * Optional entity to get the AnimatorComponent from.
   * If set, the AnimatorComponent will be retrieved from this entity.
   * If null, falls back to this.entity, then to child entities.
   */
  @property()
  @editor({description: 'Optional entity containing the AnimatorComponent. If null, searches this entity and children.'})
  animatedEntity: Entity | null = null;

  private transformComponent: TransformComponent | null = null;
  private animatorComponent: AnimatorComponent | null = null;

  private lastFramePosition: Vec3 = new Vec3(0, 0, 0);
  private initialized: boolean = false;

  private velocityBuffer: Vec3[] = [];
  private bufferIndex: number = 0;

  private isGrounded: boolean = true;
  private isJumping: boolean = false;

  @subscribe(OnEntityCreateEvent, {execution: ExecuteOn.Everywhere})
  private onCreate(): void {
    this.transformComponent = this.entity.getComponent(TransformComponent);
    this.animatorComponent = null;

    this.lastFramePosition = new Vec3(0, 0, 0);
    this.initialized = false;
    this.initializeVelocityBuffer();
  }

  /**
   * Resolves the AnimatorComponent lazily on first update so that any
   * AnimatorComponent attached at scene load time is available.
   */
  private resolveAnimator(): AnimatorComponent | null {
    if (this.animatorComponent) {
      return this.animatorComponent;
    }
    this.animatorComponent = resolveAnimatorComponent(this.entity, this.animatedEntity);
    return this.animatorComponent;
  }

  private initializeVelocityBuffer(): void {
    const frameCount = Math.max(1, Math.floor(this.smoothingFrameCount));
    this.velocityBuffer = Array.from(
      {length: frameCount},
      () => new Vec3(0, 0, 0),
    );
    this.bufferIndex = 0;
  }

  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  private onUpdate(payload: OnWorldUpdateEventPayload): void {
    const animator = this.resolveAnimator();
    if (!this.transformComponent || !animator) {
      return;
    }

    const worldPosition = this.transformComponent.worldPosition;
    const deltaTime = payload.deltaTime;

    if (!this.initialized) {
      this.lastFramePosition = worldPosition;
      this.initialized = true;
      return;
    }

    if (deltaTime < 0.0001) {
      return;
    }

    // Measure horizontal displacement and derive frame velocity as scalars
    // (vertical component dropped). Kept scalar so no per-frame Vec3 is
    // allocated in this update handler.
    const displacement = worldPosition.sub(this.lastFramePosition);
    const frameVelocityX = displacement.x / deltaTime;
    const frameVelocityZ = displacement.z / deltaTime;
    this.lastFramePosition = worldPosition;

    // Smooth velocity over N frames
    this.addVelocityToBuffer(frameVelocityX, frameVelocityZ);
    const smoothedVelocity = this.calculateSmoothedVelocity();

    // Clamp speed magnitude and apply threshold + multiplier
    const rawSpeed = smoothedVelocity.magnitude();
    const clampedSpeed = Math.min(rawSpeed, this.maxSpeedClamp);
    const finalSpeed =
      clampedSpeed < this.minSpeedThreshold
        ? 0
        : clampedSpeed * this.speedMultiplier;

    // Calculate movement direction relative to entity facing
    const movementYaw = this.calculateMovementDirectionYaw(smoothedVelocity);

    // Write directly to the AnimatorComponent graph variables
    animator.setGraphVariable('Speed', finalSpeed);
    animator.setGraphVariable('IsGrounded', this.isGrounded);
    animator.setGraphVariable('IsJumping', this.isJumping);
    animator.setGraphVariable('MovementDirectionYaw', movementYaw);
    animator.setGraphVariable('ShouldStrafe', true);

    this.logDebug(finalSpeed, movementYaw);
  }

  /**
   * Calculates the angle of the velocity vector relative to the entity's
   * forward direction, in degrees (-180 to 180).
   *
   * Projects velocity onto the entity's forward and right axes, then
   * uses atan2 to get the signed angle. Positive = rightward, negative = leftward.
   */
  private calculateMovementDirectionYaw(velocity: Vec3): number {
    const speed = velocity.magnitude();
    if (speed < 0.0001 || !this.transformComponent) {
      return 0;
    }

    const forward = this.transformComponent.worldForward;
    const right = this.transformComponent.worldRight;

    // Project velocity onto entity's local axes
    const forwardDot = velocity.dot(forward);
    const rightDot = velocity.dot(right);

    // atan2(-right, forward) gives signed angle from forward in radians
    // Negated so positive yaw = leftward movement (matches animation graph convention)
    const angleRad = Math.atan2(-rightDot, forwardDot);
    return angleRad * (180 / Math.PI);
  }

  /**
   * Emits a per-frame locomotion debug line. Opt-in via `debugLogEnabled`
   * (off by default).
   */
  private logDebug(finalSpeed: number, movementYaw: number): void {
    if (this.debugLogEnabled) {
      console.log(
        `[ActorAnimatedMovementController] Speed: ${finalSpeed.toFixed(3)}, Yaw: ${movementYaw.toFixed(1)}`,
      );
    }
  }

  private addVelocityToBuffer(velocityX: number, velocityZ: number): void {
    const frameCount = Math.max(1, Math.floor(this.smoothingFrameCount));
    if (this.velocityBuffer.length !== frameCount) {
      this.initializeVelocityBuffer();
    }
    this.velocityBuffer[this.bufferIndex] = new Vec3(velocityX, 0, velocityZ);
    this.bufferIndex = (this.bufferIndex + 1) % frameCount;
  }

  private calculateSmoothedVelocity(): Vec3 {
    let sumX = 0;
    let sumZ = 0;
    const frameCount = this.velocityBuffer.length;
    for (let i = 0; i < frameCount; i++) {
      const v = this.velocityBuffer[i];
      sumX += v.x;
      sumZ += v.z;
    }
    return new Vec3(sumX / frameCount, 0, sumZ / frameCount);
  }

  // --- Public API for external systems (behaviors, controllers) ---

  /**
   * Sets grounded state. Call from ground detection or behavior logic.
   */
  public setGrounded(grounded: boolean): void {
    this.isGrounded = grounded;
  }

  /**
   * Sets jumping state. Call from jump behavior logic.
   */
  public setJumping(jumping: boolean): void {
    this.isJumping = jumping;
  }

  /**
   * Resets the velocity buffer. Call after teleporting or repositioning
   * to prevent a velocity spike on the next frame.
   */
  public resetVelocityBuffer(): void {
    this.initializeVelocityBuffer();
    if (this.transformComponent) {
      this.lastFramePosition = this.transformComponent.worldPosition;
    }
    this.initialized = true;
  }

  /**
   * Updates the smoothing window size at runtime.
   */
  public setSmoothingFrameCount(frameCount: number): void {
    this.smoothingFrameCount = Math.max(1, Math.floor(frameCount));
    this.initializeVelocityBuffer();
  }
}
