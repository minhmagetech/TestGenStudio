// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import {ActorBehavior} from 'meta/worlds';
import type {ActorBehaviorManager} from 'meta/worlds';
import type {ActorController} from 'meta/worlds';

/**
 * SequentialBehavior - Runs a list of behaviors one after another.
 *
 * Each step runs exclusively until it sets `isFinished = true`, then the next
 * step is initialized and started. When all steps complete, the sequential
 * behavior itself finishes.
 *
 * Controller priority and usage are delegated entirely to the current step,
 * so each step can claim whatever controllers it needs (locomotion, pickup,
 * look, etc.) independently.
 *
 * Steps can be added before or after initialization. Steps added after
 * initialization are queued and will run after the current step finishes.
 *
 * Use cases:
 * - "Pick up key, then go to door" — chain SearchAndPickup + FollowTagged
 * - "Go to station, pick up meal, bring to counter" — chain Goto + SearchAndPickup + SimpleFetch
 * - Any multi-phase NPC quest sequence
 *
 * @example
 * ```typescript
 * const sequence = new SequentialBehavior();
 * sequence.basePriority = 30;
 *
 * // Step 1: Go pick up the key
 * const pickupKey = new SearchAndPickupBehavior();
 * pickupKey.targetTags = ['key'];
 * pickupKey.pickupRange = 2.0;
 *
 * // Step 2: Walk to the door
 * const goToDoor = new FollowTaggedEntityBehavior();
 * goToDoor.targetTags = ['door'];
 * goToDoor.followRange = 1.5;
 *
 * sequence.addStep(pickupKey);
 * sequence.addStep(goToDoor);
 *
 * actorLogic.addBehavior(sequence);
 * ```
 */
export class SequentialBehavior extends ActorBehavior {
  override name: string = 'SequentialBehavior';

  /** If true, loops back to the first step after all steps complete. */
  loop: boolean = false;

  private steps: ActorBehavior[] = [];
  private currentStepIndex: number = 0;
  private currentStepInitialized: boolean = false;

  /**
   * Adds a step to the sequence. Steps run in the order they are added.
   * If the sequence is already running and this is the only step, it
   * will be initialized immediately.
   */
  addStep(behavior: ActorBehavior): void {
    this.steps.push(behavior);
  }

  /** Returns the number of steps in the sequence. */
  getStepCount(): number {
    return this.steps.length;
  }

  /** Returns the index of the currently active step (0-based). */
  getCurrentStepIndex(): number {
    return this.currentStepIndex;
  }

  /** Returns the currently active step, or null if finished. */
  getCurrentStep(): ActorBehavior | null {
    if (this.currentStepIndex >= this.steps.length) {
      return null;
    }
    return this.steps[this.currentStepIndex];
  }

  override initialize(behaviorManager: ActorBehaviorManager): void {
    super.initialize(behaviorManager);
    this.currentStepIndex = 0;
    this.currentStepInitialized = false;
    this.initCurrentStep();
  }

  override update(deltaTime: number): void {
    if (this.currentStepIndex >= this.steps.length) {
      if (!this.loop) {
        this.isFinished = true;
      }
      return;
    }

    // Ensure current step is initialized
    if (!this.currentStepInitialized) {
      this.initCurrentStep();
    }

    const currentStep = this.steps[this.currentStepIndex];
    currentStep.update(deltaTime);

    // Check if current step finished
    if (currentStep.isFinished) {
      currentStep.onRemove();
      this.currentStepIndex++;
      this.currentStepInitialized = false;

      // Check if sequence is complete
      if (this.currentStepIndex >= this.steps.length) {
        if (this.loop) {
          // Reset all steps and start over
          this.currentStepIndex = 0;
          for (const step of this.steps) {
            step.isFinished = false;
          }
          this.initCurrentStep();
        } else {
          this.isFinished = true;
        }
      } else {
        this.initCurrentStep();
      }
    }
  }

  override getControllerUsePriority(controllerType: string): number {
    const currentStep = this.getCurrentStep();
    if (!currentStep) {
      return -1;
    }

    const stepPriority = currentStep.getControllerUsePriority(controllerType);
    if (stepPriority >= 0) {
      // Use the sequential behavior's own priority externally,
      // so it competes with other behaviors at the right level
      return this.basePriority;
    }

    return -1;
  }

  override useController(controllerType: string, controller: ActorController): void {
    const currentStep = this.getCurrentStep();
    if (currentStep) {
      currentStep.useController(controllerType, controller);
    }
  }

  override onRemove(): void {
    // Clean up current step
    const currentStep = this.getCurrentStep();
    if (currentStep && this.currentStepInitialized) {
      currentStep.onRemove();
    }
    this.steps = [];
    this.currentStepIndex = 0;
    this.currentStepInitialized = false;
  }

  // ── Private ───────────────────────────────────────────────────────

  private initCurrentStep(): void {
    if (this.currentStepIndex >= this.steps.length || !this.behaviorManager) {
      return;
    }

    const step = this.steps[this.currentStepIndex];
    step.initialize(this.behaviorManager);
    this.currentStepInitialized = true;
  }
}
