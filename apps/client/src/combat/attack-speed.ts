/** Asset conversion utility. */
export type AttackSpeeds = {
  /** Seconds, or undefined when the field has not arrived. */
  mainHand?: number;
  offHand?: number;
  ranged?: number;
};

export function attackSpeeds(entity: {
  baseAttackTimeMs?: number;
  offHandAttackTimeMs?: number;
  rangedAttackTimeMs?: number;
} | undefined): AttackSpeeds {
  const seconds = (ms: number | undefined) => (ms && ms > 0 ? ms / 1000 : undefined);
  return {
    mainHand: seconds(entity?.baseAttackTimeMs),
    offHand: seconds(entity?.offHandAttackTimeMs),
    ranged: seconds(entity?.rangedAttackTimeMs),
  };
}

/**
 * PaperDollFrame's DPS: the average of the damage range over the weapon speed, floored at 1 damage
 * exactly as the Lua does. The physical bonus split (UnitDamage's physicalBonusPos/Neg/percent) is
 * not published to us separately — UNIT_FIELD_MINDAMAGE/MAXDAMAGE already arrive with modifiers
 * applied — so `fullDamage` here is the post-modifier average rather than base + bonus.
 */
export function damagePerSecond(
  minDamage: number | undefined,
  maxDamage: number | undefined,
  speedSeconds: number | undefined,
): number | undefined {
  if (minDamage === undefined || maxDamage === undefined) return undefined;
  if (!speedSeconds || speedSeconds <= 0) return undefined;
  return Math.max((minDamage + maxDamage) * 0.5, 1) / speedSeconds;
}

/**
 * UNIT_MOD_CAST_SPEED is a multiplier on cast time (1.0 = unmodified). vMaNGOS publishes it as a
 * float and applies it server-side to the cast time in SMSG_SPELL_START, so this is presentation
 * only — it exists so a hasted or slowed caster reads correctly in the UI.
 */
export function castSpeedPercent(castSpeedModifier: number | undefined): number | undefined {
  if (castSpeedModifier === undefined || !Number.isFinite(castSpeedModifier) || castSpeedModifier <= 0) {
    return undefined;
  }
  return (1 / castSpeedModifier - 1) * 100;
}
