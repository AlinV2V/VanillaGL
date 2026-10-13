/** Asset conversion utility. */
import { containsPoint, ensureVanillaFonts, VanillaCanvas, type CanvasPoint, type CanvasRect } from './vanilla-canvas';
import { parseChatEscapes, type ChatSegment } from './chat-escape-codes';

/**
 * Break coloured runs across lines at word boundaries, preserving each run's colour.
 *
 * `VanillaCanvas.wrapText` handles a single string; a chat line is a sequence of differently
 * coloured runs that must flow as one paragraph, so the wrap has to span them.
 */
function wrapSegments(
  surface: VanillaCanvas,
  segments: readonly ChatSegment[],
  maxWidth: number,
  font: { size: number },
): ChatSegment[][] {
  const rows: ChatSegment[][] = [];
  let row: ChatSegment[] = [];
  let used = 0;
  for (const segment of segments) {
    // Keep the separators so spacing survives the round trip.
    for (const word of segment.text.split(/(\s+)/)) {
      if (!word) continue;
      const advance = surface.measureText(word, font);
      if (used + advance > maxWidth && used > 0) {
        rows.push(row);
        row = [];
        used = 0;
        if (/^\s+$/.test(word)) continue; // never start a wrapped row with the break's whitespace
      }
      const last = row[row.length - 1];
      if (last && last.color === segment.color) last.text += word;
      else row.push({ text: word, color: segment.color });
      used += advance;
    }
  }
  if (row.length) rows.push(row);
  return rows.length ? rows : [[]];
}

const UI = '/ui/Interface';
const CHAT = `${UI}/ChatFrame`;

/** ChatFrame.xml:4 — ScrollingMessageFrame maxLines. */
export const CHAT_MAX_LINES = 128;
export const CHAT_FRAME_WIDTH = 430;
export const CHAT_FRAME_HEIGHT = 120;
const TAB_HEIGHT = 32;
const TAB_CAP = 16;
const BUTTON = 32;
const EDIT_HEIGHT = 32;
const LINE_HEIGHT = 14;
const TEXT_INSET = 4;

/** Room the surface needs around the 430x120 frame for the tab strip, button column and edit box. */
const PAD_LEFT = BUTTON;
const PAD_TOP = TAB_HEIGHT;
const PAD_BOTTOM = EDIT_HEIGHT + 2;
export const CHAT_SURFACE_WIDTH = PAD_LEFT + CHAT_FRAME_WIDTH + 5;
export const CHAT_SURFACE_HEIGHT = PAD_TOP + CHAT_FRAME_HEIGHT + PAD_BOTTOM;
const FRAME_X = PAD_LEFT;
const FRAME_Y = PAD_TOP;

/**
 * ChatMenu — the popup behind the chat-bubble button.
 *
 * `ChatMenu_OnLoad` (ChatFrame.lua:2290-2302) adds exactly these ten, in this order, and every
 * label and slash string is verbatim from GlobalStrings.lua at the line noted. `ChatMenu` itself is
 * a `UIMenuTemplate` anchored BOTTOMLEFT@ChatFrameMenuButton TOPRIGHT (FloatingChatFrame.xml:772-774)
 * — a separate frame parented to UIParent, which is why it gets its own canvas here rather than
 * being drawn into the chat surface.
 *
 * Language and Voice Emote open submenus (LanguageMenu / VoiceMacroMenu) and Macro opens the macro
 * frame; they are listed so the menu is the right shape, and marked `submenu` so they read as
 * unavailable rather than silently doing nothing.
 */
export const CHAT_MENU_ITEMS: ReadonlyArray<{ label: string; slash?: string; type?: string; submenu?: boolean }> = [
  { label: 'Say', slash: '/s', type: 'SAY' },                 // SAY_MESSAGE:3389  SLASH_SAY1:3754
  { label: 'Party Chat', slash: '/p', type: 'PARTY' },        // PARTY_MESSAGE:2992 SLASH_PARTY1:3708
  { label: 'Guild Chat', slash: '/g', type: 'GUILD' },        // GUILD_MESSAGE:2084 SLASH_GUILD1:3596
  { label: 'Yell', slash: '/y', type: 'YELL' },               // YELL_MESSAGE:5462  SLASH_YELL1:3801
  { label: 'Whisper', slash: '/w', type: 'WHISPER' },         // WHISPER_MESSAGE:5435 SLASH_WHISPER1:3789
  { label: 'Emote', slash: '/e', type: 'EMOTE', submenu: true }, // EMOTE_MESSAGE:1431 SLASH_EMOTE1:3577
  { label: 'Reply', slash: '/r', type: 'REPLY' },             // REPLY_MESSAGE:3325  SLASH_REPLY1:3750
  { label: 'Language', submenu: true },                       // LANGUAGE:2540
  { label: 'Voice Emote', submenu: true },                    // VOICEMACRO_LABEL:5347
  { label: 'Macro', slash: '/macro', type: 'MACRO' },         // MACRO:2638 SLASH_MACRO1:3697
];

