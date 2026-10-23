/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 *
 */

import {
  TransformComponent,
  Quaternion,
  Vec3,
  property,
  editor,
  PlayerService,
  ExecuteOn as Execution,
  OnWorldUpdateEventPayload,
  OnWorldUpdateEvent,
  subscribe,
  OnEntityStartEvent,
  OnPlayerCreateEvent,
  OnPlayerCreateEventPayload,
  Component,
  Service,
  component,
  PlayerInputAxisCallbackPayload,
  PlayerInputAxis,
  PlayerInputService,
  CollisionLayerMask,
  CastMode,
  SceneHitData,
  PhysicsService,
  CameraService,
  CameraComponent,
} from 'meta/worlds';
import type {Entity, PlayerInputSubscription, RayCastInput} from 'meta/worlds';

/**
 * Camera collision state enum (matching C++ CameraCollision implementation)
 * States: NoCollision -> Collided -> WaitingToReturn -> Returning
 */
enum CameraCollisionState {
  NoCollision,
  Collided,
  WaitingToReturn,
  Returning,
}

@component()
export class PlayerCameraComponent extends Component {
  private playerService = Service.inject(PlayerService);
  private playerInputService = Service.inject(PlayerInputService);
  private physicsService = Service.inject(PhysicsService);
  private cameraService: CameraService | null = null;

  private targetEntity: Entity | null = null;
  private inputSubscription: PlayerInputSubscription | null = null;

  // Input-controlled rotation (yaw/pitch)
  private currentYaw: number = 0;
  private currentPitch: number = 0;

  // Camera collision state machine (matching C++ CameraCollision)
  private collisionState: CameraCollisionState =
    CameraCollisionState.NoCollision;
  private currentCollisionDistance: number = 0;
  private closestCollisionDistance: number = 0;
  private uncollidedDistance: number = 0;
  private returnTimer: number = 0;
  private collisionFactor: number = 0;
  private collisionTimer: number = 0;

  // Collision timing constants (matching C++ CameraCollision defaults)
  private static readonly kCollisionDuration = 1.0;
  private static readonly kReturnDelay = 0.5;
  private static readonly kReturnDuration = 0.75;

  /**
   * Optional target entity. If not set, defaults to local player.
   */
  @editor({show: true})
  @property()
  public target: Entity | null = null;

  // Character height for camera pivot (updated from PlayerComponent)
  @editor({show: true})
  @property()
  public characterHeight: number = 1.65;

  /**
   * Position offset from target in local space.
   * X: right/left, Y: up/down, Z: forward/backward (negative = behind)
   */
  @editor({show: true})
  @property()
  public positionOffset: Vec3 = new Vec3(0.3, 1.5, 5);

  /**
   * Base rotation offset applied before input rotation.
   */
  @editor({show: true})
  @property()
  public rotationOffset: Quaternion = new Quaternion(0, 0, 0, 1);

  /**
   * Translation smoothing speed. Higher = faster follow.
   * Uses exponential decay: lerp = 1 - pow(4, -speed * dt)
   */
  @editor({show: true})
  @property()
  public translationSpeed: number = 5;

  /**
   * Rotation smoothing speed. Higher = snappier rotation.
   * Uses exponential decay: lerp = 1 - pow(4, -speed * dt)
   */
  @editor({show: true})
  @property()
  public rotationSpeed: number = 3;

  /**
   * Mouse/stick sensitivity for camera rotation.
   */
  @editor({show: true})
  @property()
  public mouseSensitivity: number = 100;

  /**
   * Minimum pitch angle in degrees (looking up).
   */
  @editor({show: true})
  @property()
  public minPitch: number = -80;

  /**
   * Maximum pitch angle in degrees (looking down).
   */
  @editor({show: true})
  @property()
  public maxPitch: number = 80;

  /**
   * Enable camera collision avoidance.
   */
  @editor({show: true})
  @property()
  public enableCollision: boolean = true;

  /**
   * Collision sphere radius for raycasting.
   */
  @editor({show: true})
  @property()
  public collisionRadius: number = 0.1;

