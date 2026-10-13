import { resolveCachedCanvasImage, resolveMobileTintedCanvas } from './canvas-image-cache';

const pendingCanvasRenders = new Set<() => void>();
/** Immersive WebXR does not guarantee that window.requestAnimationFrame keeps ticking. */
export function flushCanvasRenders() {
  const callbacks = [...pendingCanvasRenders]; pendingCanvasRenders.clear();
  for (const callback of callbacks) callback();
}

export type CanvasPoint = { x: number; y: number };
export type CanvasRect = { x: number; y: number; width: number; height: number };

export type VanillaFontFamily = 'friz' | 'morpheus' | 'sans';

const FONT_STACKS: Record<VanillaFontFamily, string> = {
  friz: '"Friz Quadrata", "Times New Roman", serif',
  morpheus: '"Morpheus", "Times New Roman", serif',
  sans: 'Arial, Helvetica, sans-serif',
};

export type TextOptions = {
  size?: number;
  color?: string;
  align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline;
  shadow?: boolean;
  maxWidth?: number;
  font?: 'normal' | 'small' | 'number';
  family?: VanillaFontFamily;
};

export class VanillaCanvas {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  private renderCallback?: () => void;
  private queued = false;
  private readonly waitingImages = new Set<string>();
  private readonly imageSettled = (path: string) => { this.waitingImages.delete(path); this.requestRender(); };

  constructor(public width: number, public height: number, className: string, existingCanvas?: HTMLCanvasElement) {
    this.canvas = existingCanvas ?? document.createElement('canvas');
    this.canvas.className = className;
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is unavailable');
    this.ctx = ctx;
  }

