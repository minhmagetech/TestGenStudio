/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

/**
 * ThirdPersonCamera - Input-driven third-person camera with collision avoidance
 *
 * Component Attachment: Scene entity (NOT on player) - must have CameraPlatformComponent
 * Component Networking: Local (camera is client-only)
 * Component Ownership: Not networked - runs on all clients locally
 *
 * Based on BBArena's third-person camera with angle-space smoothing to prevent
 * quaternion hemisphere-crossing oscillation during rapid rotation.
 *
 * Control scheme:
 * - RIGHT STICK / MOUSE: Control camera yaw (horizontal) and pitch (vertical)
 * - Camera orbits around the player at a configurable distance and height
 * - Movement scripts should use CameraService.get().forward for camera-relative movement
 *
 * Exposes inputToWorldDirection() for converting screen-relative input to world direction
 * for movement scripts.
 *
 * Usage:
 * 1. Create a "Camera" entity in the scene
 * 2. Add CameraPlatformComponent to it
 * 3. Add this ThirdPersonCamera script component
 * 4. In movement scripts, use CameraService.get().forward or
 *    ThirdPersonCamera.get()?.inputToWorldDirection(inputX, inputY)
 *
 * NOTE: This camera subscribes to PlayerInputAxis.Right. If using
 * ThirdPersonControllerInputAligned (which also subscribes to Right for player
 * rotation), there will be an input conflict. The default CharacterUpdateManager
 * + MovementAbility system does NOT use the right stick, so there is no conflict
 * with the default setup.
 */

import {
  component,
  Component,
  subscribe,
  OnEntityStartEvent,
  OnPlayerCreateEvent,
  OnLateWorldUpdateEvent,
  OnWorldUpdateEventPayload,
  TransformComponent,
  Vec3,
  Quaternion,
  ExecuteOn,
  property,
  editor,
  CameraService,
  CameraMode,
  CameraComponent,
  NetworkingService,
  PlayerService,
  PlayerInputService,
  PlayerInputAxis,
  PlayerInputAxisCallbackPayload,
  PhysicsService,
  PhysicsBodyComponent,
  PhysicsBodyType,
  CastMode,
  SceneHitData,
  CollisionLayer,
  Service,
  lerp,
  WorldService,
} from 'meta/worlds';
import type {Entity, Maybe, RayCastInput, PlayerInputSubscription} from 'meta/worlds';

// Auto-follow heading guard: skip correction when the camera is nearly head-on with the
// movement (>= this angle). Prevents left/right flip-flop when the player runs straight
// toward the camera. The lower bound is the per-project autoFollowDeadZone property.
const AUTO_FOLLOW_MAX_ANGLE = 165;
// Minimum squared XZ movement (world units^2) per frame for the target to count as
// "moving" for auto-follow. Filters out positional jitter when standing still.
const AUTO_FOLLOW_MIN_MOVE_SQ = 0.0001;

/**
 * Camera collision state machine (matching C++ CameraCollision implementation).
 * States: NoCollision -> Collided -> WaitingToReturn -> Returning
 */
enum CameraCollisionState {
  NoCollision,
  Collided,
  WaitingToReturn,
  Returning,
}

@component({
  description:
    'Input-driven third-person camera with collision avoidance and angle-space smoothing',
})
export class ThirdPersonCamera extends Component {
  // ============================================
  // Static Singleton
  // ============================================

  private static instance: Maybe<ThirdPersonCamera> = null;

  /**
   * Get the ThirdPersonCamera instance.
   * Use this from movement scripts to access inputToWorldDirection().
   */
  public static get(): Maybe<ThirdPersonCamera> {
    return ThirdPersonCamera.instance;
  }

  // ============================================
  // Services
  // ============================================

  private playerService = Service.inject(PlayerService);
  private playerInputService = Service.inject(PlayerInputService);
  private physicsService = Service.inject(PhysicsService);
  private worldService = Service.inject(WorldService);

