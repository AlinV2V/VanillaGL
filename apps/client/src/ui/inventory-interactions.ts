import type { InventorySnapshot, InventorySlot, ItemInfo, RealmWorldClient } from '../world';
import { TypeID } from '../world-entities';
import { isSameSlotRef, slotRef, type CursorSlotRef, type InventoryCursorController } from './inventory-cursor';
import { inventorySellGuardReason, isEquippedBagProtocolSlot } from './inventory-guards';
import { inventoryActivation } from './item-activation';

const PLAYER_BAG = 255;
const EQUIPPED_BAG_SLOT_START = 19;
const INVTYPE_NON_EQUIP = 0;
const INVTYPE_BAG = 18;
const ITEM_CLASS_CONTAINER = 1;
const ITEM_CLASS_QUIVER = 11;

type InventorySlotItem = NonNullable<InventorySlot['item']>;

export class InventoryInteractionController {
  private readonly pendingMetadataActivations = new Set<string>();

  constructor(private readonly deps: {
    cursor: InventoryCursorController;
    getWorld: () => RealmWorldClient | undefined;
    getInventory: () => InventorySnapshot | undefined;
    getActiveMerchantGuid?: () => string | undefined;
    repairMerchantItem?: (itemGuid: string) => boolean;
    useInventoryItem?: (slot: InventorySlot) => boolean;
    itemIconUrl: (displayInfoId?: number, entry?: number) => string;
    log: (message: string) => void;
    playUi?: (name: string) => boolean;
  }) {}

  allInventorySlots(snapshot = this.deps.getInventory()) {
    if (!snapshot) return [] as InventorySlot[];
    return [...snapshot.equipment, ...snapshot.bags.flatMap((bag) => bag.slots), ...snapshot.keyring.slots];
  }

  findInventorySlot(ref: CursorSlotRef, snapshot = this.deps.getInventory()) {
    return this.allInventorySlots(snapshot).find((slot) => slot.protocolBag === ref.protocolBag && slot.protocolSlot === ref.protocolSlot);
  }

  findFirstEmptySlot(bagId: number, snapshot = this.deps.getInventory()) {
    return snapshot?.bags[bagId]?.slots.find((slot) => !slot.item);
  }

  findFirstItemByEntry(entry: number, snapshot = this.deps.getInventory()) {
    if (!snapshot) return undefined;
    const equipment = snapshot.equipment.find((slot) => slot.item?.entry === entry);
    if (equipment) return equipment;
    for (const bag of snapshot.bags) {
      const slot = bag.slots.find((s) => s.item?.entry === entry);
      if (slot) return slot;
    }
    return snapshot.keyring.slots.find((slot) => slot.item?.entry === entry);
  }

  isBagContainerItem = (item?: InventorySlotItem, info = item?.info, ref?: CursorSlotRef) =>
    this.isEquippedBagSlotRef(ref) ||
    item?.typeId === TypeID.CONTAINER ||
    (info?.containerSlots ?? 0) > 0 ||
    info?.inventoryType === INVTYPE_BAG ||
    info?.classId === ITEM_CLASS_CONTAINER ||
    info?.classId === ITEM_CLASS_QUIVER;

  canPlaceItemOnActionButton = (item?: InventorySlotItem, info = item?.info, ref?: CursorSlotRef, forcedBag = false) => {
    if (!info) return false;
    return !forcedBag && !this.isBagContainerItem(item, info, ref);
  };

  pickupItemFromSlot(slot: InventorySlot, splitCount?: number) {
    const item = slot.item;
    if (!item?.entry) return;
    const info = item.info;
    const source = slotRef(slot);
    this.deps.cursor.setHeldCursor({
      kind: 'item',
      source,
      guid: item.guid,
      entry: item.entry,
      count: item.count,
      splitCount,
      isBag: this.isBagContainerItem(item, info, source),
      name: info?.name ?? `Item #${item.entry}`,
      iconUrl: this.deps.itemIconUrl(info?.displayInfoId, item.entry),
    });
    this.deps.playUi?.('CURSORGRABOBJECT');
  }

  pickupEquippedBag(bagId: number) {
    const { cursor } = this.deps;
    const world = this.deps.getWorld();
    if (cursor.heldCursor || !world) return false;
    const snapshot = this.deps.getInventory() ?? world.getInventory();
    const bag = snapshot?.bags[bagId];
    if (!bag || bag.isBackpack || !bag.itemGuid || !bag.item?.entry) return false;
    if (bag.slots.some((s) => s.item)) {
      this.deps.log('Only empty bags can be unequipped.');
      return false;
    }
    const protocolSlot = EQUIPPED_BAG_SLOT_START + bagId - 1; // 19..22
    cursor.setHeldCursor({
      kind: 'item',
      source: { container: 'equipment', index: protocolSlot, protocolBag: PLAYER_BAG, protocolSlot },
      guid: bag.itemGuid,
      entry: bag.item.entry,
      count: bag.item.count,
      isBag: true,
      name: bag.item.info?.name ?? `Item #${bag.item.entry}`,
      iconUrl: this.deps.itemIconUrl(bag.item.info?.displayInfoId, bag.item.entry),
    });
    this.deps.playUi?.('CURSORGRABOBJECT');
    return true;
  }

