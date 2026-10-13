/** Asset conversion utility. */
import {
  containsPoint,
  ensureVanillaFonts,
  VanillaCanvas,
  type CanvasPoint,
  type CanvasRect,
} from './vanilla-canvas';
import { hudViewModelSignature } from './hud-frame-cadence'; import { isBuiltInAddonEnabled } from './builtin-addons';
import { drawCharacterMicroPortrait } from './main-menu-portrait';
import { registerCursorDropZone } from './cursor-drop-router';
import {
  MULTI_BAR_IDS,
  multiBarButtonRects,
  NO_MULTI_BARS,
  type MultiBarId,
  type MultiBarVisibility,
} from './multi-action-bars';

export const MAIN_MENU_BAR_WIDTH = 1216;
export const MAIN_MENU_BAR_HEIGHT = 173;
export const MAIN_MENU_BAR_ART_X = 96;
export const MAIN_MENU_BAR_ART_Y = 109;

const BAR_WIDTH = 1024;
/**
 * Where the bar art's VISIBLE metal sits inside its 64-row BLP section.
 *
 * Measured on `UI-MainMenuBar-Human.png`: each 256x64 section is transparent above row 9 and opaque
 * through row 63. The XML frame `MainMenuBar` is only 53 tall, so anything the XML anchors to the
 * bar's bottom edge has to be placed against row 63 of the drawn art, not against the cell.
 */
const BAR_ART_OPAQUE_BOTTOM = 63;
const ACTION_SIZE = 36;
const ACTION_STRIDE = 42;
const BAG_SIZE = 37;
const BAG_STRIDE = 42;

const UI = '/ui/Interface';
const MAIN_MENU = `${UI}/MainMenuBar`;
const BUTTONS = `${UI}/Buttons`;

export * from './main-menu-bar-model';
import type {
  MainMenuActionView,
  MainMenuBagView,
  MainMenuBarCallbacks,
  MainMenuBarTarget,
  MainMenuBarViewModel,
  MainMenuMicroButton,
} from './main-menu-bar-model';

type MainMenuHit = {
  target: MainMenuBarTarget;
  rect: CanvasRect;
  disabled?: boolean;
};

const MICRO_BUTTON_DRAW_W = 32;
const MICRO_BUTTON_DRAW_H = 64;

const MICRO_ORDER: readonly MainMenuMicroButton[] = [
  'character', 'spellbook', 'talents', 'quest', 'socials', 'world', 'mainmenu', 'help',
];

const MICRO_TEXTURES: Record<MainMenuMicroButton, string> = {
  character: 'UI-MicroButtonCharacter',
  spellbook: 'UI-MicroButton-Spellbook',
  talents: 'UI-MicroButton-Talents',
  quest: 'UI-MicroButton-Quest',
  socials: 'UI-MicroButton-Socials',
  world: 'UI-MicroButton-World',
  mainmenu: 'UI-MicroButton-MainMenu',
  help: 'UI-MicroButton-Help',
};

const EMPTY_VIEW: MainMenuBarViewModel = {
  experience: { current: 0, maximum: 1 },
  actionPage: 1,
  actions: [],
};

