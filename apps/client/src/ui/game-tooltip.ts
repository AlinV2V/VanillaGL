/** Asset conversion utility. */
import { drawMoney } from './money';
import { drawEdgedBox, ensureVanillaFonts, TOOLTIP_EDGE, VanillaCanvas, type TextOptions } from './vanilla-canvas';

export type TooltipLine = {
  text: string;
  color?: string;
  /** Optional right-aligned text on the same line (e.g. "Speed 3.60"). */
  right?: string;
  rightColor?: string;
  /** Wrap long text across lines (quest/flavor text). */
  wrap?: boolean;
  size?: number;
  family?: TextOptions['family'];
  /** Copper amount rendered with coin icons after the text ("Sell Price:"). */
  money?: number;
};

const PADDING = 10;
const MAX_TEXT_WIDTH = 240;
const LINE_GAP = 2;

export class CanvasGameTooltip {
  private readonly surface: VanillaCanvas;
  private visible = false;
  private repaint?: () => void;

  constructor() {
    this.surface = new VanillaCanvas(320, 512, 'wow-canvas-tooltip');
    const style = this.surface.canvas.style;
    style.position = 'fixed';
    style.left = '0';
    style.top = '0';
    style.zIndex = '95';
    style.pointerEvents = 'none';
    style.display = 'none';
    document.body.appendChild(this.surface.canvas);
    // Textures (border slices, coin icons) resolve asynchronously on first use;
    // repaint the visible tooltip when they arrive instead of leaving gaps.
    this.surface.onRender(() => {
      if (this.visible) this.repaint?.();
    });
    void ensureVanillaFonts().then(() => this.surface.requestRender());
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.surface.canvas.style.display = 'none';
  }

  show(lines: TooltipLine[], anchorX: number, anchorY: number) {
    if (!lines.length) { this.hide(); return; }
    const s = this.surface;

    type Row = { text: string; color: string; right?: string; rightColor?: string; size: number; family?: TextOptions['family']; money?: number };
    const rows: Row[] = [];
    lines.forEach((line, index) => {
      const size = line.size ?? (index === 0 ? 14 : 12);
      const color = line.color ?? '#ffffff';
      if (line.wrap) {
        for (const wrapped of s.wrapText(line.text, MAX_TEXT_WIDTH, { size, family: line.family })) {
          rows.push({ text: wrapped, color, size, family: line.family });
        }
      } else {
        rows.push({ text: line.text, color, right: line.right, rightColor: line.rightColor, size, family: line.family, money: line.money });
      }
    });

    let width = 0;
    let height = PADDING * 2 - LINE_GAP;
    for (const row of rows) {
      let rowWidth = s.measureText(row.text, { size: row.size, family: row.family });
      if (row.right) rowWidth += 12 + s.measureText(row.right, { size: row.size, family: row.family });
      if (row.money !== undefined) rowWidth += 6 + 90;
      width = Math.max(width, rowWidth);
      height += row.size + 2 + LINE_GAP;
    }
    width = Math.min(MAX_TEXT_WIDTH + 2 * PADDING, Math.ceil(width) + PADDING * 2);
    height = Math.ceil(height);

    this.repaint = () => {
      s.clear();
      drawEdgedBox(s, { x: 0, y: 0, width, height }, TOOLTIP_EDGE);
      let y = PADDING;
      for (const row of rows) {
        s.text(row.text, PADDING, y + row.size - 2, { size: row.size, color: row.color, family: row.family });
        if (row.right) {
          s.text(row.right, width - PADDING, y + row.size - 2, { size: row.size, color: row.rightColor ?? row.color, align: 'right', family: row.family });
        }
        if (row.money !== undefined) {
          const textWidth = s.measureText(row.text, { size: row.size, family: row.family });
          drawMoney(s, PADDING + textWidth + 6, y + row.size / 2, row.money, { align: 'left' });
        }
        y += row.size + 2 + LINE_GAP;
      }
    };
    this.repaint();

    const style = this.surface.canvas.style;
    // Clip the oversized backing canvas to the tooltip box so stale pixels never show.
    style.clipPath = `inset(0 ${this.surface.width - width}px ${this.surface.height - height}px 0)`;
    const left = Math.max(4, Math.min(window.innerWidth - width - 4, anchorX + 18));
    const top = Math.max(4, Math.min(window.innerHeight - height - 4, anchorY + 18));
    style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    style.display = 'block';
    this.visible = true;
  }
}

let sharedTooltip: CanvasGameTooltip | undefined;
export const getGameTooltip = () => (sharedTooltip ??= new CanvasGameTooltip());