const MENU_ROW = 16;
const MENU_PAD = 10;
export const CHAT_MENU_WIDTH = 150;
export const CHAT_MENU_HEIGHT = CHAT_MENU_ITEMS.length * MENU_ROW + MENU_PAD * 2;

/** The popup, on its own surface so it can overhang the chat frame like the real one does. */
export class ChatMenuCanvas {
  readonly surface: VanillaCanvas;
  readonly canvas: HTMLCanvasElement;
  private hovered = -1;
  private onPick: (index: number) => void;

  constructor(onPick: (index: number) => void) {
    this.onPick = onPick;
    this.surface = new VanillaCanvas(CHAT_MENU_WIDTH, CHAT_MENU_HEIGHT, 'wow-chat-menu-canvas');
    this.canvas = this.surface.canvas;
    this.canvas.style.cssText = 'position:absolute;pointer-events:auto;display:none;';
    this.surface.onRender(() => this.paint());
    this.canvas.addEventListener('pointermove', (event) => {
      const index = this.rowAt(event);
      if (index === this.hovered) return;
      this.hovered = index;
      this.surface.requestRender();
    });
    this.canvas.addEventListener('pointerleave', () => { this.hovered = -1; this.surface.requestRender(); });
    this.canvas.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const index = this.rowAt(event);
      if (index >= 0) this.onPick(index);
    });
  }

  get open() { return this.canvas.style.display !== 'none'; }

  setOpen(open: boolean) {
    this.canvas.style.display = open ? 'block' : 'none';
    if (open) this.paint();
  }

  private rowAt(event: PointerEvent) {
    const point = this.surface.point(event);
    const index = Math.floor((point.y - MENU_PAD) / MENU_ROW);
    return index >= 0 && index < CHAT_MENU_ITEMS.length ? index : -1;
  }

  private paint() {
    const s = this.surface;
    const ctx = s.ctx;
    s.clear();
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.9)';
    ctx.fillRect(0, 0, CHAT_MENU_WIDTH, CHAT_MENU_HEIGHT);
    ctx.strokeStyle = '#5a4a2a';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, CHAT_MENU_WIDTH - 1, CHAT_MENU_HEIGHT - 1);
    ctx.restore();
    CHAT_MENU_ITEMS.forEach((item, index) => {
      const y = MENU_PAD + index * MENU_ROW + MENU_ROW / 2;
      const active = index === this.hovered;
      s.text(item.label, MENU_PAD, y, {
        size: 11, color: item.submenu ? '#8a8a8a' : active ? '#ffffff' : '#ffd100', baseline: 'middle',
      });
      if (item.slash) {
        s.text(item.slash, CHAT_MENU_WIDTH - MENU_PAD, y, { size: 11, color: '#808080', align: 'right', baseline: 'middle' });
      } else if (item.submenu) {
        s.text('>', CHAT_MENU_WIDTH - MENU_PAD, y, { size: 11, color: '#808080', align: 'right', baseline: 'middle' });
      }
    });
  }
}

export type ChatLine = { text: string; color?: string; tab: number };

export type ChatFrameTab = { id: number; name: string };

export type ChatFrameView = {
  tabs: readonly ChatFrameTab[];
  activeTab: number;
  lines: readonly ChatLine[];
  /** First visible line from the BOTTOM; 0 pins to the newest. */
  scrollOffset: number;
  editing: boolean;
  /** Dock tabs and side buttons fade away when the chat frame is inactive. */
  controlsVisible?: boolean;
  editText: string;
  /** "Say", "Guild", "/w Bob" — drawn in the edit box before the caret (ChatFrame.xml:61). */
  editHeader: string;
  /** `chatBackgroundAlpha`-equivalent; the docked frame is transparent until hovered in vanilla. */
  backgroundAlpha?: number;
};

