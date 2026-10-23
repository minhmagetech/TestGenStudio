// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import { Vec3, PlayerService, TransformComponent, WorldTextComponent } from 'meta/worlds';
import type { Entity } from 'meta/worlds';
import { ActorBehavior } from 'meta/worlds';
import { GotoBehavior } from './GotoBehavior';
import type { ActorController } from 'meta/worlds';
import type { ActorBehaviorManager } from 'meta/worlds';
import { ActorBodyDirectionControllerTypeId, type ActorBodyDirectionController, ActorBodyDirectionParams } from 'meta/worlds';
import type { TargetInfo } from './TargetingBehavior';

/**
 * FollowBehavior - A behavior that follows a target entity.
 *
 * Navigates to the target's actual position via the NavMesh (routing around
 * walls) and stops `followRange` short of the target measured along the path,
 * parking there while the target is still.
 *
 * Supports two modes:
 * - **Composite mode** (`targetInfo` provided): Reads `predictedPosition`
 *   from the shared TargetInfo written by TargetingBehavior. With the parent
 *   `velocityPredictionTime > 0`, the actor navigates toward where the target
 *   will be in `velocityPredictionTime` seconds — leading the chase. Set
 *   `velocityPredictionTime = 0` on the parent to revert to pure
 *   current-position tracking.
 * - **Standalone mode** (`targetInfo` is null): Uses the raw target position.
 *   When `followPlayer` is true, the closest player is resolved dynamically.
 *
 * ## Hysteresis (motion state machine + arrival deceleration)
 *
 * To avoid stop-go cycles AND smoothly handle target stops without any
 * dependency on velocity smoothing, the behavior combines a two-state
 * motion machine with arrival-style speed control:
 *
 * - **`pursuing`**: actor drives toward the follow point at a speed that
 *   linearly decelerates with distance — full `followSpeed` at or beyond
 *   `hysteresisRadius` from the follow point, ramping to 0 at the center.
 * - **`settled`**: actor parks (`desiredSpeed = 0`); body direction still
 *   tracks the target. With `hysteresisRadius > 0` this is entered only when
 *   the target is essentially still (`targetSpeedXZ ≤ targetMovingThreshold`);
 *   with `hysteresisRadius = 0` it is entered purely on arrival at the follow
 *   point, regardless of target motion.
 *
 * **Arrival speed (Reynolds-style)**:
 * ```
 *   t           = min(1, distToFollow / hysteresisRadius)  // 0 at center
 *   desiredSpeed = followSpeed * t                           // smooth ramp
 * ```
 * Self-equilibrates when the target moves at constant speed: the actor
 * naturally cruises at an offset behind the follow point such that
 * `followSpeed * (offset / hysteresisRadius) ≈ targetSpeed`. For a
 * player walking at 2 m/s with `followSpeed = 5` and `hysteresisRadius =
 * 1.5`, the actor settles ~0.6 m behind the follow point and matches
 * pace — no burst-and-brake cycle, no transient when the target stops
 * (since `desiredSpeed` depends only on distance, never on a smoothed
 * velocity that lags).
 *
 * **Trade-off**: while the target is moving, the actor sits *behind* the
 * follow point by an offset proportional to target speed (rather than
 * exactly *at* the follow point). Acceptable for chase / tail-following;
 * if you need tighter tracking, shrink `hysteresisRadius` (smaller soft
 * zone → smaller equilibrium offset, but less hysteresis benefit).
 *
 * **Transitions** (XZ-plane distances):
 * - `pursuing → settled` when actor is **inside** `hysteresisRadius` AND
 *   (arrived within `distanceToStop` of the follow point, OR stuck-but-close
 *   fallback fires) AND target is essentially still.
 * - `settled → pursuing` the moment actor is **outside** `hysteresisRadius`.
 *   A target that starts moving while its follow point still sits inside
 *   the hysteresis zone is intentionally ignored — the actor waits until
 *   the player has walked far enough to drag the follow point out.
 *
 * Set `hysteresisRadius = 0` to disable arrival deceleration (pure pursuit at
 * `followSpeed`); the actor still parks at `followRange` on arrival (within
 * `distanceToStop`) regardless of target motion — the original
 * stop-at-followRange behavior, without the soft-zone smoothing.
 *
 * **Tuning note**: when using composite mode with velocity prediction, set
 * `hysteresisRadius` ≳ `velocityPredictionTime * expectedTargetSpeed` so
 * that the predicted-point snap-back when a moving target stops stays
 * inside the soft zone (no backpedal). The radius can be changed at any
 * time; the state machine reads it every frame.
 */
