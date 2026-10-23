// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {
  Component,
  component,
  property,
  subscribe,
  OnEntityStartEvent,
  OnTriggerEnterEvent,
  OnTriggerEnterEventPayload,
  Service,
  ExecuteOn,
} from 'meta/worlds';
import type {Entity} from 'meta/worlds';
import {ActorSdkBlackboardManager} from 'meta/worlds';
import {ActorTaggingBlackboard} from 'meta/worlds';
import type {ActorTaggedEntity} from 'meta/worlds';
import {BlackboardScope} from 'meta/worlds';

/**
 * Base class for trigger-based world interactions that react to tagged entities.
 *
 * Place this component on an entity with a trigger collider (PhysicsBodyType.Trigger).
 * When an entity enters the trigger, the component checks if it carries any of
 * the specified tags. If it does, `onActorWorldTriggered` is called.
 *
 * Subclasses override `onActorWorldTriggered` to implement specific behavior
 * (e.g. change NPC behavior, open a door, play a sound, spawn an entity).
 *
 * Tags are provided as a comma-separated string (e.g. "player, enemy").
 * If multiple tags are specified, the trigger reacts to ALL of them — any
 * entity carrying at least one matching tag will activate it.
 *
 * The entity entering the trigger must be registered in the ActorTaggingBlackboard
 * (via ActorSdkTagComponent or ActorSdkTagPlayerService) for tag matching to work.
 *
 * @example
 * ```typescript
 * @component()
 * export class SwitchFollowTargetTrigger extends ActorWorldTriggerComponent {
 *   @property()
 *   targetNpc: Entity | null = null;
 *
 *   override onActorWorldTriggered(activatingEntity: Entity): void {
 *     // Change the NPC's behavior when a tagged entity enters the trigger
 *   }
 * }
 * ```
 */
@component({description: 'Base world trigger that calls onActorWorldTriggered when a tagged entity enters'})
export class ActorWorldTriggerComponent extends Component {
  /**
   * Comma-separated list of tags that this trigger reacts to.
   * Example: "player, enemy"
   */
  @property()
  tags: string = '';

  /**
   * If true, the trigger can only be activated once.
   * After the first activation it stops responding to triggers.
   */
  @property()
  oneShot: boolean = false;

  /**
   * Enable debug logging to console.
   */
  @property()
  debugLogEnabled: boolean = false;

  private blackboardManager = Service.inject(ActorSdkBlackboardManager);
  private taggingBlackboard: ActorTaggingBlackboard | null = null;
  private acceptedTags: string[] = [];
  private activated: boolean = false;

  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Owner})
  onStart(): void {
    this.acceptedTags = this.parseTags(this.tags);

    if (this.acceptedTags.length === 0) {
      if (this.debugLogEnabled) {
        console.error(
          '[ActorWorldTriggerComponent] No tags specified. Set the tags property (e.g. "player, enemy").',
        );
      }
      return;
    }

    this.taggingBlackboard =
      this.blackboardManager.getBlackboard(
        ActorTaggingBlackboard,
        /* actorId */ undefined,
        /* groupId */ undefined,
        BlackboardScope.Global,
      ) ?? null;

    if (this.debugLogEnabled) {
      console.log(
        `[ActorWorldTriggerComponent] Initialized with tags: [${this.acceptedTags.join(', ')}]`,
      );
    }
  }

  @subscribe(OnTriggerEnterEvent, {execution: ExecuteOn.Owner})
  onTriggerEnter(params: OnTriggerEnterEventPayload): void {
    if (this.oneShot && this.activated) {
      return;
    }

    const enteringEntity = params.actorEntity;
    if (!enteringEntity || enteringEntity.isDestroyed()) {
      return;
    }

    if (!this.taggingBlackboard) {
      if (this.debugLogEnabled) {
        console.warn(
          '[ActorWorldTriggerComponent] No ActorTaggingBlackboard available — cannot check tags.',
        );
      }
      return;
    }

    const taggedEntity = this.taggingBlackboard.getTaggedEntity(enteringEntity);
    if (!taggedEntity) {
      // Entity is not registered in the tagging system — check parent
      // (colliders are often on child entities)
      if (enteringEntity.parent) {
        const parentTagged = this.taggingBlackboard.getTaggedEntity(
          enteringEntity.parent,
        );
        if (parentTagged && this.hasMatchingTag(parentTagged)) {
          this.activate(enteringEntity.parent);
          return;
        }
      }

      if (this.debugLogEnabled) {
        console.log(
          `[ActorWorldTriggerComponent] Entity "${enteringEntity.name}" has no tags — ignored.`,
        );
      }
      return;
    }

    if (this.hasMatchingTag(taggedEntity)) {
      this.activate(enteringEntity);
    } else if (this.debugLogEnabled) {
      console.log(
        `[ActorWorldTriggerComponent] Entity "${enteringEntity.name}" has no matching tags — ignored.`,
      );
    }
  }

  /**
   * Called when a tagged entity enters the trigger.
   * Override this method in subclasses to implement custom trigger behavior.
   *
   * @param _activatingEntity The entity that activated the trigger
   */
  protected onActorWorldTriggered(_activatingEntity: Entity): void {
    // Base implementation — subclasses override this
  }

  private activate(activatingEntity: Entity): void {
    this.activated = true;

    if (this.debugLogEnabled) {
      console.log(
        `[ActorWorldTriggerComponent] Triggered by "${activatingEntity.name}"`,
      );
    }

    this.onActorWorldTriggered(activatingEntity);
  }

  private hasMatchingTag(
    taggedEntity: ActorTaggedEntity,
  ): boolean {
    for (const tag of this.acceptedTags) {
      if (taggedEntity.hasTag(tag)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Splits a comma-separated string into trimmed, non-empty tag values.
   */
  private parseTags(raw: string): string[] {
    return raw
      .split(',')
      .map(t => t.trim())
      .filter(t => t.length > 0);
  }
}