  /**
   * If true, adjusts camera pivot to avoid target entity blocking the view.
   */
  @editor({show: true})
  @property()
  public avoidCollisionWithTarget: boolean = false;

  /**
   * Collision interpolation duration in seconds.
   * Set to 0 for instant collision response (no smooth transition).
   * Higher values = slower, smoother camera pull-in when hitting walls.
   */
  @editor({show: true})
  @property()
  public collisionInterpolationDuration: number = 0;

  @subscribe(OnEntityStartEvent)
  onStart() {
    // Get the local player - if none exists, wait for OnPlayerCreateEvent
    const localPlayer = this.playerService.getLocalPlayer();
    if (!localPlayer) {
      return;
    }

    this.initializeWithTarget(localPlayer);
  }

  @subscribe(OnPlayerCreateEvent)
  onPlayerCreate(payload: OnPlayerCreateEventPayload) {
    // Only handle local player
    if (!payload.isLocal || !payload.entity) {
      return;
    }

    this.initializeWithTarget(payload.entity);
  }

  /**
   * Initializes the camera with the given target entity.
   */
  private initializeWithTarget(localPlayer: Entity): void {
    // Use specified target or default to local player
    if (this.target == null) {
      this.targetEntity = localPlayer;
    } else {
      this.targetEntity = this.target;
    }

    // Set this entity as the active custom camera
    this.cameraService = CameraService.get();
    const cameraComponent = this.entity.getComponent(CameraComponent);
    if (cameraComponent != null && this.cameraService != null) {
      this.cameraService.setActiveCamera({
        camera: cameraComponent,
        duration: 0.5,
      });
    }

    // Subscribe to player input for camera control (right stick / mouse)
    this.inputSubscription = this.playerInputService.subscribePlayerInputAxis(
      this,
      PlayerInputAxis.Right,
      this.onCameraInput.bind(this),
    );

    // Initialize rotation state
    this.currentYaw = 0;
    this.currentPitch = 0;
  }

  /**
   * Handles camera rotation input from right stick / mouse.
   */
  private onCameraInput(data: PlayerInputAxisCallbackPayload): void {
    if (!data.value) {
      return;
    }

    // Apply sensitivity
    const deltaYaw = -data.value.x * this.mouseSensitivity * 0.01;
    const deltaPitch = -data.value.y * this.mouseSensitivity * 0.01;

    // Accumulate yaw and pitch
    this.currentYaw += deltaYaw;
    this.currentPitch += deltaPitch;

    // Clamp pitch to prevent gimbal lock
    this.currentPitch = Math.max(
      this.minPitch,
      Math.min(this.maxPitch, this.currentPitch),
    );
  }

  /**
   * Main camera update loop - runs every frame.
   * Updates camera position and rotation to follow target with smooth interpolation.
   */
  @subscribe(OnWorldUpdateEvent, {execution: Execution.Owner})
  onUpdate(event: OnWorldUpdateEventPayload) {
    const localPlayer = this.playerService.getLocalPlayer();
    if (!localPlayer) {
      return;
    }

    if (!this.targetEntity) {
      return;
    }

    void this.updateThirdPersonCamera(event.deltaTime);
  }

