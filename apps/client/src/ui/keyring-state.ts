import type { InventoryBag, InventorySnapshot, InventorySlot } from '../world';
import { KEYRING_CONTAINER_ID } from '../data/keyring-layout';

const DISCOVERY_KEY = 'wowBrowser.showKeyring.v1';
type KeyringStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function inventoryBagForId(snapshot: InventorySnapshot, bagId: number): InventoryBag | undefined {
  return bagId === KEYRING_CONTAINER_ID ? snapshot.keyring : snapshot.bags[bagId];
}

export function firstEmptyKeyringSlot(
  snapshot: InventorySnapshot,
  heldSource?: Pick<InventorySlot, 'protocolBag' | 'protocolSlot'>,
): InventorySlot | undefined {
  return snapshot.keyring.slots.find((slot) => !slot.item || (!!heldSource
    && slot.protocolBag === heldSource.protocolBag && slot.protocolSlot === heldSource.protocolSlot));
}

export function keyringHasItem(snapshot: InventorySnapshot) {
  return snapshot.keyring.slots.some((slot) => !!slot.item);
}

/** Mirrors FrameXML's saved SHOW_KEYRING flag: seeing one key reveals the button permanently. */
export class KeyringDiscoveryState {
  private discovered = false;

  constructor(private readonly storage?: KeyringStorage) {
    try { this.discovered = storage?.getItem(DISCOVERY_KEY) === '1'; } catch { /* storage may be disabled */ }
  }

  observe(snapshot: InventorySnapshot | undefined) {
    if (this.discovered || !snapshot || !keyringHasItem(snapshot)) return this.discovered;
    this.discovered = true;
    try { this.storage?.setItem(DISCOVERY_KEY, '1'); } catch { /* keep the in-memory flag */ }
    return true;
  }

  isDiscovered() { return this.discovered; }
}