export type ChatFrameTarget =
  | { kind: 'tab'; id: number }
  | { kind: 'scroll'; direction: 'up' | 'down' | 'bottom' }
  | { kind: 'menu' }
  | { kind: 'edit' }
  | { kind: 'messages' };

export type ChatFrameCallbacks = {
  onActivate?: (target: ChatFrameTarget) => void;
  onScrollWheel?: (delta: number) => void;
};

type Hit = { target: ChatFrameTarget; rect: CanvasRect };

const EMPTY: ChatFrameView = {
  tabs: [{ id: 1, name: 'General' }],
  activeTab: 1,
  lines: [],
  scrollOffset: 0,
  editing: false,
  editText: '',
  editHeader: 'Say',
};

/** ChatTabTemplate is 64 wide for a short name; vanilla grows the middle slice to fit the text. */
const tabWidth = (surface: VanillaCanvas, name: string) =>
  Math.max(64, Math.round(surface.measureText(name, { size: 12 }) + TAB_CAP * 2 + 8));

export class ChatFrameCanvas {
  readonly surface: VanillaCanvas;
  readonly canvas: HTMLCanvasElement;
  private view: ChatFrameView = EMPTY;
  private hits: Hit[] = [];
  private hover?: Hit;
  private callbacks: ChatFrameCallbacks;

  constructor(callbacks: ChatFrameCallbacks = {}, existingCanvas?: HTMLCanvasElement) {
    this.callbacks = callbacks;
    this.surface = new VanillaCanvas(CHAT_SURFACE_WIDTH, CHAT_SURFACE_HEIGHT, 'wow-chat-frame-canvas', existingCanvas);
    this.canvas = this.surface.canvas;
    this.canvas.style.pointerEvents = 'auto';
    this.canvas.style.display = 'block';
    this.surface.onRender(() => this.paint());
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerleave', this.onLeave);
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    void ensureVanillaFonts().then(() => this.surface.requestRender());
    // The frame repaints on chat events and hover, so a texture that finishes decoding AFTER the
    // first paint leaves a hole until something else happens to trigger a render — which is why the
    // tabs appeared only once the pointer touched the frame. Wait for the art, then repaint.
    for (const path of [`${CHAT}/ChatFrameTab.png`, `${CHAT}/UI-ChatIcon-Chat-Up.png`]) {
      const probe = new Image();
      probe.addEventListener('load', () => this.surface.requestRender(), { once: true });
      probe.src = path;
    }
    this.paint();
  }

  setView(view: ChatFrameView) {
    this.view = view;
    this.surface.requestRender();
  }

  getView() { return this.view; }
  requestRender() { this.surface.requestRender(); }
  targetAt(point: CanvasPoint) { return this.hitAt(point)?.target; }

  destroy() {
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerleave', this.onLeave);
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.remove();
  }

  /** Visible message rows, newest last — public so the host can clamp its own scroll offset. */
  visibleLineCount() { return Math.floor((CHAT_FRAME_HEIGHT - TEXT_INSET * 2) / LINE_HEIGHT); }

  paint() {
    const s = this.surface;
    this.hits = [];
    s.clear();
    this.drawBackground();
    if (this.view.controlsVisible) this.drawTabs();
    this.drawButtons();
    this.drawMessages();
    this.drawEditBox();
  }

  private drawBackground() {
    const alpha = this.view.backgroundAlpha ?? 0;
    if (alpha > 0) {
      const ctx = this.surface.ctx;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#000000';
      ctx.fillRect(FRAME_X, FRAME_Y, CHAT_FRAME_WIDTH, CHAT_FRAME_HEIGHT);
      ctx.restore();
    }
    this.hits.push({
      target: { kind: 'messages' },
      rect: { x: FRAME_X, y: FRAME_Y, width: CHAT_FRAME_WIDTH, height: CHAT_FRAME_HEIGHT },
    });
  }

