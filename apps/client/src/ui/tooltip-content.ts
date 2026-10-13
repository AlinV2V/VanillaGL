/** Asset conversion utility. */
import type { ItemInfo } from '../world';
import type { TooltipLine } from './game-tooltip';
import { qualityColor } from './panel-kit';
import { getInterfaceCvars } from './interface-runtime';
import { FACTIONS_BY_REPUTATION_INDEX } from '../data/factions';
import { SKILL_LINES } from '../data/skill-lines';
import { loadSpellTooltips, spellAuraDescription, spellDescription } from './spell-tooltip-text';

void loadSpellTooltips();

/** UnitPowerType — Rage and Happiness are stored x10 in Spell.dbc. */
const POWER_NAMES: Record<number, string> = { 0: 'Mana', 1: 'Rage', 2: 'Focus', 3: 'Energy', 4: 'Happiness' };
const POWER_SCALE: Record<number, number> = { 1: 10, 4: 10 };
/** SPELL_ATTR_ON_NEXT_SWING_1 — the cast resolves on the next melee swing rather than immediately. */
const SPELL_ATTR_ON_NEXT_SWING = 0x00000004;
/** ItemClass 2 = Weapon; the spell then requires one equipped. */
const ITEM_CLASS_WEAPON = 2;
/** SpellRange.dbc's melee row. At or below this, vanilla prints no range line at all. */
const MELEE_RANGE_YARDS = 5;

/** The 16-field spells.json tuple, by the indices `bake-spells.ts` writes. */
export type SpellTooltipMeta = {
  name: string;
  rank?: string;
  /** Spell.dbc Attributes (field 5 of the baked tuple). */
  attributes?: number;
  maxRange?: number;
  powerType?: number;
  powerCost?: number;
  equippedItemClass?: number;
};

/**
 * GameTooltip layout for a spell, following the live client:
 *
 *   Heroic Strike                 name, white
 *   15 Rage                       cost, white
 *   Next melee                    cast time / next-swing, white
 *   Requires Melee Weapon         equipped-item requirement, white
 *   A strong attack that ...      Spell.dbc Description, GOLD and wrapped
 *
 * The description is the part that was missing entirely — it lives in Spell.dbc with `$s1`-style
 * tokens, is baked by `bake-spell-tooltips.ts` and resolved by `spell-tooltip-text.ts`.
 */
export function spellTooltipLines(spellId: number, meta: SpellTooltipMeta): TooltipLine[] {
  const lines: TooltipLine[] = [{ text: meta.name, color: '#ffffff', size: 13 }];

  const scale = POWER_SCALE[meta.powerType ?? 0] ?? 1;
  const cost = Math.round((meta.powerCost ?? 0) / scale);
  if (cost > 0) lines.push({ text: `${cost} ${POWER_NAMES[meta.powerType ?? 0] ?? 'Mana'}`, color: '#ffffff' });

  // Vanilla prints no range line for a melee-range spell — Heroic Strike's tooltip goes straight
  // from the cost to "Next melee". SpellRange.dbc's melee row is 5 yards.
  if (meta.maxRange && meta.maxRange > MELEE_RANGE_YARDS) {
    lines.push({ text: `${Math.round(meta.maxRange)} yd range`, color: '#ffffff' });
  }

  // Only the next-swing attribute is knowable here. Real cast time lives in SpellCastTimes.dbc via
  // CastingTimeIndex, which `bake-spells.ts` does not emit — printing a guess would put "0 sec cast"
  // on Fireball, so the line is omitted until that column is baked.
  if ((meta.attributes ?? 0) & SPELL_ATTR_ON_NEXT_SWING) lines.push({ text: 'Next melee', color: '#ffffff' });

  if (meta.equippedItemClass === ITEM_CLASS_WEAPON) lines.push({ text: 'Requires Melee Weapon', color: '#ffffff' });

  const description = spellDescription(spellId);
  if (description) {
    for (const paragraph of description.split('\n')) {
      lines.push({ text: paragraph, color: '#ffd100', wrap: true });
    }
  }
  const aura = spellAuraDescription(spellId);
  if (aura && aura !== description) lines.push({ text: aura, color: '#ffd100', wrap: true });

  if (!description && meta.rank) lines.push({ text: meta.rank, color: '#ffd100' });
  return lines;
}

/** Vanilla INVTYPE_* display names, indexed by ItemPrototype.InventoryType. */
const INVENTORY_TYPE_NAMES: Record<number, string> = {
  1: 'Head', 2: 'Neck', 3: 'Shoulder', 4: 'Shirt', 5: 'Chest', 6: 'Waist',
  7: 'Legs', 8: 'Feet', 9: 'Wrist', 10: 'Hands', 11: 'Finger', 12: 'Trinket',
  13: 'One-Hand', 14: 'Off Hand', 15: 'Ranged', 16: 'Back', 17: 'Two-Hand',
  18: 'Bag', 19: 'Tabard', 20: 'Chest', 21: 'Main Hand', 22: 'Off Hand',
  23: 'Held In Off-hand', 24: 'Projectile', 25: 'Thrown', 26: 'Ranged', 28: 'Relic',
};

