// @generated - Actor Framework Scripts v7
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {
  component,
  Component,
  OnEntityStartEvent,
  property,
  subscribe,
  type Entity,
  ExecuteOn,
} from 'meta/worlds';
import {ActorSdkLogicComponent, ActorMovementControllerTypeId} from 'meta/worlds';

@component()
export class BehaviorStarterComponent extends Component {
  @property()
  controlledActor: Entity | null = null;

  @property()
  autoStart: boolean = true;

  @property()
  removeDuplicates: boolean = true;

  // CRITICAL: Only initialize behaviors on owner (server) since that's where NPC logic runs
  // Client views don't need to initialize behaviors - they receive replicated transforms
  @subscribe(OnEntityStartEvent, { execution: ExecuteOn.Owner })
  onStart() {
    if (!this.autoStart) {
      return;
    }

    if (!this.controlledActor && this.entity.getComponent(ActorSdkLogicComponent)) {
      this.controlledActor = this.entity;
    }

    if (this.controlledActor) {
      this.warnIfNoMovementController();
      this.startBehavior();
    }
  }

  /**
   * Override in starters whose behavior drives locomotion, returning the
   * subclass name. A non-null value both opts into the missing-movement-
   * controller check and labels its diagnostic, so opt-in and label cannot
   * drift apart. Null (the default) is for starters that never move the actor
   * — look and speak. Note that item starters DO move: `UseItemBehavior` and
   * `SearchAndPickupBehavior` both drive `GotoBehavior` internally.
   *
   * The name is supplied explicitly rather than read from `constructor.name`,
   * which is not stable under minification.
   */
  protected locomotionStarterName(): string | null {
    return null;
  }

  /**
   * A locomotion actor with no registered ActorMovementController holds its
   * target and never closes; the request is dropped silently, so the only
   * downstream symptom misattributes to navmesh/collider radii.
   * ActorAnimatedMovementController does NOT register one despite its name.
   *
   * Runs before startBehavior(), which early-returns on every subclass when a
   * required property is unset, so the message states only what is true either
   * way: the actor cannot be moved. Diagnostic only — startBehavior() still
   * runs. warn, not error: error severity reaches APP ERROR / hzw_hsr_errors
   * and fails smoketest.
   */
  private warnIfNoMovementController(): void {
    const starterName = this.locomotionStarterName();
    if (starterName === null || !this.controlledActor) {
      return;
    }
    const actorLogic = this.controlledActor.getComponent(ActorSdkLogicComponent);
    if (!actorLogic) {
      return;
    }
    if (actorLogic.getControllers(ActorMovementControllerTypeId).length > 0) {
      return;
    }
    console.warn(
      `[${starterName}] No ActorMovementController is registered on this ` +
      'actor — a locomotion behavior on it cannot move it. Add ' +
      "ActorTransformMoveComponent to the actor's root entity " +
      '(ActorAnimatedMovementController only drives animation).',
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  startBehavior(): void { }
}