  // ============================================
  // Target & Transform References
  // ============================================

  private targetEntity: Entity | null = null;
  private targetTransform: TransformComponent | null = null;
  private cameraTransform: TransformComponent | null = null;
  private inputSubscription: PlayerInputSubscription | null = null;

  // ============================================
  // Input State: Raw accumulated yaw/pitch
  // ============================================

  private currentYaw: number = 0;
  private currentPitch: number = 0;

  // ============================================
  // Angle-Space Smoothing
  // ============================================
  //
  // Smoothing happens in angle-space rather than via quaternion slerp to avoid
  // hemisphere-crossing oscillation: Quaternion.fromEuler produces quaternions
  // that flip hemisphere at 360 degrees of yaw, and slerp can interpolate the
  // long way around, causing the camera to swing backward during rapid rotation.

  private smoothedYaw: number = 0;
  private smoothedPitch: number = 0;
  private lastSmoothedPosition: Vec3 | null = null;
  private cachedRaycastResult: {hasCollision: boolean; hitDistance: number} = {hasCollision: false, hitDistance: 0};

  // ============================================
  // Auto-Follow State (one-thumb support)
  // ============================================

  private lastManualInputTime: number = 0;
  private lastTargetPosition: Vec3 | null = null;
  // Ramp factor 0..1: climbs to 1 over autoFollowRampDuration while actively following,
  // decays back to 0 the same way when not, so engagement/disengagement stays smooth.
  private autoFollowRamp: number = 0;

  // ============================================
  // Collision State Machine
  // ============================================

  private collisionState: CameraCollisionState =
    CameraCollisionState.NoCollision;
  private currentCollisionDistance: number = 0;
  private closestCollisionDistance: number = 0;
  private uncollidedDistance: number = 0;
  private returnTimer: number = 0;
  private collisionFactor: number = 0;
  private collisionLayerMask: number = 0;

  private static readonly returnDelay = 0.5;
  private static readonly returnDuration = 0.75;

  // Usable CameraComponent ranges, deliberately tighter than the WSDK API
  // (nearClip 0.001-1000, FOV 20-180): a remixed world can inherit a nearClip
  // that clips the whole scene and reads as the camera stuck at ground level.
  // Only out-of-range values change; these caps mirror the engine spawn-path
  // backstop in CameraPlatformComponent.
  private static readonly MIN_NEAR_CLIP = 0.001;
  private static readonly MAX_NEAR_CLIP = 0.05;
  private static readonly DEFAULT_NEAR_CLIP = 0.01;
  private static readonly DEFAULT_FAR_CLIP = 500;
  private static readonly MIN_FOV = 20;
  private static readonly MAX_FOV = 120;

  // ============================================
  // Configurable Properties
  // ============================================

  /** Distance behind the player in world units */
  @editor({show: true})
  @property()
  public targetDistance: number = 8;

  /** Height offset above the player (shoulder/head level) */
  @editor({show: true})
  @property()
  public shoulderHeight: number = 2;

  /** Horizontal offset for over-the-shoulder view (0 = centered) */
  @editor({show: true})
  @property()
  public shoulderOffset: number = 0;

  /** Base rotation offset applied before input rotation */
  @editor({show: true})
  @property()
  public rotationOffset: Quaternion = new Quaternion(0, 0, 0, 1);

  /** Translation smoothing speed. Higher = faster follow. */
  @editor({show: true})
  @property()
  public translationSpeed: number = 5;

  /**
   * Rotation smoothing speed. Higher = snappier rotation.
   * Uses exponential decay in angle-space: lerp = 1 - pow(4, -speed * dt)
   */
  @editor({show: true})
  @property()
  public rotationSpeed: number = 8;

  /** Mouse/stick sensitivity for camera rotation */
  @editor({show: true})
  @property()
  public mouseSensitivity: number = 100;

  /** Minimum pitch angle in degrees (looking up, negative = up) */
  @editor({show: true})
  @property()
  public minPitch: number = -80;