/** Vanilla item class/subclass names for the right-aligned column. */
const WEAPON_SUBCLASS: Record<number, string> = {
  0: 'Axe', 1: 'Axe', 2: 'Bow', 3: 'Gun', 4: 'Mace', 5: 'Mace', 6: 'Polearm',
  7: 'Sword', 8: 'Sword', 10: 'Staff', 13: 'Fist Weapon', 15: 'Dagger',
  16: 'Thrown', 18: 'Crossbow', 19: 'Wand', 20: 'Fishing Pole',
};
const ARMOR_SUBCLASS: Record<number, string> = {
  0: 'Miscellaneous', 1: 'Cloth', 2: 'Leather', 3: 'Mail', 4: 'Plate', 6: 'Shield',
};

/** ITEM_MOD_* base attribute names (vanilla 1.12; 2 is unused). */
const STAT_NAMES: Record<number, string> = {
  0: 'Mana', 1: 'Health', 3: 'Agility', 4: 'Strength', 5: 'Intellect', 6: 'Spirit', 7: 'Stamina',
};
/** Spell-school suffix for weapon damage; school 0 (physical) has no prefix. */
const DAMAGE_SCHOOL: Record<number, string> = {
  1: 'Holy', 2: 'Fire', 3: 'Nature', 4: 'Frost', 5: 'Shadow', 6: 'Arcane',
};
/** Resistance line labels in the wire order that follows Armor. */
const RESISTANCE_NAMES = ['Holy', 'Fire', 'Nature', 'Frost', 'Shadow', 'Arcane'];
const ITEM_BINDING: Record<number, string> = {
  1: 'Binds when picked up', 2: 'Binds when equipped', 3: 'Binds when used', 4: 'Quest Item', 5: 'Quest Item',
};
const ITEM_SPELL_TRIGGER: Record<number, string> = { 0: 'Use:', 1: 'Equip:', 2: 'Chance on hit:' };
const REPUTATION_RANK = ['Hated', 'Hostile', 'Unfriendly', 'Neutral', 'Friendly', 'Honored', 'Revered', 'Exalted'];

export type ItemTooltipExtras = {
  count?: number;
  durability?: number;
  maxDurability?: number;
  sellPrice?: boolean;
  buyPrice?: number;
  durationSeconds?: number;
  enchantments?: Array<{ enchantId: number; durationSeconds?: number }>;
};

let itemEnchantNames: Record<string, string> = {};
void fetch('/spells/item-enchants.json')
  .then((response) => response.ok ? response.json() as Promise<Record<string, string>> : {})
  .then((names) => { itemEnchantNames = names; })
  .catch(() => undefined);

const roundedDuration = (seconds: number) => {
  const remaining = Math.max(0, Math.ceil(seconds));
  if (remaining >= 86_400) return `${Math.ceil(remaining / 86_400)} days`;
  if (remaining >= 3_600) return `${Math.ceil(remaining / 3_600)} hrs`;
  if (remaining >= 60) return `${Math.ceil(remaining / 60)} min`;
  return `${remaining} sec`;
};

