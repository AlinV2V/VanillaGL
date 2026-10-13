/** Asset conversion utility. */
/** AnimationData.dbc ids used by the combat pipeline. */
export const ATTACK_ANIM = {
  UNARMED: 0x10,        // AttackUnarmed
  ONE_H: 0x11,          // Attack1H          <- 1H_Main_Swing
  TWO_H: 0x12,          // Attack2H          <- 2HT_Swing
  TWO_HL: 0x13,         // Attack2HL         <- 2HL_Swing
  ONE_H_PIERCE: 0x55,   // Attack1HPierce    <- 1H_Main_Pierce
  TWO_HL_PIERCE: 0x56,  // Attack2HLoosePierce <- 2HL_Pierce
  OFF: 0x57,            // AttackOff         <- OffH_Swing
  OFF_PIERCE: 0x58,     // AttackOffPierce   <- OffH_Pierce
  BOW: 0x2e,            // AttackBow
  RIFLE: 0x31,          // AttackRifle
  THROWN: 0x6b,         // AttackThrown
} as const;

/** AnimationData.dbc combat idle / defensive ids. */
export const DEFENSE_ANIM = {
  PARRY_UNARMED: 0x14,
  PARRY_1H: 0x15,
  PARRY_2H: 0x16,
  PARRY_2HL: 0x17,
  SHIELD_BLOCK: 0x18,
  READY_UNARMED: 0x19,
  READY_1H: 0x1a,
  READY_2H: 0x1b,
  READY_2HL: 0x1c,
  READY_BOW: 0x1d,
  DODGE: 0x1e,
  READY_RIFLE: 0x30,
  READY_THROWN: 0x6c,
} as const;

/** ItemPrototype.SubClass for class 2 (weapon) — vmangos ItemPrototype.h:192-212. */
export const WEAPON_SUBCLASS = {
  AXE: 0, AXE2: 1, BOW: 2, GUN: 3, MACE: 4, MACE2: 5, POLEARM: 6, SWORD: 7, SWORD2: 8,
  STAFF: 10, EXOTIC: 11, EXOTIC2: 12, FIST: 13, MISC: 14, DAGGER: 15, THROWN: 16,
  SPEAR: 17, CROSSBOW: 18, WAND: 19, FISHING_POLE: 20,
} as const;

type AnimKit = { subclass: number; anim: number; weight: number; offHand: boolean };

