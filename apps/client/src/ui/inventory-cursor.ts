import type { InventorySnapshot, InventorySlot, ItemInfo } from '../world';
import { hudTransformScale } from './hud-window-interactions';
import type { MultiBarId } from './multi-action-bars';

export type CursorSlotRef = {
  container: InventorySlot['container'] | 'bank';
  index: number;
  protocolBag: number;
  protocolSlot: number;
};

export type HeldCursor =
  | {
      kind: 'item';
      source: CursorSlotRef;
      guid?: string;
      entry: number;
      count: number;
      splitCount?: number;
      isBag?: boolean;
      name: string;
      iconUrl: string;
    }
  | {
      kind: 'action';
      sourceSlot?: number;
      /** Which bar the button was lifted from; absent means the main paged bar. */
      sourceBar?: MultiBarId;
      action: number;
      type: number;
      name: string;
      iconUrl: string;
    };

export type WowCursorName =
  | 'Point' | 'UnablePoint'
  | 'Attack' | 'UnableAttack'
  | 'Buy' | 'UnableBuy'
  | 'Trainer' | 'UnableTrainer'
  | 'Repair' | 'UnableRepair'
  | 'Speak' | 'UnableSpeak'
  | 'Taxi' | 'UnableTaxi'
  | 'LootAll' | 'UnableLootAll'
  | 'Interact' | 'UnableInteract'
  | 'Inspect' | 'UnableInspect';

/** Layout pixels between the pointer hotspot and the held icon's top-left corner. */
const CURSOR_ATTACHMENT_OFFSET = 10;

const WOW_CURSOR_HOTSPOTS: Partial<Record<WowCursorName, [number, number]>> = {
  Point: [0, 0],
  UnablePoint: [0, 0],
  Interact: [16, 16],
  UnableInteract: [16, 16],
};

export const isSameSlotRef = (a: CursorSlotRef, b: CursorSlotRef) =>
  a.protocolBag === b.protocolBag && a.protocolSlot === b.protocolSlot;

export const slotRef = (slot: InventorySlot): CursorSlotRef => ({
  container: slot.container,
  index: slot.index,
  protocolBag: slot.protocolBag,
  protocolSlot: slot.protocolSlot,
});

export const cursorSlotFromElement = (el: HTMLElement): CursorSlotRef | null => {
  if (!el.dataset.itemBag || !el.dataset.itemSlot || !el.dataset.itemContainer || !el.dataset.itemIndex) return null;
  const container = el.dataset.itemContainer as InventorySlot['container'];
  if (container !== 'equipment' && container !== 'backpack' && container !== 'bag' && container !== 'keyring') return null;
  return {
    container,
    index: Number(el.dataset.itemIndex),
    protocolBag: Number(el.dataset.itemBag),
    protocolSlot: Number(el.dataset.itemSlot),
  };
};

export class InventoryCursorController {
  heldCursor: HeldCursor | null = null;
  private cursorX = 0;
  private cursorY = 0;
  private activeWowCursor: WowCursorName | undefined;
  private readonly cursorAttachment: HTMLDivElement;