  /** Resize both the backing store and logical coordinate space together. */
  resize(width: number, height: number) {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  onRender(callback: () => void) {
    this.renderCallback = callback;
  }

  requestRender() {
    if (this.queued) return;
    this.queued = true;
    const paint = () => {
      if (!this.queued) return;
      pendingCanvasRenders.delete(paint);
      this.queued = false;
      this.renderCallback?.();
    };
    pendingCanvasRenders.add(paint); requestAnimationFrame(paint);
  }

  clear() { this.ctx.clearRect(0, 0, this.width, this.height); }

  private resolveImage(path: string): HTMLImageElement | undefined {
    const image = resolveCachedCanvasImage(path, this.imageSettled);
    if (!image) this.waitingImages.add(path);
    return image;
  }

  image(path: string, x: number, y: number, width?: number, height?: number, alpha = 1) {
    const img = this.resolveImage(path);
    if (!img) return false;
    this.ctx.save();
    this.ctx.globalAlpha = alpha;
    this.ctx.drawImage(img, x, y, width ?? img.naturalWidth, height ?? img.naturalHeight);
    this.ctx.restore();
    return true;
  }

  /** Composite an already-rendered canvas/video/image into a FrameXML surface. */
  source(
    source: CanvasImageSource,
    x: number,
    y: number,
    width: number,
    height: number,
    options: { alpha?: number; circular?: boolean } = {},
  ) {
    this.ctx.save();
    this.ctx.globalAlpha = options.alpha ?? 1;
    if (options.circular) {
      this.ctx.beginPath();
      this.ctx.arc(x + width / 2, y + height / 2, Math.min(width, height) / 2, 0, Math.PI * 2);
      this.ctx.clip();
    }
    this.ctx.drawImage(source, x, y, width, height);
    this.ctx.restore();
    return true;
  }

  /** Tile a texture without stretching it (FrameXML backdrop bgFile behavior). */
  tile(path: string, x: number, y: number, width: number, height: number, alpha = 1) {
    const img = this.resolveImage(path);
    if (!img) return false;
    const pattern = this.ctx.createPattern(img, 'repeat');
    if (!pattern) return false;
    this.ctx.save();
    this.ctx.globalAlpha = alpha;
    this.ctx.translate(x, y);
    this.ctx.fillStyle = pattern;
    this.ctx.fillRect(0, 0, width, height);
    this.ctx.restore();
    return true;
  }

  /** Draw a sub-rectangle of a texture (FrameXML TexCoords equivalent, in texels). */
  sprite(
    path: string,
    sx: number, sy: number, sw: number, sh: number,
    dx: number, dy: number, dw: number, dh: number,
    options: { alpha?: number; blend?: GlobalCompositeOperation } = {},
  ) {
    const img = this.resolveImage(path);
    if (!img) return false;
    this.ctx.save();
    this.ctx.globalAlpha = options.alpha ?? 1;
    if (options.blend) this.ctx.globalCompositeOperation = options.blend;
    this.ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    this.ctx.restore();
    return true;
  }

  /**
   * Draw a sub-rectangle expressed the way FrameXML `<TexCoords>` are: fractions of the texture,
   * `left/top/right/bottom` in 0..1. Resolving against `naturalWidth/Height` means the caller does
   * not need to know the BLP's pixel size, which is what the XML relies on.
   */
  spriteFraction(
    path: string,
    left: number, top: number, right: number, bottom: number,
    dx: number, dy: number, dw: number, dh: number,
    options: { alpha?: number; blend?: GlobalCompositeOperation } = {},
  ) {
    const img = this.resolveImage(path);
    if (!img?.naturalWidth) return false;
    return this.sprite(
      path,
      left * img.naturalWidth,
      top * img.naturalHeight,
      (right - left) * img.naturalWidth,
      (bottom - top) * img.naturalHeight,
      dx, dy, dw, dh,
      options,
    );
  }

  /**
   * The canvas analogue of `Texture:SetVertexColor(r, g, b)` — multiply a flat colour through a
   * greyscale texture, keeping its alpha. Drawn on an offscreen buffer because `multiply` against
   * the live surface would pick up whatever is already painted underneath.
   */
  tintedImage(path: string, color: string, x: number, y: number, width: number, height: number, alpha = 1) {
    const img = this.resolveImage(path);
    if (!img?.naturalWidth) return false;
    const cachedTint = resolveMobileTintedCanvas(img, path, color);
    if (cachedTint) {
      this.ctx.save();
      this.ctx.globalAlpha = alpha;
      this.ctx.drawImage(cachedTint, x, y, width, height);
      this.ctx.restore();
      return true;
    }
    const buffer = document.createElement('canvas');
    buffer.width = Math.max(1, Math.round(width));
    buffer.height = Math.max(1, Math.round(height));
    const bctx = buffer.getContext('2d');
    if (!bctx) return false;
    bctx.drawImage(img, 0, 0, buffer.width, buffer.height);
    bctx.globalCompositeOperation = 'multiply';
    bctx.fillStyle = color;
    bctx.fillRect(0, 0, buffer.width, buffer.height);
    // Multiply ignores the source alpha, so restore the texture's own cutout.
    bctx.globalCompositeOperation = 'destination-in';
    bctx.drawImage(img, 0, 0, buffer.width, buffer.height);
    this.ctx.save();
    this.ctx.globalAlpha = alpha;
    this.ctx.drawImage(buffer, x, y, width, height);
    this.ctx.restore();
    return true;
  }

  /** Draw a texture sub-rectangle rotated 90 degrees clockwise. Backdrop edge
   * files store TOP/BOTTOM as vertical cells and the native UI rotates them. */
  spriteRotatedClockwise(
    path: string,
    sx: number, sy: number, sw: number, sh: number,
    dx: number, dy: number, dw: number, dh: number,
    alpha = 1,
  ) {
    const img = this.resolveImage(path);
    if (!img) return false;
    this.ctx.save();
    this.ctx.globalAlpha = alpha;
    this.ctx.translate(dx + dw / 2, dy + dh / 2);
    this.ctx.rotate(Math.PI / 2);
    this.ctx.drawImage(img, sx, sy, sw, sh, -dh / 2, -dw / 2, dh, dw);
    this.ctx.restore();
    return true;
  }

  /** Additive-blend highlight, the canvas analogue of alphaMode="ADD" textures. */
  addImage(path: string, x: number, y: number, width?: number, height?: number, alpha = 1) {
    const img = this.resolveImage(path);
    if (!img) return false;
    this.ctx.save();
    this.ctx.globalAlpha = alpha;
    this.ctx.globalCompositeOperation = 'lighter';
    this.ctx.drawImage(img, x, y, width ?? img.naturalWidth, height ?? img.naturalHeight);
    this.ctx.restore();
    return true;
  }

  fourSlice(base: string, names: [string, string, string, string]) {
    this.image(`${base}/${names[0]}.png`, 0, 0, 256, 256);
    this.image(`${base}/${names[1]}.png`, 256, 0, 128, 256);
    this.image(`${base}/${names[2]}.png`, 0, 256, 256, 256);
    this.image(`${base}/${names[3]}.png`, 256, 256, 128, 256);
  }

  private fontString(options: TextOptions) {
    const size = options.size ?? (options.font === 'small' ? 11 : 13);
    const family = FONT_STACKS[options.family ?? (options.font === 'number' ? 'sans' : 'friz')];
    return `${options.font === 'number' ? '700 ' : ''}${size}px ${family}`;
  }

  text(value: string, x: number, y: number, options: TextOptions = {}) {
    const { color = '#ffd100', align = 'left', baseline = 'alphabetic', shadow = true } = options;
    const ctx = this.ctx;
    ctx.save();
    ctx.font = this.fontString(options);
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    if (shadow) {
      ctx.fillStyle = 'rgba(0,0,0,.95)';
      ctx.fillText(value, x + 1, y + 1, options.maxWidth);
    }
    ctx.fillStyle = color;
    ctx.fillText(value, x, y, options.maxWidth);
    ctx.restore();
    return this;
  }

  measureText(value: string, options: TextOptions = {}) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = this.fontString(options);
    const width = ctx.measureText(value).width;
    ctx.restore();
    return width;
  }

