export type SpellModifierKind = 'flat' | 'pct';

export type SpellModifierUpdate = {
  kind: SpellModifierKind;
  effectIndex: number;
  modOp: number;
  value: number;
};

/** SpellModOp values used by client-side cast/action prediction. */
export const SPELL_MOD_OP = {
  RANGE: 5,
  CASTING_TIME: 10,
  COOLDOWN: 11,
  SPEED: 12,
  COST: 14,
  ACTIVATION_TIME: 19,
  GLOBAL_COOLDOWN: 21,
} as const;

export function decodeSpellModifierBody(
  body: Uint8Array,
  kind: SpellModifierKind,
): SpellModifierUpdate {
  if (body.length !== 6) {
    throw new Error(`SET_${kind.toUpperCase()}_SPELL_MODIFIER body is ${body.length} bytes, expected 6`);
  }
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const effectIndex = view.getUint8(0);
  const modOp = view.getUint8(1);
  const value = view.getInt32(2, true);
  if (effectIndex >= 64) throw new Error(`spell modifier effect index ${effectIndex} is outside 0..63`);
  return { kind, effectIndex, modOp, value };
}

/**
 * Exact client table sent by vMaNGOS: one cumulative value for each
 * (flat/pct, SpellFamilyFlags bit, SpellModOp) tuple.
 */
export class SpellModifierTable {
  private readonly values = new Map<string, number>();

  apply(update: SpellModifierUpdate) {
    const key = this.key(update.kind, update.effectIndex, update.modOp);
    if (update.value === 0) this.values.delete(key);
    else this.values.set(key, update.value);
  }

  clear() {
    this.values.clear();
  }

  get(kind: SpellModifierKind, effectIndex: number, modOp: number) {
    return this.values.get(this.key(kind, effectIndex, modOp)) ?? 0;
  }

  /** Values attached to every set bit in a spell's raw 64-bit SpellFamilyFlags. */
  valuesForMask(
    kind: SpellModifierKind,
    modOp: number,
    familyFlagsLow: number,
    familyFlagsHigh: number,
  ) {
    const result: Array<{ effectIndex: number; value: number }> = [];
    for (let bit = 0; bit < 64; bit++) {
      const word = bit < 32 ? familyFlagsLow : familyFlagsHigh;
      const wordBit = bit < 32 ? bit : bit - 32;
      if (((word >>> wordBit) & 1) === 0) continue;
      const value = this.get(kind, bit, modOp);
      if (value !== 0) result.push({ effectIndex: bit, value });
    }
    return result;
  }

  private key(kind: SpellModifierKind, effectIndex: number, modOp: number) {
    return `${kind}:${effectIndex}:${modOp}`;
  }
}

/**
 * vMaNGOS sends cumulative values per family bit, not the original aura masks. When every matching
 * bit agrees (the ordinary rank-family case), that value is safe for prediction. Ambiguous,
 * overlapping masks deliberately return zero so the realm remains authoritative rather than
 * double-applying a modifier the browser cannot reconstruct from the wire table.
 */
export function uniformSpellModifier(
  values: readonly { effectIndex: number; value: number }[],
) {
  if (values.length === 0) return 0;
  const first = values[0].value;
  return values.every((entry) => entry.value === first) ? first : 0;
}

export function applySpellModifier(
  base: number,
  flat: number,
  pct: number,
  minimum = 0,
) {
  return Math.max(minimum, (base + flat) * (1 + pct / 100));
}
