// @generated - Actor Framework Scripts v6
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {
  component,
  Component,
  editor,
  ExecuteOn,
  NetworkingService,
  OnEntityStartEvent,
  OnPlayerCreateEvent,
  OnPlayerCreateEventPayload,
  OnWorldUpdateEvent,
  OnWorldUpdateEventPayload,
  PlayerService,
  property,
  subscribe,
} from 'meta/worlds';
import {ActorSpawner} from './ActorSpawner';

// Effective floor for intervalSeconds; a 0/negative editor value would
// otherwise fire spawn() every frame and flood the world.
const MIN_INTERVAL_SECONDS = 0.1;

/**
 * Fires a sibling ActorSpawner's spawn() on a fixed time cadence -- but only once
 * a PLAYER is present in the world (plus a short startDelaySeconds buffer), NOT at
 * world load. Spawning enemies during the load phase, before any player can see
 * them, is wrong for real gameplay and also burns the live cap before the wave is
 * ever observed. OnPlayerCreateEvent is the latest, most-robust "the game is
 * really running" hook the SDK offers -- there is no world-ready event, and
 * world-load auto-fire is a documented anti-pattern.
 *
 * Place this on the SAME entity as an ActorSpawner. This component owns the
 * *when* (a periodic timer); the ActorSpawner owns the *how* (spawn + live-set
 * + cap). Together they compose an interval/wave spawner without a monolithic
 * component per use case (see actor_spawning_architecture design).
 *
 * Cadence is driven by accumulating OnWorldUpdateEvent deltaTime -- i.e. GAME
 * time, which *respects pause* (a wall-clock read like Date.now does not, and
 * floods on resume/app-switch). On an interval crossing the accumulator is RESET
 * to 0 (not decremented), so a single oversized catch-up tick (post-load /
 * resume / long pause) yields at most ONE spawn, never a backlog drain. And
 * ActorSpawner.spawn() is single-flight and skips at the live cap, so a slow
 * spawn can't let paced calls pile up and the rate self-limits to the cap.
 */
@component({
  description:
    'Calls a sibling ActorSpawner.spawn() every intervalSeconds, starting once a player is present (+ startDelaySeconds). Compose with ActorSpawner on the same entity for interval/wave spawning.',
})
export class ActorIntervalTrigger extends Component {
  @property()
  @editor({description: 'Seconds between spawn attempts.'})
  intervalSeconds: number = 3.0;

  @property()
  @editor({
    description:
      'Seconds to wait after a player is first present before the first spawn -- a settle buffer so the wave starts just after gameplay begins, not during load.',
  })
  startDelaySeconds: number = 5.0;

  @property()
  @editor({
    description:
      'When true, spawns once immediately when the cadence starts (after a player is present + startDelaySeconds) rather than waiting a full interval first.',
  })
  spawnOnStart: boolean = false;

  @property()
  @editor({description: 'Enable debug logging to console.'})
  debugLogEnabled: boolean = false;

  private spawner: ActorSpawner | null = null;
  // Accumulated GAME time (seconds) since the last spawn; the pacing anchor.
  private elapsed: number = 0;
  // Monotonic cumulative GAME time (seconds) since arming; never reset. Stamped
  // on the permanent spawn_requested telemetry so the eval grades cadence from
  // GAME-time deltas -- robust to a frame-starved headless host where wall-clock
  // gaps between spawns balloon (game time stops accruing per-tick under
  // starvation; wall time does not).
  private gameClock: number = 0;
  // Armed once a player is present; the cadence does not run before this.
  private armed: boolean = false;
  // Cadence has cleared the post-arm startDelaySeconds buffer and is now running.
  private started: boolean = false;
  // Remaining startDelaySeconds buffer (game time) after arming, before the wave.
  private startDelayRemaining: number = 0;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart(): void {
    this.spawner = this.entity.getComponent(ActorSpawner);
    if (!this.spawner) {
      console.warn(
        `[ActorIntervalTrigger] ${this.entityName}: no sibling ActorSpawner on this entity; nothing to drive.`,
      );
      return;
    }
    // A player may already be present when this component starts (hot-reload,
    // late entity enable, or the join fired before onStart). OnPlayerCreateEvent
    // does NOT re-fire for an already-present player, so arm directly here.
    if (this.isServer() && PlayerService.get().getAllPlayers().length > 0) {
      this.arm();
    }
  }