  /**
   * Core camera update logic matching MHE's CameraSystems implementation.
   * Uses character height to calculate pivot point at character's upper body/head level.
   */
  private async updateThirdPersonCamera(deltaTime: number): Promise<void> {
    if (!this.targetEntity) {
      return;
    }

    // Get target entity's world transform
    const targetTransform = this.targetEntity.getComponent(TransformComponent);
    if (!targetTransform) {
      return;
    }

    const targetPosition = targetTransform.worldPosition;
    const targetScale = targetTransform.worldScale;

    // Calculate pivot point using character height
    // The camera orbits around a point near the character's head/upper body
    // This ensures the camera follows at eye level rather than at the character's feet
    const maxScale = Math.max(
      Math.abs(targetScale.x),
      Math.abs(targetScale.y),
      Math.abs(targetScale.z),
    );
    const scaledCharacterHeight = this.characterHeight * maxScale;

    // Pivot point is at character's upper body (approximately 85% of height)
    // This is where the camera collision raycast originates
    const pivotHeightOffset = scaledCharacterHeight * 0.85;
    const cameraPivot = new Vec3(
      targetPosition.x,
      targetPosition.y + pivotHeightOffset,
      targetPosition.z,
    );

    // Camera rotation is controlled by accumulated input (independent of target rotation)
    // This matches MHE's approach where camera yaw/pitch come from player input
    const yawRotation = Quaternion.fromEuler(new Vec3(0, this.currentYaw, 0));
    const pitchRotation = Quaternion.fromEuler(
      new Vec3(this.currentPitch, 0, 0),
    );
    const inputRotation = yawRotation.mul(pitchRotation);

    // Apply base rotation offset + input rotation
    const finalCameraRotation = this.rotationOffset.mul(inputRotation);

    // Calculate camera position offset from pivot point
    // The Y offset in positionOffset is now relative to the pivot, not the ground
    const scaledOffset = this.positionOffset.mul(maxScale);

    // Rotate offset by camera rotation for proper positioning behind target
    const rotatedOffset = finalCameraRotation.mulVec3(scaledOffset);
    const desiredCameraPosition = cameraPivot.add(rotatedOffset);

    // Apply camera collision adjustment (matching C++ CameraCollision)
    // Raycast from pivot (at character's upper body) to desired camera position
    const finalCameraPosition = await this.updateCameraCollision(
      cameraPivot,
      desiredCameraPosition,
      maxScale,
      deltaTime,
    );

    // Apply smoothing using exponential decay (matching C++ CameraSystems)
    let finalPosition = finalCameraPosition;
    let finalRotation = finalCameraRotation;

    const currentTransform = this.entity.getComponent(TransformComponent);
    if (currentTransform) {
      if (this.translationSpeed > 0) {
        // Exponential smoothing: lerp = 1 - pow(4, -speed * dt)
        const translationLerp =
          1.0 - Math.pow(4.0, -this.translationSpeed * deltaTime);
        finalPosition = Vec3.lerp(
          currentTransform.worldPosition,
          finalCameraPosition,
          translationLerp,
        );
      }

      if (this.rotationSpeed > 0) {
        // Exponential smoothing for rotation
        const rotationLerp =
          1.0 - Math.pow(4.0, -this.rotationSpeed * deltaTime);
        finalRotation = currentTransform.worldRotation.slerp(
          finalCameraRotation,
          rotationLerp,
        );
      }
    }

    // Update camera entity transform
    const cameraTransform = this.entity.getComponent(TransformComponent);
    if (cameraTransform) {
      cameraTransform.worldPosition = finalPosition;
      cameraTransform.worldRotation = finalRotation.normalize();
    }
  }

  /**
   * Camera collision detection and adjustment (matching C++ CameraCollision).
   * Uses a state machine: NoCollision -> Collided -> WaitingToReturn -> Returning
   * Set collisionInterpolationDuration to 0 for instant response.
   */
  private async updateCameraCollision(
    pivotPosition: Vec3,
    desiredCameraPosition: Vec3,
    scale: number,
    deltaTime: number,
  ): Promise<Vec3> {
    if (!this.enableCollision) {
      return desiredCameraPosition;
    }

    const direction = desiredCameraPosition.sub(pivotPosition);
    const rayDirection = direction.normalize();
    this.uncollidedDistance = direction.magnitude();
    this.currentCollisionDistance = this.uncollidedDistance;

    // Raycast from pivot to desired camera position
    const raycastResult = await this.raycastToClosestObstructingObject(
      pivotPosition,
      rayDirection,
      this.uncollidedDistance,
    );

    const collisionOccurred = raycastResult.hasCollision;

    if (collisionOccurred) {
      this.currentCollisionDistance = Math.max(
        0,
        Math.min(raycastResult.hitDistance, this.uncollidedDistance),
      );
    } else {
      this.currentCollisionDistance = this.uncollidedDistance;
    }

    // Update collision state machine
    this.updateCollisionState(collisionOccurred, deltaTime);

    // If no collision has ever occurred, use desired position
    if (this.collisionState === CameraCollisionState.NoCollision) {
      return desiredCameraPosition;
    }

    // Calculate collided position (where camera should be when fully collided)
    const collidedPosition = pivotPosition.add(
      rayDirection.mul(this.closestCollisionDistance),
    );

    // Interpolate from current desired position TOWARD collided position
    // collisionFactor = 0 means no collision adjustment (at desired position)
    // collisionFactor = 1 means fully at collided position
    return this.lerpVec3(
      desiredCameraPosition,
      collidedPosition,
      this.collisionFactor,
    );
  }


