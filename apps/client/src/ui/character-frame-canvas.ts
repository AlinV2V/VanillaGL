import type { CharTab } from './ingame-hud-elements';
import { paintHonorPage } from './character-honor-canvas';
import { isBuiltInAddonEnabled, onBuiltInAddonSettings } from './builtin-addons';
import {
  containsPoint,
  ensureVanillaFonts,
  type CanvasPoint,
  type CanvasRect,
  VanillaCanvas,
} from './vanilla-canvas';

const INFO = '/ui/Interface/PaperDollInfoFrame';
const DOLL = '/ui/Interface/PaperDoll';
const TABS: ReadonlyArray<readonly [CharTab, string]> = [
  ['character', 'Character'], ['pet', 'Pet'], ['reputation', 'Reputation'], ['skills', 'Skills'], ['honor', 'Honor'],
];

export type CharacterEquipmentSlotId =
  | 'head' | 'neck' | 'shoulders' | 'back' | 'chest' | 'shirt' | 'tabard' | 'wrists'
  | 'hands' | 'waist' | 'legs' | 'feet' | 'finger1' | 'finger2' | 'trinket1' | 'trinket2'
  | 'mainHand' | 'offHand' | 'ranged' | 'ammo';

export type CharacterEquipmentLayout = {
  id: CharacterEquipmentSlotId;
  label: string;
  /** Index in InventorySnapshot.equipment; ammo is not an equipment field. */
  inventoryIndex?: number;
  texture: string;
  rect: CanvasRect;
};

/** PaperDollFrame.xml anchors converted to the canvas' top-left coordinates. */
export const CHARACTER_EQUIPMENT_LAYOUT: ReadonlyArray<CharacterEquipmentLayout> = [
  { id: 'head', label: 'Head', inventoryIndex: 0, texture: 'UI-PaperDoll-Slot-Head', rect: { x: 21, y: 74, width: 37, height: 37 } },
  { id: 'neck', label: 'Neck', inventoryIndex: 1, texture: 'UI-PaperDoll-Slot-Neck', rect: { x: 21, y: 115, width: 37, height: 37 } },
  { id: 'shoulders', label: 'Shoulders', inventoryIndex: 2, texture: 'UI-PaperDoll-Slot-Shoulder', rect: { x: 21, y: 156, width: 37, height: 37 } },
  { id: 'back', label: 'Back', inventoryIndex: 14, texture: 'UI-PaperDoll-Slot-Chest', rect: { x: 21, y: 197, width: 37, height: 37 } },
  { id: 'chest', label: 'Chest', inventoryIndex: 4, texture: 'UI-PaperDoll-Slot-Chest', rect: { x: 21, y: 238, width: 37, height: 37 } },
  { id: 'shirt', label: 'Shirt', inventoryIndex: 3, texture: 'UI-PaperDoll-Slot-Shirt', rect: { x: 21, y: 279, width: 37, height: 37 } },
  { id: 'tabard', label: 'Tabard', inventoryIndex: 18, texture: 'UI-PaperDoll-Slot-Tabard', rect: { x: 21, y: 320, width: 37, height: 37 } },
  { id: 'wrists', label: 'Wrists', inventoryIndex: 8, texture: 'UI-PaperDoll-Slot-Wrists', rect: { x: 21, y: 361, width: 37, height: 37 } },
  { id: 'hands', label: 'Hands', inventoryIndex: 9, texture: 'UI-PaperDoll-Slot-Hands', rect: { x: 305, y: 74, width: 37, height: 37 } },
  { id: 'waist', label: 'Waist', inventoryIndex: 5, texture: 'UI-PaperDoll-Slot-Waist', rect: { x: 305, y: 115, width: 37, height: 37 } },
  { id: 'legs', label: 'Legs', inventoryIndex: 6, texture: 'UI-PaperDoll-Slot-Legs', rect: { x: 305, y: 156, width: 37, height: 37 } },
  { id: 'feet', label: 'Feet', inventoryIndex: 7, texture: 'UI-PaperDoll-Slot-Feet', rect: { x: 305, y: 197, width: 37, height: 37 } },
  { id: 'finger1', label: 'Finger 1', inventoryIndex: 10, texture: 'UI-PaperDoll-Slot-Finger', rect: { x: 305, y: 238, width: 37, height: 37 } },
  { id: 'finger2', label: 'Finger 2', inventoryIndex: 11, texture: 'UI-PaperDoll-Slot-Finger', rect: { x: 305, y: 279, width: 37, height: 37 } },
  { id: 'trinket1', label: 'Trinket 1', inventoryIndex: 12, texture: 'UI-PaperDoll-Slot-Trinket', rect: { x: 305, y: 320, width: 37, height: 37 } },
  { id: 'trinket2', label: 'Trinket 2', inventoryIndex: 13, texture: 'UI-PaperDoll-Slot-Trinket', rect: { x: 305, y: 361, width: 37, height: 37 } },
  { id: 'mainHand', label: 'Main Hand', inventoryIndex: 15, texture: 'UI-PaperDoll-Slot-MainHand', rect: { x: 122, y: 385, width: 37, height: 37 } },
  { id: 'offHand', label: 'Off Hand', inventoryIndex: 16, texture: 'UI-PaperDoll-Slot-SecondaryHand', rect: { x: 164, y: 385, width: 37, height: 37 } },
  { id: 'ranged', label: 'Ranged', inventoryIndex: 17, texture: 'UI-PaperDoll-Slot-Ranged', rect: { x: 206, y: 385, width: 37, height: 37 } },
  { id: 'ammo', label: 'Ammo', texture: 'UI-PaperDoll-Slot-Ammo', rect: { x: 258, y: 390, width: 27, height: 27 } },
];

