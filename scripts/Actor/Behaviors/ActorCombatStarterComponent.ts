// @generated - Actor Framework Scripts v12
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {
  component,
  Component,
  editor,
  property,
  subscribe,
  OnEntityStartEvent,
  ExecuteOn,
} from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import type {Entity} from 'meta/worlds';
import { EngageCombatBehavior } from './CoreBehaviors/EngageCombatBehavior';
import { ActorMovementControllerTypeId } from 'meta/worlds';

/**
 * ActorCombatStarterComponent - Configures an actor with combat behavior.
 *
 * All distance properties use **surface-to-surface** semantics —
 * the framework reads both actors' collider radii automatically.
 * Set `maxAttackDistance` to the weapon's reach (0 = bite, 0.3 = sword,
 * 1.0 = spear, 10 = bow) and the composite derives all internal
 * follow/attack/hysteresis values.
 *
 * Target resolution is handled by the Actor Tagging System. Ensure
 * ActorSdkTagPlayerService is active to auto-tag players, or use
 * ActorSdkTagComponent to tag custom targets.
 */
@component({
  description: 'Configures an actor with combat — follows and attacks the closest tagged entity using surface-to-surface distances.',
})
export class ActorCombatStarterComponent extends Component {
  @property()
  @editor({ description: 'Comma-separated tags to target (e.g. "player", "player,enemy"). The actor engages the closest entity matching any listed tag. Consumer half only — the target entity must ALSO carry a matching ActorSdkTagComponent tag (players auto-tagged "player"), or nothing is acquired. 🚨 Template gotcha: stored as `""` on a template instance — set explicitly to `"player"`.' })
  targetTags: string = 'player';

  @property()
  @editor({ description: 'Maximum surface-to-surface distance (meters) at which the actor can attack. This is the weapon reach — collider radii are added automatically. Examples: 0 = bite, 0.3 = sword, 1.0 = spear, 10 = bow. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly to `1.5`.' })
  maxAttackDistance: number = 1.5;

  @property()
  @editor({ description: 'Minimum surface-to-surface distance (meters) for attacks. Creates a dead zone when the target is too close (e.g. for ranged NPCs). Default 0 (no dead zone).' })
  minAttackDistance: number = 0;

  @property()
  @editor({ description: 'Surface-to-surface distance (meters) where the NPC prefers to stand. Clamped to [minAttackDistance, maxAttackDistance] at runtime. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly to `1.5`.' })
  followDistance: number = 1.5;

  @property()
  @editor({ description: 'Surface-to-surface distance (meters) for target acquisition/retention. 0 (or unset) = UNLIMITED: the actor acquires the nearest tagged target at any distance and hunts from spawn — the right default for an enemy dropped away from the player. Set a positive value only for a dormant/ambush enemy that should wake when a target comes within range. 🚨 Template gotcha: a template instance zero-inits this to `0` (unlimited) — set a positive value explicitly only if you want a finite range.' })
  engagementRange: number = 0;

  @property()
  @editor({ description: 'Movement speed in meters per second when following a target. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly to `3.0`.' })
  followSpeed: number = 3.0;

  @property()
  @editor({ description: 'Minimum time in seconds between attacks. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly to `1.0`.' })
  attackFrequency: number = 1.0;

  @property()
  @editor({ description: 'Base priority for the combat behavior. Must be higher than idle/patrol behaviors to take control. 🚨 Template gotcha: stored as `0` on a template instance — set explicitly to `10` (a `0` means combat never wins behavior arbitration).' })
  combatBasePriority: number = 10;

  @property()
  @editor({ description: 'Set for a defender that must hold position (turret / wall wizard) built with no ActorTransformMoveComponent — see the "Stationary attacker" section of the making-actors-engage-in-combat skill. Suppresses the missing-movement-controller warning, which would otherwise fire every spawn for that supported setup.' })
  expectStationary: boolean = false;

  /** Stored reference to the running EngageCombatBehavior for runtime modifications. */
  private combat: EngageCombatBehavior | null = null;

  @subscribe(OnEntityStartEvent, { execution: ExecuteOn.Owner })
  onStart() {
    const actorLogic = this.entity.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      console.error('[ActorCombatStarterComponent] No ActorSdkLogicComponent on entity');
      return;
    }

    // A combat actor with no registered ActorMovementController acquires its
    // target and never closes — the only downstream symptom is EngageCombat's
    // pursuit-stall warning, which misattributes to navmesh/collider radii.
    // ActorAnimatedMovementController does NOT register one despite its name.
    // warn, not error: error severity reaches APP ERROR / hzw_hsr_errors and
    // fails smoketest, and a mover-less actor is a supported configuration.
    if (
      !this.expectStationary &&
      actorLogic.getControllers(ActorMovementControllerTypeId).length === 0
    ) {
      console.warn(
        '[ActorCombatStarterComponent] No ActorMovementController is registered ' +
        "on this actor — it will acquire a target but never move toward it. Add " +
        "ActorTransformMoveComponent to the actor's root entity " +
        '(ActorAnimatedMovementController only drives animation). If the actor ' +
        'is meant to hold position, set expectStationary.',
      );
    }

    const combat = new EngageCombatBehavior();
    combat.basePriority = this.combatBasePriority;
    combat.targetTags = this.targetTags.split(',').map(t => t.trim()).filter(t => t.length > 0);
    combat.maxAttackDistance = this.maxAttackDistance;
    combat.minAttackDistance = this.minAttackDistance;
    combat.followDistance = this.followDistance;
    combat.engagementRange = this.engagementRange;
    combat.followSpeed = this.followSpeed;
    combat.attackFrequency = this.attackFrequency;
    // attackDamage intentionally not exposed as a starter @property —
    // EngageCombatBehavior's default of 1 covers the common case. Authors
    // who need a non-default damage value instantiate EngageCombatBehavior
    // directly instead of using this starter component.

    actorLogic.addBehavior(combat);
    this.combat = combat;
  }

  /**
   * Returns the base follow speed from the template configuration, so callers
   * know the unmodified speed for slow-debuff restoration.
   */
  public getBaseFollowSpeed(): number {
    return this.followSpeed;
  }

  /**
   * Dynamically overrides the running behavior's follow speed (e.g. a slow
   * debuff, and restore on expiry). No-op before onStart() or if the combat
   * behavior failed to initialize.
   */
  public setRuntimeFollowSpeed(speed: number): void {
    this.combat?.setFollowSpeed(speed);
  }

  /**
   * Temporarily overrides the combat target to a specific entity.
   * Pass null to revert to normal tag-based targeting.
   */
  public setTargetOverride(entity: Entity | null): void {
    this.combat?.setTargetOverride(entity);
  }
}
