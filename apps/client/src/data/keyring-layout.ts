import { PLAYER_FIELDS } from './player-field-layout';
export const KEYRING_CONTAINER_ID = -2;
export const KEYRING_PROTOCOL_BAG = 255;
export const KEYRING_PROTOCOL_SLOT_START = 81;
export const KEYRING_PROTOCOL_SLOT_COUNT = 16;
export function keyringVisibleSlotCount(level: number) {
  const n = Math.max(0, Math.floor(Number.isFinite(level) ? level : 0));
  if (n > 60) return 16; if (n >= 50) return 12; if (n >= 40) return 8; return 4;
}
export type KeyringSlotDescriptor = { index: number; field: number; protocolBag: number; protocolSlot: number; label: string };
export function keyringSlotDescriptors(level: number): KeyringSlotDescriptor[] {
  return Array.from({ length: keyringVisibleSlotCount(level) }, (_, index) => ({
    index, field: PLAYER_FIELDS.PLAYER_FIELD_KEYRING_SLOT_1 + index * 2,
    protocolBag: KEYRING_PROTOCOL_BAG, protocolSlot: KEYRING_PROTOCOL_SLOT_START + index,
    label: `Keyring ${index + 1}`,
  }));
}
export function keyringFieldForProtocolSlot(slot: number) {
  if (!Number.isInteger(slot) || slot < KEYRING_PROTOCOL_SLOT_START || slot >= KEYRING_PROTOCOL_SLOT_START + KEYRING_PROTOCOL_SLOT_COUNT) return undefined;
  return PLAYER_FIELDS.PLAYER_FIELD_KEYRING_SLOT_1 + (slot - KEYRING_PROTOCOL_SLOT_START) * 2;
}
export function isKeyringField(field: number) {
  const first = PLAYER_FIELDS.PLAYER_FIELD_KEYRING_SLOT_1;
  return Number.isInteger(field) && field >= first && field < first + KEYRING_PROTOCOL_SLOT_COUNT * 2;
}
