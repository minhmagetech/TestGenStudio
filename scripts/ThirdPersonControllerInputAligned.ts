/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

/**
 * ThirdPersonControllerInputAligned - Player movement controller with strafe/backpedal
 * 
 * Component Attachment: Player template (attached to the player entity root)
 * Component Networking: Local (runs on owning client only)
 * Component Ownership: Player-owned (each player controls their own movement)
 * 
 * This component handles:
 * - Player movement with mixed camera-relative and player-relative controls
 * - Player rotation via right stick/drag input (NOT automatic)
 * 
 * Control Scheme:
 * - LEFT STICK UP (forward): Move in camera's forward direction (NO automatic rotation)
 * - LEFT STICK DOWN (back): BACKPEDAL - move backward relative to player's facing (no rotation)
 * - LEFT STICK LEFT: STRAFE LEFT - move left relative to player's facing (no rotation)
 * - LEFT STICK RIGHT: STRAFE RIGHT - move right relative to player's facing (no rotation)
 * - RIGHT STICK/DRAG: Rotate player's facing direction (distance-based, not velocity-based)
 * 
 * ROTATION BEHAVIOR:
 * - When drag starts, the origin point is recorded
 * - Rotation speed is proportional to DISTANCE from origin (not stick velocity)
 * - Dragging further from origin = faster rotation
 * - Holding at a distance = constant rotation speed
 * - Returning to center = stops rotation
 * 
 * The camera orbits to stay behind the player, so rotating the player via right stick
 * will cause the camera to orbit around to follow.
 * 
 * CAMERA COMPATIBILITY:
 * This component uses CameraService.get().forward to determine forward direction.
 * It works with ANY camera that uses CameraService.setCameraMode() to control the camera,
 * including orbit cameras, follow cameras, fixed cameras, etc.
 * 
 * PHYSICS REQUIREMENTS:
 * The player entity must have:
 * - PhysicsBodyPlatformComponent (type: DynamicCollider)
 *   - lockedRotationAxes: 7 (all axes locked - script controls rotation)
 *   - angularDamping: 100000000.0 (prevents physics rotation)
 *   - useGravity: true
 * - Child entity with ColliderCapsulePlatformComponent
 *   - axis: Y (vertical capsule)
 *   - Positioned to center on player body
 */

import {
  component,
  Component,
  subscribe,
  OnEntityStartEvent,
  OnEntityDestroyEvent,
  OnWorldUpdateEvent,
  OnWorldUpdateEventPayload,
  TransformComponent,
  Vec3,
  Vec2,
  Quaternion,
  PlayerInputService,
  PlayerInputSubscription,
  PlayerInputAxis,
  PlayerInputAxisCallbackPayload,
  ExecuteOn,
  property,
  CameraService,
  clamp,
  WorldService,
} from 'meta/worlds';
import type { Maybe } from 'meta/worlds';

@component({ description: 'Player movement controller with strafe, backpedal, and drag-to-rotate support' })
export class ThirdPersonControllerInputAligned extends Component {
  // ==================== MOVEMENT PROPERTIES ====================
  
  /** Movement speed in units per second */
  @property()
  moveSpeed: number = 6.0;

  /** How quickly the player rotates when using right stick/drag (degrees per second at full drag distance) */
  @property()
  rotationSpeed: number = 45.0;

  /** Deadzone for rotation input - inputs below this threshold are ignored (0-1 range after normalization) */
  @property()
  rotationDeadzone: number = 0.02;

  /** Maximum rotation per frame in degrees - safety limit for extreme inputs */
  @property()
  maxRotationPerFrame: number = 8.0;

  /** 
   * Maximum drag distance for full rotation speed (normalized units).
   * Dragging this far from origin gives full rotation speed.
   * Dragging further still gives full speed (clamped).
   */
  @property()
  maxDragDistance: number = 0.8;

  // ==================== PRIVATE FIELDS ====================
  
  /** Reference to the transform component */
  private transform: Maybe<TransformComponent> = null;

  /** Camera service for getting camera position/direction */
  private cameraService = CameraService.get();

  /** Input service for subscribing to joystick input */
  private inputService = PlayerInputService.get();