  @subscribe(OnPlayerCreateEvent, {execution: ExecuteOn.Owner})
  onPlayerJoin(payload: OnPlayerCreateEventPayload): void {
    // OnPlayerCreateEvent is a Broadcast event; gate to the server so the wave
    // arms once, authoritatively (a client arming would be dropped by
    // SpawnService anyway, but don't even try).
    if (!this.isServer() || payload.entity == null) {
      return;
    }
    this.arm();
  }

  // Arm the cadence once a player is present. Idempotent: later joins don't
  // restart the buffer or re-anchor the timer.
  private arm(): void {
    if (this.armed) {
      return;
    }
    this.armed = true;
    this.startDelayRemaining = Math.max(0, this.startDelaySeconds);
    this.log(
      `player present -> armed; first spawn in ~${this.startDelayRemaining.toFixed(1)}s`,
    );
  }

  @subscribe(OnWorldUpdateEvent, {execution: ExecuteOn.Owner})
  onUpdate(payload: OnWorldUpdateEventPayload): void {
    if (!this.spawner || !this.armed) {
      return;
    }
    this.gameClock += payload.deltaTime;
    // Burn the post-arm settle buffer before the wave begins. Once it elapses,
    // start the cadence (spawnOnStart fires the first spawn now; otherwise the
    // first is a full interval later).
    if (!this.started) {
      this.startDelayRemaining -= payload.deltaTime;
      if (this.startDelayRemaining > 0) {
        return;
      }
      this.started = true;
      this.elapsed = 0;
      if (this.spawnOnStart) {
        this.log(`spawnOnStart -> spawn (dt=${payload.deltaTime.toFixed(3)}s)`);
        this.emitSpawnRequested();
        void this.spawner.spawn();
      }
      return;
    }
    const interval = Math.max(this.intervalSeconds, MIN_INTERVAL_SECONDS);
    this.elapsed += payload.deltaTime;
    if (this.elapsed >= interval) {
      // Reset to 0 (NOT subtract/catch-up): one spawn per interval crossing, so a
      // single oversized catch-up tick (post-load / resume / long pause) yields at
      // most ONE spawn instead of a backlog drain. deltaTime is game time, so it
      // already stops accruing while paused -- no wall-clock flood on resume.
      this.elapsed = 0;
      this.log(`spawn (dt=${payload.deltaTime.toFixed(3)}s)`);
      this.emitSpawnRequested();
      void this.spawner.spawn();
    }
  }

  // Permanent telemetry (NOT debug-gated): the spawn_cadence eval grades the
  // GAME-time (gt) deltas between these markers. Emitted on every interval
  // crossing -- the INTENDED cadence -- even when the sibling ActorSpawner.spawn()
  // then single-flight-skips, and even on a frame-starved headless host where the
  // wall-clock gap between spawns balloons. Grading gt (game time) rather than the
  // log line's wall-clock timestamp is what makes the check FPS-robust.
  private emitSpawnRequested(): void {
    console.log(
      `[ActorSpawnTelemetry] event=spawn_requested spawner=${this.entityName} ` +
        `gt=${this.gameClock.toFixed(3)}`,
    );
  }

  private isServer(): boolean {
    return NetworkingService.get().isServerContext();
  }

  private log(...args: unknown[]): void {
    if (this.debugLogEnabled) {
      console.log(`[ActorIntervalTrigger] ${this.entityName}:`, ...args);
    }
  }

  private get entityName(): string {
    return this.entity?.valid ? this.entity.name : '<destroyed>';
  }
}