  /** Maximum pitch angle in degrees (looking down) */
  @editor({show: true})
  @property()
  public maxPitch: number = 5;

  /** Default pitch angle on start (negative = looking slightly down) */
  @editor({show: true})
  @property()
  public defaultPitch: number = -15;

  /** Enable camera collision avoidance */
  @editor({show: true})
  @property()
  public enableCollision: boolean = true;

  /** Collision sphere radius for raycasting */
  @editor({show: true})
  @property()
  public collisionRadius: number = 0.1;

  /** Maximum number of unsorted raycast hits to process */
  @property()
  public numRaycastAttempts: number = 9;

  /** Collision layers to check against */
  @editor({show: true})
  @property()
  public readonly collisionLayers: readonly CollisionLayer[] = [
    CollisionLayer.Layer2,
  ];

  /** Field of view in degrees */
  @editor({show: true})
  @property()
  public fieldOfView: number = 60;

  // ============================================
  // Auto-Follow (one-thumb) Configurable Properties
  // ============================================

  /**
   * Enable Roblox-style auto-follow: the camera automatically rotates to stay behind the
   * player's movement direction, allowing one-thumb play. Set false to restore the
   * original right-stick/mouse-only behavior.
   */
  @editor({show: true})
  @property()
  public autoFollowEnabled: boolean = true;

  /** Seconds of no manual camera input before auto-follow re-engages. */
  @editor({show: true})
  @property()
  public autoFollowDelay: number = 2.0;

  /** Auto-follow rotation speed in degrees per second (constant angular rate). */
  @editor({show: true})
  @property()
  public autoFollowSpeed: number = 50.0;

  /** Dead zone in degrees; auto-follow ignores heading errors smaller than this. */
  @editor({show: true})
  @property()
  public autoFollowDeadZone: number = 30.0;

  /** Seconds to ramp the auto-follow turn rate from 0 to full speed (and back to 0). */
  @editor({show: true})
  @property()
  public autoFollowRampDuration: number = 0.5;

  // ============================================
  // Lifecycle
  // ============================================

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  onStart() {
    if (NetworkingService.get().isServerContext()) {
      return;
    }

    ThirdPersonCamera.instance = this;

    this.cameraTransform = this.entity.getComponent(TransformComponent);

    this.refreshTarget();

    // Subscribe to right stick/mouse for camera rotation
    this.inputSubscription =
      this.playerInputService.subscribePlayerInputAxis(
        this,
        PlayerInputAxis.Right,
        this.onCameraInput.bind(this),
      );

    // Initialize yaw/pitch
    this.currentYaw = 0;
    this.currentPitch = this.defaultPitch;
    this.smoothedYaw = this.currentYaw;
    this.smoothedPitch = this.currentPitch;

    // Set up collision layer mask
    this.collisionLayerMask = 0;
    for (const layer of this.collisionLayers) {
      this.collisionLayerMask |= 1 << layer;
    }
    if (this.enableCollision && this.collisionLayerMask === 0) {
      console.warn(
        '[ThirdPersonCamera] Collision enabled but no collision layers set.',
      );
      this.enableCollision = false;
    }

    this.activateCustomCamera();
  }

  /**
   * Re-acquire target and re-activate camera after player spawns.
   * The engine resets camera mode on player creation.
   */
  @subscribe(OnPlayerCreateEvent, {execution: ExecuteOn.Everywhere})
  onPlayerCreate() {
    if (NetworkingService.get().isServerContext()) {
      return;
    }

    this.refreshTarget();
    this.activateCustomCamera();
  }

  // ============================================
  // Update Loop
  // ============================================

  @subscribe(OnLateWorldUpdateEvent, {execution: ExecuteOn.Everywhere})
  onLateUpdate(event: OnWorldUpdateEventPayload) {
    if (NetworkingService.get().isServerContext()) {
      return;
    }

    this.updateAttachedCamera(event.deltaTime);
  }