  constructor(private readonly deps: {
    ingameHud: HTMLElement;
    worldCanvas: HTMLElement;
    actionBar: HTMLElement;
    backpackButton: HTMLButtonElement;
    bagSlotButtons: HTMLButtonElement[];
    getInventory: () => InventorySnapshot | undefined;
    getItemInfo: (entry: number) => ItemInfo | undefined;
    findInventorySlot: (ref: CursorSlotRef) => InventorySlot | undefined;
    isBagContainerItem: (item?: NonNullable<InventorySlot['item']>, info?: ItemInfo, ref?: CursorSlotRef) => boolean;
    canPlaceItemOnActionButton: (item?: NonNullable<InventorySlot['item']>, info?: ItemInfo, ref?: CursorSlotRef, forcedBag?: boolean) => boolean;
    onChange?: () => void;
  }) {
    this.cursorAttachment = document.createElement('div');
    this.cursorAttachment.className = 'wow-cursor-attachment is-hidden';
    deps.ingameHud.appendChild(this.cursorAttachment);
    // The `gxCursor` video option owns this class from applyVideoCvars; do not force it on here or
    // the option would be overridden every time the inventory cursor is constructed.
    this.setWowCursor('Point');

    document.addEventListener('pointermove', (event) => {
      this.cursorX = event.clientX;
      this.cursorY = event.clientY;
      this.updateCursorAttachmentPosition();
      const target = event.target;
      if (target instanceof Node && target !== deps.worldCanvas && !deps.worldCanvas.contains(target)) this.setWowCursor('Point');
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.heldCursor) {
        this.clearHeldCursor();
        event.preventDefault();
      }
    });
  }

  setWowCursor(name: WowCursorName) {
    if (this.activeWowCursor === name) return;
    this.activeWowCursor = name;
    const [hotX, hotY] = WOW_CURSOR_HOTSPOTS[name] ?? [0, 0];
    document.body.style.setProperty('--wow-cursor', `url('/ui/Interface/Cursor/${name}.png') ${hotX} ${hotY}, auto`);
  }

  slotRef(slot: InventorySlot): CursorSlotRef {
    return slotRef(slot);
  }

  slotFromElement(el: HTMLElement): CursorSlotRef | null {
    return cursorSlotFromElement(el);
  }

  isSameSlotRef(a: CursorSlotRef, b: CursorSlotRef): boolean {
    return isSameSlotRef(a, b);
  }

  heldSourceMatches(slot: InventorySlot) {
    return this.heldCursor?.kind === 'item' && isSameSlotRef(this.heldCursor.source, slotRef(slot));
  }

  refreshHeldSourceMarks() {
    const held = this.heldCursor?.kind === 'item' ? this.heldCursor.source : undefined;
    const heldSlot = this.heldCursor?.kind === 'item' ? this.deps.findInventorySlot(this.heldCursor.source) : undefined;
    const heldInfo = this.heldCursor?.kind === 'item' ? heldSlot?.item?.info ?? this.deps.getItemInfo(this.heldCursor.entry) : undefined;
    const heldIsBag = this.heldCursor?.kind === 'item' && (this.heldCursor.isBag || this.deps.isBagContainerItem(heldSlot?.item, heldInfo, this.heldCursor.source));
    const heldCanAction =
      this.heldCursor?.kind === 'action' ||
      (this.heldCursor?.kind === 'item' && this.deps.canPlaceItemOnActionButton(heldSlot?.item, heldInfo, this.heldCursor.source, this.heldCursor.isBag));
    this.deps.ingameHud.querySelectorAll<HTMLElement>('.wow-item-slot[data-item-bag]').forEach((el) => {
      const ref = cursorSlotFromElement(el);
      el.classList.toggle('is-held-source', !!held && !!ref && isSameSlotRef(held, ref));
      el.classList.toggle('is-drop-valid', !!held && !!ref && !isSameSlotRef(held, ref));
    });
    this.deps.actionBar.querySelectorAll<HTMLElement>('.wow-action-button').forEach((el) => {
      el.classList.toggle('is-drop-valid', !!this.heldCursor && heldCanAction);
      el.classList.toggle('is-drop-invalid', this.heldCursor?.kind === 'item' && !heldCanAction);
    });
    this.deps.backpackButton.classList.toggle('is-drop-valid', this.heldCursor?.kind === 'item');
    this.deps.backpackButton.classList.toggle('is-drop-invalid', false);
    for (const [index, button] of this.deps.bagSlotButtons.entries()) {
      const bag = this.deps.getInventory()?.bags[index + 1];
      const acceptsHeld = this.heldCursor?.kind === 'item' && (heldIsBag || !!bag?.itemGuid);
      button.classList.toggle('is-drop-valid', !!acceptsHeld);
      button.classList.toggle('is-drop-invalid', this.heldCursor?.kind === 'item' && !acceptsHeld);
    }
  }

  clearHeldCursor() {
    this.heldCursor = null;
    document.body.classList.remove('wow-cursor-holding');
    this.cursorAttachment.classList.add('is-hidden');
    this.cursorAttachment.style.removeProperty('background-image');
    this.cursorAttachment.textContent = '';
    this.refreshHeldSourceMarks();
    this.deps.onChange?.();
  }

  setHeldCursor(next: HeldCursor | null) {
    this.heldCursor = next;
    if (!next) {
      this.clearHeldCursor();
      return;
    }
    document.body.classList.add('wow-cursor-holding');
    this.cursorAttachment.classList.toggle('is-hidden', !next.iconUrl);
    this.cursorAttachment.style.backgroundImage = next.iconUrl ? `url('${next.iconUrl}')` : '';
    this.cursorAttachment.textContent = next.kind === 'item' && (next.splitCount ?? next.count) > 1 ? String(next.splitCount ?? next.count) : '';
    this.cursorAttachment.title = next.name;
    this.updateCursorAttachmentPosition();
    this.refreshHeldSourceMarks();
    this.deps.onChange?.();
  }

  /**
   * Place the held icon under the pointer.
   *
   * `pointermove` reports VIEWPORT pixels, but the attachment lives inside `.wow-ingame-hud`, which
   * carries `transform: scale(--wow-ui-scale)`. A transformed ancestor becomes the containing block
   * for `position: fixed` descendants, so the translate below is spent in LAYOUT pixels and the
   * ancestor then scales it — the icon lands at `client * scale`, not at `client`. Measured in the
   * live page at scale 0.64: intended (600,500), actual (384,320), i.e. 216px left and 180px up.
   * `hudTransformScale` exists for exactly this conversion; see its header.
   */
  private updateCursorAttachmentPosition() {
    const scale = hudTransformScale(this.deps.ingameHud) || 1;
    const x = Math.round((this.cursorX + CURSOR_ATTACHMENT_OFFSET) / scale);
    const y = Math.round((this.cursorY + CURSOR_ATTACHMENT_OFFSET) / scale);
    this.cursorAttachment.style.transform = `translate(${x}px, ${y}px)`;
  }
}