  /** Greedy word wrap in the target font; explicit \n are respected. */
  wrapText(value: string, maxWidth: number, options: TextOptions = {}): string[] {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = this.fontString(options);
    const lines: string[] = [];
    for (const paragraph of value.split('\n')) {
      const words = paragraph.split(/\s+/).filter(Boolean);
      if (!words.length) { lines.push(''); continue; }
      let line = '';
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && ctx.measureText(candidate).width > maxWidth) {
          lines.push(line);
          line = word;
        } else {
          line = candidate;
        }
      }
      if (line) lines.push(line);
    }
    ctx.restore();
    return lines;
  }

  /**
   * Standard 1.12 red panel button. Art file is 128x32 but the button itself
   * occupies the top-left 80x22 (UIPanelButtonTemplate TexCoords 0..0.625 x 0..0.6875).
   */
  panelButton(label: string, rect: CanvasRect, state: 'normal' | 'hover' | 'down' | 'disabled' = 'normal') {
    const suffix = state === 'down' ? 'Down' : state === 'disabled' ? 'Disabled' : 'Up';
    this.sprite(`/ui/Interface/Buttons/UI-Panel-Button-${suffix}.png`, 0, 0, 80, 22, rect.x, rect.y, rect.width, rect.height);
    if (state === 'hover') {
      this.sprite('/ui/Interface/Buttons/UI-Panel-Button-Highlight.png', 0, 0, 80, 22, rect.x, rect.y, rect.width, rect.height, { blend: 'lighter' });
    }
    this.text(label, rect.x + rect.width / 2, rect.y + rect.height / 2 + (state === 'down' ? 2 : 1), {
      size: 12, color: state === 'disabled' ? '#77736b' : '#ffd100', align: 'center', baseline: 'middle',
    });
  }

  closeButton(x = 324, y = 9, state: 'normal' | 'hover' | 'down' = 'normal') {
    const suffix = state === 'down' ? 'Down' : 'Up';
    this.image(`/ui/Interface/Buttons/UI-Panel-MinimizeButton-${suffix}.png`, x, y, 32, 32);
    if (state === 'hover') this.addImage('/ui/Interface/Buttons/UI-Panel-MinimizeButton-Highlight.png', x, y, 32, 32);
  }

  point(event: PointerEvent): CanvasPoint {
    return this.pointFromClient(event.clientX, event.clientY);
  }

  /**
   * Same conversion from raw viewport coordinates. A drag that STARTED on another panel holds the
   * pointer capture, so its release never arrives here as an event — the drop router hands us bare
   * client coordinates instead (`ui/cursor-drop-router.ts`).
   */
  pointFromClient(clientX: number, clientY: number): CanvasPoint {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * this.width / Math.max(1, rect.width),
      y: (clientY - rect.top) * this.height / Math.max(1, rect.height),
    };
  }
}

export const containsPoint = (rect: CanvasRect, point: CanvasPoint) =>
  point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;