export type CharacterEquipmentSlotView = {
  id: CharacterEquipmentSlotId;
  label?: string;
  iconUrl?: string;
  count?: number;
  quality?: number;
  durability?: number;
  maxDurability?: number;
  disabled?: boolean;
  tooltip?: string;
  /** Opaque application payload returned unchanged to callbacks. */
  data?: unknown;
};

export type CharacterStatRow = {
  label: string;
  value?: string | number;
  color?: string;
  valueColor?: string;
};

export type CharacterTextSection = {
  title?: string;
  rows?: ReadonlyArray<CharacterStatRow>;
  lines?: ReadonlyArray<string>;
};

export type CharacterSubpageView = {
  heading?: string;
  sections?: ReadonlyArray<CharacterTextSection>;
  emptyText?: string;
};

export type CharacterFrameCanvasViewModel = {
  title?: string;
  subtitle?: string;
  livePortraitCanvas?: HTMLCanvasElement;
  portraitUrl?: string;
  equipment?: ReadonlyArray<CharacterEquipmentSlotView>;
  /** Left attributes and right melee/ranged columns from CharacterAttributesFrame. */
  statColumns?: readonly [ReadonlyArray<CharacterStatRow>, ReadonlyArray<CharacterStatRow>];
  pages?: Partial<Record<Exclude<CharTab, 'character'>, CharacterSubpageView>>;
  disabledTabs?: ReadonlyArray<CharTab>;
};

export type CharacterFrameCanvasCallbacks = {
  onClose?: () => void;
  onTabChange?: (tab: CharTab) => void;
  onRotate?: (direction: 'left' | 'right') => void;
  onSlotHover?: (slot: CharacterEquipmentSlotView | undefined, point: CanvasPoint) => void;
  onSlotClick?: (slot: CharacterEquipmentSlotView, event: PointerEvent) => void;
};

type Hit =
  | { kind: 'close'; key: 'close'; rect: CanvasRect }
  | { kind: 'rotate'; key: string; rect: CanvasRect; direction: 'left' | 'right' }
  | { kind: 'tab'; key: string; rect: CanvasRect; tab: CharTab; disabled: boolean }
  | { kind: 'slot'; key: string; rect: CanvasRect; slot: CharacterEquipmentSlotView }
  | { kind: 'scroll'; key: string; rect: CanvasRect; direction: -1 | 1; disabled: boolean };