/** AttackAnimKits.dbc, 26 rows, transcribed in file order. */
const ATTACK_ANIM_KITS: readonly AnimKit[] = [
  { subclass: 0,  anim: ATTACK_ANIM.ONE_H,         weight: 1, offHand: false }, // Axe1H  1H_Main_Swing
  { subclass: 1,  anim: ATTACK_ANIM.TWO_H,         weight: 1, offHand: false }, // Axe2H  2HT_Swing
  { subclass: 4,  anim: ATTACK_ANIM.ONE_H,         weight: 1, offHand: false }, // Mace1H 1H_Main_Swing
  { subclass: 5,  anim: ATTACK_ANIM.TWO_H,         weight: 1, offHand: false }, // Mace2H 2HT_Swing
  { subclass: 6,  anim: ATTACK_ANIM.TWO_HL_PIERCE, weight: 1, offHand: false }, // Polearm 2HL_Pierce
  { subclass: 6,  anim: ATTACK_ANIM.TWO_HL,        weight: 1, offHand: false }, // Polearm 2HL_Swing
  { subclass: 7,  anim: ATTACK_ANIM.ONE_H,         weight: 4, offHand: false }, // Sword1H 1H_Main_Swing
  { subclass: 7,  anim: ATTACK_ANIM.ONE_H_PIERCE,  weight: 1, offHand: false }, // Sword1H 1H_Main_Pierce
  { subclass: 8,  anim: ATTACK_ANIM.TWO_H,         weight: 1, offHand: false }, // Sword2H 2HT_Swing
  { subclass: 10, anim: ATTACK_ANIM.TWO_HL,        weight: 4, offHand: false }, // Staff  2HL_Swing
  { subclass: 11, anim: ATTACK_ANIM.ONE_H,         weight: 1, offHand: false }, // Exotic 1H_Main_Swing
  { subclass: 11, anim: ATTACK_ANIM.ONE_H_PIERCE,  weight: 1, offHand: false }, // Exotic 1H_Main_Pierce
  { subclass: 12, anim: ATTACK_ANIM.TWO_H,         weight: 2, offHand: false }, // Exotic2 2HT_Swing
  { subclass: 0,  anim: ATTACK_ANIM.OFF,           weight: 1, offHand: true },  // Axe1H  OffH_Swing
  { subclass: 4,  anim: ATTACK_ANIM.OFF,           weight: 1, offHand: true },  // Mace1H OffH_Swing
  { subclass: 7,  anim: ATTACK_ANIM.OFF,           weight: 1, offHand: true },  // Sword1H OffH_Swing
  { subclass: 11, anim: ATTACK_ANIM.OFF,           weight: 1, offHand: true },  // Exotic OffH_Swing
  { subclass: 11, anim: ATTACK_ANIM.OFF_PIERCE,    weight: 1, offHand: true },  // Exotic OffH_Pierce
  { subclass: 7,  anim: ATTACK_ANIM.OFF_PIERCE,    weight: 4, offHand: true },  // Sword1H OffH_Pierce
  { subclass: 10, anim: ATTACK_ANIM.TWO_HL_PIERCE, weight: 1, offHand: false }, // Staff  2HL_Pierce
  { subclass: 15, anim: ATTACK_ANIM.ONE_H_PIERCE,  weight: 1, offHand: false }, // Dagger 1H_Main_Pierce
  { subclass: 15, anim: ATTACK_ANIM.OFF_PIERCE,    weight: 1, offHand: true },  // Dagger OffH_Pierce
  { subclass: 15, anim: ATTACK_ANIM.ONE_H,         weight: 1, offHand: false }, // Dagger 1H_Main_Swing
  { subclass: 15, anim: ATTACK_ANIM.OFF,           weight: 1, offHand: true },  // Dagger OffH_Swing
  { subclass: 14, anim: ATTACK_ANIM.ONE_H,         weight: 1, offHand: false }, // Misc   1H_Main_Swing
  { subclass: 14, anim: ATTACK_ANIM.OFF,           weight: 1, offHand: true },  // Misc   OffH_Swing
];

/** ItemPrototype.InventoryType — vmangos ItemPrototype.h:102-130. */
const INVTYPE_WEAPON = 13;
const INVTYPE_RANGED = 15;
const INVTYPE_2HWEAPON = 17;
const INVTYPE_WEAPONMAINHAND = 21;
const INVTYPE_WEAPONOFFHAND = 22;
const INVTYPE_THROWN = 25;
const INVTYPE_RANGEDRIGHT = 26;

/**
 * What we know about one equipped weapon. `subclass` is only present once the item's
 * SMSG_ITEM_QUERY_SINGLE_RESPONSE has landed; until then (and for the char-select/starter-outfit
 * fallbacks, and for creatures) only `inventoryType` is available and the coarse
 * one-hand/two-hand split below is all we can honestly do.
 */
export type EquippedWeapon = {
  subclass?: number;
  inventoryType?: number;
  classId?: number;
  material?: number;
} | undefined;

export const isMainHandSlot = (inventoryType?: number) =>
  inventoryType === INVTYPE_WEAPON || inventoryType === INVTYPE_2HWEAPON || inventoryType === INVTYPE_WEAPONMAINHAND;

export const isOffHandSlot = (inventoryType?: number) =>
  inventoryType === INVTYPE_WEAPON || inventoryType === INVTYPE_WEAPONOFFHAND;

export const isRangedSlot = (inventoryType?: number) =>
  inventoryType === INVTYPE_RANGED || inventoryType === INVTYPE_THROWN || inventoryType === INVTYPE_RANGEDRIGHT;

export type EquippedWeapons = { mainHand: EquippedWeapon; offHand: EquippedWeapon; ranged: EquippedWeapon };

const EQUIPMENT_SLOT_MAINHAND = 15;
const EQUIPMENT_SLOT_OFFHAND = 16;
const EQUIPMENT_SLOT_RANGED = 17;

/**
 * Split a unit's visible gear into the three weapon hands.
 *
 * Prefer the stamped equipment slot; the visible-equipment array is compacted, and INVTYPE_WEAPON
 * (13) is valid in both hands, so matching on inventory type alone cannot tell a dual-wielded
 * off-hand sword from the main-hand one. The inventory-type path is the fallback for sources that
 * carry no slot (the CharStartOutfit starter fallback, creature equipment).
 */