/**
 * FrameXML backdrop edge file: 8 equal cells in a horizontal strip, ordered
 * LEFT, RIGHT, TOP, BOTTOM, TOPLEFT, TOPRIGHT, BOTTOMLEFT, BOTTOMRIGHT.
 */
export type EdgeSpec = {
  edgeFile: string;
  /** Cell size in the strip (16 for tooltips, 32 for dialog boxes). */
  edgeSize: number;
  /** Drawn edge thickness; defaults to edgeSize. */
  drawSize?: number;
  backgroundFile?: string;
  backgroundInset?: number;
  backgroundAlpha?: number;
  /** Final RGB applied while retaining the backdrop texture's own alpha. */
  backgroundColor?: string;
};

export const TOOLTIP_EDGE: EdgeSpec = {
  edgeFile: '/ui/Interface/Tooltips/UI-Tooltip-Border.png',
  edgeSize: 16,
  backgroundFile: '/ui/Interface/Tooltips/UI-Tooltip-Background.png',
  backgroundInset: 5,
  // GameTooltip.lua: TOOLTIP_DEFAULT_BACKGROUND_COLOR = { .09, .09, .19 }.
  // The extracted greyscale texture is vertex-tinted by the native client.
  backgroundColor: '#0d0d1b',
};

export const DIALOG_EDGE: EdgeSpec = {
  edgeFile: '/ui/Interface/DialogFrame/UI-DialogBox-Border.png',
  edgeSize: 32,
  backgroundFile: '/ui/Interface/DialogFrame/UI-DialogBox-Background.png',
  backgroundInset: 11,
};

/** Draw a backdrop (tiled background + 8-slice border) in FrameXML's edge-file format. */
export const drawEdgedBox = (s: VanillaCanvas, rect: CanvasRect, spec: EdgeSpec) => {
  const size = spec.drawSize ?? spec.edgeSize;
  const cell = spec.edgeSize;
  const { x, y, width, height } = rect;
  if (spec.backgroundFile) {
    const inset = spec.backgroundInset ?? 4;
    const background = {
      x: x + inset,
      y: y + inset,
      width: Math.max(0, width - inset * 2),
      height: Math.max(0, height - inset * 2),
    };
    const tiled = s.tile(
      spec.backgroundFile,
      background.x,
      background.y,
      background.width,
      background.height,
      spec.backgroundAlpha ?? 1,
    );
    if (tiled && spec.backgroundColor) {
      // SetBackdropColor changes RGB without replacing the BLP's transparency.
      s.ctx.save();
      s.ctx.globalCompositeOperation = 'source-atop';
      s.ctx.fillStyle = spec.backgroundColor;
      s.ctx.fillRect(background.x, background.y, background.width, background.height);
      s.ctx.restore();
    }
  }
  const file = spec.edgeFile;
  const innerW = Math.max(0, width - size * 2);
  const innerH = Math.max(0, height - size * 2);
  // Edges: cells 0..3
  if (innerH > 0) {
    for (let offset = 0; offset < innerH; offset += size) {
      s.sprite(file, cell * 0, 0, cell, cell, x, y + size + offset, size, size);
      s.sprite(file, cell * 1, 0, cell, cell, x + width - size, y + size + offset, size, size);
    }
  }
  if (innerW > 0) {
    for (let offset = 0; offset < innerW; offset += size) {
      s.spriteRotatedClockwise(file, cell * 2, 0, cell, cell, x + size + offset, y, size, size);
      s.spriteRotatedClockwise(file, cell * 3, 0, cell, cell, x + size + offset, y + height - size, size, size);
    }
  }
  // Corners: cells 4..7
  s.sprite(file, cell * 4, 0, cell, cell, x, y, size, size);
  s.sprite(file, cell * 5, 0, cell, cell, x + width - size, y, size, size);
  s.sprite(file, cell * 6, 0, cell, cell, x, y + height - size, size, size);
  s.sprite(file, cell * 7, 0, cell, cell, x + width - size, y + height - size, size, size);
};

export const ensureVanillaFonts = async () => {
  try {
    await Promise.all([
      document.fonts.load('13px "Friz Quadrata"'),
      document.fonts.load('13px "Morpheus"'),
    ]);
  } catch { /* fallback remains deterministic */ }
};
