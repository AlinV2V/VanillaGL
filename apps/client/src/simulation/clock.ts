export type SimulationClockSnapshot = Readonly<{
  tick: number;
  timeMs: number;
  fixedDeltaMs: number;
}>;

/** Deterministic simulation time. Domain code never reads Date/performance directly. */
export class FixedSimulationClock {
  private tickValue = 0;
  private timeValueMs = 0;

  constructor(readonly fixedDeltaMs = 1000 / 60) {
    if (!Number.isFinite(fixedDeltaMs) || fixedDeltaMs <= 0) {
      throw new RangeError('fixedDeltaMs must be a positive finite number');
    }
  }

  get tick() { return this.tickValue; }
  get timeMs() { return this.timeValueMs; }

  snapshot(): SimulationClockSnapshot {
    return { tick: this.tickValue, timeMs: this.timeValueMs, fixedDeltaMs: this.fixedDeltaMs };
  }

  step(ticks = 1): SimulationClockSnapshot {
    if (!Number.isInteger(ticks) || ticks < 0) throw new RangeError('ticks must be a non-negative integer');
    this.tickValue += ticks;
    this.timeValueMs = this.tickValue * this.fixedDeltaMs;
    return this.snapshot();
  }

  reset(tick = 0): void {
    if (!Number.isInteger(tick) || tick < 0) throw new RangeError('tick must be a non-negative integer');
    this.tickValue = tick;
    this.timeValueMs = tick * this.fixedDeltaMs;
  }
}