export const itemTooltipLines = (
  info: ItemInfo | undefined,
  entry: number,
  extras: ItemTooltipExtras = {},
): TooltipLine[] => {
  if (!info) return [{ text: `Item #${entry}`, color: '#ffffff' }];
  const lines: TooltipLine[] = [{ text: info.name, color: qualityColor(info.quality) }];
  const slotName = INVENTORY_TYPE_NAMES[info.inventoryType];
  if (slotName) {
    const subclassName = info.classId === 2 ? WEAPON_SUBCLASS[info.subclass] : info.classId === 4 ? ARMOR_SUBCLASS[info.subclass] : undefined;
    lines.push({ text: slotName, right: subclassName && subclassName !== 'Miscellaneous' ? subclassName : undefined });
  }
  const binding = ITEM_BINDING[info.bonding ?? 0];
  if (binding) lines.push({ text: binding });
  if (info.classId === 1 && info.containerSlots > 0) lines.push({ text: `${info.containerSlots} Slot Bag` });
  // Weapon damage + speed + DPS, then armor, base stats and resistances — vanilla GameTooltip order,
  // placed before durability/requirements. Arrays are optional-guarded so preview mocks (cast to
  // ItemInfo without these fields) don't throw.
  const damage = info.damage ?? [];
  const delaySec = (info.delay ?? 0) / 1000;
  if (damage.length > 0) {
    let totalMin = 0;
    let totalMax = 0;
    for (const d of damage) {
      const school = DAMAGE_SCHOOL[d.type];
      const label = school ? `${school} Damage` : 'Damage';
      lines.push({
        text: `${Math.round(d.min)} - ${Math.round(d.max)} ${label}`,
        right: delaySec > 0 && d === damage[0] ? `Speed ${delaySec.toFixed(2)}` : undefined,
      });
      totalMin += d.min;
      totalMax += d.max;
    }
    if (delaySec > 0) {
      const dps = (totalMin + totalMax) / 2 / delaySec;
      lines.push({ text: `(${dps.toFixed(1)} damage per second)` });
    }
  }
  if ((info.armor ?? 0) > 0) lines.push({ text: `${info.armor} Armor` });
  if ((info.block ?? 0) > 0) lines.push({ text: `${info.block} Block` });
  for (const stat of info.stats ?? []) {
    const name = STAT_NAMES[stat.type];
    if (!name) continue;
    lines.push({ text: `${stat.value > 0 ? '+' : ''}${stat.value} ${name}` });
  }
  // Interface Options → "Enhanced Tooltips" (UberTooltips). Resistances are the secondary
  // detail block: name, slot, damage, armor and stats are the item's identity and always
  // print; the per-school resistance list is what the compact tooltip drops.
  if (Number(getInterfaceCvars().UberTooltips) === 1) {
    (info.resistances ?? []).forEach((value, i) => {
      if (value > 0) lines.push({ text: `+${value} ${RESISTANCE_NAMES[i]} Resistance`, color: '#ffffff' });
    });
  }
  const maxDurability = extras.maxDurability ?? info.maxDurability;
  const durability = extras.durability ?? maxDurability;
  if (durability !== undefined && maxDurability) {
    lines.push({ text: `Durability ${durability} / ${maxDurability}` });
  }
  for (const enchantment of extras.enchantments ?? []) {
    const name = itemEnchantNames[String(enchantment.enchantId)] ?? `Enchantment ${enchantment.enchantId}`;
    lines.push({
      text: enchantment.durationSeconds && enchantment.durationSeconds > 0
        ? `${name} (${roundedDuration(enchantment.durationSeconds)})`
        : name,
      color: '#1eff00',
    });
  }
  if (extras.durationSeconds && extras.durationSeconds > 0) {
    lines.push({ text: `Duration: ${roundedDuration(extras.durationSeconds)}` });
  }
  if (info.requiredLevel > 1) lines.push({ text: `Requires Level ${info.requiredLevel}` });
  if (info.requiredSkill) {
    const skill = SKILL_LINES[info.requiredSkill]?.name ?? `Skill ${info.requiredSkill}`;
    lines.push({ text: `Requires ${skill}${info.requiredSkillRank ? ` (${info.requiredSkillRank})` : ''}` });
  }
  if (info.requiredReputationFaction) {
    const faction = Object.values(FACTIONS_BY_REPUTATION_INDEX)
      .find((candidate) => candidate.id === info.requiredReputationFaction)?.name ?? `Faction ${info.requiredReputationFaction}`;
    const rank = REPUTATION_RANK[info.requiredReputationRank ?? 0] ?? String(info.requiredReputationRank ?? 0);
    lines.push({ text: `Requires ${faction} - ${rank}` });
  }
  // "Show Detailed Tooltips" adds the item's own id — the diagnostic line, not gameplay text.
  if (Number(getInterfaceCvars().detailedTooltips) === 1 && entry) {
    lines.push({ text: `Item ${entry}`, color: '#808080' });
  }
  for (const spell of info.spells ?? []) {
    if (!spell.spellId) continue;
    const trigger = ITEM_SPELL_TRIGGER[spell.trigger];
    if (!trigger) continue;
    const text = spellDescription(spell.spellId) || spellAuraDescription(spell.spellId)
      || (spell.trigger === 0 ? 'Right-click to use.' : '');
    if (text) lines.push({ text: `${trigger} ${text}`, color: '#1eff00', wrap: true });
  }
  if (info.description) lines.push({ text: `\"${info.description}\"`, color: '#ffd100', wrap: true });
  if ((extras.count ?? 1) > 1) lines.push({ text: `Stack of ${extras.count}` });
  if (extras.buyPrice !== undefined) lines.push({ text: 'Price:', money: extras.buyPrice });
  else if (extras.sellPrice && info.sellPrice > 0) lines.push({ text: 'Sell Price:', money: info.sellPrice });
  return lines;
};

export const textTooltipLines = (title: string, ...body: string[]): TooltipLine[] => [
  { text: title, color: '#ffffff' },
  ...body.map((text): TooltipLine => ({ text, color: '#ffd100', wrap: true })),
];