  /** Three-sliced ChatFrameTab, one per docked window, sitting on top of the frame. */
  private drawTabs() {
    const s = this.surface;
    let x = FRAME_X;
    const y = FRAME_Y - TAB_HEIGHT + 2; // BOTTOMLEFT (0, 2) against the frame's top edge
    for (const tab of this.view.tabs) {
      const width = tabWidth(s, tab.name);
      // FloatingChatFrame.lua:1068-1078 — the SELECTED dock frame's tab is alpha 1.0 and every
      // other tab is 0.5. Hover lifts an unselected tab toward full, which is the fade at :884-887.
      const active = tab.id === this.view.activeTab;
      const hovered = this.hover?.target.kind === 'tab' && this.hover.target.id === tab.id;
      const alpha = active ? 1 : hovered ? 1 : 0.5;
      // `chatTab:SetAlpha()` fades the whole frame, LABEL INCLUDED — so the text has to sit under
      // the same alpha, not be drawn opaque on top of a faded plate.
      const ctx = s.ctx;
      ctx.save();
      ctx.globalAlpha = alpha;
      s.spriteFraction(`${CHAT}/ChatFrameTab.png`, 0, 0, 0.25, 1, x, y, TAB_CAP, TAB_HEIGHT);
      s.spriteFraction(`${CHAT}/ChatFrameTab.png`, 0.25, 0, 0.75, 1, x + TAB_CAP, y, width - TAB_CAP * 2, TAB_HEIGHT);
      s.spriteFraction(`${CHAT}/ChatFrameTab.png`, 0.75, 0, 1, 1, x + width - TAB_CAP, y, TAB_CAP, TAB_HEIGHT);
      s.text(tab.name, x + width / 2, y + TAB_HEIGHT / 2 + 1, {
        size: 12, color: active ? '#ffd100' : '#c0c0c0', align: 'center', baseline: 'middle',
      });
      ctx.restore();
      this.hits.push({ target: { kind: 'tab', id: tab.id }, rect: { x, y, width, height: TAB_HEIGHT } });
      x += width;
    }
  }

  /** Bottom-up stack on the frame's left edge: Bottom, Down, Up, Menu. */
  private drawButtons() {
    const x = FRAME_X - BUTTON;
    const bottomY = FRAME_Y + CHAT_FRAME_HEIGHT - BUTTON + 4;
    const atBottom = this.view.scrollOffset <= 0;
    const stack: Array<{ target: ChatFrameTarget; art: string; y: number; disabled: boolean }> = [
      { target: { kind: 'scroll', direction: 'bottom' }, art: 'UI-ChatIcon-ScrollEnd', y: bottomY, disabled: atBottom },
      { target: { kind: 'scroll', direction: 'down' }, art: 'UI-ChatIcon-ScrollDown', y: bottomY - BUTTON - 2, disabled: atBottom },
      { target: { kind: 'scroll', direction: 'up' }, art: 'UI-ChatIcon-ScrollUp', y: bottomY - (BUTTON + 2) - BUTTON, disabled: false },
      { target: { kind: 'menu' }, art: 'UI-ChatIcon-Chat', y: bottomY - (BUTTON + 2) - BUTTON * 2, disabled: false },
    ];
    for (const entry of stack) {
      const key = this.hover?.target;
      const hovered = key?.kind === entry.target.kind
        && (key.kind !== 'scroll' || key.direction === (entry.target as { direction?: string }).direction);
      const suffix = entry.disabled ? 'Disabled' : hovered ? 'Down' : 'Up';
      this.surface.image(`${CHAT}/${entry.art}-${suffix}.png`, x, entry.y, BUTTON, BUTTON);
      this.hits.push({ target: entry.target, rect: { x, y: entry.y, width: BUTTON, height: BUTTON } });
    }
  }

  /**
   * Messages, newest at the bottom.
   *
   * Two things this has to get right that a naive draw does not:
   *  - `|cAARRGGBB`/`|r`/`|H..|h` markup is parsed into coloured runs. The server really does send
   *    it — the vMaNGOS GM summon-cap alert is wrapped in `LANG_GM_ANNOUNCE_COLOR` — and printing
   *    the raw codes is what made that line look like garbage.
   *  - Long lines WRAP. Passing `maxWidth` to `fillText` does not clip or wrap, it horizontally
   *    CONDENSES the glyphs, which is why one long alert rendered as unreadable microtext.
   */
  private drawMessages() {
    const width = CHAT_FRAME_WIDTH - TEXT_INSET * 2;
    const font = { size: 12 } as const;
    const lines = this.view.lines.filter((line) => line.tab === this.view.activeTab);

    // Expand each message into its wrapped rows first, so scrolling counts rendered rows.
    const rendered: ChatSegment[][] = [];
    for (const line of lines) {
      const segments = parseChatEscapes(line.text, line.color ?? '#ffffff');
      for (const row of wrapSegments(this.surface, segments, width, font)) rendered.push(row);
    }

    const rows = this.visibleLineCount();
    const end = Math.max(0, rendered.length - this.view.scrollOffset);
    const start = Math.max(0, end - rows);
    const visible = rendered.slice(start, end);
    let y = FRAME_Y + CHAT_FRAME_HEIGHT - TEXT_INSET - (visible.length - 1) * LINE_HEIGHT - LINE_HEIGHT / 2;
    for (const row of visible) {
      let x = FRAME_X + TEXT_INSET;
      for (const segment of row) {
        this.surface.text(segment.text, x, y, { ...font, color: segment.color ?? '#ffffff', baseline: 'middle' });
        x += this.surface.measureText(segment.text, font);
      }
      y += LINE_HEIGHT;
    }
  }