export function resolveWeapons(
  equipment: readonly {
    displayInfoId: number;
    inventoryType: number;
    slot?: number;
    subclass?: number;
    classId?: number;
    material?: number;
  }[] | undefined,
): EquippedWeapons {
  const worn = (equipment ?? []).filter((item) => item.displayInfoId > 0);
  const bySlot = (slot: number) => worn.find((item) => item.slot === slot);
  const anySlotted = worn.some((item) => item.slot !== undefined);
  const mainHand = bySlot(EQUIPMENT_SLOT_MAINHAND)
    ?? (anySlotted ? undefined : worn.find((item) => isMainHandSlot(item.inventoryType)));
  // Slot 16 also holds shields (INVTYPE_SHIELD 14) and held-in-off-hand items (23); neither can
  // produce an off-hand swing, so only a real weapon counts as the off hand.
  const offHandItem = bySlot(EQUIPMENT_SLOT_OFFHAND)
    ?? (anySlotted ? undefined : worn.find((item) => item.inventoryType === INVTYPE_WEAPONOFFHAND));
  const offHand = isOffHandSlot(offHandItem?.inventoryType) ? offHandItem : undefined;
  const ranged = bySlot(EQUIPMENT_SLOT_RANGED)
    ?? (anySlotted ? undefined : worn.find((item) => isRangedSlot(item.inventoryType)));
  return { mainHand, offHand, ranged };
}

/** Weighted pick across the kit rows for one subclass/hand, mirroring the DBC weight column. */
const pickKit = (subclass: number, offHand: boolean, roll: number): number | undefined => {
  let total = 0;
  for (const kit of ATTACK_ANIM_KITS) {
    if (kit.subclass === subclass && kit.offHand === offHand) total += kit.weight;
  }
  if (total <= 0) return undefined;
  let cursor = Math.max(0, Math.min(0.999999, roll)) * total;
  for (const kit of ATTACK_ANIM_KITS) {
    if (kit.subclass !== subclass || kit.offHand !== offHand) continue;
    cursor -= kit.weight;
    if (cursor < 0) return kit.anim;
  }
  return undefined;
};

/**
 * Melee swing animation for one weapon hand.
 *
 * `offHand` comes straight off the wire: vmangos sets HITINFO_LEFTSWING (0x04) for every
 * OFF_ATTACK and HITINFO_NORMALSWING for BASE_ATTACK (Unit.cpp:1305-1312, 2167-2170).
 */
export function meleeSwingAnim(weapon: EquippedWeapon, offHand: boolean, roll = Math.random()): number {
  if (weapon?.subclass !== undefined) {
    const kit = pickKit(weapon.subclass, offHand, roll);
    // A known subclass with no kit row genuinely has no swing of its own — fist weapons (13),
    // fishing poles (20). Vanilla punches with those, which is what AttackAnimKits omitting them
    // means. Do NOT fall through to the inventory-type guess here: that would hand claws a sword
    // animation on the strength of them sharing INVTYPE_WEAPON.
    return kit ?? (offHand ? ATTACK_ANIM.OFF : ATTACK_ANIM.UNARMED);
  }
  // Subclass not resolved yet (item query still in flight, creature, starter-outfit fallback):
  // the inventory type is all we have, so keep the coarse one-hand/two-hand split.
  if (offHand) return weapon ? ATTACK_ANIM.OFF : ATTACK_ANIM.UNARMED;
  if (!weapon) return ATTACK_ANIM.UNARMED;
  if (weapon.inventoryType === INVTYPE_2HWEAPON) return ATTACK_ANIM.TWO_H;
  if (isMainHandSlot(weapon.inventoryType)) return ATTACK_ANIM.ONE_H;
  return ATTACK_ANIM.UNARMED;
}

/** True when the weapon belongs to the AttackAnimTypes "2HL" (two-handed loose) family. */
const isTwoHandedLoose = (weapon: EquippedWeapon) =>
  weapon?.subclass === WEAPON_SUBCLASS.POLEARM || weapon?.subclass === WEAPON_SUBCLASS.STAFF;

