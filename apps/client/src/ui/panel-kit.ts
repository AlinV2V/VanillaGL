/** Asset conversion utility. */
import { getGameTooltip, type TooltipLine } from './game-tooltip';
import {
  containsPoint,
  ensureVanillaFonts,
  VanillaCanvas,
  type CanvasRect,
} from './vanilla-canvas';

export const QUALITY_COLORS = ['#9d9d9d', '#ffffff', '#1eff00', '#0070dd', '#a335ee', '#ff8000', '#e6cc80'] as const;
export const qualityColor = (quality: number | undefined) =>
  QUALITY_COLORS[Math.max(0, Math.min(6, quality ?? 1))];

export const UI_GOLD = '#ffd100';
export const UI_WHITE = '#ffffff';
export const UI_DESC = '#fff1bd';
export const UI_GRAY = '#77736b';
export const UI_GREEN = '#1eff00';
export const UI_RED = '#e60b0b';
/** Quest/gossip body text — GameFontBlack on parchment. */
export const UI_INK = '#181818';

export { drawMoney, formatMoneyText, splitMoney } from './money';

export type ItemButtonOptions = {
  iconUrl?: string;
  /** Art shown when no icon (engraved paper-doll slots, empty bank slots). */
  emptyUrl?: string;
  count?: number;
  hover?: boolean;
  pushed?: boolean;
  disabled?: boolean;
  /** Green stock text (vendor limited supply), drawn top-left like $parentStock. */
  stock?: number;
};

/** ItemButtonTemplate: 37x37 icon, 64x64 UI-Quickslot2 ring centered, ADD highlight. */
export const drawItemButton = (s: VanillaCanvas, x: number, y: number, size: number, options: ItemButtonOptions = {}) => {
  const ring = Math.round(size * 64 / 37);
  const ringOffset = Math.round((ring - size) / 2);
  const art = options.iconUrl ?? options.emptyUrl ?? '/ui/Interface/Buttons/UI-EmptySlot.png';
  if (options.iconUrl || options.emptyUrl) {
    s.image(art, x, y, size, size, options.disabled ? 0.4 : 1);
  } else {
    s.image(art, x - ringOffset, y - ringOffset, ring, ring);
  }
  if (options.pushed) {
    s.image('/ui/Interface/Buttons/UI-Quickslot-Depress.png', x, y, size, size);
  } else {
    s.image('/ui/Interface/Buttons/UI-Quickslot2.png', x - ringOffset, y - ringOffset, ring, ring);
  }
  if (options.hover && !options.disabled) {
    s.addImage('/ui/Interface/Buttons/ButtonHilight-Square.png', x, y, size, size, 0.9);
  }
  if (options.count !== undefined && options.count > 1) {
    s.text(String(options.count), x + size - 2, y + size - 4, { size: 13, font: 'number', color: '#ffffff', align: 'right' });
  }
  if (options.stock !== undefined && options.stock >= 0) {
    s.text(String(options.stock), x + 2, y + 8, { size: 11, font: 'number', color: '#e6e600' });
  }
};

/**
 * QuestItemTemplate reward banner: 39x39 icon + UI-QuestItemNameFrame plate with
 * the item name in quality color. Total footprint 147x41.
 */
export const drawQuestItemBanner = (
  s: VanillaCanvas,
  x: number,
  y: number,
  options: { iconUrl?: string; name: string; count?: number; quality?: number; hover?: boolean; fallback?: string },
) => {
  s.image('/ui/Interface/QuestFrame/UI-QuestItemNameFrame.png', x + 29, y - 12, 128, 64);
  drawItemButton(s, x + 1, y + 1, 37, { iconUrl: options.iconUrl, count: options.count, hover: options.hover });
  if (!options.iconUrl && options.fallback) {
    s.text(options.fallback, x + 19, y + 24, { size: 12, align: 'center', color: '#ffffff' });
  }
  const name = options.name + (options.count && options.count > 1 ? ` x${options.count}` : '');
  const lines = s.wrapText(name, 88, { size: 11 });
  const startY = y + 21 - (lines.length - 1) * 6;
  lines.slice(0, 2).forEach((line, index) => {
    s.text(line, x + 46, startY + index * 12, { size: 11, color: qualityColor(options.quality), maxWidth: 92 });
  });
  if (options.hover) s.addImage('/ui/Interface/QuestFrame/UI-QuestItemHighlight.png', x - 4, y - 6, 152, 52, 0.7);
};