  /** Subscription to left thumbstick input (movement) */
  private moveSubscription: PlayerInputSubscription | null = null;

  /** Subscription to right thumbstick input (rotation) */
  private rotateSubscription: PlayerInputSubscription | null = null;

  /** Current movement input from left joystick (X = left/right, Y = forward/back) */
  private moveInput: Vec3 = Vec3.zero;

  /** Current rotation input based on distance from drag origin, normalized to -1 to 1 */
  private rotateInput: number = 0;

  /** 
   * Scale factor to normalize raw input values from PlayerInputAxis.Right
   * Raw input values are typically in the 50-500+ range, not 0-1.
   * This divisor converts them to a normalized -1 to 1 range.
   */
  private readonly INPUT_NORMALIZATION_FACTOR: number = 10.0;

  // ==================== DISTANCE-BASED ROTATION TRACKING ====================
  
  /** 
   * Last raw input position from right stick (normalized coordinates).
   * Stored in event handler, used in update loop to calculate rotation every frame.
   */
  private lastStickPosition: Vec2 = Vec2.zero;

  /** 
   * Whether a drag is currently active.
   * True when input has moved from center to above deadzone.
   * False when input returns to below deadzone (center).
   */
  private isDragging: boolean = false;

  /**
   * Timestamp of the last input change from right stick.
   * Used to detect when input has gone stale (user released but no (0,0) event received).
   */
  private lastInputChangeTime: number = 0;

  /**
   * Timeout in seconds after which stale input is considered released.
   * If no input change occurs within this duration, lastStickPosition is reset to zero.
   */
  private readonly INPUT_TIMEOUT: number = 0.1;

  /**
   * Threshold for forcing input to zero in the callback.
   * Slightly larger than deadzone to catch near-zero inputs that indicate release.
   */
  private readonly INPUT_RELEASE_THRESHOLD: number = 0.05;

  // ==================== INITIALIZATION ====================

  /**
   * Initialize component - runs on owner (the player client)
   * Sets up transform reference and input subscriptions
   */
  @subscribe(OnEntityStartEvent, { execution: ExecuteOn.Owner })
  onStart() {
    // Get transform component for position and rotation manipulation
    this.transform = this.entity.getComponent(TransformComponent);

    // Subscribe to left thumbstick for movement input
    this.moveSubscription = this.inputService.subscribePlayerInputAxis(
      this,
      PlayerInputAxis.Left,
      (payload: PlayerInputAxisCallbackPayload) => {
        this.onLeftThumbstickMove(payload.value);
      }
    );

    // Subscribe to right thumbstick for rotation input (drag-to-rotate)
    this.rotateSubscription = this.inputService.subscribePlayerInputAxis(
      this,
      PlayerInputAxis.Right,
      (payload: PlayerInputAxisCallbackPayload) => {
        this.onRightThumbstickMove(payload.value);
      }
    );
  }

  // ==================== INPUT HANDLING ====================

  /**
   * Handle left thumbstick input for movement
   * X = left/right strafe, Y = forward/backward
   */
  private onLeftThumbstickMove(value: { x: number; y: number }) {
    // Store raw input: X for left/right strafe, Y for forward/back
    // Y positive = push stick forward = move forward (camera-relative)
    // Y negative = push stick back = backpedal (player-relative)
    // X positive = push stick right = strafe right (player-relative)
    // X negative = push stick left = strafe left (player-relative)
    this.moveInput = new Vec3(value.x, 0, value.y);
  }