export class FollowBehavior extends ActorBehavior {
  override name: string = 'FollowBehavior';

  /**
   * Target entity to follow.
   * In composite mode, this is overridden by targetInfo.targetEntity.
   */
  targetEntity: Entity | null = null;

  /**
   * Desired follow distance from target in meters
   */
  followRange: number = 1.0;

  /**
   * Movement speed
   */
  followSpeed: number = 5.0;

  // GotoBehavior pass-through parameters
  repathInterval: number = 0.2;
  distanceToStop: number = 0.1;

  /**
   * Controls which direction the actor faces while following.
   *   'faceTarget'   — face toward the target entity
   *   'faceMovement' — face the direction the actor is moving (its travel heading)
   *   'matchTarget'  — face the same direction as the target
   *   'none'         — do not control body direction (actor keeps its facing)
   */
  bodyDirectionMode: 'faceTarget' | 'faceMovement' | 'matchTarget' | 'none' = 'faceTarget';

  /**
   * Angular speed in radians per second for body direction rotation.
   */
  bodyDirectionAngularSpeed: number = 3.14;

  /**
   * Shared target info from a parent CompositeBehavior.
   * When provided, position/velocity/prediction data is read from here.
   * When null, standalone mode is used (raw target position, no prediction).
   */
  targetInfo: TargetInfo | null = null;

  /**
   * When true, the behavior dynamically resolves the closest player as the
   * target every `playerSearchInterval` seconds. This handles the case where
   * the player spawns after the NPC: the behavior keeps searching until a
   * player appears, then follows them. If the followed player disconnects,
   * it will re-acquire the next closest player.
   */
  followPlayer: boolean = false;

  /**
   * How often (in seconds) to search for the closest player when
   * `followPlayer` is true. Lower values are more responsive but slightly
   * more expensive. Only used in standalone + followPlayer mode.
   */
  playerSearchInterval: number = 0.5;

  protected gotoBehavior: GotoBehavior | null = null;
  protected actorTransform: TransformComponent | null = null;

  /**
   * Internal timer for throttling player searches in followPlayer mode.
   */
  protected playerSearchTimer: number = 0;

  /**
   * The direction the actor should face (towards target).
   * Null if body direction is not being controlled by this behavior.
   */
  protected desiredBodyDirection: Vec3 | null = null;

  // ── Hysteresis ────────────────────────────────────────────────────

  /**
   * Soft-zone radius (meters, XZ plane) around the follow point. When the
   * actor is inside this radius AND has arrived (or is stuck-but-close),
   * the actor settles and stops issuing movement requests until the follow
   * point drifts outside the radius.
   *
   * Set to 0 to disable hysteresis (pure pursuit — original behavior).
   * May be changed dynamically; read every frame.
   */
  hysteresisRadius: number = 0;

  /**
   * Actor XZ speed (m/s) below which the actor is considered "stuck" — i.e.
   * unable to make further progress toward the follow point (e.g. blocked
   * by collision, peer actor crowding).
   */
  stuckSpeedThreshold: number = 0.1;

  /**
   * Sustained time (seconds) the actor must remain "stuck" while inside
   * `hysteresisRadius` before the motion state is force-settled. Prevents
   * unreachable-point thrashing. Set to 0 to disable the fallback.
   */
  stuckSettleTime: number = 0.5;

  /**
   * XZ speed (m/s) below which the target is considered "essentially still".
   *
   * - When target speed is **below** this, the actor is allowed to enter
   *   `settled` (full stop) on arrival inside hysteresis.
   * - When target speed is **at or above** this, the actor stays in
   *   `pursuing` and uses arrival deceleration instead — naturally
   *   cruising at an equilibrium offset behind the follow point.
   *
   * Composite mode only (uses `targetInfo.smoothedVelocity`). In standalone
   * mode this has no effect.
   */
  targetMovingThreshold: number = 0.1;