  /**
   * Performs raycast to detect closest obstructing object.
   * Note: distance parameter is already in world units (already scaled), no additional scaling needed.
   */
  private async raycastToClosestObstructingObject(
    origin: Vec3,
    direction: Vec3,
    distance: number,
  ): Promise<{hasCollision: boolean; hitDistance: number}> {
    try {
      const raycastInput: RayCastInput = {
        origin: origin,
        dir: direction,
        distance: distance, // Already in world units, no scaling needed
        mode: CastMode.ClosestHit,
        collisionLayerMask: CollisionLayerMask.AllLayers,
      };

      const castOutput = await this.physicsService.rayCast(raycastInput);

      if (
        castOutput.hasHitSomething &&
        castOutput.hits &&
        castOutput.hits.length > 0
      ) {
        let closestHit: SceneHitData | null = null;
        for (const hit of castOutput.hits) {
          // Always skip hits on the target entity (player) - we don't want camera to collide with player
          if (
            hit.actorEntity === this.targetEntity ||
            hit.shapeEntity === this.targetEntity
          ) {
            continue;
          }

          if (!closestHit || hit.distance < closestHit.distance) {
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
   * Updates collision state machine (matching C++ CameraCollision::updateState).
   * States: NoCollision -> Collided -> WaitingToReturn -> Returning
   *
   * collisionFactor:
   *   0 = camera at desired position (no collision effect)
   *   1 = camera at collided position (fully pulled in)
   *
   * If collisionInterpolationDuration is 0, transitions are instant.
   */
  private updateCollisionState(isColliding: boolean, deltaTime: number): void {
    switch (this.collisionState) {
      case CameraCollisionState.NoCollision:
        if (isColliding) {
          this.triggerNewCollision();
        }
        break;

      case CameraCollisionState.Collided:
        // Update closest collision distance if we hit something closer
        if (isColliding && this.requiresNewCollision()) {
          this.closestCollisionDistance = this.currentCollisionDistance;
        }

        // Handle interpolation (instant if duration is 0)
        if (this.collisionInterpolationDuration > 0) {
          this.collisionTimer = Math.max(
            0,
            this.collisionTimer -
              deltaTime * (1.0 / this.collisionInterpolationDuration),
          );
        } else {
          this.collisionTimer = 0; // Instant
        }

        // Calculate collisionFactor: as timer goes 1->0, factor goes 0->1
        const t =
          1.0 -
          this.collisionTimer / PlayerCameraComponent.kCollisionDuration;
        this.collisionFactor = this.smoothStep(0, 1, t);

        // Transition to WaitingToReturn when timer expires OR collision clears
        if (this.collisionTimer === 0 || !isColliding) {
          this.collisionState = CameraCollisionState.WaitingToReturn;
          this.returnTimer = PlayerCameraComponent.kReturnDelay;
        }
        break;

      case CameraCollisionState.WaitingToReturn:
        // If still colliding, stay in collided state (don't return yet)
        if (isColliding) {
          // Update closest distance if we hit something closer
          if (this.requiresNewCollision()) {
            this.closestCollisionDistance = this.currentCollisionDistance;
          }
          // Stay at collided position - don't transition to Returning
          this.collisionFactor = 1;
        } else {
          // No longer colliding - start returning
          if (this.collisionInterpolationDuration <= 0) {
            // Instant return
            this.collisionFactor = 0;
            this.closestCollisionDistance = 0;
            this.collisionState = CameraCollisionState.NoCollision;
          } else {
            this.returnTimer -= deltaTime;
            if (this.returnTimer <= 0) {
              this.collisionState = CameraCollisionState.Returning;
              this.returnTimer =
                PlayerCameraComponent.kReturnDuration *
                (1 -
                  this.collisionTimer /
                    PlayerCameraComponent.kCollisionDuration);
            }
          }
        }
        break;

      case CameraCollisionState.Returning:
        // If colliding again, go back to collided state
        if (isColliding) {
          this.collisionState = CameraCollisionState.Collided;
          this.closestCollisionDistance = this.currentCollisionDistance;
          this.collisionFactor = 1;
        } else {
          // Continue returning to desired position
          if (this.collisionInterpolationDuration <= 0) {
            // Instant return
            this.collisionFactor = 0;
            this.closestCollisionDistance = 0;
            this.collisionState = CameraCollisionState.NoCollision;
          } else {
            // Decrease return timer to transition collisionFactor from 1 -> 0
            this.returnTimer = Math.max(0, this.returnTimer - deltaTime);

            // Calculate collisionFactor: as timer goes 1->0, factor goes 1->0
            const returnT = this.inverseLerp(
              0,
              PlayerCameraComponent.kReturnDuration,
              this.returnTimer,
            );
            this.collisionFactor = this.smoothStep(0, 1, returnT);

            if (this.returnTimer === 0) {
              this.collisionFactor = 0;
              this.closestCollisionDistance = 0;
              this.collisionState = CameraCollisionState.NoCollision;
            }
          }
        }
        break;
    }
  }

  /**
   * Checks if a new collision is required.
   */
  private requiresNewCollision(): boolean {
    return this.currentCollisionDistance <= this.getReturningDistance();
  }

  /**
   * Gets the returning distance for collision interpolation.
   */
  private getReturningDistance(): number {
    return this.lerp(
      this.uncollidedDistance,
      this.closestCollisionDistance,
      this.collisionFactor,
    );
  }

  /**
   * Triggers a new collision state (matching C++ CameraCollision::triggerNewCollision).
   * Starts with collisionFactor = 0, which will transition to 1.
   * If collisionInterpolationDuration is 0, factor is immediately set to 1.
   */
  private triggerNewCollision(): void {
    this.collisionState = CameraCollisionState.Collided;
    this.closestCollisionDistance = this.currentCollisionDistance;
    this.returnTimer = 0;

    if (this.collisionInterpolationDuration <= 0) {
      // Instant: immediately at collided position
      this.collisionTimer = 0;
      this.collisionFactor = 1;
    } else {
      // Smooth: start transition from 0 to 1
      this.collisionTimer = PlayerCameraComponent.kCollisionDuration;
      this.collisionFactor = 0;
    }
  }

  // ========== Math Utilities ==========

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  private inverseLerp(a: number, b: number, value: number): number {
    return (value - a) / (b - a);
  }

  private smoothStep(edge0: number, edge1: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  private lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
    return new Vec3(
      this.lerp(a.x, b.x, t),
      this.lerp(a.y, b.y, t),
      this.lerp(a.z, b.z, t),
    );
  }

  // ========== Public API ==========

  /**
   * Sets the yaw rotation directly (in degrees).
   */
  setYaw(yawDegrees: number): void {
    this.currentYaw = yawDegrees;
  }

  /**
   * Sets the pitch rotation directly (in degrees).
   */
  setPitch(pitchDegrees: number): void {
    this.currentPitch = Math.max(
      this.minPitch,
      Math.min(this.maxPitch, pitchDegrees),
    );
  }

  /**
   * Gets the current yaw in degrees.
   */
  getYaw(): number {
    return this.currentYaw;
  }

  /**
   * Gets the current pitch in degrees.
   */
  getPitch(): number {
    return this.currentPitch;
  }

  /**
   * Sets a new target entity to follow.
   */
  setTarget(entity: Entity): void {
    this.targetEntity = entity;
  }

  /**
   * Updates the position offset at runtime.
   */
  setPositionOffset(offset: Vec3): void {
    this.positionOffset = offset;
  }

  /**
   * Cleanup on component destruction.
   */
  private cleanup(): void {
    if (this.inputSubscription) {
      this.inputSubscription.disconnect();
      this.inputSubscription = null;
    }
  }
}