const CLOSE_RECT: CanvasRect = { x: 324, y: 9, width: 32, height: 32 };
const QUALITY_COLORS = ['#9d9d9d', '#ffffff', '#1eff00', '#0070dd', '#a335ee', '#ff8000', '#e6cc80'];
const tabRect = (index: number): CanvasRect => ({ x: 28 + index * 53, y: 434, width: 67, height: 32 });
const pageArt = (tab: CharTab): [string, string, string, string] => tab === 'character'
  ? ['UI-Character-CharacterTab-L1', 'UI-Character-CharacterTab-R1', 'UI-Character-CharacterTab-BottomLeft', 'UI-Character-CharacterTab-BottomRight']
  : tab === 'honor'
    ? ['UI-Character-Honor-TopLeft', 'UI-Character-Honor-TopRight', 'UI-Character-Honor-BottomLeft', 'UI-Character-Honor-BottomRight']
    : ['UI-Character-General-TopLeft', 'UI-Character-General-TopRight', 'UI-Character-General-BottomLeft', 'UI-Character-General-BottomRight'];

export class CharacterFrameCanvasRenderer {
  private readonly surface: VanillaCanvas;
  private tab: CharTab = 'character';
  private viewModel: CharacterFrameCanvasViewModel = {};
  private callbacks: CharacterFrameCanvasCallbacks = {};
  private hits: Hit[] = [];
  private hoveredKey?: string;
  private hoveredSlot?: CharacterEquipmentSlotView;
  private pressedKey?: string;
  private readonly pageScroll: Partial<Record<CharTab, number>> = {};
  private subpageMaxScroll = 0;
  private disposeSettings?: () => void;

  private readonly onMove = (event: PointerEvent) => this.handleMove(event);
  private readonly onLeave = () => this.handleLeave();
  private readonly onDown = (event: PointerEvent) => this.handleDown(event);
  private readonly onUp = (event: PointerEvent) => this.handleUp(event);
  private readonly onCancel = () => this.clearPressed();
  private readonly onContext = (event: MouseEvent) => event.preventDefault();
  private readonly onKey = (event: KeyboardEvent) => this.handleKey(event);
  private readonly onWheel = (event: WheelEvent) => this.handleWheel(event);

