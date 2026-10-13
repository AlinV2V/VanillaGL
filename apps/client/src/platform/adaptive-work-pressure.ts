/** Non-render callback time is conservative CPU evidence: submission/GPU waits are excluded. */
export class AdaptiveWorkPressure {
  averageMs = 0;
  samples = 0;
  record(callbackMs: number, renderMs: number): void {
    if (!Number.isFinite(callbackMs) || !Number.isFinite(renderMs) || callbackMs < 0 || renderMs < 0) return;
    const work = Math.max(0, callbackMs - renderMs);
    this.averageMs = this.samples ? this.averageMs * 0.95 + work * 0.05 : work;
    this.samples++;
  }
  constrained(targetMs: number): boolean { return this.samples >= 30 && this.averageMs > targetMs * 0.85; }
  reset(): void { this.averageMs = 0; this.samples = 0; }
}

let effectAdmissionScale = 1;
export function setAdaptiveEffectAdmissionScale(scale: number): void { effectAdmissionScale = Math.max(0.5, Math.min(1, scale)); }
export function adaptiveEffectAdmissionScale(): number { return effectAdmissionScale; }
