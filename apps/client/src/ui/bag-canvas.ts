/** Asset conversion utility. */
import type { TooltipLine } from './game-tooltip';
import { getGameTooltip } from './game-tooltip';
import { CanvasPanel, drawInputBox, drawItemButton, drawMoney, qualityColor, type PanelHit } from './panel-kit';
import { isBuiltInAddonEnabled } from './builtin-addons';
import { stackSplitAnchorFromCanvas, type StackSplitAnchor } from './stack-split-frame';
import { containsPoint, type CanvasPoint, type CanvasRect } from './vanilla-canvas';
import {
  bagSlotRectFor, CONTAINER_FRAME_WIDTH as FRAME_WIDTH, CONTAINER_MAX_ITEMS as MAX_CONTAINER_ITEMS,
  containerFrameSpecFor,
} from './container-frame-geometry';

const TEXTURE_WIDTH = 256;
const TEXTURE_VISIBLE_OFFSET = FRAME_WIDTH - TEXTURE_WIDTH;
const SLOT_SIZE = 37;

export type BagCanvasTooltip = TooltipLine[] | (() => TooltipLine[] | undefined);

export type BagCanvasItemView = {
  /** Zero-based container slot, matching InventorySlot.index. */
  slot: number;
  iconUrl?: string;
  count?: number;
  tooltip?: BagCanvasTooltip;
  /** Locked items are desaturated and do not activate. */
  locked?: boolean;
  /** Dim the source while it is carried by the inventory cursor. */
  held?: boolean;
  quality?: number;
  /** Search results retain their slot location but dim non-matching items. */
  searchMiss?: boolean;
  /** Opaque integration payload returned with callbacks. */
  data?: unknown;
};

export type BagCanvasView = {
  bagId: number;
  name: string;
  /** Number of usable slots. Vanilla ContainerFrame supports at most 36. */
  slotCount: number;
  items: readonly BagCanvasItemView[];
  /** Defaults to bagId === 0. */
  isBackpack?: boolean;
  /** FrameXML KEYRING_CONTAINER uses the -Keyring component atlas and fixed portrait. */
  isKeyring?: boolean;
  /** Backpack-only SmallMoneyFrame amount, in copper. */
  money?: number;
  portraitIconUrl?: string;
  portraitTooltip?: BagCanvasTooltip;
  emptySlotTooltip?: (slot: number) => TooltipLine[] | undefined;
  searchQuery?: string;
};

export type BagCanvasModifiers = {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
};

export type BagCanvasSlotAction = BagCanvasModifiers & {
  bagId: number;
  slot: number;
  item?: BagCanvasItemView;
  button: 'left' | 'right';
  anchor: StackSplitAnchor;
};

export type BagCanvasOptions = {
  className?: string;
  playUi?: (name: string) => unknown;
  onClose?: (bagId: number) => void;
  onSlotActivate?: (action: BagCanvasSlotAction) => void;
  /** Optional pointer-down hook for inventory drag/cursor integrations. */
  onSlotPress?: (action: BagCanvasSlotAction) => void;
  onPortraitActivate?: (bagId: number) => void;
  onSearchChange?: (query: string) => void;
};

const modifiersOf = (event: MouseEvent | PointerEvent): BagCanvasModifiers => ({
  shiftKey: event.shiftKey,
  ctrlKey: event.ctrlKey,
  altKey: event.altKey,
  metaKey: event.metaKey,
});

const normalizeSlotCount = (value: number) =>
  Math.max(0, Math.min(MAX_CONTAINER_ITEMS, Math.floor(Number.isFinite(value) ? value : 0)));

const isBackpackView = (view: BagCanvasView) => view.isBackpack ?? view.bagId === 0;

const frameSpecFor = (view: BagCanvasView) =>
  containerFrameSpecFor(normalizeSlotCount(view.slotCount), isBackpackView(view));

const slotRectFor = (view: BagCanvasView, slot: number): CanvasRect | undefined => {
  const slotCount = normalizeSlotCount(view.slotCount);
  if (slot < 0 || slot >= slotCount) return undefined;

  return bagSlotRectFor(slotCount, isBackpackView(view), slot);
};

/** A single native ContainerFrame surface. Position/stack the canvas via its host. */
export class BagCanvasPanel extends CanvasPanel {
  private view: BagCanvasView;
  private readonly options: BagCanvasOptions;
  private activationModifiers: BagCanvasModifiers = {
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
  };