  constructor(canvas: HTMLCanvasElement, options: {
    viewModel?: CharacterFrameCanvasViewModel;
    callbacks?: CharacterFrameCanvasCallbacks;
  } = {}) {
    // Retain the supplied node: HUD/model consumers may already hold its reference.
    this.surface = new VanillaCanvas(384, 512, 'wow-character-native-background', canvas);
    this.viewModel = options.viewModel ?? {};
    this.callbacks = options.callbacks ?? {};
    canvas.removeAttribute('aria-hidden');
    canvas.setAttribute('role', 'dialog');
    canvas.setAttribute('aria-label', 'Character Info');
    canvas.tabIndex = 0;
    // Keyboard-focusable for tab navigation, but the UA focus ring would draw a
    // white box around the whole frame — the canvas paints its own focus cues.
    canvas.style.outline = 'none';
    canvas.style.pointerEvents = 'auto';
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onCancel);
    canvas.addEventListener('contextmenu', this.onContext);
    canvas.addEventListener('keydown', this.onKey);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.surface.onRender(() => this.paint());
    this.disposeSettings = onBuiltInAddonSettings(() => this.surface.requestRender());
    void ensureVanillaFonts().then(() => this.surface.requestRender());
    this.surface.requestRender();
  }

  get element() { return this.surface.canvas; }
  get currentTab() { return this.tab; }

  /** Existing render(tab) calls stay valid; callers may update the VM atomically. */
  render(tab: CharTab, viewModel?: CharacterFrameCanvasViewModel) {
    this.tab = tab;
    if (viewModel) this.viewModel = viewModel;
    this.surface.requestRender();
  }

  setViewModel(viewModel: CharacterFrameCanvasViewModel) {
    this.viewModel = viewModel;
    this.surface.requestRender();
  }

  setCallbacks(callbacks: CharacterFrameCanvasCallbacks) { this.callbacks = callbacks; }

  destroy() {
    this.disposeSettings?.();
    const canvas = this.surface.canvas;
    canvas.removeEventListener('pointermove', this.onMove);
    canvas.removeEventListener('pointerleave', this.onLeave);
    canvas.removeEventListener('pointerdown', this.onDown);
    canvas.removeEventListener('pointerup', this.onUp);
    canvas.removeEventListener('pointercancel', this.onCancel);
    canvas.removeEventListener('contextmenu', this.onContext);
    canvas.removeEventListener('keydown', this.onKey);
    canvas.removeEventListener('wheel', this.onWheel);
  }

  private paint() {
    this.hits = [];
    this.surface.clear();
    this.surface.fourSlice(INFO, pageArt(this.tab));
    this.paintHeader();
    if (this.tab === 'character') this.paintCharacter();
    else this.paintSubpage(this.viewModel.pages?.[this.tab]);
    this.paintTabs();
    this.paintClose();
  }

  private paintHeader() {
    const portrait = this.viewModel.livePortraitCanvas;
    if (portrait || this.viewModel.portraitUrl) {
      const ctx = this.surface.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.arc(38, 36, 27, 0, Math.PI * 2);
      ctx.clip();
      if (portrait) ctx.drawImage(portrait, 10, 8, 56, 56);
      else this.surface.image(this.viewModel.portraitUrl!, 10, 8, 56, 56);
      ctx.restore();
    }
    this.surface.text(this.viewModel.title ?? 'Character', 192, 26, {
      size: 14, color: '#fff1bd', align: 'center', baseline: 'middle', maxWidth: 246,
    });
    if (this.viewModel.subtitle) this.surface.text(this.viewModel.subtitle, 192, 52, {
      size: 12, color: '#ffd100', align: 'center', baseline: 'middle', maxWidth: 270,
    });
  }

  private paintCharacter() {
    const byId = new Map((this.viewModel.equipment ?? []).map((slot) => [slot.id, slot]));
    for (const layout of CHARACTER_EQUIPMENT_LAYOUT) {
      const slot = byId.get(layout.id) ?? { id: layout.id, label: layout.label };
      this.paintSlot(layout, slot);
      this.hits.push({ kind: 'slot', key: `slot:${layout.id}`, rect: layout.rect, slot });
    }
    this.paintStats();
    this.paintRotationButtons();
  }

  /** CharacterModelFrame.xml: two 35x35 model rotation buttons at 65,78. */
  private paintRotationButtons() {
    const buttons = [
      { direction: 'left' as const, x: 65, art: 'Left' },
      { direction: 'right' as const, x: 100, art: 'Right' },
    ];
    for (const button of buttons) {
      const key = `rotate:${button.direction}`;
      const down = this.pressedKey === key;
      this.surface.image(`/ui/Interface/Buttons/UI-Rotation${button.art}-Button-${down ? 'Down' : 'Up'}.png`, button.x, 78, 35, 35);
      if (this.hoveredKey === key) this.surface.addImage('/ui/Interface/Buttons/ButtonHilight-Round.png', button.x + 1, 79, 33, 33, 0.8);
      this.hits.push({ kind: 'rotate', key, rect: { x: button.x, y: 78, width: 35, height: 35 }, direction: button.direction });
    }
  }

  private paintSlot(layout: CharacterEquipmentLayout, slot: CharacterEquipmentSlotView) {
    const { x, y, width, height } = layout.rect;
    const key = `slot:${layout.id}`;
    this.surface.image(`${DOLL}/${layout.texture}.png`, x, y, width, height);
    if (slot.iconUrl) {
      const inset = width < 32 ? 2 : 3;
      this.surface.image(slot.iconUrl, x + inset, y + inset, width - inset * 2, height - inset * 2, slot.disabled ? 0.45 : 1);
      if (isBuiltInAddonEnabled('itemTools')) {
        const quality = Math.max(0, Math.min(QUALITY_COLORS.length - 1, slot.quality ?? 1));
        const ctx = this.surface.ctx;
        ctx.save();
        ctx.strokeStyle = QUALITY_COLORS[quality];
        ctx.globalAlpha = 0.85;
        ctx.strokeRect(x + 1.5, y + 1.5, width - 3, height - 3);
        ctx.restore();
      }
    }
    if (slot.count && slot.count > 1) this.surface.text(String(slot.count), x + width - 3, y + height - 2, {
      font: 'number', family: 'sans', size: width < 32 ? 9 : 11, color: '#ffffff', align: 'right', baseline: 'bottom',
    });
    if (slot.maxDurability && slot.durability !== undefined) {
      const pct = Math.max(0, Math.min(1, slot.durability / slot.maxDurability));
      const barHeight = Math.max(1, Math.round((height - 6) * pct));
      const ctx = this.surface.ctx;
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,.9)';
      ctx.fillRect(x + width - 4, y + 3, 2, height - 6);
      ctx.fillStyle = pct <= 0.2 ? '#ff2020' : pct <= 0.5 ? '#ffd100' : '#31c43b';
      ctx.fillRect(x + width - 4, y + height - 3 - barHeight, 2, barHeight);
      ctx.restore();
    }
    const ctx = this.surface.ctx;
    if (this.hoveredKey === key) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,.18)';
      ctx.fillRect(x + 2, y + 2, width - 4, height - 4);
      ctx.strokeStyle = '#fff8c5';
      ctx.strokeRect(x + 1.5, y + 1.5, width - 3, height - 3);
      ctx.restore();
    }
    if (this.pressedKey === key) {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,.38)';
      ctx.fillRect(x + 2, y + 2, width - 4, height - 4);
      ctx.restore();
    }
  }

  private paintStats() {
    const columns = this.viewModel.statColumns;
    if (!columns) return;
    [73, 189].forEach((x, column) => columns[column].slice(0, 6).forEach((row, index) => {
      const y = 300 + index * 13;
      this.surface.text(row.label, x, y, { size: 10, color: row.color ?? '#ffd100', baseline: 'middle', maxWidth: 70 });
      this.surface.text(String(row.value ?? '-'), x + 98, y, {
        size: 10, color: row.valueColor ?? '#ffffff', align: 'right', baseline: 'middle', maxWidth: 48,
      });
    }));
  }

  private paintSubpage(page?: CharacterSubpageView) {
    if (this.tab === 'honor' && paintHonorPage(this.surface, page)) return;
    const heading = page?.heading ?? TABS.find(([tab]) => tab === this.tab)?.[1] ?? '';
    this.surface.text(heading, 184, 83, { size: 15, color: '#ffd100', align: 'center', baseline: 'middle', maxWidth: 270 });
    const sections = page?.sections ?? [];
    if (!sections.length) {
      this.subpageMaxScroll = 0;
      this.surface.text(page?.emptyText ?? `No ${heading.toLowerCase()} data to display.`, 184, 130, {
        size: 12, color: '#c9b48c', align: 'center', baseline: 'middle', maxWidth: 260,
      });
      return;
    }
    let measuredHeight = 0;
    for (const section of sections) {
      if (section.title) measuredHeight += 17;
      measuredHeight += (section.rows?.length ?? 0) * 16;
      for (const line of section.lines ?? []) measuredHeight += this.surface.wrapText(line, 265, { size: 11 }).length * 15;
      measuredHeight += 6;
    }
    this.subpageMaxScroll = Math.max(0, measuredHeight - 306);
    const scroll = Math.max(0, Math.min(this.subpageMaxScroll, this.pageScroll[this.tab] ?? 0));
    this.pageScroll[this.tab] = scroll;
    const ctx = this.surface.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(40, 101, 288, 316);
    ctx.clip();
    let y = 111 - scroll;
    for (const section of sections) {
      if (section.title) {
        this.surface.text(section.title, 48, y, { size: 12, color: '#ffd100', baseline: 'middle', maxWidth: 270 });
        y += 17;
      }
      for (const row of section.rows ?? []) {
        this.surface.text(row.label, 49, y, { size: 11, color: row.color ?? '#ffd100', baseline: 'middle', maxWidth: 174 });
        if (row.value !== undefined) this.surface.text(String(row.value), 318, y, {
          size: 11, color: row.valueColor ?? '#ffffff', align: 'right', baseline: 'middle', maxWidth: 104,
        });
        y += 16;
      }
      for (const line of section.lines ?? []) for (const wrapped of this.surface.wrapText(line, 265, { size: 11 })) {
        this.surface.text(wrapped, 49, y, { size: 11, color: '#f8deb1', baseline: 'middle', maxWidth: 265 });
        y += 15;
      }
      y += 6;
    }
    ctx.restore();
    if (this.subpageMaxScroll > 0) this.paintSubpageScroll(scroll);
  }

  private paintSubpageScroll(scroll: number) {
    const upDisabled = scroll <= 0;
    const downDisabled = scroll >= this.subpageMaxScroll;
    const upKey = 'scroll:up';
    const downKey = 'scroll:down';
    const button = '/ui/Interface/Buttons';
    const stateName = (key: string, disabled: boolean) => disabled ? 'Disabled' : this.pressedKey === key ? 'Down' : 'Up';
    this.surface.image(`${button}/UI-ScrollBar-ScrollUpButton-${stateName(upKey, upDisabled)}.png`, 322, 96, 32, 32);
    this.surface.image(`${button}/UI-ScrollBar-ScrollDownButton-${stateName(downKey, downDisabled)}.png`, 322, 385, 32, 32);
    if (this.hoveredKey === upKey && !upDisabled) this.surface.addImage(`${button}/UI-ScrollBar-ScrollUpButton-Highlight.png`, 322, 96, 32, 32);
    if (this.hoveredKey === downKey && !downDisabled) this.surface.addImage(`${button}/UI-ScrollBar-ScrollDownButton-Highlight.png`, 322, 385, 32, 32);
    const knobY = 126 + (252 * scroll) / Math.max(1, this.subpageMaxScroll);
    this.surface.sprite(`${button}/UI-ScrollBar-Knob.png`, 8, 6, 16, 20, 330, knobY, 16, 24);
    this.hits.push({ kind: 'scroll', key: upKey, rect: { x: 326, y: 100, width: 24, height: 24 }, direction: -1, disabled: upDisabled });
    this.hits.push({ kind: 'scroll', key: downKey, rect: { x: 326, y: 389, width: 24, height: 24 }, direction: 1, disabled: downDisabled });
  }

  private paintTabs() {
    const disabled = new Set(this.viewModel.disabledTabs ?? []);
    TABS.forEach(([tab, label], index) => {
      const rect = tabRect(index);
      const isDisabled = disabled.has(tab);
      const active = tab === this.tab;
      const key = `tab:${tab}`;
      this.surface.image(`${INFO}/UI-Character-${active ? 'Active' : 'Inactive'}Tab.png`, rect.x, rect.y, rect.width, rect.height, isDisabled ? 0.5 : 1);
      if (!isDisabled && this.hoveredKey === key) this.surface.addImage(`${INFO}/UI-Character-Tab-Highlight.png`, rect.x, rect.y, rect.width, rect.height, 0.85);
      this.surface.text(label, rect.x + rect.width / 2, rect.y + 17 + (this.pressedKey === key ? 1 : 0), {
        size: 9, align: 'center', baseline: 'middle', color: isDisabled ? '#77736b' : active ? '#fff1bd' : '#ffd100', maxWidth: rect.width - 12,
      });
      this.hits.push({ kind: 'tab', key, rect, tab, disabled: isDisabled });
    });
  }

  private paintClose() {
    this.surface.closeButton(CLOSE_RECT.x, CLOSE_RECT.y, this.pressedKey === 'close' ? 'down' : this.hoveredKey === 'close' ? 'hover' : 'normal');
    this.hits.push({ kind: 'close', key: 'close', rect: CLOSE_RECT });
  }

  private hitAt(point: CanvasPoint) {
    // Later tabs paint over the 14px overlap, so reverse order for hit testing.
    return [...this.hits].reverse().find((hit) => containsPoint(hit.rect, point));
  }

  private handleMove(event: PointerEvent) {
    const point = this.surface.point(event);
    const hit = this.hitAt(point);
    const slot = hit?.kind === 'slot' ? hit.slot : undefined;
    if (this.hoveredSlot !== slot) this.callbacks.onSlotHover?.(slot, point);
    if (this.hoveredKey !== hit?.key) {
      this.hoveredKey = hit?.key;
      this.hoveredSlot = slot;
      this.surface.canvas.style.cursor = hit && !(hit.kind === 'tab' && hit.disabled) ? 'pointer' : 'default';
      this.surface.requestRender();
    }
  }

  private handleLeave() {
    if (this.hoveredSlot) this.callbacks.onSlotHover?.(undefined, { x: -1, y: -1 });
    this.hoveredKey = undefined;
    this.hoveredSlot = undefined;
    this.surface.canvas.style.cursor = 'default';
    this.clearPressed();
  }

  private handleDown(event: PointerEvent) {
    const point = this.surface.point(event);
    const hit = this.hitAt(point);
    // Preserve the FrameXML title bar as a drag handle. The host's drag
    // installer receives this event; non-header blank parchment stays opaque.
    if (!hit && point.y <= 64) return;
    event.preventDefault();
    event.stopPropagation();
    if (!hit || (hit.kind === 'tab' && hit.disabled) || (hit.kind === 'scroll' && hit.disabled) || (hit.kind === 'slot' && hit.slot.disabled)) return;
    this.surface.canvas.focus({ preventScroll: true });
    this.surface.canvas.setPointerCapture(event.pointerId);
    this.pressedKey = hit.key;
    this.surface.requestRender();
  }

  private handleUp(event: PointerEvent) {
    const hit = this.hitAt(this.surface.point(event));
    const pressed = this.pressedKey;
    this.clearPressed();
    if (this.surface.canvas.hasPointerCapture(event.pointerId)) this.surface.canvas.releasePointerCapture(event.pointerId);
    if (!hit || hit.key !== pressed || (hit.kind === 'tab' && hit.disabled) || (hit.kind === 'scroll' && hit.disabled) || (hit.kind === 'slot' && hit.slot.disabled)) return;
    event.preventDefault();
    event.stopPropagation();
    if (hit.kind === 'close') this.callbacks.onClose?.();
    else if (hit.kind === 'tab') this.activateTab(hit.tab);
    else if (hit.kind === 'rotate') this.callbacks.onRotate?.(hit.direction);
    else if (hit.kind === 'slot') this.callbacks.onSlotClick?.(hit.slot, event);
    else this.scrollSubpage(hit.direction * 48);
  }

  private handleWheel(event: WheelEvent) {
    if (this.tab === 'character' || !this.subpageMaxScroll) return;
    event.preventDefault();
    event.stopPropagation();
    this.scrollSubpage(event.deltaY > 0 ? 48 : -48);
  }

  private scrollSubpage(delta: number) {
    this.pageScroll[this.tab] = Math.max(0, Math.min(this.subpageMaxScroll, (this.pageScroll[this.tab] ?? 0) + delta));
    this.surface.requestRender();
  }

  private handleKey(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.callbacks.onClose?.();
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const enabled = TABS.map(([tab]) => tab).filter((tab) => !(this.viewModel.disabledTabs ?? []).includes(tab));
    const current = Math.max(0, enabled.indexOf(this.tab));
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    this.activateTab(enabled[(current + delta + enabled.length) % enabled.length]);
  }

  private activateTab(tab: CharTab) {
    if (tab === this.tab) return;
    this.tab = tab;
    this.callbacks.onTabChange?.(tab);
    this.surface.requestRender();
  }

  private clearPressed() {
    if (!this.pressedKey) return;
    this.pressedKey = undefined;
    this.surface.requestRender();
  }
}
