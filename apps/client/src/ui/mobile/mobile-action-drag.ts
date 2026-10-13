import { VanillaCanvas, type CanvasPoint } from '../vanilla-canvas';
import { drawMobileActions, drawMobileActionDrag, mobileActionTargetAt, type MobileActionTarget } from './mobile-control-art';

const STORAGE = 'vanillagl.mobile-action-order';
const identity = () => [1, 2, 3, 4, 5, 6];
const key = (target: MobileActionTarget) => target.kind === 'action' ? `action:${target.slot}` : target.kind;

/** Reorders mobile button positions; each button still uses its original action-bar binding. */
export class MobileActionDrag {
  private order = identity();
  private held?: { id: number; target: MobileActionTarget; origin: CanvasPoint; point: CanvasPoint; dragging: boolean; moved: boolean };
  private timer?: ReturnType<typeof setTimeout>;
  private readonly pressed = new Set<string>();
  constructor(private readonly surface: VanillaCanvas, private readonly emit: (target: MobileActionTarget, down: boolean) => void) {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(STORAGE) ?? 'null');
      if (Array.isArray(saved) && saved.length === 6 && identity().every(slot => saved.includes(slot))) this.order = saved;
    } catch { /* Storage is optional in private browsing. */ }
    surface.canvas.addEventListener('pointerdown', this.down);
    surface.canvas.addEventListener('pointermove', this.move);
    surface.canvas.addEventListener('pointerup', this.up);
    surface.canvas.addEventListener('pointercancel', this.cancelEvent);
    surface.canvas.addEventListener('lostpointercapture', this.cancelEvent);
  }
  private down = (event: PointerEvent) => {
    if (this.held || event.button !== 0) return;
    const point = this.surface.point(event), target = mobileActionTargetAt(point, this.order);
    if (!target) return;
    event.preventDefault();
    this.surface.canvas.setPointerCapture?.(event.pointerId);
    this.held = { id: event.pointerId, target, origin: point, point, dragging: false, moved: false };
    this.pressed.add(key(target));
    if (target.kind !== 'action') this.emit(target, true);
    else this.timer = setTimeout(() => {
      if (!this.held || this.held.moved) return;
      this.held.dragging = true;
      this.surface.requestRender();
    }, 450);
    this.surface.requestRender();
  };
  private move = (event: PointerEvent) => {
    const held = this.held; if (!held || held.id !== event.pointerId) return;
    event.preventDefault(); held.point = this.surface.point(event);
    if (!held.dragging && Math.hypot(held.point.x - held.origin.x, held.point.y - held.origin.y) > 12) {
      held.moved = true; clearTimeout(this.timer);
    }
    this.surface.requestRender();
  };
  private up = (event: PointerEvent) => {
    const held = this.held; if (!held || held.id !== event.pointerId) return;
    event.preventDefault();
    const drop = mobileActionTargetAt(this.surface.point(event), this.order);
    if (held.target.kind === 'action') {
      if (held.dragging && drop?.kind === 'action') {
        const from = this.order.indexOf(held.target.slot), to = this.order.indexOf(drop.slot);
        [this.order[from], this.order[to]] = [this.order[to], this.order[from]];
        try { localStorage.setItem(STORAGE, JSON.stringify(this.order)); } catch { /* Session arrangement still works. */ }
      } else if (!held.dragging && !held.moved && drop?.kind === 'action' && drop.slot === held.target.slot) {
        this.emit(held.target, true); this.emit(held.target, false);
      }
    }
    this.cancel();
  };
  private cancelEvent = (event: PointerEvent) => { if (this.held?.id === event.pointerId) this.cancel(); };
  cancel = () => {
    const held = this.held; this.held = undefined; clearTimeout(this.timer);
    if (held && held.target.kind !== 'action') this.emit(held.target, false);
    if (held && this.surface.canvas.hasPointerCapture?.(held.id)) this.surface.canvas.releasePointerCapture(held.id);
    this.pressed.clear(); this.surface.requestRender();
  };
  draw() {
    drawMobileActions(this.surface, this.pressed, this.order);
    const held = this.held;
    if (held?.dragging && held.target.kind === 'action') drawMobileActionDrag(this.surface, held.target.slot, held.point);
  }
  destroy() {
    this.cancel();
    this.surface.canvas.removeEventListener('pointerdown', this.down);
    this.surface.canvas.removeEventListener('pointermove', this.move);
    this.surface.canvas.removeEventListener('pointerup', this.up);
    this.surface.canvas.removeEventListener('pointercancel', this.cancelEvent);
    this.surface.canvas.removeEventListener('lostpointercapture', this.cancelEvent);
  }
}
