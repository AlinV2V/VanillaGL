/** Asset conversion utility. */
/** WeaponAttackType, and the equipment slots the character pipeline uses for the same weapons. */
export const VIRTUAL_ITEM_SLOT_COUNT = 3;
export const EQUIPMENT_SLOT_MAINHAND = 15; // vMaNGOS Player.h:499
export const EQUIPMENT_SLOT_OFFHAND = 16;
export const EQUIPMENT_SLOT_RANGED = 17;
const EQUIPMENT_SLOT_FOR_VIRTUAL_SLOT: number[] = [
  EQUIPMENT_SLOT_MAINHAND,
  EQUIPMENT_SLOT_OFFHAND,
  EQUIPMENT_SLOT_RANGED,
];

/**
 * `UNIT_FIELD_BYTES_2` byte 0 — `UpdateFields_1_10_2.h:103` puts the field at 0x0A4, and
 * `Objects/UnitDefines.h:170-172` defines the values:
 *
 *   SHEATH_STATE_UNARMED = 0   "non prepared weapon"
 *   SHEATH_STATE_MELEE   = 1   "prepared melee weapon"
 *   SHEATH_STATE_RANGED  = 2   "prepared ranged weapon"
 */
export const SHEATH_STATE_UNARMED = 0;
export const SHEATH_STATE_MELEE = 1;
export const SHEATH_STATE_RANGED = 2;

/**
 * Is this weapon in hand, or stowed on its sheath socket?
 *
 * The state names *which set is prepared*, so it selects one set and stows the other — it is not a
 * drawn/undrawn boolean. Treating it as one drew every carried weapon at once: Northshire Guard
 * (entry 1642) carries main hand 7483, off hand 2080 and ranged 10671 at sheath state 1, and had
 * both the sword and the crossbow in her hands instead of the crossbow on her back.
 *
 * Anything that is not the ranged slot belongs to the melee set, which keeps shields (off hand)
 * with the sword where vanilla puts them.
 */
export function isWeaponDrawn(sheathState: number, equipmentSlot: number | undefined): boolean {
  // Direct creature diagnostics may still supply raw virtual slots 0/1/2; the composed character
  // path supplies player equipment slots 15/16/17. Missing slot identity is unsafe: choosing melee
  // would recreate the sword/crossbow overlap, so unknown attachments stay stowed.
  if (equipmentSlot === undefined) return false;
  const ranged = equipmentSlot === 2 || equipmentSlot === EQUIPMENT_SLOT_RANGED;
  if (sheathState === SHEATH_STATE_MELEE) return !ranged;
  if (sheathState === SHEATH_STATE_RANGED) return ranged;
  return false; // UNARMED — everything stowed
}

export type WeaponAttachmentJoint = number | 'hide' | null;

/**
 * Pick the socket an attachment must occupy for the current prepared weapon set. A null sheath
 * socket means this is ordinary worn equipment, so it stays on its authored joint.
 */
export function weaponAttachmentJoint(
  sheathState: number,
  equipmentSlot: number | undefined,
  drawnJointId: number,
  sheathedJointId: WeaponAttachmentJoint,
): number | 'hide' {
  if (sheathedJointId === null || isWeaponDrawn(sheathState, equipmentSlot)) return drawnJointId;
  return sheathedJointId;
}

