/** Bounded diagnostics for headset runs; interval misses are estimates, not compositor telemetry. */
export class XrPerformance {
  private readonly intervals = new Float32Array(2048);
  private readonly cpu = new Float32Array(2048);
  private count = 0;
  private cursor = 0;
  private previous = 0;
  private started = 0;
  private missed = 0;
  reset() { this.count = this.cursor = this.previous = this.started = this.missed = 0; }
  pause() { this.previous = 0; }
  record(time: number, cpuMs: number, hz: number) {
    if (!this.started) this.started = time;
    if (this.previous) {
      const interval = time - this.previous;
      this.intervals[this.cursor] = interval; this.cpu[this.cursor] = cpuMs;
      if (interval > 1500 / hz) this.missed++;
      this.cursor = (this.cursor + 1) % this.intervals.length; this.count++;
    }
    this.previous = time;
  }
  summary() {
    const n = Math.min(this.count, this.intervals.length);
    const percentile = (values: Float32Array, p: number) => {
      const sorted = Array.from(values.subarray(0, n)).sort((a, b) => a - b);
      return sorted[Math.min(n - 1, Math.floor(n * p))] ?? 0;
    };
    return { frames: this.count, elapsedSeconds: (this.previous - this.started) / 1000,
      frameIntervalP95Ms: percentile(this.intervals, 0.95), callbackCpuP95Ms: percentile(this.cpu, 0.95),
      estimatedMissedFrameIntervals: this.missed, windowFrames: n, hardwareAcceptance: 'requires a measured 20-minute headset run' };
  }
}