const isTwoHanded = (weapon: EquippedWeapon) =>
  weapon?.inventoryType === INVTYPE_2HWEAPON
  || weapon?.subclass === WEAPON_SUBCLASS.AXE2
  || weapon?.subclass === WEAPON_SUBCLASS.MACE2
  || weapon?.subclass === WEAPON_SUBCLASS.SWORD2
  || weapon?.subclass === WEAPON_SUBCLASS.EXOTIC2
  || isTwoHandedLoose(weapon);

export function rangedAttackAnim(ranged: EquippedWeapon): number | undefined {
  switch (ranged?.subclass) {
    case WEAPON_SUBCLASS.BOW:
    case WEAPON_SUBCLASS.CROSSBOW:
      return ATTACK_ANIM.BOW;
    case WEAPON_SUBCLASS.GUN:
      return ATTACK_ANIM.RIFLE;
    case WEAPON_SUBCLASS.THROWN:
      return ATTACK_ANIM.THROWN;
    default:
      break;
  }
  // Wands (subclass 19) have no Attack* sequence of their own in AnimationData — leave them to
  // the spell-visual pipeline rather than inventing a pose. Same for an unresolved subclass on a
  // bow/gun slot, where the inventory type alone cannot tell a gun from a bow.
  if (ranged?.subclass !== undefined) return undefined;
  return ranged?.inventoryType === INVTYPE_THROWN ? ATTACK_ANIM.THROWN : undefined;
}

/**
 * Combat-ready idle. UNIT_FIELD_BYTES_2 byte 0 is the SheathState: 0 sheathed, 1 melee drawn,
 * 2 ranged drawn (vmangos UnitDefines.h SheathState). The 1H/2H/2HL split reuses the same weapon
 * taxonomy AttackAnimKits defines for the swings — AnimationData names the poses identically
 * (Ready1H/Ready2H/Ready2HL) and no DBC maps them separately.
 */
export function readyStanceAnim(
  sheathState: number,
  mainHand: EquippedWeapon,
  ranged: EquippedWeapon,
): number | undefined {
  if (sheathState === 2) {
    switch (ranged?.subclass) {
      case WEAPON_SUBCLASS.GUN: return DEFENSE_ANIM.READY_RIFLE;
      case WEAPON_SUBCLASS.THROWN: return DEFENSE_ANIM.READY_THROWN;
      default: break;
    }
    if (ranged?.inventoryType === INVTYPE_THROWN) return DEFENSE_ANIM.READY_THROWN;
    return DEFENSE_ANIM.READY_BOW;
  }
  if (sheathState !== 1) return undefined; // sheathed (or an unknown state) stands normally
  if (isTwoHandedLoose(mainHand)) return DEFENSE_ANIM.READY_2HL;
  if (isTwoHanded(mainHand)) return DEFENSE_ANIM.READY_2H;
  if (mainHand) return DEFENSE_ANIM.READY_1H;
  return DEFENSE_ANIM.READY_UNARMED;
}

const UNIT_FLAG_IN_COMBAT = 0x00080000;

/**
 * Remote combat-ready idle gate.
 *
 * Players may deliberately unsheathe outside combat, so their SheathState is enough to select a
 * Ready pose. Creatures are different: vMaNGOS initializes almost every creature with
 * SHEATH_STATE_MELEE ("creatures always have melee weapon ready if any") even while idle. For an
 * NPC, UNIT_FLAG_IN_COMBAT is therefore the authoritative stance gate and SheathState only decides
 * which prepared-weapon pose to use once combat is active.
 */
export function remoteReadyStanceAnim(
  isCreature: boolean,
  unitFlags: number | undefined,
  sheathState: number,
  mainHand: EquippedWeapon,
  ranged: EquippedWeapon,
): number | undefined {
  if (isCreature && (((unitFlags ?? 0) & UNIT_FLAG_IN_COMBAT) === 0)) return undefined;
  return readyStanceAnim(sheathState, mainHand, ranged);
}

/** Parry pose, following the same weapon taxonomy as the ready stance. */
export function parryAnim(mainHand: EquippedWeapon): number {
  if (isTwoHandedLoose(mainHand)) return DEFENSE_ANIM.PARRY_2HL;
  if (isTwoHanded(mainHand)) return DEFENSE_ANIM.PARRY_2H;
  if (mainHand) return DEFENSE_ANIM.PARRY_1H;
  return DEFENSE_ANIM.PARRY_UNARMED;
}