  // ============================================
  // Camera Input
  // ============================================

  private onCameraInput(data: PlayerInputAxisCallbackPayload): void {
    if (!data.value) {
      return;
    }

    // Record manual camera input so auto-follow stays suppressed for autoFollowDelay
    // seconds after the player releases the right stick / mouse.
    if (Math.abs(data.value.x) > 0.001 || Math.abs(data.value.y) > 0.001) {
      this.lastManualInputTime = this.worldService.getWorldTime();
    }

    const deltaYaw = -data.value.x * this.mouseSensitivity * 0.01;
    const deltaPitch = -data.value.y * this.mouseSensitivity * 0.01;

    this.currentYaw += deltaYaw;
    this.currentPitch += deltaPitch;
    this.currentPitch = Math.max(
      this.minPitch,
      Math.min(this.maxPitch, this.currentPitch),
    );
  }

  // ============================================
  // Camera Update with Angle-Space Smoothing
  // ============================================

  private updateAttachedCamera(deltaTime: number): void {
    if (!this.targetEntity || !this.targetTransform) {
      this.refreshTarget();
      return;
    }

    const targetPosition = this.targetTransform.worldPosition;
    const targetScale = this.targetTransform.worldScale;
    const maxScale = Math.max(targetScale.x, targetScale.y, targetScale.z);

    // Auto-follow may rotate currentYaw before the angle-space smoothing below.
    this.updateAutoFollow(targetPosition, deltaTime);

    // Calculate pivot position (target + shoulder height)
    const pivotPosition = targetPosition.add(
      new Vec3(0, this.shoulderHeight * maxScale, 0),
    );

    // Local-space offsets (reused for smoothed rotation and distance math)
    const shoulderOffsetLocal = new Vec3(
      this.shoulderOffset * maxScale,
      0,
      0,
    );
    const backwardLocal = new Vec3(0, 0, this.targetDistance * maxScale);

    // Smooth yaw and pitch angles directly rather than slerping quaternions.
    // Angle-space smoothing avoids hemisphere-crossing oscillation entirely.
    if (this.rotationSpeed > 0) {
      const rotationLerp =
        1.0 - Math.pow(4.0, -this.rotationSpeed * deltaTime);
      this.smoothedYaw +=
        (this.currentYaw - this.smoothedYaw) * rotationLerp;
      this.smoothedPitch +=
        (this.currentPitch - this.smoothedPitch) * rotationLerp;
    } else {
      this.smoothedYaw = this.currentYaw;
      this.smoothedPitch = this.currentPitch;
    }

    // Build rotation from smoothed angles (not from raw input + slerp)
    const yawRotation = Quaternion.fromEuler(
      new Vec3(0, this.smoothedYaw, 0),
    );
    const pitchRotation = Quaternion.fromEuler(
      new Vec3(this.smoothedPitch, 0, 0),
    );
    const smoothedInputRotation = yawRotation.mul(pitchRotation);
    const finalRotation = this.rotationOffset.mul(smoothedInputRotation);

    // Derive orbit position from the smoothed rotation.
    // Direct position interpolation produces artifacts: Vec3.lerp creates
    // chords (camera dips toward player), and Vec3 slerp causes vertical
    // tilt (great-circle arcs leave the orbit plane). Using the quaternion-
    // derived position avoids both — the camera stays on the correct orbit.
    const smoothedShoulder = finalRotation.mulVec3(shoulderOffsetLocal);
    const smoothedBackward = finalRotation.mulVec3(backwardLocal);
    const orbitPosition = pivotPosition
      .add(smoothedShoulder)
      .add(smoothedBackward);

    // Collision uses the previous frame's raycast distance and dispatches a
    // new raycast for the next frame. The one-frame lag is imperceptible
    // because the collision state machine already smooths transitions.
    const finalCameraPosition = this.updateCameraCollision(
      pivotPosition,
      orbitPosition,
      maxScale,
      deltaTime,
    );

    // Smoothly interpolate radial distance for collision-induced zoom
    let finalPosition = finalCameraPosition;
    if (this.translationSpeed > 0) {
      const translationLerp =
        1.0 - Math.pow(4.0, -this.translationSpeed * deltaTime);
      const orbitOffset = orbitPosition.sub(pivotPosition);
      const orbitMag = orbitOffset.magnitude();
      const desiredMag = finalCameraPosition.sub(pivotPosition).magnitude();
      const currentMag = (this.lastSmoothedPosition ?? finalCameraPosition)
        .sub(pivotPosition)
        .magnitude();
      const smoothedMag =
        currentMag + (desiredMag - currentMag) * translationLerp;

      if (orbitMag > 0.001) {
        finalPosition = pivotPosition.add(
          orbitOffset.mul(smoothedMag / orbitMag),
        );
      } else {
        finalPosition = orbitPosition;
      }
    }

    // Store smoothed position for next frame's distance interpolation
    this.lastSmoothedPosition = finalPosition;

    // Update camera transform
    if (this.cameraTransform) {
      this.cameraTransform.worldPosition = finalPosition;
      this.cameraTransform.worldRotation = finalRotation;
    }
  }