  /**
   * Internal motion state. Drives whether follow issues move requests
   * (`pursuing`) or parks the actor (`settled`).
   */
  protected motionState: 'pursuing' | 'settled' = 'pursuing';

  /**
   * Actor world position recorded last frame. Used to compute the actor's
   * actual XZ speed for stuck detection.
   */
  protected prevActorPos: Vec3 | null = null;

  /**
   * Time (seconds) the actor has been below `stuckSpeedThreshold`
   * continuously. Reset on adequate movement or on transition out of
   * `settled`.
   */
  protected stuckTimer: number = 0;

  // ── Debug ──────────────────────────────────────────────────────────

  /**
   * Optional in-world text entity for live debug output. Each frame, a
   * line containing the motion state, desiredSpeed and distance to the
   * follow point is appended to a circular buffer of `debugMaxFrames`
   * entries; the buffer is then written into the entity's
   * `WorldTextComponent.text` (newline-separated, oldest first).
   *
   * If null or the entity has no `WorldTextComponent`, debug output
   * is skipped entirely (no buffering, no overhead beyond the null check).
   */
  debugTextEntity: Entity | null = null;

  /**
   * Maximum number of frames retained in the rolling debug log.
   */
  debugMaxFrames: number = 10;

  /** Internal: rolling log of debug lines (newest at the end). */
  protected debugLog: string[] = [];

  /** Internal: monotonic frame counter prefixed onto each log entry. */
  protected debugFrameCounter: number = 0;

  /** Internal: snapshot of the desiredSpeed sent to goto this frame. */
  protected debugLastDesiredSpeed: number = 0;

  /** Internal: snapshot of distance from actor to follow point this frame. */
  protected debugLastDistToFollow: number = 0;

  override initialize(behaviorManager: ActorBehaviorManager): void {
    super.initialize(behaviorManager);

    this.actorTransform = this.getEntity().getComponent(TransformComponent);

    const currentPos = this.actorTransform?.worldPosition ?? new Vec3(0, 0, 0);
    this.gotoBehavior = new GotoBehavior();
    this.gotoBehavior.basePriority = this.basePriority;
    this.gotoBehavior.desiredSpeed = this.followSpeed;
    this.gotoBehavior.targetPosition = currentPos;
    this.gotoBehavior.repathInterval = this.repathInterval;
    this.gotoBehavior.distanceToStop = this.distanceToStop;
    // Follower reassigns the target every frame; repath on the interval only.
    this.gotoBehavior.repathOnTargetChange = false;
    // FollowBehavior owns body direction (see updateBodyDirection); the nested
    // goto must not also claim the body-direction controller and fight it.
    this.gotoBehavior.shouldFaceDirection = false;
    this.gotoBehavior.initialize(this.behaviorManager!);
  }

  override update(deltaTime: number): void {
    if (!this.gotoBehavior || !this.actorTransform) {
      return;
    }

    const targetPos = this.resolveTargetPosition(deltaTime);
    if (targetPos === null) {
      return;
    }

    this.followTarget(targetPos, deltaTime);
  }

  /**
   * Decides *what* to follow this frame and returns its world position.
   *
   * - Composite mode (`targetInfo` set): reads `predictedPosition` from the
   *   shared TargetInfo (smoothed position projected forward by
   *   `velocityPredictionTime`). When the parent's `velocityPredictionTime`
   *   is 0, this equals `smoothedPosition`.
   * - Standalone mode (`targetInfo` null): reads `worldPosition` from
   *   `targetEntity`. When `followPlayer` is true, the closest player is
   *   resolved into `targetEntity` first.
   *
   * Returns null when no valid target is available this frame.
   */
  protected resolveTargetPosition(_deltaTime: number): Vec3 | null {
    if (this.targetInfo) {
      return this.targetInfo.isValid ? this.targetInfo.predictedPosition : null;
    }

    if (this.followPlayer) {
      this.resolvePlayerTarget(_deltaTime);
    }

    if (!this.targetEntity || this.targetEntity.isDestroyed()) {
      return null;
    }

    const targetTransform = this.targetEntity.getComponent(TransformComponent);
    return targetTransform ? targetTransform.worldPosition : null;
  }

