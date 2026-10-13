/** Asset conversion utility. */
import type { ItemInfo } from '../world';
import type { TooltipLine } from './game-tooltip';
import { itemTooltipLines, spellTooltipLines, type SpellTooltipMeta } from './tooltip-content';

/**
 * The spells.json tuple, by the indices `bake-spells.ts` writes:
 * 0 name, 1 rank, 5 attributes, 7 maxRange, 16 powerType, 17 powerCost, 22 equippedItemClass.
 * Index 11 is NOT cast time — it is `Spell.dbc` field 33, a float. Real cast time needs
 * CastingTimeIndex + SpellCastTimes.dbc, neither of which is baked.
 */
export type BakedSpellTuple = ReadonlyArray<unknown> | undefined;

export function spellMetaFromTuple(tuple: BakedSpellTuple, fallbackName: string): SpellTooltipMeta {
  const at = (index: number) => Number(tuple?.[index] ?? 0);
  return {
    name: String(tuple?.[0] ?? fallbackName),
    rank: tuple?.[1] ? String(tuple[1]) : undefined,
    attributes: at(5),
    maxRange: at(7),
    powerType: at(16),
    powerCost: at(17),
    equippedItemClass: tuple?.[22] === undefined ? -1 : at(22),
  };
}

/** Lines for a spell button. */
export const spellButtonTooltip = (spellId: number, tuple: BakedSpellTuple, fallbackName: string): TooltipLine[] =>
  spellTooltipLines(spellId, spellMetaFromTuple(tuple, fallbackName));

/** Lines for an item button, including its stack size. */
export const itemButtonTooltip = (entry: number, info: ItemInfo | undefined, count?: number): TooltipLine[] =>
  itemTooltipLines(info, entry, { count });