  // ============================================
  // Auto-Follow (one-thumb support)
  // ============================================

  /**
   * Rotates currentYaw to keep the camera behind the player's movement direction.
   *
   * Measures the target's actual world-space XZ movement and, after autoFollowDelay
   * seconds with no manual input, turns currentYaw toward "behind the movement" at a
   * constant angular rate (deg/sec), gated by a 0..1 ramp, the dead zone, and a
   * near-180° guard. Because it writes currentYaw, the existing angle-space smoothing in
   * updateAttachedCamera still applies on top. Pitch is intentionally never touched.
   */
  private updateAutoFollow(targetPosition: Vec3, deltaTime: number): void {
    if (!this.autoFollowEnabled) {
      return;
    }

    let isActivelyFollowing = false;
    let angleDiff = 0;
    let absAngle = 0;

    if (this.lastTargetPosition !== null) {
      const dx = targetPosition.x - this.lastTargetPosition.x;
      const dz = targetPosition.z - this.lastTargetPosition.z;
      const movementDistSq = dx * dx + dz * dz;
      const timeSinceInput =
        this.worldService.getWorldTime() - this.lastManualInputTime;

      if (
        movementDistSq > AUTO_FOLLOW_MIN_MOVE_SQ &&
        timeSinceInput > this.autoFollowDelay
      ) {
        // "Behind the movement direction": yaw points opposite to motion.
        const desiredYaw = Math.atan2(-dx, -dz) * (180 / Math.PI);

        // Shortest signed angular difference wrapped to [-180, 180].
        angleDiff = desiredYaw - this.currentYaw;
        angleDiff = ((((angleDiff + 180) % 360) + 360) % 360) - 180;
        absAngle = Math.abs(angleDiff);

        // Skip the dead zone and the near-180° backpedal (prevents flip-flopping when
        // the player runs straight at the camera).
        isActivelyFollowing =
          absAngle > this.autoFollowDeadZone &&
          absAngle < AUTO_FOLLOW_MAX_ANGLE;
      }
    }
    this.lastTargetPosition = targetPosition;

    // Linear ramp: full ramp duration to climb 0→1 or fall 1→0.
    const rampStep =
      this.autoFollowRampDuration > 0
        ? deltaTime / this.autoFollowRampDuration
        : 1.0;
    this.autoFollowRamp = isActivelyFollowing
      ? Math.min(1.0, this.autoFollowRamp + rampStep)
      : Math.max(0.0, this.autoFollowRamp - rampStep);

    // Constant angular speed (deg/sec) scaled only by the ramp, clamped so we never
    // overshoot the desired heading in a single frame.
    if (this.autoFollowRamp > 0 && isActivelyFollowing) {
      const stepDeg = this.autoFollowSpeed * this.autoFollowRamp * deltaTime;
      const step = Math.min(stepDeg, absAngle);
      this.currentYaw += step * Math.sign(angleDiff);
    }
  }