  activateInventorySlot(slot: InventorySlot) {
    const item = slot.item;
    if (!item?.entry) return;
    const world = this.deps.getWorld();
    const vendorGuid = this.deps.getActiveMerchantGuid?.();
    if (world && vendorGuid && item.guid && slot.container !== 'keyring') {
      if (this.deps.repairMerchantItem?.(item.guid)) {
        this.deps.playUi?.('ITEM_REPAIR');
        return;
      }
      this.sellSlotToVendor(vendorGuid, slot);
      return;
    }
    // Item instances can arrive one packet before SMSG_ITEM_QUERY_SINGLE_RESPONSE. Treat that
    // interval as loading, not as proof that the item is a non-equippable consumable. Otherwise a
    // first click on freshly looted gear incorrectly sends CMSG_USE_ITEM and appears to do nothing.
    if (!item.info && world) {
      this.deferActivationUntilMetadata(slot, item.guid, item.entry, world);
      return;
    }
    const equippable = this.isBagContainerItem(item, item.info, slotRef(slot)) || (item.info?.inventoryType ?? INVTYPE_NON_EQUIP) !== INVTYPE_NON_EQUIP;
    const onUseSpellSlot = item.info?.onUseSpellSlot;
    const activation = inventoryActivation(item.info, slot.container === 'equipment', equippable);
    if (activation === 'quest' && item.guid && item.info?.startQuest) {
      world?.questQuery(item.guid, item.info.startQuest);
    } else if (activation === 'read') {
      world?.readItem(slot.protocolBag, slot.protocolSlot);
    } else if (activation === 'open') {
      world?.openItem(slot.protocolBag, slot.protocolSlot);
    } else if (activation === 'equip') {
      world?.autoEquipItem(slot.protocolBag, slot.protocolSlot);
    } else if (activation === 'unequip') {
      // Right-clicking an equipped item with no on-use effect unequips it into the first free bag
      // slot — vanilla's UseInventoryItem only casts when the item actually has a use spell, so
      // plain armour used to fire CMSG_USE_ITEM and do nothing at all. vMaNGOS
      // HandleAutoStoreBagItemOpcode branches on IsEquipmentPos(src) -> CanUnequipItem, so
      // CMSG_AUTOSTORE_BAG_ITEM is the correct unequip path and the server reports its own errors
      // (bag full, non-empty container, cursed item) rather than the client guessing.
      world?.autoStoreBagItem(slot.protocolBag, slot.protocolSlot, PLAYER_BAG);
    } else {
      world?.useItem(slot.protocolBag, slot.protocolSlot, onUseSpellSlot ?? 0);
    }
    this.deps.playUi?.('ITEMGENERICSOUND');
  }

  private deferActivationUntilMetadata(slot: InventorySlot, expectedGuid: string | undefined, expectedEntry: number, world: RealmWorldClient) {
    const ref = slotRef(slot);
    const key = `${ref.protocolBag}:${ref.protocolSlot}`;
    if (this.pendingMetadataActivations.has(key)) return;
    this.pendingMetadataActivations.add(key);
    world.requestItemInfo(expectedEntry);
    const deadline = Date.now() + 2_000;
    const retry = () => {
      const current = this.findInventorySlot(ref);
      const currentItem = current?.item;
      const sameItem = currentItem?.entry === expectedEntry
        && (!expectedGuid || currentItem.guid === expectedGuid);
      if (!sameItem) {
        this.pendingMetadataActivations.delete(key);
        return;
      }
      if (currentItem?.info && current) {
        this.pendingMetadataActivations.delete(key);
        if (!this.deps.useInventoryItem?.(current)) this.activateInventorySlot(current);
        return;
      }
      if (Date.now() >= deadline) {
        this.pendingMetadataActivations.delete(key);
        this.deps.log(`item ${expectedEntry}: metadata did not arrive; activation cancelled`);
        return;
      }
      world.requestItemInfo(expectedEntry);
      globalThis.setTimeout(retry, 50);
    };
    globalThis.setTimeout(retry, 50);
  }

