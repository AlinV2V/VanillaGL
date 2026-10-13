import type { InventoryBag, InventorySlot, InventorySnapshot } from '../world';
import { BagCanvasPanel, type BagCanvasSlotAction, type BagCanvasView } from './bag-canvas';
import type { TooltipLine } from './game-tooltip';
import { hudTransformScale } from './hud-window-interactions';
import { inventoryBagForId } from './keyring-state';
import { isBuiltInAddonEnabled, onBuiltInAddonSettings } from './builtin-addons';

export type InventoryContainerCanvasDeps = {
  containerLayer: HTMLElement;
  ingameHud: HTMLElement;
  draggedFramePositions: Map<string, { left: number; top: number }>;
  getSnapshot: () => InventorySnapshot | undefined;
  itemIconUrl: (displayInfoId?: number, entry?: number) => string;
  itemTooltip: (slot: InventorySlot) => TooltipLine[];
  bagTooltip: (bag: InventoryBag) => TooltipLine[];
  emptyTooltip: (slot: InventorySlot | undefined, index: number) => TooltipLine[];
  heldSourceMatches: (slot: InventorySlot) => boolean;
  onSlotAction: (slot: InventorySlot, button: number, action: BagCanvasSlotAction) => void;
  onClose: (bagId: number) => void;
  onPortraitActivate: (bagId: number) => void;
  playUi: (name: string) => unknown;
};

/** Owns native ContainerFrame canvas mounting so main.ts only supplies gameplay callbacks. */
export class InventoryContainerCanvasBridge {
  private readonly panels = new Map<number, BagCanvasPanel>();
  private readonly warnedOversizeBags = new Set<number>();
  private searchQuery = '';

  constructor(private readonly deps: InventoryContainerCanvasDeps) {
    onBuiltInAddonSettings((settings) => {
      if (!settings.bagSearch) this.searchQuery = '';
      this.refresh();
    });
  }

  refresh() {
    const snapshot = this.deps.getSnapshot();
    if (!snapshot) return;
    for (const [bagId, panel] of this.panels) {
      const bag = inventoryBagForId(snapshot, bagId);
      if (bag) panel.setView(this.view(bag, snapshot.money));
    }
  }

  render(snapshot: InventorySnapshot | undefined, visibleBagIds: readonly number[]) {
    for (const panel of this.panels.values()) panel.destroy();
    this.panels.clear();
    if (!snapshot) return;
    for (const bagId of visibleBagIds) {
      const bag = inventoryBagForId(snapshot, bagId);
      const host = this.deps.containerLayer.querySelector<HTMLElement>(`[data-bag-id="${bagId}"]`);
      if (!bag || !host) continue;
      host.replaceChildren();
      const panel = new BagCanvasPanel(host, this.view(bag, snapshot.money), {
        playUi: this.deps.playUi,
        onClose: this.deps.onClose,
        onPortraitActivate: this.deps.onPortraitActivate,
        onSearchChange: (query) => { this.searchQuery = query; this.refresh(); },
        onSlotActivate: (action) => {
          const slot = bag.slots[action.slot];
          if (slot) this.deps.onSlotAction(slot, action.button === 'right' ? 2 : 0, action);
        },
      });
      host.style.width = `${panel.surface.width}px`;
      host.style.height = `${panel.surface.height}px`;
      host.classList.add('has-canvas-ui');
      this.installDrag(host);
      this.panels.set(bagId, panel);
    }
  }

  private view(bag: InventoryBag, money: number): BagCanvasView {
    if (bag.size > 36 && !this.warnedOversizeBags.has(bag.index)) {
      this.warnedOversizeBags.add(bag.index);
      console.warn(`[ui] Vanilla ContainerFrame supports 36 slots; bag ${bag.index} reports ${bag.size}`);
    }
    return {
      bagId: bag.index,
      name: bag.isKeyring ? 'Keyring' : bag.isBackpack ? 'Backpack'
        : bag.item?.info?.name ?? (bag.itemGuid ? 'Loading Bag' : bag.label),
      slotCount: bag.size,
      isBackpack: bag.isBackpack,
      isKeyring: bag.isKeyring,
      money: bag.isBackpack ? money : undefined,
      portraitIconUrl: bag.isBackpack || bag.isKeyring ? undefined
        : this.deps.itemIconUrl(bag.item?.info?.displayInfoId, bag.item?.entry) || undefined,
      portraitTooltip: this.deps.bagTooltip(bag),
      items: bag.slots.filter((slot) => !!slot.item).map((slot) => ({
        slot: slot.index,
        iconUrl: this.deps.itemIconUrl(slot.item?.info?.displayInfoId, slot.item?.entry)
          || '/ui/Interface/Icons/INV_Misc_QuestionMark.png',
        count: slot.item!.count,
        held: this.deps.heldSourceMatches(slot),
        quality: slot.item?.info?.quality,
        searchMiss: !!this.searchQuery && !`${slot.item?.info?.name ?? ''} ${slot.item?.entry ?? ''}`.toLowerCase()
          .includes(this.searchQuery.trim().toLowerCase()),
        data: slot,
        tooltip: () => this.deps.itemTooltip(slot),
      })),
      emptySlotTooltip: (index) => this.deps.emptyTooltip(bag.slots[index], index),
      searchQuery: this.searchQuery,
    };
  }

  private installDrag(host: HTMLElement) {
    host.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const rect = host.getBoundingClientRect();
      const x = (event.clientX - rect.left) * 192 / Math.max(1, rect.width);
      const y = (event.clientY - rect.top) * Number.parseFloat(host.style.height || '239') / Math.max(1, rect.height);
      // The optional search EditBox occupies the middle of the original title drag strip.
      // Let CanvasPanel receive that pointerdown so it can take keyboard focus; previously this
      // capture listener stopped the event first, making the painted search field inert.
      if (isBuiltInAddonEnabled('bagSearch') && x >= 50 && x <= 156 && y >= 7 && y <= 27) return;
      if (x < 48 || x > 154 || y < 3 || y > 31) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const scale = hudTransformScale(this.deps.ingameHud);
      const hudRect = this.deps.ingameHud.getBoundingClientRect();
      const startX = event.clientX / scale;
      const startY = event.clientY / scale;
      const startLeft = (rect.left - hudRect.left) / scale;
      const startTop = (rect.top - hudRect.top) / scale;
      const move = (next: PointerEvent) => {
        const left = Math.round(startLeft + next.clientX / scale - startX);
        const top = Math.round(startTop + next.clientY / scale - startY);
        host.style.left = `${left}px`; host.style.top = `${top}px`;
        host.style.right = 'auto'; host.style.bottom = 'auto';
        if (host.dataset.frameId) this.deps.draggedFramePositions.set(host.dataset.frameId, { left, top });
      };
      const end = () => {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', end, true);
        window.removeEventListener('pointercancel', end, true);
      };
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', end, true);
      window.addEventListener('pointercancel', end, true);
    }, true);
  }
}
