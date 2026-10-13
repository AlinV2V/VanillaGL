/** Asset conversion utility. */
import { CharacterPreview } from '../login/CharacterPreview';
import { effectivePreviewPixelRatio } from '../platform/mobile-render-policy';
import { renderAuxiliaryCanvas } from './auxiliary-renderer';
import type { CharacterInfo } from '../world';
import { CHARACTER_EQUIPMENT_LAYOUT } from './character-frame-canvas';
import { CanvasPanel, type PanelHit } from './panel-kit';
import type { TooltipLine } from './game-tooltip';
import { inspectCharacterModelKey, onRemoteCharacter } from './inspect-character-refresh';

const INFO = '/ui/Interface/PaperDollInfoFrame';
const DOLL = '/ui/Interface/PaperDoll';
const QUALITY_COLORS = ['#9d9d9d', '#ffffff', '#1eff00', '#0070dd', '#a335ee', '#ff8000', '#e6cc80'];

/** One equipment slot as resolved by the caller from the target's visible items. */
export type InspectSlotView = {
  /** VISIBLE_ITEM slot index (0..18) — equals the layout's inventoryIndex. */
  index: number;
  iconUrl?: string;
  quality?: number;
  tooltip?: TooltipLine[];
};

export type InspectView = {
  guid: string;
  title: string;
  subtitle: string;
  slots: InspectSlotView[];
};

// The model box within the PaperDollInfoFrame art (same region the character sheet renders into).
const MODEL_BOX = { x: 66, y: 72, width: 170, height: 210 } as const;

export class InspectFrame extends CanvasPanel {
  private view?: InspectView;
  private readonly modelCanvas: HTMLCanvasElement;
  private preview: CharacterPreview | null = null;
  private loadedFor?: string;
  private readonly stopCharacterRefresh: () => void;

  constructor(private readonly host: HTMLElement, private readonly maxAnisotropy: number, deps: { playUi: (name: string) => void }) {
    super(host, 384, 512, 'wow-native-panel-canvas', deps);
    // The Build-5875 PaperDoll centre is opaque, so the transparent model canvas must sit above it
    // (the same layering rule used by the local paper doll in main.ts).
    this.modelCanvas = document.createElement('canvas');
    Object.assign(this.modelCanvas.style, {
      position: 'absolute', pointerEvents: 'none', zIndex: '2',
    });
    this.surface.canvas.style.position = 'relative';
    this.surface.canvas.style.zIndex = '1';
    host.insertBefore(this.modelCanvas, this.surface.canvas);
    this.stopCharacterRefresh = onRemoteCharacter((character) => {
      if (character.guid === this.view?.guid) this.ensureModel(character);
    });
  }

  show(view: InspectView, character: CharacterInfo | null) {
    this.view = view;
    this.host.classList.remove('is-hidden');
    this.positionModelCanvas();
    if (character) this.ensureModel(character);
    this.surface.requestRender();
  }

  hide() {
    this.host.classList.add('is-hidden');
    this.view = undefined;
  }

  isOpen() {
    return !this.host.classList.contains('is-hidden');
  }

  guid() {
    return this.view?.guid;
  }

  /** Refresh the slot icons/tooltips; resolved appearance updates arrive through the shared hub. */
  setSlots(slots: InspectSlotView[]) {
    if (this.view) {
      this.view = { ...this.view, slots };
      this.surface.requestRender();
    }
  }

  /** Called from the render loop while open, to spin/animate the 3D model. */
  update(dt: number) {
    if (!this.isOpen() || !this.preview) return;
    this.preview.update(dt);
    const ratio = effectivePreviewPixelRatio(window.devicePixelRatio);
    renderAuxiliaryCanvas(this.modelCanvas, MODEL_BOX.width * ratio, MODEL_BOX.height * ratio, 0, 0,
      (renderer, width, height) => this.preview!.render(renderer, 0, 0, width, height));
  }

  private positionModelCanvas() {
    // Place the model canvas over the model box in the panel's own coordinate space. The panel
    // canvas is 384x512 in CSS pixels; MODEL_BOX is in that same space.
    const scaleX = (this.surface.canvas.clientWidth || 384) / 384;
    const scaleY = (this.surface.canvas.clientHeight || 512) / 512;
    Object.assign(this.modelCanvas.style, {
      left: `${MODEL_BOX.x * scaleX}px`,
      top: `${MODEL_BOX.y * scaleY}px`,
      width: `${MODEL_BOX.width * scaleX}px`,
      height: `${MODEL_BOX.height * scaleY}px`,
    });
  }

  private ensureModel(character: CharacterInfo) {
    if (!this.preview) {
      this.preview = new CharacterPreview(this.modelCanvas, this.maxAnisotropy);
      this.preview.setAutoRotate(false);
    }
    const key = inspectCharacterModelKey(character);
    if (this.loadedFor !== key) {
      this.loadedFor = key;
      void this.preview.loadCharacter(character);
    }
  }

  protected paint() {
    const s = this.surface;
    s.clear();
    s.fourSlice(INFO, ['UI-Character-General-TopLeft', 'UI-Character-General-TopRight', 'UI-Character-General-BottomLeft', 'UI-Character-General-BottomRight']);
    const view = this.view;
    s.text(view?.title ?? 'Inspect', 192, 26, { size: 14, color: '#fff1bd', align: 'center', baseline: 'middle', maxWidth: 246 });
    if (view?.subtitle) s.text(view.subtitle, 192, 52, { size: 12, color: '#ffd100', align: 'center', baseline: 'middle', maxWidth: 270 });
    const closeState = this.state('close');
    s.closeButton(324, 9, closeState === 'disabled' ? 'normal' : closeState);
    this.hit('close', { x: 324, y: 9, width: 32, height: 32 });

    const byIndex = new Map((view?.slots ?? []).map((slot) => [slot.index, slot]));
    for (const layout of CHARACTER_EQUIPMENT_LAYOUT) {
      if (layout.inventoryIndex === undefined) continue; // ammo — not a visible-item slot
      const { x, y, width, height } = layout.rect;
      s.image(`${DOLL}/${layout.texture}.png`, x, y, width, height);
      const slot = byIndex.get(layout.inventoryIndex);
      const id = `slot:${layout.id}`;
      if (slot?.iconUrl) {
        const inset = width < 32 ? 2 : 3;
        s.image(slot.iconUrl, x + inset, y + inset, width - inset * 2, height - inset * 2);
        const quality = Math.max(0, Math.min(QUALITY_COLORS.length - 1, slot.quality ?? 1));
        const ctx = s.ctx;
        ctx.save();
        ctx.strokeStyle = QUALITY_COLORS[quality];
        ctx.globalAlpha = 0.85;
        ctx.strokeRect(x + 1.5, y + 1.5, width - 3, height - 3);
        ctx.restore();
        this.hit(id, layout.rect, { tooltip: slot.tooltip ? () => slot.tooltip! : undefined });
      }
    }
  }

  protected activate(hit: PanelHit) {
    if (hit.id === 'close') {
      this.playUi('igCharacterInfoClose');
      this.hide();
    }
  }

  destroy() {
    this.stopCharacterRefresh();
    this.preview?.destroy();
    this.preview = null;
  }
}