/**
 * InputBoxTemplate (UIPanelTemplates.xml:221-259): a three-slice of the 128x32
 * `Interface\Common\Common-Input-Border`, whose used region is the top 20 rows
 * (TexCoords bottom = 0.625). Left and Right are 8px caps taken from x 0..8 and 120..128
 * (TexCoords 0..0.0625 and 0.9375..1.0); the Middle stretches x 8..120 between them.
 *
 * `focused` paints the caret. Vanilla EditBoxes show a solid bar; it blinks on a 1s cycle,
 * which is what the phase argument reproduces without needing a timer inside the widget.
 */
export const drawInputBox = (
  s: VanillaCanvas,
  x: number,
  y: number,
  width: number,
  value: string,
  options: { focused?: boolean; size?: number; color?: string; placeholder?: string } = {},
) => {
  const BORDER = '/ui/Interface/Common/Common-Input-Border.png';
  const H = 20;
  s.sprite(BORDER, 0, 0, 8, 20, x, y, 8, H);
  s.sprite(BORDER, 8, 0, 112, 20, x + 8, y, Math.max(0, width - 16), H);
  s.sprite(BORDER, 120, 0, 8, 20, x + width - 8, y, 8, H);
  const size = options.size ?? 12;
  const inset = 6;
  const text = value || (options.focused ? '' : options.placeholder ?? '');
  const dim = !value && !!options.placeholder && !options.focused;
  if (text) {
    s.text(text, x + inset, y + H / 2, {
      size, color: dim ? UI_GRAY : options.color ?? UI_WHITE,
      baseline: 'middle', maxWidth: width - inset * 2,
    });
  }
  if (options.focused && Math.floor(performance.now() / 500) % 2 === 0) {
    const caretX = x + inset + s.measureText(value, { size });
    s.text('|', Math.min(caretX, x + width - inset), y + H / 2, { size, color: UI_WHITE, baseline: 'middle' });
  }
  return H;
};

/**
 * MoneyInputFrameTemplate (MoneyInputFrame.xml): 176x18 overall, three numeric EditBoxes —
 * gold 68 wide (8 letters), silver 30 (2 letters), copper 30 (2 letters) — each chained
 * LEFT@previous.RIGHT and each a Common-Input-Border three-slice. The coin icons come from the
 * same UI-MoneyIcons cells `drawMoney` uses.
 *
 * Registers `${id}:gold` / `${id}:silver` / `${id}:copper` hits. Returns the total width drawn.
 */
export const drawMoneyInput = (
  panel: { surface: VanillaCanvas; hit: (id: string, rect: CanvasRect, extra?: Omit<PanelHit, 'id' | 'rect'>) => void },
  id: string,
  x: number,
  y: number,
  parts: { gold: number; silver: number; copper: number },
  focusedField?: string,
) => {
  const s = panel.surface;
  const MONEY_ICONS = '/ui/Interface/MoneyFrame/UI-MoneyIcons.png';
  const fields: Array<{ key: 'gold' | 'silver' | 'copper'; width: number; cell: number }> = [
    { key: 'gold', width: 68, cell: 0 },
    { key: 'silver', width: 30, cell: 16 },
    { key: 'copper', width: 30, cell: 32 },
  ];
  let cursor = x;
  for (const field of fields) {
    const full = `${id}:${field.key}`;
    drawInputBox(s, cursor, y, field.width, String(parts[field.key]), {
      focused: focusedField === full, size: 12,
    });
    // The coin sits inside the box against its right edge, as in MoneyInputFrame.
    s.sprite(MONEY_ICONS, field.cell, 0, 16, 16, cursor + field.width - 16, y + 3, 13, 13);
    panel.hit(full, { x: cursor, y, width: field.width, height: 20 });
    cursor += field.width;
  }
  return cursor - x;
};

export type PanelHit = {
  id: string;
  rect: CanvasRect;
  data?: unknown;
  tooltip?: TooltipLine[] | (() => TooltipLine[] | undefined);
  disabled?: boolean;
  /** Suppress the pressed/hover treatment (static rows). */
  silent?: boolean;
};

/**
 * Base class for pixel-space panels: owns the surface, pointer plumbing,
 * hover/pressed hit states and canvas tooltip display. Subclasses implement
 * paint() (which registers hits via this.hit) and activate(hit).
 */
export abstract class CanvasPanel {
  readonly surface: VanillaCanvas;
  protected hits: PanelHit[] = [];
  protected hover?: PanelHit;
  protected pressed?: PanelHit;