  // ============================================
  // Camera Collision (matching C++ CameraCollision)
  // ============================================

  /**
   * Uses the previous frame's raycast result and dispatches a new raycast
   * (fire-and-forget) for the next frame. The one-frame lag on collision
   * distance is imperceptible because the state machine already smooths
   * collision transitions.
   */
  private updateCameraCollision(
    pivotPosition: Vec3,
    desiredCameraPosition: Vec3,
    scale: number,
    deltaTime: number,
  ): Vec3 {
    if (!this.enableCollision) {
      return desiredCameraPosition;
    }

    const direction = desiredCameraPosition.sub(pivotPosition);
    const rayDirection = direction.normalize();
    this.uncollidedDistance = direction.magnitude();
    this.currentCollisionDistance = this.uncollidedDistance;

    // Use the previous frame's raycast result
    if (this.cachedRaycastResult.hasCollision) {
      this.currentCollisionDistance = Math.max(
        0,
        Math.min(this.cachedRaycastResult.hitDistance, this.uncollidedDistance),
      );
    }

    // Dispatch a new raycast for the next frame (fire-and-forget)
    void this.dispatchCollisionRaycast(
      pivotPosition,
      rayDirection,
      this.uncollidedDistance,
      scale,
    );

    // Update collision state machine
    this.updateCollisionState(
      this.cachedRaycastResult.hasCollision,
      deltaTime,
    );

    // Calculate final camera position with collision adjustment
    const collidedPosition = pivotPosition.add(
      rayDirection.mul(this.closestCollisionDistance),
    );
    return Vec3.lerp(
      desiredCameraPosition,
      collidedPosition,
      this.collisionFactor,
    );
  }

  /**
   * Dispatches an async raycast and caches the result for the next frame.
   */
  private async dispatchCollisionRaycast(
    origin: Vec3,
    direction: Vec3,
    distance: number,
    scale: number,
  ): Promise<void> {
    this.cachedRaycastResult =
      await this.raycastToClosestObstructingObject(
        origin,
        direction,
        distance,
        scale,
      );
  }

  /**
   * Performs raycast to detect closest obstructing object.
   * Filters out the target entity and non-static physics bodies.
   */
  private async raycastToClosestObstructingObject(
    origin: Vec3,
    direction: Vec3,
    distance: number,
    scale: number,
  ): Promise<{hasCollision: boolean; hitDistance: number}> {
    try {
      const raycastInput: RayCastInput = {
        origin: origin,
        dir: direction,
        distance: distance * scale,
        mode: CastMode.UnsortedHits,
        maxUnsortedHits: this.numRaycastAttempts,
        collisionLayerMask: this.collisionLayerMask,
      };

      const castOutput = await this.physicsService.rayCast(raycastInput);

      if (
        castOutput.hasHitSomething &&
        castOutput.hits &&
        castOutput.hits.length > 0
      ) {
        let closestHit: SceneHitData | null = null;
        for (const hit of castOutput.hits) {
          // Skip hits on the target entity (player)
          if (
            hit.actorEntity === this.targetEntity ||
            hit.shapeEntity === this.targetEntity
          ) {
            continue;
          }

          // Only collide with static objects (walls, floors, etc.)
          const physicsBody =
            hit.actorEntity?.getComponent(PhysicsBodyComponent);
          if (
            physicsBody &&
            physicsBody.type !== PhysicsBodyType.StaticCollision
          ) {
            continue;
          }

          if (closestHit === null || hit.distance < closestHit.distance) {
            closestHit = hit;
          }
        }

        if (closestHit) {
          const hitDistance = Math.min(closestHit.distance, distance);
          return {hasCollision: true, hitDistance: hitDistance};
        }
      }
    } catch (error) {
      console.error('Camera collision raycast failed:', error);
    }

    return {hasCollision: false, hitDistance: 0};
  }