  /**
   * Decides *how* to follow: navigates to the target's actual position via
   * the NavMesh (routing around walls) and stops `followRange` short of the
   * target measured ALONG THE PATH. Mode-agnostic.
   *
   * Precondition: `gotoBehavior` and `actorTransform` are non-null
   * (verified by `update()`).
   */
  protected followTarget(targetPos: Vec3, deltaTime: number): void {
    const actorPos = this.actorTransform!.worldPosition;

    // Along-path distance to the standoff point: remaining route length minus
    // `followRange` (0 once within `followRange` of the target). Drives the
    // motion state machine and the arrival speed ramp.
    // Note: pre-first-repath getRemainingPathLength() is 0 (empty path), so
    // distToFollow is 0 and a hysteresis follower may settle for the first
    // spawn frame; benign — movement is gated on pathReady and it self-corrects
    // once a path exists.
    const remainingPathLength = this.gotoBehavior!.getRemainingPathLength();
    const distToFollow = Math.max(0, remainingPathLength - this.followRange);

    // Target XZ speed — gates settled entry only (a slow-but-moving target
    // shouldn't briefly settle each cycle); speed itself is distance-derived.
    let targetSpeedXZ = 0;
    if (this.targetInfo && this.targetInfo.isValid) {
      const sv = this.targetInfo.smoothedVelocity;
      targetSpeedXZ = Math.sqrt(sv.x * sv.x + sv.z * sv.z);
    }
    const isTargetMoving = targetSpeedXZ > this.targetMovingThreshold;

    // Drive the hysteresis state machine (decides pursue vs. park)
    this.updateMotionState(actorPos, deltaTime, distToFollow, isTargetMoving);

    // Update body direction (always — even when settled). Runs after the
    // motion state is resolved so faceMovement can gate its release on the
    // same settled state the motion machine uses this frame.
    this.updateBodyDirection(actorPos, targetPos);

    // Keep goto aimed at the target even when settled; retargeting actorPos
    // zeroes getRemainingPathLength() and traps the actor in `settled`.
    this.gotoBehavior!.targetPosition = targetPos;
    const computedDesiredSpeed =
      this.motionState === 'settled' ? 0 : this.computePursuitSpeed(distToFollow);
    this.gotoBehavior!.desiredSpeed = computedDesiredSpeed;
    this.gotoBehavior!.update(deltaTime);

    // Snapshot for debug, then push a frame entry into the rolling log.
    this.debugLastDistToFollow = distToFollow;
    this.debugLastDesiredSpeed = computedDesiredSpeed;
    this.updateDebugText();

    this.renderDebug();
  }

  /**
   * Pushes a frame entry into the rolling debug log and writes the log
   * to the configured `WorldTextComponent` on `debugTextEntity`. No-ops
   * cheaply when no debug entity is configured.
   *
   * Line format: `#<frame> <state> v=<desiredSpeed> d=<distToFollow>`
   * Example:    `#1247 pursuing v=2.43 d=0.85`
   */
  protected updateDebugText(): void {
    if (!this.debugTextEntity || this.debugTextEntity.isDestroyed()) {
      return;
    }

    this.debugFrameCounter++;
    const line =
      `#${this.debugFrameCounter} ${this.motionState} ` +
      `v=${this.debugLastDesiredSpeed.toFixed(2)} ` +
      `d=${this.debugLastDistToFollow.toFixed(2)}`;
    this.debugLog.push(line);
    while (this.debugLog.length > this.debugMaxFrames) {
      this.debugLog.shift();
    }

    const textComp = this.debugTextEntity.getComponent(WorldTextComponent);
    if (textComp) {
      textComp.text = this.debugLog.join('\n');
    }
  }

