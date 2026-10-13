import { spellAuraReadiness } from './aura-state';

export type ActionUsability = {
  usable: boolean;
  notEnoughPower: boolean;
  reactive: boolean;
};

/** Spell.dbc PreventionType (field 156). vMaNGOS SpellDefines.h:196-198. */
export const SPELL_PREVENTION_TYPE_NONE = 0;
export const SPELL_PREVENTION_TYPE_SILENCE = 1;
export const SPELL_PREVENTION_TYPE_PACIFY = 2;

/** Spell.dbc PowerType (field 27); -2 is health, which is not a UNIT_FIELD_POWER index. */
export const POWER_TYPE_HEALTH = -2;

export type SpellCostInput = {
  /** Spell.dbc PowerType. */
  powerType?: number;
  /** Spell.dbc ManaCost, in the same raw units the server publishes (rage in tenths). */
  powerCost?: number;
  /** Spell.dbc ManaCostPercentage (field 148 in Build 5875). */
  powerCostPercentage?: number;
  /** Spell.dbc PreventionType. */
  preventionType?: number;
  /** Spell.dbc CasterAuraState / TargetAuraState. */
  casterAuraState?: number;
  targetAuraState?: number;
  /** Spell.dbc Reagent/ReagentCount and Totem item requirements. */
  reagents?: ReadonlyArray<readonly [itemEntry: number, count: number]>;
  totems?: readonly number[];
  equippedItemClass?: number;
  equippedItemSubclassMask?: number;
  equippedItemInventoryTypeMask?: number;
  explicitTargetMask?: number;
};

export type UsabilityInventoryItem = {
  entry?: number;
  count?: number;
  classId?: number;
  subclass?: number;
  inventoryType?: number;
  durability?: number;
  maxDurability?: number;
};

export type CasterStateInput = {
  /** UNIT_FIELD_POWER1..5, indexed by power type. */
  powers?: number[];
  maxPowers?: number[];
  health?: number;
  baseMana?: number;
  baseHealth?: number;
  /** UNIT_FIELD_BYTES_0 byte 3 — the class's own resource. */
  powerType?: number;
  auraState?: number;
  targetAuraState?: number;
  /** UNIT_FIELD_FLAGS bits 0x2000 / 0x20000. */
  silenced?: boolean;
  pacified?: boolean;
  inventoryItems?: readonly UsabilityInventoryItem[];
  equippedItems?: readonly UsabilityInventoryItem[];
  proficiencyMasks?: Readonly<Record<number, number>>;
};

/**
 * Does a silence or a pacify block this spell?
 *
 * vMaNGOS Spell::CheckCast (Spell.cpp:6664-6668) gates on the spell's own PreventionType, not on
 * its school: UNIT_FLAG_SILENCED blocks PreventionType 1, UNIT_FLAG_PACIFIED blocks PreventionType
 * 2. Auto Shot, Heroic Strike and Sinister Strike are all type 2; Fireball and Lesser Heal are
 * type 1. (The server additionally lets a STUNNED mage Blink out of a silence; stun is not modelled
 * here because the client already locks input on UNIT_FLAG_STUNNED.)
 */
export function preventedByControl(
  preventionType: number | undefined,
  silenced: boolean | undefined,
  pacified: boolean | undefined,
): boolean {
  if (silenced && preventionType === SPELL_PREVENTION_TYPE_SILENCE) return true;
  if (pacified && preventionType === SPELL_PREVENTION_TYPE_PACIFY) return true;
  return false;
}

/** The caster's current amount of whatever resource this spell spends. */
export function availablePower(caster: CasterStateInput, powerType: number | undefined): number | undefined {
  if (powerType === POWER_TYPE_HEALTH) return caster.health;
  if (powerType === undefined || powerType < 0 || powerType > 4) return undefined;
  return caster.powers?.[powerType];
}

