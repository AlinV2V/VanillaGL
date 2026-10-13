import { VanillaCanvas, ensureVanillaFonts } from '../vanilla-canvas';
import { layoutMirrorNodes, type UiNode } from './framexml';

export class MirrorXmlRenderer {
  readonly surface: VanillaCanvas;
  private readonly byName: Map<string, UiNode>;
  private readonly rects: ReturnType<typeof layoutMirrorNodes>;
  private readonly tinted = new Map<string, VanillaCanvas>();
  private disposed = false;
  constructor(readonly nodes: UiNode[], host: HTMLElement, width = 256, height = 128, originY = -71) {
    ensureVanillaFonts();
    this.surface = new VanillaCanvas(width, height, 'wow-lua-mirror-timer-canvas');
    host.appendChild(this.surface.canvas);
    this.surface.canvas.setAttribute('aria-label', 'Original Lua/XML mirror timers');
    this.byName = new Map(nodes.map(n => [n.name, n]));
    this.rects = layoutMirrorNodes(nodes, { x: 0, y: originY, width, height });
    this.surface.onRender(() => { if (!this.disposed) this.paint(); });
  }
  mutate(name: string, method: string, ...values: (number | string | boolean)[]) {
    const node = this.byName.get(name);
    if (!node) throw new Error(`Unknown frame ${name}`);
    switch (method) {
      case 'hidden': node.hidden = Boolean(values[0]); break;
      case 'text': node.text = String(values[0]); break;
      case 'value': node.value = Number(values[0]); break;
      case 'level': node.level = Number(values[0]); break;
      case 'range': node.minimum = Number(values[0]); node.maximum = Number(values[1]); break;
      case 'color': node.color = values.map(Number).concat(1); break;
      default: throw new Error(`Unsupported frame method ${method}`);
    }
  }
  requestRender() { if (!this.disposed) this.surface.requestRender(); }
  paint() {
    this.surface.clear();
    const visible = (node: UiNode): boolean => !node.hidden && (!node.parent || visible(this.byName.get(node.parent)!));
    const color = (rgba: number[]) => `rgba(${rgba.slice(0, 3).map(c => Math.round(c * 255)).join(',')},${rgba[3] ?? 1})`;
    for (const node of [...this.nodes].sort((a, b) => a.layer - b.layer || Number(a.kind === 'FontString') - Number(b.kind === 'FontString'))) {
      if (!visible(node)) continue;
      const rect = this.rects.get(node.name)!;
      const ctx = this.surface.ctx;
      if (node.kind === 'FontString') {
        this.surface.text(node.text, rect.x, rect.y, { size: 12, align: 'center', baseline: 'top', color: '#ffffff' });
        continue;
      }
      if (node.kind !== 'Texture' && node.kind !== 'StatusBar') continue;
      let width = rect.width;
      if (node.kind === 'StatusBar') {
        const ratio = (node.value - node.minimum) / Math.max(1e-9, node.maximum - node.minimum);
        width *= Math.max(0, Math.min(1, ratio));
      }
      if (node.texture) {
        const path = `/ui/${node.texture.replaceAll('\\', '/')}.png`;
        if (node.kind === 'StatusBar') {
          ctx.save();
          ctx.beginPath(); ctx.rect(rect.x, rect.y, width, rect.height); ctx.clip();
          const tint = color(node.color ?? [1, 1, 1, 1]);
          const key = `${path}:${tint}:${rect.width}:${rect.height}`;
          let cached = this.tinted.get(key);
          if (!cached) {
            cached = new VanillaCanvas(rect.width, rect.height, '');
            const image = cached;
            const renderTint = () => {
              if (this.disposed) return;
              image.clear(); image.tintedImage(path, tint, 0, 0, rect.width, rect.height);
              this.requestRender();
            };
            image.onRender(renderTint); renderTint(); this.tinted.set(key, image);
          }
          this.surface.source(cached.canvas, rect.x, rect.y, rect.width, rect.height);
          ctx.restore();
        } else this.surface.image(path, rect.x, rect.y, width, rect.height);
      } else if (node.color) {
        ctx.fillStyle = color(node.color);
        ctx.fillRect(rect.x, rect.y, width, rect.height);
      }
    }
  }
  dispose() {
    this.disposed = true; this.surface.onRender(() => {}); this.surface.canvas.remove();
    for (const image of this.tinted.values()) image.onRender(() => {});
    this.tinted.clear();
  }
}