  /**
   * Hysteresis state machine. Reads `hysteresisRadius` and
   * `targetMovingThreshold` every frame so they can change dynamically.
   *
   * `distToFollow` is the remaining NavMesh path distance to the follow
   * point (not straight-line), so a follow point behind a wall keeps the
   * actor pursuing until it has detoured around the obstacle.
   *
   * - `pursuing → settled` when inside hysteresis AND (arrived at center
   *   within `distanceToStop`, or stuck-but-close fallback fires) AND the
   *   target is essentially still. While the target is moving the actor
   *   stays in `pursuing` and arrival deceleration self-equilibrates the
   *   actor at an offset behind the follow point — no settle, no cycle.
   * - `settled → pursuing` only when the actor falls outside the hysteresis
   *   radius. A moving target whose follow point still sits inside the
   *   soft zone is intentionally ignored so small player movements do not
   *   wake a parked actor.
   *
   * `hysteresisRadius <= 0` disables the soft zone: full-speed pursuit that
   * still settles once the actor arrives at the follow point (within
   * `distanceToStop`), so `followRange` is honored.
   */
  protected updateMotionState(
    actorPos: Vec3,
    deltaTime: number,
    distToFollow: number,
    isTargetMoving: boolean,
  ): void {
    if (this.hysteresisRadius <= 0) {
      // No soft zone: pursuit aims goto at the target itself, so settle at the
      // follow point (followRange out) instead of walking all the way in.
      this.motionState =
        distToFollow <= this.distanceToStop ? 'settled' : 'pursuing';
      this.stuckTimer = 0;
      this.prevActorPos = actorPos;
      return;
    }

    const inHysteresis = distToFollow <= this.hysteresisRadius;
    const arrivedAtCenter = distToFollow <= this.distanceToStop;

    // Stuck detection: actual XZ speed of the actor over the last frame.
    if (this.prevActorPos !== null && deltaTime > 0) {
      const adx = actorPos.x - this.prevActorPos.x;
      const adz = actorPos.z - this.prevActorPos.z;
      const actualSpeed = Math.sqrt(adx * adx + adz * adz) / deltaTime;
      if (actualSpeed < this.stuckSpeedThreshold) {
        this.stuckTimer += deltaTime;
      } else {
        this.stuckTimer = 0;
      }
    }
    this.prevActorPos = actorPos;

    const stuckFallback =
      this.stuckSettleTime > 0 && this.stuckTimer >= this.stuckSettleTime;
    const forcedSettle = inHysteresis && stuckFallback;

    if (this.motionState === 'pursuing') {
      // Only park when the target is essentially still. While the target
      // is moving, pace matching handles things smoothly inside pursuing
      // (entering settled here would cause stop-go cycles).
      if (
        inHysteresis &&
        (arrivedAtCenter || forcedSettle) &&
        !isTargetMoving
      ) {
        this.motionState = 'settled';
      }
    } else {
      // settled — exit ONLY on hysteresis exit. A moving target whose
      // follow point still sits inside hysteresis around the actor is
      // intentionally ignored: we wait for the player to actually walk
      // far enough that the follow point escapes the soft zone.
      if (!inHysteresis) {
        this.motionState = 'pursuing';
        this.stuckTimer = 0;
      }
    }
  }

  /**
   * Arrival-style pursuit speed (Reynolds steering).
   *
   * `desiredSpeed = followSpeed * clamp(distToFollow / hysteresisRadius, 0, 1)`
   *
   * `distToFollow` here is the remaining NavMesh path distance (see
   * `GotoBehavior.getRemainingPathLength`), so deceleration ramps down over
   * the actual route rather than the straight-line gap.
   *
   * - At or beyond `hysteresisRadius`: full `followSpeed` (max chase).
   * - Inside the zone: linearly ramps to 0 at the follow-point center.
   *
   * Depends only on distance — no target-velocity input — so there is
   * no transient when the target's smoothed velocity is mid-decay. When
   * the target moves at a steady speed the actor self-equilibrates at an
   * offset behind the follow point (offset ≈ `hysteresisRadius *
   * targetSpeed / followSpeed`), automatically pace-matching without any
   * explicit pace-match formula.
   *
   * `hysteresisRadius <= 0` disables arrival deceleration entirely —
   * pursuit always uses `followSpeed`.
   */
  protected computePursuitSpeed(distToFollow: number): number {
    if (this.hysteresisRadius <= 0) {
      return this.followSpeed;
    }
    const t = Math.min(1, distToFollow / this.hysteresisRadius);
    return this.followSpeed * t;
  }