  /**
   * Updates collision state machine (matching C++ CameraCollision implementation).
   */
  private updateCollisionState(
    isColliding: boolean,
    deltaTime: number,
  ): void {
    if (
      isColliding &&
      (this.collisionState === CameraCollisionState.NoCollision ||
        this.requiresNewCollision())
    ) {
      this.triggerNewCollision();
      return;
    }

    switch (this.collisionState) {
      case CameraCollisionState.NoCollision:
        break;

      case CameraCollisionState.Collided:
        this.collisionState = CameraCollisionState.WaitingToReturn;
        this.returnTimer = ThirdPersonCamera.returnDelay;
        break;

      case CameraCollisionState.WaitingToReturn:
        this.returnTimer -= deltaTime;
        if (this.returnTimer <= 0) {
          this.collisionState = CameraCollisionState.Returning;
          this.returnTimer = ThirdPersonCamera.returnDuration;
        }
        break;

      case CameraCollisionState.Returning: {
        this.returnTimer = Math.max(0, this.returnTimer - deltaTime);
        const t = this.inverseLerp(
          0,
          ThirdPersonCamera.returnDuration,
          this.returnTimer,
        );
        this.collisionFactor = this.smoothStep(0, 1, t);

        if (this.returnTimer === 0) {
          if (isColliding && this.requiresNewCollision()) {
            this.triggerNewCollision();
          } else {
            this.collisionState = CameraCollisionState.NoCollision;
            this.closestCollisionDistance = 0;
          }
        }
        break;
      }
    }
  }

  private requiresNewCollision(): boolean {
    return this.currentCollisionDistance <= this.getReturningDistance();
  }

  private getReturningDistance(): number {
    return lerp(
      this.uncollidedDistance,
      this.closestCollisionDistance,
      this.collisionFactor,
    );
  }

  private triggerNewCollision(): void {
    this.collisionState = CameraCollisionState.Collided;
    this.closestCollisionDistance = this.currentCollisionDistance;
    this.returnTimer = 0;
    this.collisionFactor = 1;
  }

  // ============================================
  // Math Utilities
  // ============================================

  private inverseLerp(a: number, b: number, value: number): number {
    return (value - a) / (b - a);
  }

