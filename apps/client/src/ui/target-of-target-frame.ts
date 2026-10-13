/** Asset conversion utility. */
import type { WorldEntity } from '../world';
import { ensureVanillaFonts, VanillaCanvas } from './vanilla-canvas';
import { getInterfaceCvars } from './interface-runtime';

const FRAME_WIDTH = 128;
const FRAME_HEIGHT = 64;
/** Health bar inside the small frame art. */
const BAR = { x: 48, y: 19, width: 72, height: 10 } as const;

export type TargetOfTargetDeps = {
  /** The unit the player currently has selected, if any. */
  getSelectedTargetEntity: () => WorldEntity | undefined;
  /** Resolve any guid to a live entity. */
  getEntity: (guid: string) => WorldEntity | undefined;
  /** Display name for a unit, using the same resolver the other frames use. */
  nameFor: (guid: string, entity: WorldEntity) => string;
  /** True while the player is in a raid group, for the "In Raids" mode. */
  isInRaid: () => boolean;
};

/**
 * Whether the frame should be drawn at all. The checkbox is the master switch; the dropdown
 * below it narrows when. "Never" exists as an explicit mode, so it wins over the checkbox.
 */
export function targetOfTargetVisible(isInRaid: boolean): boolean {
  const cvars = getInterfaceCvars();
  if (Number(cvars.showTargetOfTarget) !== 1) return false;
  const mode = String(cvars.targetOfTargetMode);
  if (mode === 'Never') return false;
  if (mode === 'In Raids') return isInRaid;
  return true;
}

export class TargetOfTargetFrame {
  private readonly surface = new VanillaCanvas(FRAME_WIDTH, FRAME_HEIGHT, 'wow-tot-frame-canvas');
  private view?: { name: string; healthFraction: number; dead: boolean };

  constructor(private readonly host: HTMLElement, private readonly deps: TargetOfTargetDeps) {
    host.appendChild(this.surface.canvas);
    this.surface.onRender(() => this.paint());
    void ensureVanillaFonts().then(() => this.surface.requestRender());
    this.host.classList.add('is-hidden');
  }

  /**
   * Recompute from the current selection. Cheap enough to call from the same places that
   * refresh the target frame; hides itself whenever there is nothing valid to show.
   */
  refresh() {
    if (!targetOfTargetVisible(this.deps.isInRaid())) return this.hide();
    const target = this.deps.getSelectedTargetEntity();
    const totGuid = target?.targetGuid;
    if (!target || !totGuid) return this.hide();
    const tot = this.deps.getEntity(totGuid);
    // The unit your target is fighting is frequently outside your own visibility set (a mob
    // pulled by someone across the field). Without an entity there is no health to draw, so
    // the frame stays hidden rather than showing an empty bar.
    if (!tot) return this.hide();
    const maxHealth = Math.max(1, tot.maxHealth ?? 1);
    const health = Math.max(0, Math.min(maxHealth, tot.health ?? maxHealth));
    this.view = {
      name: this.deps.nameFor(totGuid, tot),
      healthFraction: health / maxHealth,
      dead: health <= 0,
    };
    this.host.classList.remove('is-hidden');
    this.surface.requestRender();
  }

  hide() {
    if (this.view === undefined && this.host.classList.contains('is-hidden')) return;
    this.view = undefined;
    this.host.classList.add('is-hidden');
  }

  private paint() {
    const s = this.surface;
    s.clear();
    const view = this.view;
    if (!view) return;
    s.image('/ui/Interface/TargetingFrame/UI-SmallTargetingFrame.png', 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
    s.text(view.name, 84, 13, { size: 10, color: view.dead ? '#808080' : '#ffffff', align: 'center', maxWidth: 74 });
    const ctx = s.ctx;
    ctx.save();
    ctx.fillStyle = '#101010';
    ctx.fillRect(BAR.x, BAR.y, BAR.width, BAR.height);
    ctx.fillStyle = view.dead ? '#555555' : '#00a000';
    ctx.fillRect(BAR.x, BAR.y, BAR.width * view.healthFraction, BAR.height);
    ctx.restore();
  }
}