/**
 * vMaNGOS Spell::CalculatePowerCost adds ManaCostPercentage against UNIT_FIELD_BASE_MANA for mana,
 * UNIT_FIELD_BASE_HEALTH for health, and max power for rage/focus/energy. Integer division truncates.
 */
export function effectivePowerCost(spell: SpellCostInput, caster: CasterStateInput): number {
  let cost = spell.powerCost ?? 0;
  const percentage = spell.powerCostPercentage ?? 0;
  if (percentage <= 0) return cost;
  const base = spell.powerType === POWER_TYPE_HEALTH
    ? caster.baseHealth
    : spell.powerType === 0
      ? caster.baseMana
      : spell.powerType !== undefined && spell.powerType >= 0 && spell.powerType <= 4
        ? caster.maxPowers?.[spell.powerType]
        : undefined;
  if (base !== undefined) cost += Math.trunc(percentage * base / 100);
  return cost;
}

const TARGET_FLAG_ITEM = 0x0010;

function countInventoryEntry(inventory: readonly UsabilityInventoryItem[], entry: number): number {
  let total = 0;
  for (let i = 0; i < inventory.length; i++) {
    const item = inventory[i];
    if (item.entry === entry) total += Math.max(1, item.count ?? 1);
  }
  return total;
}

/** Mirror Spell::CheckItems' reagent/totem and equipped-item predicates for action-bar tinting. */
export function meetsItemRequirements(spell: SpellCostInput, caster: CasterStateInput): boolean {
  const inventory = caster.inventoryItems;
  if (inventory) {
    for (const [entry, count] of spell.reagents ?? []) {
      if (entry > 0 && countInventoryEntry(inventory, entry) < Math.max(1, count)) return false;
    }
    for (const entry of spell.totems ?? []) {
      if (entry > 0 && countInventoryEntry(inventory, entry) < 1) return false;
    }
  }

  const requiredClass = spell.equippedItemClass;
  // Item-target spells validate the chosen target item after the targeting cursor resolves. They do
  // not require a matching item to already be equipped (Spell::CheckItems:7232-7252).
  if (requiredClass === undefined || requiredClass < 0 || ((spell.explicitTargetMask ?? 0) & TARGET_FLAG_ITEM) !== 0) {
    return true;
  }
  if (!caster.equippedItems) return true; // unknown login state must not produce a false grey button

  const subclassMask = spell.equippedItemSubclassMask ?? 0;
  const inventoryTypeMask = spell.equippedItemInventoryTypeMask ?? 0;
  const proficiency = caster.proficiencyMasks?.[requiredClass];
  if (subclassMask && proficiency !== undefined && (proficiency & subclassMask) === 0) return false;
  return caster.equippedItems.some((item) => {
    if (item.classId !== requiredClass) return false;
    if (subclassMask && (subclassMask & (1 << (item.subclass ?? 0))) === 0) return false;
    if (inventoryTypeMask && (inventoryTypeMask & (1 << (item.inventoryType ?? 0))) === 0) return false;
    if ((item.maxDurability ?? 0) > 0 && (item.durability ?? 0) === 0) return false;
    return true;
  });
}

export function spellUsability(spell: SpellCostInput, caster: CasterStateInput): ActionUsability {
  const aura = spellAuraReadiness(
    caster.auraState,
    caster.targetAuraState,
    spell.casterAuraState,
    spell.targetAuraState,
  );
  const blocked = !aura.usable
    || preventedByControl(spell.preventionType, caster.silenced, caster.pacified)
    || !meetsItemRequirements(spell, caster);

  const cost = effectivePowerCost(spell, caster);
  const current = availablePower(caster, spell.powerType);
  // An unknown current value means the field has not arrived yet. Vanilla never renders blue on
  // missing data, and neither should we — a spell you can afford must not look unaffordable.
  const notEnoughPower = !blocked && cost > 0 && current !== undefined && current < cost;

  return {
    usable: !blocked && !notEnoughPower,
    notEnoughPower,
    reactive: aura.reactive,
  };
}
