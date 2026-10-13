/** Indices appended by bake-spells.ts from raw Build-5875 Spell/SpellShapeshiftForm DBC rows. */
export const SHAPESHIFT_META = {
  formId: 25,
  stanceBarOrder: 26,
  bonusActionBar: 27,
  attackIconId: 28,
} as const;

/** SpellShapeshiftForm.dbc form 4: the native client labels failed land casts "Can only use while swimming". */
export const AQUATIC_FORM_ID = 4;

export type ShapeshiftSpellMeta = readonly unknown[];

export type ShapeshiftFormEntry = {
  spellId: number;
  formId: number;
  name: string;
  iconId: number;
  stanceBarOrder: number;
  bonusActionBar: number;
  attackIconId: number;
  active: boolean;
};

const numberAt = (meta: ShapeshiftSpellMeta, index: number) => Number(meta[index]) || 0;
const rankAt = (meta: ShapeshiftSpellMeta) => {
  const match = String(meta[1] ?? '').match(/^\s*rank\s+(\d+)\s*$/i);
  return match ? Number(match[1]) : 0;
};

/**
 * Mirrors CGPlayer_C's learned-form list: discover form spells from their baked aura relationship,
 * replace an older rank of the same form, preserve learn order for equal bar orders, and cap the
 * FrameXML bar at NUM_SHAPESHIFT_SLOTS (10).
 */
export function collectShapeshiftForms(
  knownSpellIds: readonly number[],
  auraSpellIds: readonly number[],
  metaFor: (spellId: number) => ShapeshiftSpellMeta | undefined,
): ShapeshiftFormEntry[] {
  const activeForms = new Set(auraSpellIds.map((spellId) =>
    numberAt(metaFor(spellId) ?? [], SHAPESHIFT_META.formId)).filter(Boolean));
  const byForm = new Map<number, { entry: ShapeshiftFormEntry; order: number; rank: number }>();
  knownSpellIds.forEach((spellId, order) => {
    const meta = metaFor(spellId);
    if (!meta) return;
    const formId = numberAt(meta, SHAPESHIFT_META.formId);
    const iconId = numberAt(meta, 2);
    if (!formId || !iconId) return;
    const rank = rankAt(meta);
    const stanceBarOrder = Number(meta[SHAPESHIFT_META.stanceBarOrder]) || 0;
    const previous = byForm.get(formId);
    // Multiple NPC/test spells can point at the same form and carry the same blank rank. Native
    // bar entries have a non-negative StanceBarOrder, so they win over -1 fallback variants before
    // rank is considered. Within the same class, only a genuinely higher rank replaces the first.
    if (previous) {
      const previousIsNativeBarEntry = previous.entry.stanceBarOrder >= 0;
      const candidateIsNativeBarEntry = stanceBarOrder >= 0;
      if (previousIsNativeBarEntry && !candidateIsNativeBarEntry) return;
      if (previousIsNativeBarEntry === candidateIsNativeBarEntry && previous.rank >= rank) return;
    }
    byForm.set(formId, {
      order: previous?.order ?? order,
      rank,
      entry: {
        spellId,
        formId,
        name: String(meta[0] ?? `Spell #${spellId}`),
        iconId,
        stanceBarOrder,
        bonusActionBar: numberAt(meta, SHAPESHIFT_META.bonusActionBar),
        attackIconId: numberAt(meta, SHAPESHIFT_META.attackIconId),
        active: activeForms.has(formId),
      },
    });
  });
  return [...byForm.values()]
    .sort((a, b) => {
      const ap = a.entry.stanceBarOrder < 0 ? Number.MAX_SAFE_INTEGER : a.entry.stanceBarOrder;
      const bp = b.entry.stanceBarOrder < 0 ? Number.MAX_SAFE_INTEGER : b.entry.stanceBarOrder;
      return ap - bp || a.order - b.order;
    })
    .slice(0, 10)
    .map(({ entry }) => entry);
}

export function activeShapeshiftAttackIcon(
  auraSpellIds: readonly number[],
  metaFor: (spellId: number) => ShapeshiftSpellMeta | undefined,
): number | undefined {
  for (const spellId of auraSpellIds) {
    const meta = metaFor(spellId);
    const iconId = meta ? numberAt(meta, SHAPESHIFT_META.attackIconId) : 0;
    if (iconId) return iconId;
  }
  return undefined;
}