  private smoothStep(edge0: number, edge1: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  // ============================================
  // Helper Methods
  // ============================================

  private refreshTarget(): void {
    const localPlayer = this.playerService.getLocalPlayer();
    if (!localPlayer) {
      return;
    }

    this.targetEntity = localPlayer;
    this.targetTransform = localPlayer.getComponent(TransformComponent);
    this.cameraTransform = this.entity.getComponent(TransformComponent);

    // Reset auto-follow tracking so a (re)acquired target — e.g. after respawn or
    // teleport — doesn't register a spurious movement delta on the next frame.
    this.lastTargetPosition = null;
    this.autoFollowRamp = 0;
  }

  private activateCustomCamera(): void {
    const cameraComponent = this.entity.getComponent(CameraComponent);
    if (!cameraComponent) {
      console.warn(
        'ThirdPersonCamera: CameraComponent not found! Add CameraPlatformComponent to this entity.',
      );
      return;
    }

    this.sanitizeCameraComponent(cameraComponent);

    CameraService.get().setCameraMode(CameraMode.Custom, {
      camera: cameraComponent,
      fov: this.sanitizedFieldOfView(),
      duration: 0.3,
    });
  }

  /**
   * Resets camera-component values that fall outside a viable range. Guards
   * against inherited configs (e.g. from a remixed source world) whose
   * nearClippingPlane is large enough to clip the entire scene. Only
   * out-of-range values are touched. NaN is caught two ways: the near-plane
   * clamp uses an explicit Number.isNaN check, while the far-plane reset relies
   * on the negated comparison !(far > near), which is true for NaN.
   */
  private sanitizeCameraComponent(cameraComponent: CameraComponent): void {
    const near = cameraComponent.nearClippingPlane;
    const clampedNear = Math.max(
      ThirdPersonCamera.MIN_NEAR_CLIP,
      Math.min(
        ThirdPersonCamera.MAX_NEAR_CLIP,
        Number.isNaN(near) ? ThirdPersonCamera.DEFAULT_NEAR_CLIP : near,
      ),
    );
    if (clampedNear !== near) {
      console.warn(
        `[ThirdPersonCamera] nearClippingPlane ${near} out of range [${ThirdPersonCamera.MIN_NEAR_CLIP}, ${ThirdPersonCamera.MAX_NEAR_CLIP}]; using ${clampedNear}.`,
      );
      cameraComponent.nearClippingPlane = clampedNear;
    }

    // The far plane must sit beyond the near plane or nothing renders.
    if (
      !(cameraComponent.farClippingPlane > cameraComponent.nearClippingPlane)
    ) {
      console.warn(
        `[ThirdPersonCamera] farClippingPlane ${cameraComponent.farClippingPlane} <= nearClippingPlane; resetting to ${ThirdPersonCamera.DEFAULT_FAR_CLIP}.`,
      );
      cameraComponent.farClippingPlane = ThirdPersonCamera.DEFAULT_FAR_CLIP;
    }
  }

  /** Field of view passed to the custom camera, clamped away from degenerate values. */
  private sanitizedFieldOfView(): number {
    const fov = this.fieldOfView;
    if (!(fov >= ThirdPersonCamera.MIN_FOV) || fov > ThirdPersonCamera.MAX_FOV) {
      const clamped = Math.max(
        ThirdPersonCamera.MIN_FOV,
        Math.min(ThirdPersonCamera.MAX_FOV, Number.isNaN(fov) ? 60 : fov),
      );
      console.warn(
        `[ThirdPersonCamera] fieldOfView ${fov} out of range [${ThirdPersonCamera.MIN_FOV}, ${ThirdPersonCamera.MAX_FOV}]; using ${clamped}.`,
      );
      return clamped;
    }
    return fov;
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Convert screen-relative input to world direction.
   * Projects camera forward/right onto XZ plane for horizontal movement.
   *
   * @param inputX - Horizontal input (-1 to 1, positive = right on screen)
   * @param inputY - Vertical input (-1 to 1, positive = forward on screen)
   * @returns World-space direction vector (Y = 0, normalized)
   */
  public inputToWorldDirection(inputX: number, inputY: number): Vec3 {
    if (!this.cameraTransform) {
      const fallback = new Vec3(inputX, 0, inputY);
      return fallback.magnitudeSquared() > 0.001
        ? fallback.normalize()
        : Vec3.zero;
    }

    const rotation = this.cameraTransform.worldRotation;

    // Get camera forward and right in world space
    const camForward = rotation.mulVec3(Vec3.forward);
    const camRight = rotation.mulVec3(Vec3.right);

    // Project to XZ plane for horizontal movement
    const fwdMagSq = camForward.x * camForward.x + camForward.z * camForward.z;
    const rightMagSq = camRight.x * camRight.x + camRight.z * camRight.z;

    if (fwdMagSq < 0.001 || rightMagSq < 0.001) {
      const fallback = new Vec3(inputX, 0, inputY);
      return fallback.magnitudeSquared() > 0.001
        ? fallback.normalize()
        : Vec3.zero;
    }

    const fwdInvMag = 1 / Math.sqrt(fwdMagSq);
    const rightInvMag = 1 / Math.sqrt(rightMagSq);

    // inputY = forward on screen, inputX = right on screen
    const dir = new Vec3(
      camForward.x * fwdInvMag * inputY + camRight.x * rightInvMag * inputX,
      0,
      camForward.z * fwdInvMag * inputY + camRight.z * rightInvMag * inputX,
    );

    const mag = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
    return mag > 0.001 ? dir.mul(1 / mag) : Vec3.zero;
  }
}