  /**
   * Updates the actor's body direction based on bodyDirectionMode.
   *   faceTarget:   actor faces toward the target entity
   *   faceMovement: actor faces its travel heading (toward its path waypoint)
   *   matchTarget:  actor faces the same direction as the target entity
   *   none:         body direction is left uncontrolled (facing held)
   */
  protected updateBodyDirection(actorPos: Vec3, targetPos: Vec3): void {
    if (this.bodyDirectionMode === 'none') {
      this.desiredBodyDirection = null;
      return;
    }

    if (this.bodyDirectionMode === 'faceMovement') {
      // Face the current path waypoint (target as pre-path fallback) so facing
      // follows the route around corners instead of pointing through a wall.
      // Gate release on the settled state — not a separate distance test — so
      // facing and motion agree at the arrival boundary; the magnitude guard
      // skips a degenerate heading when the actor sits on the waypoint.
      const movePoint = this.gotoBehavior?.getCurrentWaypoint() ?? targetPos;
      const toMove = movePoint.sub(actorPos);
      const moveXZ = new Vec3(toMove.x, 0, toMove.z);
      if (this.motionState !== 'settled' && moveXZ.magnitude() > this.distanceToStop) {
        this.desiredBodyDirection = moveXZ.normalize();
      } else {
        this.desiredBodyDirection = null;
      }
      return;
    }

    if (this.bodyDirectionMode === 'matchTarget') {
      const entity = this.targetInfo?.targetEntity ?? this.targetEntity;
      if (!entity || entity.isDestroyed()) return;
      const transform = entity.getComponent(TransformComponent);
      if (!transform) return;
      const forward = transform.worldRotation.mulVec3(Vec3.forward);
      const forwardXZ = new Vec3(forward.x, 0, forward.z);
      if (forwardXZ.magnitude() > 0.001) {
        this.desiredBodyDirection = forwardXZ.normalize();
      }
      return;
    }

    // faceTarget (default)
    const toTarget = targetPos.sub(actorPos);
    const directionXZ = new Vec3(toTarget.x, 0, toTarget.z);
    if (directionXZ.magnitude() > 0.001) {
      this.desiredBodyDirection = directionXZ.normalize();
    }
  }

  /**
   * Renders debug visualization. Override to add custom debug rendering.
   */
  protected renderDebug(): void {
    // No-op by default
  }

  /**
   * Searches for the closest player and sets it as targetEntity.
   * Called every frame in followPlayer mode but only performs the actual
   * PlayerService query at playerSearchInterval intervals (or immediately
   * when there is no valid target).
   */
  protected resolvePlayerTarget(deltaTime: number): void {
    const needsTarget = !this.targetEntity || this.targetEntity.isDestroyed();

    this.playerSearchTimer += deltaTime;
    if (!needsTarget && this.playerSearchTimer < this.playerSearchInterval) {
      return;
    }
    this.playerSearchTimer = 0;

    const actorPos = this.actorTransform!.worldPosition;
    const players = PlayerService.get().getAllPlayers();

    let nearestPlayer: Entity | null = null;
    let nearestDistance = Infinity;

    for (const playerEntity of players) {
      if (!playerEntity || !playerEntity.valid) continue;

      const playerTransform = playerEntity.getComponent(TransformComponent);
      if (!playerTransform) continue;

      const distance = actorPos.distance(playerTransform.worldPosition);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestPlayer = playerEntity;
      }
    }

    if (nearestPlayer) {
      this.targetEntity = nearestPlayer;
    }
  }

  override getControllerUsePriority(controllerType: string): number {
    const hasTarget = this.targetInfo
      ? this.targetInfo.isValid
      : (this.targetEntity && !this.targetEntity.isDestroyed());

    if (!hasTarget || !this.gotoBehavior) {
      return super.getControllerUsePriority(controllerType);
    }

    if (controllerType === ActorBodyDirectionControllerTypeId && this.desiredBodyDirection) {
      return this.basePriority;
    }

    return this.gotoBehavior.getControllerUsePriority(controllerType);
  }

  override useController(controllerType: string, controller: ActorController): void {
    if (controllerType === ActorBodyDirectionControllerTypeId && this.desiredBodyDirection) {
      (controller as ActorBodyDirectionController).rotateBodyTo(
        new ActorBodyDirectionParams(this.desiredBodyDirection, this.bodyDirectionAngularSpeed),
      );
    }

    if (this.gotoBehavior) {
      this.gotoBehavior.useController(controllerType, controller);
    }
  }
}
