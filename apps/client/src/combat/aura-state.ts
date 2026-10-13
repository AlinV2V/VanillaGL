export function hasAuraState(mask: number | undefined, requiredState: number | undefined): boolean {
  const state = requiredState ?? 0;
  if (state <= 0) return true;
  if (state > 32) return false;
  return (((mask ?? 0) >>> 0) & (1 << (state - 1))) !== 0;
}

export type SpellAuraReadiness = {
  usable: boolean;
  reactive: boolean;
  casterReady: boolean;
  targetReady: boolean;
};

/** Allocation-free variant for callers that evaluate this on a hot cadence. */
export function spellAuraReadinessInto(
  casterMask: number | undefined,
  targetMask: number | undefined,
  requiredCasterState: number | undefined,
  requiredTargetState: number | undefined,
  out: SpellAuraReadiness,
): SpellAuraReadiness {
  const casterReady = hasAuraState(casterMask, requiredCasterState);
  const targetReady = hasAuraState(targetMask, requiredTargetState);
  const hasReactiveRequirement = (requiredCasterState ?? 0) > 0 || (requiredTargetState ?? 0) > 0;
  out.usable = casterReady && targetReady;
  out.reactive = hasReactiveRequirement && casterReady && targetReady;
  out.casterReady = casterReady;
  out.targetReady = targetReady;
  return out;
}

/**
 * Client-side action-button advice only. The realm remains authoritative and the action stays
 * clickable so SPELL_FAILED_* feedback is never hidden by a stale/missing update field.
 */
export function spellAuraReadiness(
  casterMask: number | undefined,
  targetMask: number | undefined,
  requiredCasterState: number | undefined,
  requiredTargetState: number | undefined,
): SpellAuraReadiness {
  return spellAuraReadinessInto(
    casterMask,
    targetMask,
    requiredCasterState,
    requiredTargetState,
    { usable: false, reactive: false, casterReady: false, targetReady: false },
  );
}
