// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import { ActorBehavior } from 'meta/worlds';
import type { ActorBehaviorManager } from 'meta/worlds';
import type { ActorController } from 'meta/worlds';

/**
 * CompositeBehavior acts as a single ActorBehavior from the manager's perspective.
 * Externally it competes for controllers using its own basePriority.
 * Internally, sub-behaviors compete among themselves — the composite routes
 * won controllers to the highest-priority sub-behavior.
 *
 * Sub-behaviors are updated in descending basePriority order so that
 * high-priority behaviors (e.g. TargetingBehavior at 200) run first.
 */
export class CompositeBehavior extends ActorBehavior {
  override name: string = 'CompositeBehavior';
  subBehaviors: ActorBehavior[] = [];

  override initialize(behaviorManager: ActorBehaviorManager): void {
    super.initialize(behaviorManager);

    for (const sub of this.subBehaviors) {
      sub.initialize(behaviorManager);
    }
  }

  override update(deltaTime: number): void {
    // Update sub-behaviors in descending basePriority order
    const sorted = [...this.subBehaviors].sort((a, b) => b.basePriority - a.basePriority);

    for (const sub of sorted) {
      sub.update(deltaTime);
    }

    // Remove finished sub-behaviors
    const finished = this.subBehaviors.filter((b) => b.isFinished);
    for (const sub of finished) {
      sub.onRemove();
    }
    this.subBehaviors = this.subBehaviors.filter((b) => !b.isFinished);
  }

  override getControllerUsePriority(controllerType: string): number {
    // Check if ANY sub-behavior wants this controller
    let anyWants = false;
    for (const sub of this.subBehaviors) {
      if (sub.getControllerUsePriority(controllerType) >= 0) {
        anyWants = true;
        break;
      }
    }

    if (anyWants) {
      return this.basePriority;
    }

    return -1;
  }

  override useController(controllerType: string, controller: ActorController): void {
    // Find the sub-behavior with highest internal priority for this controller
    let best: ActorBehavior | null = null;
    let bestPriority = -1;

    for (const sub of this.subBehaviors) {
      const priority = sub.getControllerUsePriority(controllerType);
      if (priority >= 0 && priority > bestPriority) {
        bestPriority = priority;
        best = sub;
      }
    }

    if (best) {
      best.useController(controllerType, controller);
    }
  }

  override onRemove(): void {
    for (const sub of this.subBehaviors) {
      sub.onRemove();
    }
  }

  /**
   * Adds a sub-behavior to the composite.
   * If the composite is already initialized, the sub-behavior is also initialized.
   */
  addSubBehavior(behavior: ActorBehavior): void {
    this.subBehaviors.push(behavior);
    if (this.behaviorManager) {
      behavior.initialize(this.behaviorManager);
    }
  }

  /**
   * Removes a sub-behavior from the composite with cleanup.
   */
  removeSubBehavior(behavior: ActorBehavior): void {
    behavior.onRemove();
    this.subBehaviors = this.subBehaviors.filter((b) => b !== behavior);
  }
}