  constructor(private readonly panelHost: HTMLElement, width: number, height: number, className: string, private readonly kit: { playUi?: (name: string) => unknown } = {}) {
    this.surface = new VanillaCanvas(width, height, className);
    panelHost.appendChild(this.surface.canvas);
    this.surface.onRender(() => {
      this.hits = [];
      this.paint();
    });
    const canvas = this.surface.canvas;
    canvas.addEventListener('pointermove', (event) => this.handleMove(event));
    canvas.addEventListener('pointerleave', () => {
      this.hover = undefined;
      getGameTooltip().hide();
      this.surface.requestRender();
    });
    canvas.addEventListener('pointerdown', (event) => this.handleDown(event));
    canvas.addEventListener('pointerup', (event) => this.handleUp(event));
    canvas.addEventListener('pointercancel', (event) => this.handleCancel(event));
    canvas.addEventListener('wheel', (event) => {
      if (!this.onWheel) return;
      event.preventDefault();
      this.onWheel(Math.sign(event.deltaY), this.surface.point(event as unknown as PointerEvent));
    }, { passive: false });
    // Canvas-native text entry, the same way character-frame-canvas.ts does it: the element is
    // focusable so it receives keys, and the UA focus ring is suppressed because the panel paints
    // its own cue (the EditBox caret). Vanilla EditBoxes live inside the frame; overlaying an HTML
    // <input> would break pixel-space layout and the frame's own font/art.
    canvas.tabIndex = 0;
    canvas.style.outline = 'none';
    canvas.addEventListener('keydown', (event) => this.handleFieldKey(event));
    void ensureVanillaFonts().then(() => this.surface.requestRender());
  }

  protected abstract paint(): void;
  protected abstract activate(hit: PanelHit, event?: PointerEvent): void;
  protected acceptsPointerButton(button: number): boolean { return button === 0; }
  protected onWheel?: (direction: number, point: { x: number; y: number }) => void;
  /** Continuous interaction while the pointer is held on a hit (sliders). */
  protected onDrag?: (hit: PanelHit, point: { x: number; y: number }) => void;

  protected playUi(name: string) { this.kit.playUi?.(name); }

  /**
   * The EditBox that currently owns the keyboard, or undefined. Panels set it from `activate()`
   * via `focusField` and read it when painting so `drawInputBox` knows where to put the caret.
   */
  protected focusedField?: string;

  /**
   * Called for every accepted keystroke while a field is focused. `char` is a single printable
   * character, or undefined for the named editing keys. Panels override this to mutate their own
   * state; returning nothing is fine, the surface is re-rendered either way.
   */
  protected onFieldKey?: (field: string, key: 'char' | 'backspace' | 'enter' | 'escape' | 'tab', char?: string) => void;

  /** Give a named EditBox the keyboard and pull DOM focus onto the canvas so keys arrive. */
  protected focusField(field: string | undefined) {
    this.focusedField = field;
    if (field) this.surface.canvas.focus();
    this.surface.requestRender();
  }