  /** Sell all or a confirmed subset of one stack; the realm still validates count and ownership. */
  sellSlotToVendor(vendorGuid: string, source: InventorySlot, count = 0) {
    const slot = this.findInventorySlot(slotRef(source)) ?? source;
    const item = slot.item;
    const world = this.deps.getWorld();
    if (!world || !item?.guid) return false;
    const blocked = inventorySellGuardReason(slot);
    if (blocked) {
      this.deps.log(blocked);
      return false;
    }
    count = count > 0 ? Math.max(1, Math.min(255, item.count, Math.floor(count))) : 0;
    world.sellItem(vendorGuid, item.guid, count);
    this.deps.playUi?.('ITEMGENERICSOUND');
    return true;
  }

  sellHeldItemTo(vendorGuid: string) {
    const held = this.deps.cursor.heldCursor;
    const world = this.deps.getWorld();
    if (!world || held?.kind !== 'item' || !held.guid) return false;
    const source = this.findInventorySlot(held.source);
    if (!source) {
      // Equipped bag portraits are not normal inventory slots, but their
      // protocol coordinates are still enough to identify and protect them.
      if (isEquippedBagProtocolSlot(held.source.protocolBag, held.source.protocolSlot)) {
        this.deps.log('Unequip that bag before selling it.');
      }
      return false;
    }
    const blocked = inventorySellGuardReason(source);
    if (blocked) {
      this.deps.log(blocked);
      return false;
    }
    world.sellItem(vendorGuid, held.guid, held.splitCount ?? 0);
    this.deps.cursor.clearHeldCursor();
    this.deps.playUi?.('ITEMGENERICSOUND');
    return true;
  }

  dropHeldItemOnSlot(target: InventorySlot) {
    const { cursor } = this.deps;
    const heldCursor = cursor.heldCursor;
    const world = this.deps.getWorld();
    if (heldCursor?.kind !== 'item' || !world) return false;
    const source = heldCursor.source;
    const targetRef = slotRef(target);
    if (isSameSlotRef(source, targetRef)) {
      cursor.clearHeldCursor();
      this.deps.playUi?.('CURSORDROPOBJECT');
      return true;
    }
    if (heldCursor.splitCount) world.splitItem(source.protocolBag, source.protocolSlot, target.protocolBag, target.protocolSlot, heldCursor.splitCount);
    else if (source.protocolBag === PLAYER_BAG && target.protocolBag === PLAYER_BAG) world.swapInventoryItem(source.protocolSlot, target.protocolSlot);
    else world.swapItem(source.protocolBag, source.protocolSlot, target.protocolBag, target.protocolSlot);
    cursor.clearHeldCursor();
    this.deps.playUi?.('CURSORDROPOBJECT');
    return true;
  }

  dropHeldItemOnBagButton(bagId: number) {
    const { cursor } = this.deps;
    const heldCursor = cursor.heldCursor;
    const world = this.deps.getWorld();
    if (heldCursor?.kind !== 'item' || !world) return false;
    const sourceSlot = this.findInventorySlot(heldCursor.source);
    const info: ItemInfo | undefined = sourceSlot?.item?.info ?? world.getItemInfo(heldCursor.entry);
    const canEquipAsBag = heldCursor.isBag || this.isBagContainerItem(sourceSlot?.item, info, heldCursor.source);
    if (bagId > 0 && canEquipAsBag) {
      const dstSlot = EQUIPPED_BAG_SLOT_START + bagId - 1;
      if (heldCursor.source.protocolBag === PLAYER_BAG) world.swapInventoryItem(heldCursor.source.protocolSlot, dstSlot);
      else world.swapItem(heldCursor.source.protocolBag, heldCursor.source.protocolSlot, PLAYER_BAG, dstSlot);
      cursor.clearHeldCursor();
      this.deps.playUi?.('CURSORDROPOBJECT');
      return true;
    }
    const target = this.findFirstEmptySlot(bagId);
    if (!target) return false;
    if (heldCursor.splitCount) world.splitItem(heldCursor.source.protocolBag, heldCursor.source.protocolSlot, target.protocolBag, target.protocolSlot, heldCursor.splitCount);
    else if (bagId > 0) world.autoStoreBagItem(heldCursor.source.protocolBag, heldCursor.source.protocolSlot, target.protocolBag);
    // Backpack drop (bag 0): both positions live under player bag 255, so the
    // protocol requires CMSG_SWAP_INV_ITEM, not CMSG_SWAP_ITEM.
    else if (heldCursor.source.protocolBag === PLAYER_BAG && target.protocolBag === PLAYER_BAG)
      world.swapInventoryItem(heldCursor.source.protocolSlot, target.protocolSlot);
    else world.swapItem(heldCursor.source.protocolBag, heldCursor.source.protocolSlot, target.protocolBag, target.protocolSlot);
    cursor.clearHeldCursor();
    this.deps.playUi?.('CURSORDROPOBJECT');
    return true;
  }

  private isEquippedBagSlotRef(ref?: CursorSlotRef) {
    return !!ref && isEquippedBagProtocolSlot(ref.protocolBag, ref.protocolSlot);
  }
}
