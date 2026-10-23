// @generated - Actor Framework Scripts v5
/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

import { AnimatorComponent, type Entity } from 'meta/worlds';

/**
 * Resolves an `AnimatorComponent` using the following fallback chain:
 * 1. If `animatedEntity` is provided, use the `AnimatorComponent` from that entity.
 * 2. Otherwise, try `entity` itself.
 * 3. Otherwise, search the immediate children of `entity` for an `AnimatorComponent`.
 *
 * Returns `null` if no `AnimatorComponent` can be found.
 *
 * Used by controllers and components that drive animation by calling
 * `AnimatorComponent.setGraphVariable()` and `AnimatorComponent.requestTransition()`
 * directly.
 */
export function resolveAnimatorComponent(
    entity: Entity,
    animatedEntity: Entity | null,
): AnimatorComponent | null {
    if (animatedEntity !== null) {
        const animator = animatedEntity.getComponent(AnimatorComponent);
        if (animator) {
            return animator;
        }
    }

    const selfAnimator = entity.getComponent(AnimatorComponent);
    if (selfAnimator) {
        return selfAnimator;
    }

    const childrenWithAnimator = entity.getChildrenWithComponent(AnimatorComponent);
    if (childrenWithAnimator.length > 0) {
        const childAnimator = childrenWithAnimator[0].getComponent(AnimatorComponent);
        if (childAnimator) {
            return childAnimator;
        }
    }

    return null;
}
