import type { InventorySlot } from '../world';

const PLAYER_BAG = 255;
const EQUIPPED_BAG_SLOT_START = 19;

export const isEquippedBagProtocolSlot = (bag: number, slot: number) =>
  bag === PLAYER_BAG && (
    (slot >= EQUIPPED_BAG_SLOT_START && slot < EQUIPPED_BAG_SLOT_START + 4) ||
    (slot >= 63 && slot < 69)
  );

/** Client-side merchant safety; the realm remains authoritative. */
export const inventorySellGuardReason = (slot: InventorySlot): string | undefined => {
  if (!slot.item?.guid || !slot.item.entry) return 'There is no item in that slot.';
  if (slot.container === 'equipment' || isEquippedBagProtocolSlot(slot.protocolBag, slot.protocolSlot)) {
    return 'Unequip that item before selling it.';
  }
  if ((slot.item.info?.sellPrice ?? 0) <= 0) return 'That item cannot be sold.';
  return undefined;
};