/** Resolve ItemPrototype.Sheath to the raw Build 5875 logical attachment IDs in character M2s. */
export function sheathJointFor(
  drawnJointId: number,
  inventoryType: number,
  sheathType?: number,
  modelSource?: string,
): WeaponAttachmentJoint {
  // Item query responses serialize ItemPrototype.Sheath for every item, including armor, where it
  // is zero. Only weapon/shield attachments use hand joints 0/1/2; helmet and shoulder joints must
  // remain on their authored sockets instead of falling through sheath type 0 to `hide`.
  if (drawnJointId !== 0 && drawnJointId !== 1 && drawnJointId !== 2) return null;
  // ItemPrototype.Sheath selects a socket pair and the carrying hand picks the side. Attachment ids:
  // 26/27 back sheath, 31/30 large weapon, 32/33 left/right hip, 28 middle-back shield. The socket's static
  // transform is the authored pose; callers must not add corrective rotations or offsets.
  const offHand = drawnJointId === 2;
  if (sheathType !== undefined) {
    switch (sheathType) {
      case 1: return offHand ? 27 : 26;
      case 2: return offHand ? 30 : 31;
      case 3: return offHand ? 33 : 32;
      case 4: return 28;
      case 5: return offHand ? 32 : 33;
      case 6: return offHand ? 32 : 33;
      case 7: return 28;
      default: return 'hide';
    }
  }
  if (inventoryType === 14 || drawnJointId === 0) return 28;
  if (inventoryType === 23) return 'hide';
  if (inventoryType === 13 || inventoryType === 21) return offHand ? 33 : 32;
  if (inventoryType === 22) return 33;
  if (inventoryType === 17) return /(?:stave|staff|polearm|spear)/i.test(modelSource ?? '') ? 31 : 26;
  if (inventoryType === 15 || inventoryType === 25 || inventoryType === 26) return 31;
  return null;
}

export type VirtualItem = {
  /** WeaponAttackType: 0 main hand, 1 off hand, 2 ranged. */
  slot: number;
  displayInfoId: number;
  itemClass: number;
  subclass: number;
  material: number;
  inventoryType: number;
  sheath: number;
};

const byte = (word: number | undefined, index: number) => ((word ?? 0) >>> (index * 8)) & 0xff;

/**
 * Decode the raw fields into one entry per armed slot. Slots with no display id are dropped —
 * SetVirtualItem zeroes all three words when a slot is cleared.
 */
export function decodeVirtualItems(
  displayIds: readonly number[] | undefined,
  info: readonly number[] | undefined,
): VirtualItem[] {
  const items: VirtualItem[] = [];
  for (let slot = 0; slot < VIRTUAL_ITEM_SLOT_COUNT; slot++) {
    const displayInfoId = displayIds?.[slot] ?? 0;
    if (!displayInfoId) continue;
    const word0 = info?.[slot * 2];
    const word1 = info?.[slot * 2 + 1];
    items.push({
      slot,
      displayInfoId,
      itemClass: byte(word0, 0),
      subclass: byte(word0, 1),
      material: byte(word0, 2),
      inventoryType: byte(word0, 3),
      sheath: byte(word1, 0),
    });
  }
  return items;
}

/**
 * Shape the decoded weapons like the player pipeline's `visibleEquipment`, so a creature's live
 * weapons can be composed and socketed by exactly the code that already handles player weapons —
 * including sheathJointFor, which needs inventoryType and sheath.
 */
export function virtualItemsAsEquipment(items: readonly VirtualItem[]) {
  return items.map((item) => ({
    displayInfoId: item.displayInfoId,
    inventoryType: item.inventoryType,
    classId: item.itemClass,
    subclass: item.subclass,
    material: item.material,
    sheath: item.sheath,
    slot: EQUIPMENT_SLOT_FOR_VIRTUAL_SLOT[item.slot] ?? EQUIPMENT_SLOT_MAINHAND,
  }));
}

/**
 * Weapon subclass for the attacker's main hand — what AttackAnimKits picks the swing from and what
 * WeaponImpactSounds keys its impact row on. Falls back to the ranged slot for a creature that only
 * carries a bow, matching the sheath-2 ready stance.
 */
export function mainHandSubclass(items: readonly VirtualItem[]): number | undefined {
  const main = items.find((item) => item.slot === 0) ?? items.find((item) => item.slot === 2);
  return main?.subclass;
}

/** Material id paired with mainHandSubclass(), from the same authoritative virtual-item word. */
export function mainHandMaterial(items: readonly VirtualItem[]): number | undefined {
  const main = items.find((item) => item.slot === 0) ?? items.find((item) => item.slot === 2);
  return main?.material;
}