  /** Rendered row count for the active tab, so the host can clamp scrolling to real rows. */
  wrappedRowCount(lines: readonly ChatLine[], tab: number) {
    const width = CHAT_FRAME_WIDTH - TEXT_INSET * 2;
    let total = 0;
    for (const line of lines) {
      if (line.tab !== tab) continue;
      total += wrapSegments(this.surface, parseChatEscapes(line.text, line.color), width, { size: 12 }).length;
    }
    return total;
  }

  /** Only drawn while typing — vanilla hides ChatFrameEditBox until a chat key opens it. */
  private drawEditBox() {
    if (!this.view.editing) return;
    const s = this.surface;
    const x = FRAME_X - 5;
    const width = CHAT_FRAME_WIDTH + 10;
    const y = FRAME_Y + CHAT_FRAME_HEIGHT + 2;
    // Left cap is a full 256-wide plate; clamp it when the box is narrower than the art.
    const leftWidth = Math.min(256, width - TAB_CAP);
    s.sprite(`${CHAT}/UI-ChatInputBorder-Left.png`, 0, 0, (leftWidth / 256) * 256, 32, x, y, leftWidth, EDIT_HEIGHT);
    s.spriteFraction(`${CHAT}/UI-ChatInputBorder-Right.png`, 0, 0, 0.9375, 1,
      x + leftWidth, y, Math.max(0, width - leftWidth - TAB_CAP), EDIT_HEIGHT);
    s.spriteFraction(`${CHAT}/UI-ChatInputBorder-Right.png`, 0.9375, 0, 1, 1,
      x + width - TAB_CAP, y, TAB_CAP, EDIT_HEIGHT);

    const headerX = x + 13;
    const header = this.view.editHeader ? `${this.view.editHeader}: ` : '';
    let cursorX = headerX;
    if (header) {
      s.text(header, headerX, y + EDIT_HEIGHT / 2, { size: 12, color: '#ffd100', baseline: 'middle' });
      cursorX += s.measureText(header, { size: 12 });
    }
    s.text(this.view.editText, cursorX, y + EDIT_HEIGHT / 2, { size: 12, color: '#ffffff', baseline: 'middle' });
    const caretX = cursorX + s.measureText(this.view.editText, { size: 12 }) + 1;
    if (Math.floor(performance.now() / 530) % 2 === 0) {
      const ctx = s.ctx;
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(caretX, y + 8, 1, 16);
      ctx.restore();
    }
    this.hits.push({ target: { kind: 'edit' }, rect: { x, y, width, height: EDIT_HEIGHT } });
  }

  private hitAt(point: CanvasPoint) {
    for (let index = this.hits.length - 1; index >= 0; index--) {
      if (containsPoint(this.hits[index].rect, point)) return this.hits[index];
    }
    return undefined;
  }

  private onMove = (event: PointerEvent) => {
    const hit = this.hitAt(this.surface.point(event));
    // Compare the WHOLE target, not just `kind`: sliding from one tab to the next is two hits of
    // kind 'tab', and comparing kinds alone left the highlight stuck on the first one.
    if (JSON.stringify(hit?.target) === JSON.stringify(this.hover?.target)) return;
    this.hover = hit;
    this.surface.requestRender();
  };

  private onLeave = () => {
    if (!this.hover) return;
    this.hover = undefined;
    this.surface.requestRender();
  };

  private onDown = (event: PointerEvent) => {
    const hit = this.hitAt(this.surface.point(event));
    if (!hit || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.callbacks.onActivate?.(hit.target);
    this.surface.requestRender();
  };

  private onWheel = (event: WheelEvent) => {
    const point = this.surface.pointFromClient(event.clientX, event.clientY);
    if (!this.hitAt(point)) return;
    event.preventDefault();
    this.callbacks.onScrollWheel?.(event.deltaY > 0 ? -1 : 1);
  };
}