  constructor(host: HTMLElement, view: BagCanvasView, options: BagCanvasOptions = {}) {
    const normalized = { ...view, slotCount: normalizeSlotCount(view.slotCount) };
    super(
      host,
      FRAME_WIDTH,
      frameSpecFor(normalized).frameHeight,
      options.className ?? 'wow-bag-canvas',
      { playUi: options.playUi },
    );
    this.view = normalized;
    this.options = options;

    const canvas = this.surface.canvas;
    canvas.setAttribute('role', 'dialog');
    canvas.setAttribute('aria-label', normalized.name || 'Bag');

    // Capture modifiers and expose an early hook for cursor/drag implementations.
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      this.activationModifiers = modifiersOf(event);
      const slot = this.slotAtPoint(this.surface.point(event));
      if (slot === undefined) return;
      const rect = slotRectFor(this.view, slot);
      if (!rect) return;
      const item = this.itemForSlot(slot);
      if (item?.locked) return;
      this.options.onSlotPress?.({
        bagId: this.view.bagId,
        slot,
        item,
        button: 'left',
        anchor: stackSplitAnchorFromCanvas(canvas.getBoundingClientRect(), this.surface.width, this.surface.height, rect, 'right'),
        ...this.activationModifiers,
      });
    }, { capture: true });

    // CanvasPanel owns primary-button activation; retain native right-click item use.
    canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const point = this.mousePoint(event);
      const slot = this.slotAtPoint(point);
      if (slot === undefined) return;
      const rect = slotRectFor(this.view, slot);
      if (!rect) return;
      const item = this.itemForSlot(slot);
      if (item?.locked) return;
      this.options.onSlotActivate?.({
        bagId: this.view.bagId,
        slot,
        item,
        button: 'right',
        anchor: stackSplitAnchorFromCanvas(canvas.getBoundingClientRect(), this.surface.width, this.surface.height, rect, 'right'),
        ...modifiersOf(event),
      });
    });

    this.onFieldKey = (field, key, char) => {
      if (field !== 'search') return;
      let query = this.view.searchQuery ?? '';
      if (key === 'char' && char && query.length < 40) query += char;
      else if (key === 'backspace') query = query.slice(0, -1);
      else if (key === 'escape' || key === 'enter') this.focusField(undefined);
      this.options.onSearchChange?.(query);
    };

    this.surface.requestRender();
  }

  setView(view: BagCanvasView) {
    this.view = { ...view, slotCount: normalizeSlotCount(view.slotCount) };
    this.surface.resize(FRAME_WIDTH, frameSpecFor(this.view).frameHeight);
    this.surface.canvas.setAttribute('aria-label', this.view.name || 'Bag');
    this.surface.requestRender();
  }

  getView() { return this.view; }

  destroy() {
    getGameTooltip().hide();
    this.surface.canvas.remove();
  }

  protected paint() {
    const s = this.surface;
    const spec = frameSpecFor(this.view);
    s.clear();
    if (spec.backpack) {
      s.image('/ui/Interface/ContainerFrame/UI-BackpackBackground.png', TEXTURE_VISIBLE_OFFSET, 0, TEXTURE_WIDTH, 256);
    } else {
      const components = `/ui/Interface/ContainerFrame/UI-Bag-Components${this.view.isKeyring ? '-Keyring' : ''}.png`;
      const [top, bottom] = spec.topTexCoords!;
      s.spriteFraction(components, 0, top, 1, bottom, TEXTURE_VISIBLE_OFFSET, 0, TEXTURE_WIDTH, spec.topHeight);
      let y = spec.topHeight;
      for (const height of spec.middleHeights) {
        s.spriteFraction(components, 0, 0.353515625, 1, 0.353515625 + height / 512,
          TEXTURE_VISIBLE_OFFSET, y, TEXTURE_WIDTH, height);
        y += height;
      }
      s.spriteFraction(components, 0, 0.330078125, 1, 0.349609375,
        TEXTURE_VISIBLE_OFFSET, y, TEXTURE_WIDTH, 10);
    }

    const portrait = this.view.portraitIconUrl
      ?? (isBackpackView(this.view)
        ? '/ui/Interface/Buttons/Button-Backpack-Up.png'
        : this.view.isKeyring ? '/ui/Interface/ContainerFrame/KeyRing-Bag-Icon.png' : undefined);
    if (portrait) s.image(portrait, 7, 5, 40, 40);

    if (isBuiltInAddonEnabled('bagSearch')) {
      drawInputBox(s, 50, 7, 106, this.view.searchQuery ?? '', {
        focused: this.focusedField === 'search', size: 11, placeholder: 'Search',
      });
      this.hit('search', { x: 50, y: 7, width: 106, height: 20 }, { tooltip: [{ text: 'Search Bags', color: '#ffffff' }] });
    } else {
      s.text(this.view.name, 103, 16, {
        size: 12,
        color: '#ffffff',
        align: 'center',
        baseline: 'middle',
        maxWidth: 112,
      });
    }

    const closeState = this.state('close');
    s.closeButton(160, 2, closeState === 'down' ? 'down' : closeState === 'hover' ? 'hover' : 'normal');
    this.hit('close', { x: 160, y: 2, width: 32, height: 32 });

    this.hit('portrait', { x: 7, y: 5, width: 40, height: 40 }, {
      tooltip: this.view.portraitTooltip,
      silent: !this.options.onPortraitActivate,
    });

    const items = new Map<number, BagCanvasItemView>();
    for (const item of this.view.items) {
      if (item.slot >= 0 && item.slot < this.view.slotCount) items.set(item.slot, item);
    }

    for (let slot = 0; slot < this.view.slotCount; slot++) {
      const rect = slotRectFor(this.view, slot);
      if (!rect) continue;
      const item = items.get(slot);
      const id = `slot:${slot}`;
      const state = this.state(id);
      if (item?.iconUrl) {
        drawItemButton(s, rect.x, rect.y, SLOT_SIZE, {
          iconUrl: item.iconUrl,
          count: item.count,
          hover: state === 'hover',
          pushed: state === 'down',
          disabled: item.locked || item.held || item.searchMiss,
        });
        if (isBuiltInAddonEnabled('itemTools') && (item.quality ?? 1) > 1) {
          const ctx = s.ctx;
          ctx.save(); ctx.strokeStyle = qualityColor(item.quality); ctx.lineWidth = 2;
          ctx.strokeRect(rect.x + 1, rect.y + 1, SLOT_SIZE - 2, SLOT_SIZE - 2); ctx.restore();
        }
      } else {
        // The ContainerFrame texture already owns empty-slot artwork.
        if (state === 'down') {
          s.image('/ui/Interface/Buttons/UI-Quickslot-Depress.png', rect.x, rect.y, SLOT_SIZE, SLOT_SIZE);
        } else if (state === 'hover') {
          s.addImage('/ui/Interface/Buttons/ButtonHilight-Square.png', rect.x, rect.y, SLOT_SIZE, SLOT_SIZE, 0.9);
        }
      }
      this.hit(id, rect, {
        data: slot,
        disabled: item?.locked,
        tooltip: item?.tooltip ?? (() => this.view.emptySlotTooltip?.(slot)),
      });
    }

    if (isBackpackView(this.view) && this.view.money !== undefined) {
      // SmallMoneyFrame is TOPRIGHT -2, -216 in ContainerFrame.xml.
      drawMoney(s, 190, 225, this.view.money, { align: 'right' });
    }
  }

  protected activate(hit: PanelHit) {
    if (hit.id === 'search') {
      this.focusField('search');
      return;
    }
    if (hit.id === 'close') {
      this.options.onClose?.(this.view.bagId);
      return;
    }
    if (hit.id === 'portrait') {
      this.options.onPortraitActivate?.(this.view.bagId);
      return;
    }
    if (!hit.id.startsWith('slot:')) return;
    const slot = Number(hit.data);
    if (!Number.isInteger(slot)) return;
    const item = this.itemForSlot(slot);
    if (item?.locked) return;
    this.options.onSlotActivate?.({
      bagId: this.view.bagId,
      slot,
      item,
      button: 'left',
      anchor: stackSplitAnchorFromCanvas(this.surface.canvas.getBoundingClientRect(), this.surface.width, this.surface.height, hit.rect, 'right'),
      ...this.activationModifiers,
    });
  }

  private itemForSlot(slot: number) {
    return this.view.items.find((item) => item.slot === slot);
  }

  private slotAtPoint(point: CanvasPoint) {
    for (let slot = this.view.slotCount - 1; slot >= 0; slot--) {
      const rect = slotRectFor(this.view, slot);
      if (rect && containsPoint(rect, point)) return slot;
    }
    return undefined;
  }

  private mousePoint(event: MouseEvent): CanvasPoint {
    const rect = this.surface.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * this.surface.width / Math.max(1, rect.width),
      y: (event.clientY - rect.top) * this.surface.height / Math.max(1, rect.height),
    };
  }
}

export const BAG_CANVAS_WIDTH = FRAME_WIDTH;
export const BAG_CANVAS_MAX_SLOTS = MAX_CONTAINER_ITEMS;