  /**
   * Handle right thumbstick input for rotation (drag-to-rotate)
   * 
   * This event handler ONLY stores the raw input position.
   * The actual rotation calculation happens in onUpdate every frame
   * to ensure constant rotation speed while holding the stick.
   * 
   * DISTANCE-BASED ROTATION (calculated in onUpdate):
   * - Rotation speed is proportional to DISTANCE from center (not stick velocity)
   * - The further you drag from center, the faster the turn rate
   * - When you drag and hold at a distance, character keeps turning at constant rate
   * - When input returns to center (below deadzone), rotation stops
   * 
   * INPUT RELEASE HANDLING:
   * - Forces input to zero if magnitude is below INPUT_RELEASE_THRESHOLD
   * - This catches near-zero residual inputs that indicate the stick was released
   * - Combined with timeout detection in onUpdate for robustness
   */
  private onRightThumbstickMove(value: { x: number; y: number }) {
    // Normalize raw input to -1 to 1 range
    const normalizedX = clamp(value.x / this.INPUT_NORMALIZATION_FACTOR, -1.0, 1.0);
    const normalizedY = clamp(value.y / this.INPUT_NORMALIZATION_FACTOR, -1.0, 1.0);
    
    // Calculate magnitude to check for near-zero input (indicates release)
    const magnitude = Math.sqrt(normalizedX * normalizedX + normalizedY * normalizedY);
    
    // Force to zero if below release threshold - handles input release
    // This catches cases where the callback fires with near-zero values on release
    if (magnitude < this.INPUT_RELEASE_THRESHOLD) {
      this.lastStickPosition = Vec2.zero;
    } else {
      this.lastStickPosition = new Vec2(normalizedX, normalizedY);
    }
    
    // Update timestamp for timeout detection (handles cases where callback doesn't fire on release)
    this.lastInputChangeTime = WorldService.get().getWorldTime();
  }

  // ==================== UPDATE LOOP ====================