const targetKey = (target: MainMenuBarTarget | undefined) => {
  if (!target) return '';
  switch (target.kind) {
    case 'experience': return 'experience';
    case 'action': return `action:${target.bar ?? 'main'}:${target.slot}`;
    case 'shapeshift': return `shapeshift:${target.slot}`;
    case 'page': return `page:${target.direction}`;
    case 'micro': return `micro:${target.id}`;
    case 'bag': return `bag:${target.bagId}`;
    case 'keyring': return 'keyring';
    case 'latency': return 'latency';
  }
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

/**
 * How far the pointer must travel while held before a press becomes a drag.
 *
 * Chosen, not measured — the client's own threshold is inside the unreversed input path. It only
 * has to be large enough that the hand-jitter of a normal click cannot cross it and small enough
 * that a deliberate drag feels immediate; a 36px button gives plenty of room either way.
 */
const DRAG_THRESHOLD_PX = 5;

/**
 * A single interactive canvas. The backing store stays at original FrameXML
 * pixels while CSS may scale it; VanillaCanvas.point keeps hit testing exact.
 */
export class MainMenuBarCanvas {
  readonly surface: VanillaCanvas;
  readonly canvas: HTMLCanvasElement;

  private model: MainMenuBarViewModel = EMPTY_VIEW;
  private modelSignature: string | number = '';
  private callbacks: MainMenuBarCallbacks;
  private hits: MainMenuHit[] = [];
  private hover?: MainMenuHit;
  private pressed?: MainMenuHit;
  /** Where the current press began, for the drag threshold. */
  private pressOrigin?: CanvasPoint;
  /** A drag is in flight: the release is a drop, not a click. */
  private dragging = false;
  private keyboardIndex = -1;
  private readonly unregisterDropZone: () => void;

  constructor(callbacks: MainMenuBarCallbacks = {}, existingCanvas?: HTMLCanvasElement) {
    this.callbacks = callbacks;
    this.surface = new VanillaCanvas(
      MAIN_MENU_BAR_WIDTH,
      MAIN_MENU_BAR_HEIGHT,
      'wow-main-menu-bar-canvas',
      existingCanvas,
    );
    this.canvas = this.surface.canvas;
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'toolbar');
    this.canvas.setAttribute('aria-label', 'Main action bar');
    this.canvas.style.outline = 'none'; // canvas paints its own focus cues
    this.canvas.style.display = 'block';
    this.canvas.style.touchAction = 'none';
    this.canvas.style.userSelect = 'none';
    this.canvas.style.pointerEvents = 'auto';

    this.surface.onRender(() => this.paint());
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerleave', this.handlePointerLeave);
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointerup', this.handlePointerUp);
    this.canvas.addEventListener('pointercancel', this.handlePointerCancel);
    this.canvas.addEventListener('contextmenu', this.handleContextMenu);
    this.canvas.addEventListener('keydown', this.handleKeyDown);
    this.canvas.addEventListener('blur', this.handleBlur);
    // A drag that began on another panel (spellbook, bags) releases against THAT panel's pointer
    // capture, so the bar can only receive it through the router.
    this.unregisterDropZone = registerCursorDropZone({
      element: this.canvas,
      onDrop: (clientX, clientY) => {
        const hit = this.hitAt(this.surface.pointFromClient(clientX, clientY));
        // Deliberately NOT filtered on `hit.disabled`. An empty action slot is disabled because
        // there is nothing to cast, yet it is the single most common thing a player drags a spell
        // onto — rejecting it here made "drag from the spellbook" silently do nothing. What a given
        // target accepts is the host's decision, in onDrop.
        if (!hit) return false;
        this.callbacks.onDrop?.(hit.target);
        this.surface.requestRender();
        return true;
      },
    });
    void ensureVanillaFonts().then(() => this.surface.requestRender());
    this.paint();
  }

  setCallbacks(callbacks: MainMenuBarCallbacks) {
    this.callbacks = callbacks;
  }

  setViewModel(model: MainMenuBarViewModel) {
    const signature = hudViewModelSignature(model);
    if (signature === this.modelSignature) return;
    this.model = model;
    this.modelSignature = signature;
    this.surface.requestRender();
  }

  getViewModel() { return this.model; }

  requestRender() { this.surface.requestRender(); }

  /** Semantic hit testing is public for drag/drop bridges and tooltip routing. */
  targetAt(point: CanvasPoint) {
    return this.hitAt(point)?.target;
  }

  /** Current logical rectangle for a semantic target, if it is visible. */
  rectFor(target: MainMenuBarTarget) {
    return this.hits.find((hit) => targetKey(hit.target) === targetKey(target))?.rect;
  }

  destroy() {
    this.unregisterDropZone();
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerCancel);
    this.canvas.removeEventListener('contextmenu', this.handleContextMenu);
    this.canvas.removeEventListener('keydown', this.handleKeyDown);
    this.canvas.removeEventListener('blur', this.handleBlur);
    this.canvas.remove();
  }

  private paint() {
    const s = this.surface;
    this.hits = [];
    s.clear();
    this.drawEndCaps();
    this.drawBarArt();
    this.drawExperience();
    this.drawShapeshiftBar();
    this.drawMultiBars();
    this.drawActions();
    this.drawPageControls();
    this.drawMicroButtons();
    this.drawPerformanceBar();
    this.drawBags();
    this.drawKeyring();
    this.drawKeyboardFocus();
  }

  private skinName() {
    const skin = this.model.skin ?? 'dwarf';
    if (skin === 'night-elf') return 'NightElf';
    return skin === 'human' ? 'Human' : 'Dwarf';
  }

  private drawEndCaps() {
    if (this.model.showEndCaps === false) return;
    const endCapSkin = this.model.skin === 'dwarf' || !this.model.skin ? 'Dwarf' : 'Human';
    const path = `${MAIN_MENU}/UI-MainMenuBar-EndCap-${endCapSkin}.png`;
    this.surface.image(path, 0, 0, 128, 128);
    const ctx = this.surface.ctx;
    ctx.save();
    ctx.translate(MAIN_MENU_BAR_WIDTH, 0);
    ctx.scale(-1, 1);
    this.surface.image(path, 0, 0, 128, 128);
    ctx.restore();
  }

  /** The 256x256 BLP is four reversed 256x64 horizontal sections. */
  private drawBarArt() {
    const path = `${MAIN_MENU}/UI-MainMenuBar-${this.skinName()}.png`;
    for (let section = 0; section < 4; section++) {
      this.surface.sprite(
        path,
        0,
        (3 - section) * 64,
        256,
        64,
        MAIN_MENU_BAR_ART_X + section * 256,
        MAIN_MENU_BAR_ART_Y,
        256,
        64,
      );
    }
    if (this.model.keyring?.visible) {
      const keyring = `${MAIN_MENU}/UI-MainMenuBar-KeyRing.png`;
      // MainMenuBar_UpdateKeyRing replaces Texture2/3 with these exact 43px atlas crops.
      this.surface.spriteFraction(keyring, 0, 0.6640625, 1, 1, MAIN_MENU_BAR_ART_X + 512, MAIN_MENU_BAR_ART_Y + 21, 256, 43);
      this.surface.spriteFraction(keyring, 0, 0.1640625, 1, 0.5, MAIN_MENU_BAR_ART_X + 768, MAIN_MENU_BAR_ART_Y + 21, 256, 43);
    }
  }

  private drawExperience() {
    const { current, maximum, restedBonus = 0, atMaxLevel, displayText } = this.model.experience;
    // The bar art's XP groove interior spans art rows 13..20 with 5px end caps
    // (measured off UI-MainMenuBar-*: border rows 11-12/21-22, ticks every 51px).
    const rect = { x: MAIN_MENU_BAR_ART_X + 5, y: MAIN_MENU_BAR_ART_Y + 13, width: BAR_WIDTH - 10, height: 8 };
    this.hits.push({ target: { kind: 'experience' }, rect });
    const max = Math.max(1, maximum);
    const currentRatio = clamp01(current / max);
    const restedRatio = clamp01((current + Math.max(0, restedBonus)) / max);

    const ctx = this.surface.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width * restedRatio, rect.height);
    ctx.clip();
    ctx.fillStyle = '#0758ba';
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    // SetStatusBarColor multiplies UI-StatusBar; source-over alpha washed #94008c into lavender.
    ctx.globalCompositeOperation = 'multiply'; this.surface.image(`${UI}/TargetingFrame/UI-StatusBar.png`, rect.x, rect.y, rect.width, rect.height);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width * currentRatio, rect.height);
    ctx.clip();
    ctx.fillStyle = restedBonus > 0 ? '#006be0' : '#94008c';
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.globalCompositeOperation = 'multiply'; this.surface.image(`${UI}/TargetingFrame/UI-StatusBar.png`, rect.x, rect.y, rect.width, rect.height);
    ctx.restore();
    if (atMaxLevel) {
      this.surface.image(`${MAIN_MENU}/UI-MainMenuBar-MaxLevel.png`, rect.x, rect.y - 2, rect.width, 12);
    } else {
      const text = displayText ?? `${Math.max(0, current)} / ${Math.max(0, maximum)}`;
      this.surface.text(text, rect.x + rect.width / 2, rect.y + rect.height / 2, {
        family: 'sans', font: 'number', size: 9, color: '#ffffff', align: 'center', baseline: 'middle',
      });
    }
  }

  /** Canvas rect of main-bar ActionButton1 — the anchor MultiActionBars.xml hangs the bars off. */
  private actionButton1Rect(): CanvasRect {
    return {
      x: MAIN_MENU_BAR_ART_X + 8,
      y: MAIN_MENU_BAR_ART_Y + 24,
      width: ACTION_SIZE,
      height: ACTION_SIZE,
    };
  }

  private drawActions() {
    const bySlot = new Map(this.model.actions.map((action) => [action.slot, action]));
    const anchor = this.actionButton1Rect();
    for (let slot = 0; slot < 12; slot++) {
      this.drawActionButton(bySlot.get(slot), {
        x: anchor.x + slot * ACTION_STRIDE,
        y: anchor.y,
        width: ACTION_SIZE,
        height: ACTION_SIZE,
      }, { kind: 'action', slot });
    }
  }

  /**
   * The two horizontal extra bars, drawn with the same button art as the main row.
   *
   * A hidden bar contributes no hits at all, so its slots cannot be clicked or dropped onto —
   * matching `MultiBarBottomLeft:Hide()` in MultiActionBars.lua:55.
   */
  private drawMultiBars() {
    const multi = this.model.multiBars;
    if (!multi) return;
    const anchor = this.actionButton1Rect();
    for (const id of MULTI_BAR_IDS) {
      if (!multi.visible[id]) continue;
      const views = multi.actions[id] ?? [];
      const bySlot = new Map(views.map((action) => [action.slot, action]));
      multiBarButtonRects(id, anchor).forEach((rect, slot) => {
        this.drawActionButton(bySlot.get(slot), rect, { kind: 'action', slot, bar: id });
      });
    }
  }

  /** Build-5875 ShapeshiftBarFrame.xml: 30px buttons, 7px pitch, anchored above MainMenuBar. */
  private drawShapeshiftBar() {
    const forms = this.model.shapeshiftForms?.slice(0, 10) ?? [];
    if (!forms.length) return;
    const raised = this.model.multiBars?.visible.bottomLeft ?? false;
    const frameX = MAIN_MENU_BAR_ART_X + 30;
    const frameBottom = MAIN_MENU_BAR_ART_Y + 10 - (raised ? 45 : 0);
    if (!raised) {
      const artY = frameBottom - 50;
      const ends = `${UI}/ShapeshiftBar/ShapeshiftBarEnds.png`;
      this.surface.spriteFraction(ends, 0, 0, 0.453125, 1, frameX, artY, 45, 50);
      if (forms.length === 1) {
        this.surface.spriteFraction(ends, 0.453125, 0, 0.875, 1, frameX + 12, artY, 42, 50);
      } else {
        for (let index = 0; index < Math.max(0, forms.length - 2); index++) {
          this.surface.image(`${UI}/ShapeshiftBar/ShapeshiftBarMiddle.png`, frameX + 45 + index * 38, artY, 38, 50);
        }
        const rightX = frameX + 45 + Math.max(0, forms.length - 2) * 38;
        this.surface.spriteFraction(ends, 0.453125, 0, 0.875, 1, rightX, artY, 42, 50);
      }
    }
    forms.forEach((form, slot) => {
      this.drawActionButton({
        slot,
        iconUrl: form.iconUrl,
        enabled: true,
        usable: form.usable,
        activeAttack: form.active,
        cooldown: form.cooldown,
      }, {
        x: frameX + 11 + slot * 37,
        y: frameBottom - 33,
        width: 30,
        height: 30,
      }, { kind: 'shapeshift', slot }, raised ? 50 : 64);
    });
  }
  private drawActionButton(
    action: MainMenuActionView | undefined,
    rect: CanvasRect,
    target: MainMenuBarTarget,
    normalSize = 66,
  ) {
    const { x, y } = rect;
    const disabled = action?.enabled === false;
    const unusable = action?.usable === false;
    this.hits.push({ target, rect, disabled });
    const isHover = targetKey(this.hover?.target) === targetKey(target);
    const isPressed = targetKey(this.pressed?.target) === targetKey(target);

    if (action?.iconUrl) this.surface.image(action.iconUrl, x + 2, y + 2, rect.width - 4, rect.height - 4, disabled || unusable ? 0.42 : 1);
    const normalInset = (rect.width - normalSize) / 2;
    this.surface.image(`${BUTTONS}/UI-Quickslot2.png`, x + normalInset, y + normalInset, normalSize, normalSize, disabled ? 0.55 : 1);
    if (isPressed) this.surface.image(`${BUTTONS}/UI-Quickslot-Depress.png`, x + 2, y + 2, rect.width - 4, rect.height - 4);

    if (action?.outOfRange && action.iconUrl) {
      const ctx = this.surface.ctx;
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = 'rgba(185,20,20,.48)';
      ctx.fillRect(x + 2, y + 2, rect.width - 4, rect.height - 4);
      ctx.restore();
    }
    if (action?.cooldown && action.cooldown.durationMs > 0 && action.cooldown.remainingMs > 0) {
      this.drawCooldown(rect, action.cooldown.remainingMs / action.cooldown.durationMs);
      const seconds = Math.max(0, action.cooldown.remainingMs / 1000);
      const text = action.cooldown.text ?? (seconds >= 1 ? String(Math.ceil(seconds)) : '');
      if (text && isBuiltInAddonEnabled('cooldownNumbers')) this.surface.text(text, x + rect.width / 2, y + rect.height / 2 + 2, {
        family: 'sans', font: 'number', size: 15, color: '#ffffff', align: 'center', baseline: 'middle',
      });
    }
    if (action?.count !== undefined && action.count > 1) {
      this.surface.text(String(action.count), x + 35, y + 34, {
        family: 'sans', font: 'number', size: 12, color: '#ffffff', align: 'right',
      });
    }
    if (action?.hotkey) {
      this.surface.text(action.hotkey, x + 35, y + 7, {
        family: 'sans', font: 'number', size: 10, color: '#ffffff', align: 'right',
      });
    }
    const dropState = action?.dropState ?? 'none';
    // Vanilla CheckButton semantics: hover = blue-white square, checked
    // (queued cast / active auto-attack) = gold CheckButtonHilight.
    if (action?.queued || action?.activeAttack || action?.reactive) {
      this.surface.addImage(`${BUTTONS}/CheckButtonHilight.png`, x + 2, y + 2, rect.width - 4, rect.height - 4, 0.95);
    }
    if (isHover || dropState === 'valid') {
      this.surface.addImage(`${BUTTONS}/ButtonHilight-SquareQuickslot.png`, x + normalInset, y + normalInset, normalSize, normalSize, 0.65);
    }
    if (dropState === 'invalid') this.drawInvalidDrop(rect);
  }

  private drawCooldown(rect: CanvasRect, fraction: number) {
    const amount = clamp01(fraction);
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const radius = Math.hypot(rect.width, rect.height);
    const start = -Math.PI / 2;
    const ctx = this.surface.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x + 2, rect.y + 2, rect.width - 4, rect.height - 4);
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, start, start + Math.PI * 2 * amount);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,.72)';
    ctx.fill();
    ctx.restore();
  }

  private drawInvalidDrop(rect: CanvasRect) {
    const ctx = this.surface.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(205,25,25,.9)';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#b00000';
    ctx.shadowBlur = 6;
    ctx.strokeRect(rect.x + 1, rect.y + 1, rect.width - 2, rect.height - 2);
    ctx.restore();
  }

  private drawPageControls() {
    // The whole control lives in the button tray (art rows 23+) so it never
    // covers the XP groove above; page number sits left of the arrow stack.
    const x = MAIN_MENU_BAR_ART_X + 512;
    const pageCount = Math.max(1, this.model.actionPageCount ?? 6);
    const upDisabled = this.model.actionPage >= pageCount;
    const downDisabled = this.model.actionPage <= 1;
    this.drawPageButton('up', { x, y: MAIN_MENU_BAR_ART_Y + 23, width: 26, height: 20 }, upDisabled);
    this.drawPageButton('down', { x, y: MAIN_MENU_BAR_ART_Y + 44, width: 26, height: 20 }, downDisabled);
    this.surface.text(String(Math.max(1, this.model.actionPage)), x - 5, MAIN_MENU_BAR_ART_Y + 44, {
      family: 'sans', size: 11, color: '#ffd100', align: 'right', baseline: 'middle',
    });
  }

  private drawPageButton(direction: 'up' | 'down', rect: CanvasRect, disabled: boolean) {
    const target: MainMenuBarTarget = { kind: 'page', direction };
    this.hits.push({ target, rect, disabled });
    const key = targetKey(target);
    const pressed = targetKey(this.pressed?.target) === key;
    const hover = targetKey(this.hover?.target) === key;
    const stem = direction === 'up' ? 'UI-MainMenu-ScrollUpButton' : 'UI-MainMenu-ScrollDownButton';
    const suffix = disabled ? 'Disabled' : pressed ? 'Down' : 'Up';
    this.surface.image(`${MAIN_MENU}/${stem}-${suffix}.png`, rect.x, rect.y - 3, 32, 32);
    if (hover && !disabled) this.surface.addImage(`${MAIN_MENU}/${stem}-Highlight.png`, rect.x, rect.y - 3, 32, 32, 0.85);
  }

  private drawMicroButtons() {
    const configured = new Map((this.model.microButtons ?? []).map((button) => [button.id, button]));
    MICRO_ORDER.forEach((id, index) => {
      const view = configured.get(id);
      const x = MAIN_MENU_BAR_ART_X + 552 + index * 26;
      const y = MAIN_MENU_BAR_ART_Y;
      const rect = { x: x + 2, y: y + 4, width: 28, height: 58 };
      const target: MainMenuBarTarget = { kind: 'micro', id };
      const disabled = view?.enabled === false;
      this.hits.push({ target, rect, disabled });
      const key = targetKey(target);
      const pressed = targetKey(this.pressed?.target) === key || view?.open;
      const hover = targetKey(this.hover?.target) === key;
      const suffix = pressed ? 'Down' : 'Up';
      const art = `${BUTTONS}/${MICRO_TEXTURES[id]}-${suffix}.png`;
      this.surface.image(art, x, y, MICRO_BUTTON_DRAW_W, MICRO_BUTTON_DRAW_H, disabled ? 0.42 : 1);
      if (id === 'character') drawCharacterMicroPortrait(this.surface, this.model.portraitSource, this.model.portraitUrl, x, y, !!pressed, disabled);
      if (hover && !disabled) {
        this.surface.addImage(`${BUTTONS}/UI-MicroButton-Hilight.png`, x, y, MICRO_BUTTON_DRAW_W, MICRO_BUTTON_DRAW_H, 0.78);
      }
    });
  }

  /**
   * MainMenuBarPerformanceBar — the vertical latency bar between the micro buttons and the bags.
   *
   * MainMenuBar.xml:344-354  MainMenuBarPerformanceBarFrame  16x64, BOTTOMRIGHT (-227, -10)
   * MainMenuBar.xml:357-364  texture UI-MainMenuBar-PerformanceBar 20x66 anchored TOPRIGHT
   * MainMenuBar.xml:369-387  PERFORMANCEBAR_LOW_LATENCY 300, MEDIUM 600; the texture is tinted
   *                          green below 300ms, yellow below 600ms, red above — SetVertexColor
   *                          (0,1,0) / (1,1,0) / (1,0,0) on a greyscale bar.
   */
  private drawPerformanceBar() {
    const latency = this.model.latencyMs;
    if (latency === undefined) return;
    // The frame is 16x64 anchored BOTTOMRIGHT of MainMenuBar at (-227, -10) — y is UP in FrameXML,
    // so its bottom hangs 10px BELOW the bar's bottom edge. The texture is 20x66 anchored TOPRIGHT
    // of that frame, i.e. it starts at the frame TOP and runs down past the frame's bottom.
    // `-10` hangs off the art's visible bottom (BAR_ART_OPAQUE_BOTTOM), not off the BLP cell; the
    // first attempt used the cell and pushed the whole bar ~8px above the artwork.
    const frameRight = MAIN_MENU_BAR_ART_X + BAR_WIDTH - (this.model.keyring?.visible ? 235 : 227);
    const frameTop = MAIN_MENU_BAR_ART_Y + BAR_ART_OPAQUE_BOTTOM + 10 - 64;
    this.hits.push({ target: { kind: 'latency' }, rect: { x: frameRight - 16, y: frameTop, width: 16, height: 64 } });
    const tint = latency > 600 ? '#ff0000' : latency > 300 ? '#ffff00' : '#00ff00';
    this.surface.tintedImage(`${MAIN_MENU}/UI-MainMenuBar-PerformanceBar.png`, tint, frameRight - 20, frameTop, 20, 66);
  }

  private drawBags() {
    const provided = this.model.bags ?? [];
    // CharacterBag3..0 run left-to-right; protocol bag 1 is the slot nearest the backpack.
    const equipped = provided.filter((bag) => !bag.isBackpack && bag.bagId !== 0).sort((a, b) => b.bagId - a.bagId);
    const backpack = provided.find((bag) => bag.isBackpack || bag.bagId === 0) ?? {
      bagId: 0, isBackpack: true, hasBag: true,
    };
    const bags: readonly MainMenuBagView[] = [...equipped.slice(0, 4), backpack];
    const padded: Array<MainMenuBagView | undefined> = Array.from({ length: 5 }, (_, index) => bags[index]);
    padded.forEach((bag, index) => {
      const x = MAIN_MENU_BAR_ART_X + 812 + index * BAG_STRIDE;
      const y = MAIN_MENU_BAR_ART_Y + 24;
      const rect = { x, y, width: BAG_SIZE, height: BAG_SIZE };
      if (!bag) {
        this.surface.image(`${BUTTONS}/UI-Quickslot2.png`, x - 14, y - 14, 64, 64, 0.6);
        this.surface.image(`${UI}/PaperDoll/UI-PaperDoll-Slot-Bag.png`, x, y, BAG_SIZE, BAG_SIZE, 0.5);
        return;
      }
      const target: MainMenuBarTarget = { kind: 'bag', bagId: bag.bagId };
      const disabled = bag.enabled === false || (!bag.isBackpack && bag.hasBag === false);
      this.hits.push({ target, rect, disabled });
      const key = targetKey(target);
      const hover = targetKey(this.hover?.target) === key;
      const pressed = targetKey(this.pressed?.target) === key;
      const defaultArt = bag.isBackpack
        ? `${BUTTONS}/Button-Backpack-Up.png`
        : `${UI}/PaperDoll/UI-PaperDoll-Slot-Bag.png`;
      this.surface.image(bag.iconUrl ?? defaultArt, x, y, BAG_SIZE, BAG_SIZE, disabled ? 0.42 : 1);
      this.surface.image(`${BUTTONS}/UI-Quickslot2.png`, x - 14, y - 14, 64, 64, disabled ? 0.5 : 1);
      if (pressed) this.surface.image(`${BUTTONS}/UI-Quickslot-Depress.png`, x + 2, y + 2, 33, 33);
      if (bag.count !== undefined && bag.count > 1) {
        this.surface.text(String(bag.count), x + 36, y + 35, {
          family: 'sans', font: 'number', size: 12, color: '#ffffff', align: 'right',
        });
      }
      if (bag.open) this.surface.addImage(`${BUTTONS}/CheckButtonHilight.png`, x + 2, y + 2, BAG_SIZE - 4, BAG_SIZE - 4, 0.95);
      if (hover || bag.dropState === 'valid') {
        this.surface.addImage(`${BUTTONS}/ButtonHilight-SquareQuickslot.png`, x - 14, y - 14, 64, 64, 0.65);
      }
      if (bag.dropState === 'invalid') this.drawInvalidDrop(rect);
    });
  }

  private drawKeyring() {
    const view = this.model.keyring;
    if (!view?.visible) return;
    // 18x39, RIGHT of CharacterBag3's LEFT by -5 (MainMenuBarBagButtons.xml:142-151).
    const rect = { x: MAIN_MENU_BAR_ART_X + 789, y: MAIN_MENU_BAR_ART_Y + 23, width: 18, height: 39 };
    const target: MainMenuBarTarget = { kind: 'keyring' };
    this.hits.push({ target, rect });
    const key = targetKey(target);
    const pressed = view.open || targetKey(this.pressed?.target) === key;
    const hover = targetKey(this.hover?.target) === key;
    const art = `${BUTTONS}/UI-Button-KeyRing${pressed ? '-Down' : ''}.png`;
    this.surface.sprite(art, 0, 0, 18, 39, rect.x, rect.y, rect.width, rect.height);
    if (hover || view.dropState === 'valid') {
      this.surface.sprite(`${BUTTONS}/UI-Button-KeyRing-Highlight.png`, 0, 0, 18, 39,
        rect.x, rect.y, rect.width, rect.height, { alpha: 0.9, blend: 'lighter' });
    }
    if (view.dropState === 'invalid') this.drawInvalidDrop(rect);
  }

  private drawKeyboardFocus() {
    if (document.activeElement !== this.canvas || this.keyboardIndex < 0) return;
    const hit = this.hits[this.keyboardIndex];
    if (!hit) return;
    const ctx = this.surface.ctx;
    ctx.save();
    ctx.strokeStyle = '#ffd100';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.strokeRect(hit.rect.x + 1.5, hit.rect.y + 1.5, hit.rect.width - 3, hit.rect.height - 3);
    ctx.restore();
  }

  private hitAt(point: CanvasPoint) {
    for (let index = this.hits.length - 1; index >= 0; index--) {
      if (containsPoint(this.hits[index].rect, point)) return this.hits[index];
    }
    return undefined;
  }

  private handlePointerMove = (event: PointerEvent) => {
    const point = this.surface.point(event);
    // OnDragStart. Vanilla action buttons are RegisterForDrag("LeftButton", "RightButton")
    // (ActionButton.lua:108) AND RegisterForClicks("LeftButtonUp", ...) (:109) — so holding and
    // moving lifts the action off the bar, while press-and-release uses it. Clearing `pressed` is
    // what stops the release from also firing onActivate on a button we just emptied.
    if (this.pressed && this.pressOrigin) {
      const moved = Math.hypot(point.x - this.pressOrigin.x, point.y - this.pressOrigin.y);
      if (moved > DRAG_THRESHOLD_PX) {
        const dragged = this.pressed;
        this.pressed = undefined;
        this.pressOrigin = undefined;
        this.dragging = true;
        this.callbacks.onDragStart?.(dragged.target, event);
        this.surface.requestRender();
      }
    }
    const hit = this.hitAt(point);
    const previous = targetKey(this.hover?.target);
    this.hover = hit;
    this.callbacks.onPointerMove?.(hit?.target, event);
    if (previous !== targetKey(hit?.target)) {
      this.callbacks.onHoverChange?.(hit?.target, event);
      this.surface.requestRender();
    }
  };

  private handlePointerLeave = (event: PointerEvent) => {
    if (!this.hover) return;
    this.hover = undefined;
    this.callbacks.onHoverChange?.(undefined, event);
    this.surface.requestRender();
  };

  private handlePointerDown = (event: PointerEvent) => {
    const hit = this.hitAt(this.surface.point(event));
    if (!hit || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.pressed = hit;
    this.pressOrigin = this.surface.point(event);
    this.keyboardIndex = this.hits.indexOf(hit);
    this.canvas.setPointerCapture(event.pointerId);
    if (!hit.disabled) this.callbacks.onPointerDown?.(hit.target, event);
    this.surface.requestRender();
  };

  private handlePointerUp = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const hit = this.hitAt(this.surface.point(event));
    const pressed = this.pressed;
    const dropping = this.dragging;
    this.dragging = false;
    // Ending a drag is OnReceiveDrag, never a click — and it must fire even with no hit under the
    // pointer, because releasing over nothing is how vanilla throws an action off the bar. Pointer
    // capture is what delivers that release here at all when it happens over the world.
    if (dropping) {
      event.preventDefault();
      event.stopPropagation();
      this.pressed = undefined;
      this.pressOrigin = undefined;
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      this.callbacks.onDrop?.(hit?.target, event);
      this.surface.requestRender();
      return;
    }
    if (!pressed && !hit) return;
    event.preventDefault();
    event.stopPropagation();
    this.pressed = undefined;
    this.pressOrigin = undefined;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.callbacks.onPointerUp?.(hit?.target, event);
    if (hit && pressed && !hit.disabled && targetKey(hit.target) === targetKey(pressed.target)) {
      this.callbacks.onActivate?.(hit.target, event);
    }
    this.surface.requestRender();
  };

  private handlePointerCancel = (event: PointerEvent) => {
    this.pressed = undefined;
    this.pressOrigin = undefined;
    this.dragging = false;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.surface.requestRender();
  };

  private handleContextMenu = (event: MouseEvent) => {
    const hit = this.hitAt(this.surface.point(event as unknown as PointerEvent));
    if (!hit || hit.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    this.callbacks.onContextMenu?.(hit.target, event);
  };

  private handleKeyDown = (event: KeyboardEvent) => {
    if (!this.hits.length) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      this.keyboardIndex = (this.keyboardIndex + 1 + this.hits.length) % this.hits.length;
      this.surface.requestRender();
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.keyboardIndex = (this.keyboardIndex - 1 + this.hits.length) % this.hits.length;
      this.surface.requestRender();
      return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const hit = this.hits[this.keyboardIndex];
    if (!hit || hit.disabled) return;
    event.preventDefault();
    this.callbacks.onActivate?.(hit.target, event);
  };

  private handleBlur = () => {
    this.keyboardIndex = -1;
    this.surface.requestRender();
  };
}
