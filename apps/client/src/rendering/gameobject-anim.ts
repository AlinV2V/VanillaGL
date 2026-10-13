/** Asset conversion utility. */
export const GO_ANIM_CLOSE = 146;
export const GO_ANIM_CLOSED = 147;
export const GO_ANIM_OPEN = 148;
export const GO_ANIM_OPENED = 149;
export const GO_ANIM_HOLD = 158;

/** The shut pose. Both ACTIVE states (0 and 2) mean open; only READY means closed. */
export const GO_STATE_READY = 1;

/** Transitions must never be selected as an idle pose. */
export const GO_TRANSITION_ANIM_IDS: readonly number[] = [GO_ANIM_CLOSE, GO_ANIM_OPEN];

/**
 * Resting poses preferred when a model ships neither the requested animation nor Stand (0).
 * Ordered most- to least-specific.
 */
export const M2_RESTING_ANIM_IDS: readonly number[] = [GO_ANIM_CLOSED, GO_ANIM_OPENED, GO_ANIM_HOLD];

/**
 * The pose a GameObject sits in for a given state.
 *
 * `hold` distinguishes the two shapes the Build 5875 corpus actually ships:
 *   - a resting idle (147/149) — loop it, because some are authored idles (`WarchiefRendsHead`
 *     sways for 10s on `Opened`);
 *   - transitions only (146/148) — `ChestActive01.m2` ships `Open`, `Close`, two customs, `Destroy`
 *     and `Rebuild`, with no `Closed`/`Opened`/`Stand` at all. Its resting pose *is* the final frame
 *     of the matching transition, so play once and freeze there. Looping it is the open/close cycle.
 */
export type GameObjectPose = { animId: number; hold: boolean };

export function gameObjectRestingPose(
  state: number | undefined,
  available: readonly number[],
): GameObjectPose | undefined {
  const ready = state === GO_STATE_READY;
  const wanted = ready ? GO_ANIM_CLOSED : GO_ANIM_OPENED;
  if (available.includes(wanted)) return { animId: wanted, hold: false };
  // A model may author only one of the pair — prefer the other resting idle over a transition.
  const other = ready ? GO_ANIM_OPENED : GO_ANIM_CLOSED;
  if (available.includes(other)) return { animId: other, hold: false };
  // No resting idle at all: settle on the end of the transition that produced this state.
  const transition = ready ? GO_ANIM_CLOSE : GO_ANIM_OPEN;
  if (available.includes(transition)) return { animId: transition, hold: true };
  const otherTransition = ready ? GO_ANIM_OPEN : GO_ANIM_CLOSE;
  return available.includes(otherTransition) ? { animId: otherTransition, hold: true } : undefined;
}

/** Transition to play when a GameObject changes state, if the model authors it. */
export function gameObjectTransitionAnim(
  from: number | undefined,
  to: number | undefined,
  available: readonly number[],
): number | undefined {
  if (from === undefined || from === to) return undefined;
  const wanted = to === GO_STATE_READY ? GO_ANIM_CLOSE : GO_ANIM_OPEN;
  return available.includes(wanted) ? wanted : undefined;
}

/**
 * Which sequence index `M2Animator.update` settles on for `wantedId`.
 *
 * This is the real resolution chain used by `m2-animator.ts`; it lives here so the regression gate
 * can run it over every baked model. Order: the requested id, then Stand (0), then a resting pose,
 * then index 0 as the floor.
 */
export function resolveSequenceIndex(
  sequences: readonly { id: number }[],
  animLookup: readonly number[] | undefined,
  wantedId: number,
): number {
  const sequenceFor = (id: number) => {
    const lookup = animLookup?.[id];
    if (lookup !== undefined && lookup >= 0 && sequences[lookup]) return lookup;
    return sequences.findIndex((sequence) => sequence.id === id);
  };
  const direct = sequenceFor(wantedId);
  if (direct >= 0) return direct;
  const stand = sequenceFor(0);
  if (stand >= 0) return stand;
  for (const id of M2_RESTING_ANIM_IDS) {
    const index = sequenceFor(id);
    if (index >= 0) return index;
  }
  return 0;
}