  /**
   * Update loop - processes movement and rotation each frame.
   * 
   * Movement behavior:
   * - FORWARD (stick Y+): Move in camera's forward direction (NO automatic rotation)
   * - BACK (stick Y-): Backpedal - move backward relative to player facing, no rotation
   * - LEFT/RIGHT (stick X): Strafe - move sideways relative to player facing, no rotation
   * 
   * Rotation behavior:
   * - RIGHT STICK: Distance-based rotation
   * - Rotation speed is proportional to distance from drag origin
   * - Holding at a distance = constant rotation speed
   */
  @subscribe(OnWorldUpdateEvent, { execution: ExecuteOn.Owner })
  onUpdate(payload: OnWorldUpdateEventPayload) {
    if (!this.transform) {
      return;
    }

    // ==================== INPUT TIMEOUT DETECTION ====================
    // If no input change has occurred within INPUT_TIMEOUT, reset lastStickPosition.
    // This handles cases where the input callback doesn't fire with (0,0) on release.
    const currentTime = WorldService.get().getWorldTime();
    if (this.lastStickPosition.magnitudeSquared() > 0 && 
        this.lastInputChangeTime > 0 && 
        currentTime - this.lastInputChangeTime > this.INPUT_TIMEOUT) {
      this.lastStickPosition = Vec2.zero;
    }

    // ==================== CALCULATE ROTATION INPUT (every frame) ====================
    // Calculate rotateInput from lastStickPosition every frame to ensure constant
    // rotation speed while holding the stick (event only fires on value change)
    const magnitude = this.lastStickPosition.magnitude();
    
    if (magnitude < this.rotationDeadzone) {
      // Input below deadzone - stop rotation
      this.rotateInput = 0;
      this.isDragging = false;
    } else {
      // Input above deadzone - calculate rotation speed from distance
      if (!this.isDragging) {
        this.isDragging = true;
      }
      
      // Determine rotation direction from horizontal component
      // Positive X = turn right, Negative X = turn left
      const direction = Math.sign(this.lastStickPosition.x);
      
      // If drag is purely vertical with no horizontal component, no rotation
      if (Math.abs(this.lastStickPosition.x) < 0.001) {
        this.rotateInput = 0;
      } else {
        // Distance from center (origin is always Vec2.zero)
        const distance = magnitude;
        
        // Convert distance to rotation speed (0 to 1 range, clamped at maxDragDistance)
        const normalizedDistance = clamp(distance / this.maxDragDistance, 0, 1);
        
        // Store as rotation input (with direction)
        // Further from center = faster rotation
        this.rotateInput = direction * normalizedDistance;
      }
    }

    // ==================== HANDLE ROTATION (RIGHT STICK) ====================
    // Process rotation input from right stick/drag
    // rotateInput is now based on distance from origin, normalized to -1 to 1 range
    if (Math.abs(this.rotateInput) > 0.001) {
      // Calculate rotation amount: input * speed * deltaTime
      // With normalized input (-1 to 1), rotationSpeed directly means "degrees per second at full drag distance"
      // e.g., rotationSpeed=90 and full drag distance = 90°/sec rotation
      let rotationDegrees = this.rotateInput * this.rotationSpeed * payload.deltaTime;
      
      // Safety clamp - should rarely trigger during normal use
      rotationDegrees = clamp(rotationDegrees, -this.maxRotationPerFrame, this.maxRotationPerFrame);
      
      // Create rotation quaternion around Y axis
      // Negate the rotation because positive X input should turn right (clockwise from above)
      const rotationDelta = Quaternion.fromEuler(new Vec3(0, -rotationDegrees, 0));
      
      // Apply rotation to current rotation
      const currentRotation = this.transform.worldRotation;
      const newRotation = Quaternion.mul(currentRotation, rotationDelta);
      
      // Set the new rotation
      this.transform.worldRotation = newRotation;
    }

    // ==================== HANDLE MOVEMENT (LEFT STICK) ====================
    // Check if there's any movement input
    if (this.moveInput.magnitudeSquared() <= 0.01) {
      return;
    }

    // Get player's current facing direction (from transform rotation)
    // Player's forward is -Z in local space, so we get worldForward
    const playerForward = this.transform.worldForward;
    
    // Player's right direction (perpendicular to forward on XZ plane)
    const playerRight = this.transform.worldRight;

    // Initialize world movement direction
    let worldMoveDirection = Vec3.zero;

    // Separate forward input from strafe/backpedal inputs
    const forwardInput = Math.max(0, this.moveInput.z); // Only positive Y (forward)
    const backInput = Math.max(0, -this.moveInput.z);   // Only negative Y (back) as positive value
    const strafeInput = this.moveInput.x;              // Left/right strafe

    // FORWARD MOVEMENT (stick forward/Y+): Camera-relative, NO automatic rotation
    if (forwardInput > 0.01) {
      // Get camera's forward direction from CameraService
      const cameraForward = this.cameraService.forward;
      
      // Flatten camera forward to XZ plane (ignore vertical tilt)
      const flatCameraForward = new Vec3(cameraForward.x, 0, cameraForward.z).normalize();

      // Forward movement goes in camera's forward direction
      worldMoveDirection = worldMoveDirection.add(flatCameraForward.mul(forwardInput));
    }

    // BACKPEDAL (stick back/Y-): Player-relative, no rotation
    if (backInput > 0.01) {
      // Move backward relative to player's current facing (opposite of playerForward)
      // playerForward is already normalized
      worldMoveDirection = worldMoveDirection.add(playerForward.mul(-backInput));
    }

    // STRAFE (stick left/right): Player-relative, no rotation
    if (Math.abs(strafeInput) > 0.01) {
      // Move sideways relative to player's current facing
      // Positive X = strafe right, negative X = strafe left
      worldMoveDirection = worldMoveDirection.add(playerRight.mul(strafeInput));
    }

    // If we have any movement, apply it
    if (worldMoveDirection.magnitudeSquared() > 0.001) {
      // Normalize if magnitude > 1 to prevent diagonal speed boost
      const mag = worldMoveDirection.magnitude();
      if (mag > 1.0) {
        worldMoveDirection = worldMoveDirection.div(mag);
      }

      // Calculate movement delta: direction * speed * deltaTime
      const moveDelta = worldMoveDirection.mul(this.moveSpeed * payload.deltaTime);

      // Get current position and add movement delta
      const currentPosition = this.transform.worldPosition;
      const newPosition = currentPosition.add(moveDelta);

      // Directly set the new position
      this.transform.worldPosition = newPosition;
    }
  }

  // ==================== CLEANUP ====================

  /**
   * Cleanup - disconnect input subscriptions when entity is destroyed
   */
  @subscribe(OnEntityDestroyEvent, { execution: ExecuteOn.Owner })
  onDestroy() {
    this.moveSubscription?.disconnect();
    this.moveSubscription = null;
    
    this.rotateSubscription?.disconnect();
    this.rotateSubscription = null;
  }
}
