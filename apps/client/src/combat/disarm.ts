import { isMainHandSlot } from './attack-anims';
import { EQUIPMENT_SLOT_MAINHAND } from './virtual-items';
/** Asset conversion utility. */
export function withoutDisarmedMainHand<T extends { slot?: number; inventoryType: number }>(
  equipment: readonly T[],
  disarmed: boolean | undefined,
): T[] {
  if (!disarmed) return [...equipment];
  // Prefer the stamped slot; fall back to the inventory type for the char-enum and starter-outfit
  // lists, which carry no slot index. isMainHandSlot deliberately excludes ranged types, so a bow
  // survives a disarm exactly as CanUseEquippedWeapon says it should.
  const slotted = equipment.some((item) => item.slot !== undefined);
  return equipment.filter((item) => (slotted
    ? item.slot !== EQUIPMENT_SLOT_MAINHAND
    : !isMainHandSlot(item.inventoryType)));
}
