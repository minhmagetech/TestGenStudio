/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

/**
 * NpcAnimKey — the networked AnimGraph trigger / variable names an Actor-Framework NPC drives
 * through {@link WorldsCharacterStateReplication} (Combo_Character.animgraph in Base_AI_Template).
 * Each constant value IS both the replication key AND the authored AnimGraph event / variable
 * name, so a replicated key drives the animator directly — no key→name/type registry (mirrors
 * the player's `AnimKey` after the AnimGraph registry was dropped).
 *
 * SCOPE — the discrete, networked facts an NPC behavior triggers: one-shot triggers `Attack` /
 * `GetHit` / `Dance`, and the `IsAlive` bool (drives the Death state). Locomotion (`Speed` /
 * `MovementDirectionYaw` / grounded / jump) is EXCLUDED — the NPC's movement is fed locally each
 * frame by its locomotion controller, not replicated through this layer. (So this set does NOT
 * extend the player's `AnimKey` locomotion constants.)
 *
 * NAMING — these graph names match the NPC's Combo_Character.animgraph, NOT the player graph: the
 * NPC's attack event is plain `Attack` (the player's is authored `AttackTrigger`). Verified that
 * events `Attack`, `GetHit` and the `IsAlive` variable exist on the live graph.
 *
 * DEPENDENCY — `Dance` has no transition event in the graph yet; a `Grounded -> Dance` (event
 * `Dance`) state must be authored in Combo_Character.animgraph before `trigger(NpcAnimKey.DANCE)`
 * plays anything (until then it is a harmless no-op).
 */
// State-name constants use UPPER_SNAKE; their values are the authored AnimGraph event / variable
// names. Disable the camelCase class-property rule for this constants-only class.
/* eslint-disable @typescript-eslint/naming-convention */
export class NpcAnimKey {
  /** Trigger: one-shot attack swing (graph event `Attack`). */
  static readonly ATTACK = 'Attack';
  /** Trigger: one-shot hit / stagger reaction (graph event `GetHit`). */
  static readonly GET_HIT = 'GetHit';
  /** Trigger: one-shot dance / emote, e.g. taunt before engaging (graph event `Dance`). */
  static readonly DANCE = 'Dance';
  /** Bool: NPC is alive (false ⇒ Death state). */
  static readonly IS_ALIVE = 'IsAlive';
}
/* eslint-enable @typescript-eslint/naming-convention */
