import type { PerformanceProfile } from './performance-profile';

/** Cadence gate for expensive presentation frames; networking and browser events remain independent. */
export class FrameRateGate {
  private lastAccepted: number | null = null;

  shouldRun(now: number, fps: number): boolean {
    const interval = 1000 / Math.max(1, fps);
    if (this.lastAccepted === null || now < this.lastAccepted) {
      this.lastAccepted = now;
      return true;
    }
    const elapsed = now - this.lastAccepted;
    if (elapsed + 0.25 < interval) return false;
    const intervals = Math.max(1, Math.floor((elapsed + 0.25) / interval));
    this.lastAccepted += intervals * interval;
    return true;
  }

  reset(): void {
    this.lastAccepted = null;
  }
}

export function shouldRunPerformanceFrame(
  gate: FrameRateGate,
  profile: PerformanceProfile,
  xrPresenting: boolean,
  now: number,
): boolean {
  if (!profile.device.mobile || xrPresenting) {
    gate.reset();
    return true;
  }
  return gate.shouldRun(now, profile.targetFps);
}
