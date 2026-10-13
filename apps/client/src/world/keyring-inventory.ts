import type { InventoryBag, InventorySlot } from '../world';
import {
  KEYRING_CONTAINER_ID,
  KEYRING_PROTOCOL_BAG,
  keyringSlotDescriptors,
  type KeyringSlotDescriptor,
} from '../data/keyring-layout';

const emptySlot = (slot: KeyringSlotDescriptor): InventorySlot => ({
  container: 'keyring',
  index: slot.index,
  protocolBag: slot.protocolBag,
  protocolSlot: slot.protocolSlot,
  label: slot.label,
});

/** Build the UI-facing keyring while retaining the protocol coordinates on every slot. */
export function buildKeyringBag(
  level: number,
  makeSlot: (slot: KeyringSlotDescriptor) => InventorySlot = emptySlot,
): InventoryBag {
  const slots = keyringSlotDescriptors(level).map(makeSlot);
  return {
    index: KEYRING_CONTAINER_ID,
    protocolBag: KEYRING_PROTOCOL_BAG,
    label: 'Keyring',
    isBackpack: false,
    isKeyring: true,
    size: slots.length,
    slots,
  };
}
