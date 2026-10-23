// @generated - Actor Framework Scripts v9
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {
  AnimatorComponent,
  component,
  subscribe,
  property,
  editor,
  OnEntityCreateEvent,
  OnEntityDestroyEvent,
  ExecuteOn,
  subscribePropertyChange,
  type Entity,
} from 'meta/worlds';
import { ActorHealthControllerTypeId, ActorHealthControllerData, type ActorHealthController } from 'meta/worlds';
import {ActorSdkLogicComponent} from 'meta/worlds';
import { resolveAnimatorComponent } from './ResolveAnimatorComponent';
import { GameplayHealthComponent } from './GameplayHealthComponent';

/**
 * Health component for animated actors (e.g. Samurai).
 * Triggers AnimGraph transitions for Hit and Death reactions on all clients
 * via networked properties.
 */
@component({
  description: 'Health component for animated actors (e.g. Samurai). Triggers AnimGraph transitions for hit and death reactions on all clients via networked properties.',
})
export class ActorAnimatedHealthComponent extends GameplayHealthComponent implements ActorHealthController {

  @property()
  @editor({ description: 'AnimGraph transition name to trigger on death. Must match the TypeScript Name on the relevant AnimGraph transition.' })
  deathTransitionName: string = 'Death';

  @property()
  @editor({ description: 'AnimGraph transition name to trigger when hit. Must match the TypeScript Name on the relevant AnimGraph transition.' })
  hitTransitionName: string = 'Hit';

  @property()
  @editor({ description: 'AnimGraph transition name to return to after a hit reaction completes.' })
  idleTransitionName: string = 'Idle';

  @property()
  @editor({ description: 'Duration in seconds the hit reaction plays before returning to idle.' })
  hitDuration: number = 0.35;

  @property({ isNetworked: true })
  @editor({ show: false })
  networkedIsDead: boolean = false;

  @property({ isNetworked: true })
  @editor({ show: false })
  networkedIsHit: boolean = false;

  /**
   * Optional entity to get the AnimatorComponent from.
   * If set, the AnimatorComponent will be retrieved from this entity.
   * If null, falls back to this.entity, then to child entities.
   */
  @property()
  @editor({ description: 'Optional entity containing the AnimatorComponent. If null, searches this entity and children.' })
  animatedEntity: Entity | null = null;

  private actorLogicComponent: ActorSdkLogicComponent | null = null;
  private animatorComponent: AnimatorComponent | null = null;
  private hitResetTimeoutId: number | null = null;

  @subscribe(OnEntityCreateEvent, { execution: ExecuteOn.Everywhere })
  override onCreate() {
    super.onCreate();
    this.actorLogicComponent = this.entity.getComponent(ActorSdkLogicComponent);
    this.animatorComponent = null;

    if (this.entity.isOwned()) {
      this.registerActorController();
    }
  }

  @subscribe(OnEntityDestroyEvent)
  onDestroy() {
    if (this.hitResetTimeoutId) {
      clearTimeout(this.hitResetTimeoutId);
    }
    this.unregisterActorController();
  }

  /**
   * Resolves the AnimatorComponent lazily on first use using the
   * standard fallback chain (`animatedEntity` → this entity → children).
   */
  private resolveAnimator(): AnimatorComponent | null {
    if (this.animatorComponent) {
      return this.animatorComponent;
    }
    this.animatorComponent = resolveAnimatorComponent(this.entity, this.animatedEntity);
    return this.animatorComponent;
  }

  @subscribePropertyChange('networkedIsDead')
  onNetworkedIsDeadChanged() {
    if (!this.networkedIsDead) return;

    const animator = this.resolveAnimator();
    if (!animator) return;

    // Force Death transition regardless of current state
    if (this.deathTransitionName) {
      animator.requestTransition(this.deathTransitionName);
    }
  }

  @subscribePropertyChange('networkedIsHit')
  onNetworkedIsHitChanged() {
    if (this.isDead) return;

    const animator = this.resolveAnimator();
    if (!animator) return;

    if (this.networkedIsHit) {
      if (this.hitTransitionName) {
        animator.requestTransition(this.hitTransitionName);
      }
    } else {
      if (this.idleTransitionName) {
        animator.requestTransition(this.idleTransitionName);
      }
    }
  }

  override onDeath() {
    super.onDeath();

    if (this.entity.isOwned()) {
      // Cancel any pending hit reaction to avoid blocking the Death transition
      if (this.hitResetTimeoutId) {
        clearTimeout(this.hitResetTimeoutId);
        this.hitResetTimeoutId = null;
      }
      this.isHit = false;
      this.networkedIsHit = false;

      // Trigger death on all clients
      this.networkedIsDead = true;
    }
  }

  override takeDamage(amount: number): void {
    if (this.isDead) return;

    const newHealth = Math.max(0, this.currentHealth - amount);
    const dead = newHealth <= 0;

    this.setHealthData(Object.assign(new ActorHealthControllerData(), {
      maxHealth: this.maxHealth,
      currentHealth: newHealth,
      isDead: dead,
      isHit: !dead,
    }));

    // This override does not call super.takeDamage, so the base's combat
    // telemetry is only emitted because of this call. Runs after setHealthData
    // so the emitted health= is the post-damage value.
    this.recordDamage(amount, dead);

    if (!dead && this.entity.isOwned()) {
      this.isHit = true;
      this.networkedIsHit = true;

      if (this.hitResetTimeoutId) {
        clearTimeout(this.hitResetTimeoutId);
      }
      this.hitResetTimeoutId = setTimeout(() => {
        this.isHit = false;
        this.networkedIsHit = false;
        this.hitResetTimeoutId = null;
      }, this.hitDuration * 1000);
    }

    if (dead) {
      this.onDeath();
    }
  }

  healDamage(amount: number): void {
    const newHealth = Math.min(this.currentHealth + amount, this.maxHealth);
    this.setHealthData(Object.assign(new ActorHealthControllerData(), {
      maxHealth: this.maxHealth,
      currentHealth: newHealth,
      isDead: this.isDead,
      isHit: this.isHit,
    }));
  }

  getHealthData(): ActorHealthControllerData {
    return Object.assign(new ActorHealthControllerData(), {
      maxHealth: this.maxHealth,
      currentHealth: this.currentHealth,
      isDead: this.isDead,
      isHit: this.isHit,
    });
  }

  setHealthData(data: ActorHealthControllerData): void {
    // A revive starts a new life, so hits-to-kill restarts with it; without
    // this the next death line reports the total across both lives.
    if (this.isDead && !data.isDead) {
      this.hitCount = 0;
    }
    this.maxHealth = data.maxHealth;
    this.currentHealth = data.currentHealth;
    this.isDead = data.isDead;
    this.isHit = data.isHit;
  }

  registerActorController(): void {
    this.actorLogicComponent?.registerController(ActorHealthControllerTypeId, this);
  }

  unregisterActorController(): void {
    this.actorLogicComponent?.unregisterController(this);
  }
}
