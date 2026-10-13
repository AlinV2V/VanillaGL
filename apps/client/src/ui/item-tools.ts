import type { InventorySlot, InventorySnapshot, ItemInfo } from '../world';
import type { TooltipLine } from './game-tooltip';
import { isBuiltInAddonEnabled } from './builtin-addons';
import { qualityColor } from './panel-kit';

const EQUIPMENT_BY_INVENTORY_TYPE: Record<number, readonly number[]> = {
  1: [0], 2: [1], 3: [2], 4: [3], 5: [4], 6: [5], 7: [6], 8: [7], 9: [8], 10: [9],
  11: [10, 11], 12: [12, 13], 13: [15, 16], 14: [16], 15: [17], 16: [14], 17: [15],
  19: [18], 20: [4], 21: [15], 22: [16], 23: [16], 25: [17], 26: [17], 28: [17],
};
const STAT_NAMES: Record<number, string> = {
  0: 'Mana', 1: 'Health', 3: 'Agility', 4: 'Strength', 5: 'Intellect', 6: 'Spirit', 7: 'Stamina',
};

const dps = (item: ItemInfo | undefined) => {
  if (!item?.delay || !item.damage?.length) return 0;
  return item.damage.reduce((sum, entry) => sum + (entry.min + entry.max) / 2, 0) / (item.delay / 1000);
};

const statTotals = (item: ItemInfo | undefined) => {
  const result = new Map<number, number>();
  for (const stat of item?.stats ?? []) result.set(stat.type, (result.get(stat.type) ?? 0) + stat.value);
  return result;
};

const signed = (value: number, label: string): TooltipLine | undefined => value
  ? { text: `${value > 0 ? '+' : ''}${Number.isInteger(value) ? value : value.toFixed(1)} ${label}`, color: value > 0 ? '#1eff00' : '#ff4040' }
  : undefined;

/** Optional EquipCompare-style delta block for a bag item. */
export function equippedComparisonLines(candidate: ItemInfo | undefined, snapshot: InventorySnapshot | undefined): TooltipLine[] {
  if (!isBuiltInAddonEnabled('itemTools') || !candidate || !snapshot) return [];
  const slots = EQUIPMENT_BY_INVENTORY_TYPE[candidate.inventoryType];
  if (!slots?.length) return [];
  const equipped = slots.map((index) => snapshot.equipment[index]).find((slot) => slot?.item?.info)?.item?.info;
  if (!equipped || equipped.entry === candidate.entry) return [];
  const lines: TooltipLine[] = [{ text: `Equipped: ${equipped.name}`, color: qualityColor(equipped.quality) }];
  const deltas: Array<TooltipLine | undefined> = [
    signed((candidate.armor ?? 0) - (equipped.armor ?? 0), 'Armor'),
    signed(dps(candidate) - dps(equipped), 'DPS'),
  ];
  const candidateStats = statTotals(candidate), equippedStats = statTotals(equipped);
  for (const type of new Set([...candidateStats.keys(), ...equippedStats.keys()])) {
    deltas.push(signed((candidateStats.get(type) ?? 0) - (equippedStats.get(type) ?? 0), STAT_NAMES[type] ?? `Stat ${type}`));
  }
  lines.push(...deltas.filter((line): line is TooltipLine => !!line));
  return lines;
}

export const itemToolsSellPriceEnabled = () => isBuiltInAddonEnabled('itemTools');

export function junkInventorySlots(snapshot: InventorySnapshot | undefined): InventorySlot[] {
  if (!snapshot) return [];
  return snapshot.bags.flatMap((bag) => bag.slots).filter((slot) => {
    const info = slot.item?.info;
    return !!slot.item && info?.quality === 0 && info.sellPrice > 0;
  });
}
