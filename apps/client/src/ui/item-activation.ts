import type { ItemInfo } from '../world';

export type InventoryActivation = 'quest' | 'read' | 'open' | 'equip' | 'unequip' | 'use';

// ItemPrototypeFlags::ITEM_FLAG_LOOTABLE. vMaNGOS documents this as the client-side
// "Right click to open" discriminator for non-container packages and lockboxes.
const ITEM_FLAG_LOOTABLE = 0x00000004;
/** Asset conversion utility. */
export function inventoryActivation(
  info: ItemInfo | undefined,
  equipped: boolean,
  equippable: boolean,
): InventoryActivation {
  if (info?.startQuest) return 'quest';
  if (info?.pageText) return 'read';
  if (info && ((info.flags & ITEM_FLAG_LOOTABLE) !== 0 || info.lockId)) return 'open';
  if (!equipped && equippable) return 'equip';
  if (equipped && info?.onUseSpellSlot === undefined) return 'unequip';
  return 'use';
}