  private handleFieldKey(event: KeyboardEvent) {
    const field = this.focusedField;
    if (!field || !this.onFieldKey) return;
    // Everything below is consumed by the EditBox, so it must not also reach the world input
    // handlers — an unstopped 'w' in a search box would walk the character forward.
    if (event.key === 'Backspace') { this.onFieldKey(field, 'backspace'); }
    else if (event.key === 'Enter') { this.onFieldKey(field, 'enter'); }
    else if (event.key === 'Escape') { this.onFieldKey(field, 'escape'); }
    else if (event.key === 'Tab') { this.onFieldKey(field, 'tab'); }
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) { this.onFieldKey(field, 'char', event.key); }
    else return;
    event.preventDefault();
    event.stopPropagation();
    this.surface.requestRender();
  }

  hit(id: string, rect: CanvasRect, extra: Omit<PanelHit, 'id' | 'rect'> = {}) {
    this.hits.push({ id, rect, ...extra });
  }

  /** Visual state for a hit id ('slot:3') or id prefix group ('slot:'). */
  state(id: string): 'normal' | 'hover' | 'down' | 'disabled' {
    const matches = (hit?: PanelHit) => !!hit && (hit.id === id || (id.endsWith(':') && hit.id.startsWith(id)));
    if (matches(this.pressed)) return this.pressed?.disabled ? 'disabled' : 'down';
    if (matches(this.hover)) return this.hover?.disabled ? 'disabled' : 'hover';
    return 'normal';
  }

  protected isHover(id: string) { return this.hover?.id === id; }
  protected isPressed(id: string) { return this.pressed?.id === id; }

  private hitAt(event: PointerEvent) {
    const point = this.surface.point(event);
    // Later hits are painted later (on top); resolve topmost first.
    for (let index = this.hits.length - 1; index >= 0; index--) {
      if (containsPoint(this.hits[index].rect, point)) return this.hits[index];
    }
    return undefined;
  }

  private handleMove(event: PointerEvent) {
    if (this.pressed && this.onDrag) {
      this.onDrag(this.pressed, this.surface.point(event));
      return;
    }
    const previous = this.hover;
    this.hover = this.hitAt(event);
    const lines = typeof this.hover?.tooltip === 'function' ? this.hover.tooltip() : this.hover?.tooltip;
    if (lines?.length) getGameTooltip().show(lines, event.clientX, event.clientY);
    else getGameTooltip().hide();
    if (previous?.id !== this.hover?.id || previous?.data !== this.hover?.data) this.surface.requestRender();
  }

  private handleDown(event: PointerEvent) {
    if (!this.acceptsPointerButton(event.button)) return;
    const point = this.surface.point(event);
    const hit = this.hitAt(event);
    // FrameXML panels drag from unused title-bar chrome. Let that narrow region
    // bubble to installDraggableFrames; all other blank canvas remains opaque to
    // world input. Interactive close/tab buttons still win their own hit tests.
    if (!hit && this.panelHost.dataset.frameId && point.y <= 64) {
      this.pressed = undefined;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.pressed = hit;
    if (this.pressed && !this.pressed.silent) {
      if (this.onDrag) {
        this.surface.canvas.setPointerCapture(event.pointerId);
        this.onDrag(this.pressed, this.surface.point(event));
      }
    }
    this.surface.requestRender();
  }

  private handleUp(event: PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.acceptsPointerButton(event.button)) return;
    const hit = this.hitAt(event);
    const pressed = this.pressed;
    this.pressed = undefined;
    if (this.surface.canvas.hasPointerCapture(event.pointerId)) this.surface.canvas.releasePointerCapture(event.pointerId);
    if (!hit || !pressed || hit.id !== pressed.id) {
      this.surface.requestRender();
      return;
    }
    if (!hit.disabled) this.activate(hit, event);
    this.surface.requestRender();
  }

  private handleCancel(event: PointerEvent) {
    this.pressed = undefined;
    if (this.surface.canvas.hasPointerCapture(event.pointerId)) this.surface.canvas.releasePointerCapture(event.pointerId);
    this.surface.requestRender();
  }
}

/**
 * UIPanelScrollBar: up/down arrow buttons (16px) with a proportional knob.
 * Registers `${id}:up` / `${id}:down` hits on the panel; wheel handling is the
 * panel's responsibility. Returns nothing — purely visual + hit registration.
 */
export const drawScrollBar = (
  panel: { surface: VanillaCanvas; hit: (id: string, rect: CanvasRect, extra?: Omit<PanelHit, 'id' | 'rect'>) => void; state: (id: string) => 'normal' | 'hover' | 'down' | 'disabled' },
  id: string,
  x: number,
  y: number,
  height: number,
  offset: number,
  maxOffset: number,
) => {
  const s = panel.surface;
  const arrows = '/ui/Interface/Buttons';
  const upState = offset <= 0 ? 'Disabled' : panel.state(`${id}:up`) === 'down' ? 'Down' : 'Up';
  const downState = offset >= maxOffset ? 'Disabled' : panel.state(`${id}:down`) === 'down' ? 'Down' : 'Up';
  s.image(`${arrows}/UI-ScrollBar-ScrollUpButton-${upState}.png`, x - 8, y - 8, 32, 32);
  s.image(`${arrows}/UI-ScrollBar-ScrollDownButton-${downState}.png`, x - 8, y + height - 24, 32, 32);
  if (panel.state(`${id}:up`) === 'hover' && offset > 0) s.addImage(`${arrows}/UI-ScrollBar-ScrollUpButton-Highlight.png`, x - 8, y - 8, 32, 32);
  if (panel.state(`${id}:down`) === 'hover' && offset < maxOffset) s.addImage(`${arrows}/UI-ScrollBar-ScrollDownButton-Highlight.png`, x - 8, y + height - 24, 32, 32);
  const trackTop = y + 16;
  const trackHeight = height - 56;
  if (maxOffset > 0 && trackHeight > 0) {
    const knobY = trackTop + (trackHeight * offset) / maxOffset;
    s.sprite(`${arrows}/UI-ScrollBar-Knob.png`, 8, 6, 16, 20, x, knobY, 16, 24);
  }
  panel.hit(`${id}:up`, { x: x - 4, y: y - 4, width: 24, height: 24 }, { disabled: offset <= 0 });
  panel.hit(`${id}:down`, { x: x - 4, y: y + height - 20, width: 24, height: 24 }, { disabled: offset >= maxOffset });
};
