import type { MirrorTimerEvent } from '../world';
import { VanillaCanvas } from './vanilla-canvas';

type LiveTimer = {
  timerType: number;
  valueMs: number;
  durationMs: number;
  scale: number;
  paused: boolean;
  updatedAt: number;
};

const LABELS: Record<number, string> = { 0: 'Fatigue', 1: 'Breath', 2: 'Feign Death' };
const COLORS: Record<number, string> = { 0: '#ffe600', 1: '#0080ff', 2: '#ffb300' };

/** Exact MirrorTimerTemplate geometry from 1.12 FrameXML: 206x26, up to three rows. */
export class MirrorTimerCanvas {
  private readonly surface = new VanillaCanvas(256, 78, 'wow-mirror-timer-canvas');
  private readonly timers = new Map<number, LiveTimer>();
  private frame = 0;

  constructor(private readonly host: HTMLElement) {
    host.appendChild(this.surface.canvas);
    this.surface.onRender(() => this.paint());
    this.surface.canvas.setAttribute('aria-label', 'Mirror timers');
  }

  handle(event: MirrorTimerEvent) {
    const now = performance.now();
    if (event.kind === 'start') {
      this.timers.set(event.timerType, {
        timerType: event.timerType,
        valueMs: event.remainingMs,
        durationMs: Math.max(1, event.durationMs),
        scale: event.scale,
        paused: event.paused,
        updatedAt: now,
      });
    } else if (event.kind === 'pause') {
      const timer = this.timers.get(event.timerType);
      if (timer) {
        this.advance(timer, now);
        timer.paused = event.paused;
      }
    } else {
      this.timers.delete(event.timerType);
    }
    this.syncVisibility();
  }

  clear() {
    this.timers.clear();
    this.syncVisibility();
  }

  private syncVisibility() {
    this.host.classList.toggle('is-hidden', this.timers.size === 0);
    if (this.timers.size && !this.frame) this.frame = requestAnimationFrame((at) => this.tick(at));
    if (!this.timers.size && this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.surface.requestRender();
  }

  private tick(at: number) {
    this.frame = 0;
    for (const timer of this.timers.values()) this.advance(timer, at);
    this.surface.requestRender();
    if (this.timers.size) this.frame = requestAnimationFrame((next) => this.tick(next));
  }

  private advance(timer: LiveTimer, at: number) {
    const elapsed = Math.max(0, at - timer.updatedAt);
    timer.updatedAt = at;
    if (!timer.paused) timer.valueMs = Math.max(0, Math.min(timer.durationMs, timer.valueMs + timer.scale * elapsed));
  }

  private paint() {
    const s = this.surface;
    s.clear();
    const timers = [...this.timers.values()].slice(0, 3);
    timers.forEach((timer, index) => {
      const y = index * 26;
      const ratio = Math.max(0, Math.min(1, timer.valueMs / timer.durationMs));
      const ctx = s.ctx;
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(31, y + 2, 195, 13);
      ctx.fillStyle = COLORS[timer.timerType] ?? '#ffb300';
      ctx.fillRect(31, y + 2, 195 * ratio, 13);
      ctx.restore();
      // MirrorTimer.xml anchors the 256x64 casting border 25 pixels above the row.
      s.image('/ui/Interface/CastingBar/UI-CastingBar-Border.png', 0, y - 25, 256, 64);
      s.text(LABELS[timer.timerType] ?? `Timer ${timer.timerType}`, 128, y + 7, {
        size: 12,
        color: '#ffffff',
        align: 'center',
        baseline: 'middle',
      });
    });
  }
}
