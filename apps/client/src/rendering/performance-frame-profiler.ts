import type * as THREE from 'three';

export const PERFORMANCE_FRAME_HISTORY = 360;
const MAX_PHASES = 32;
const FRAME_BUDGET_60_MS = 1_000 / 60;

export type PerformanceSeriesSummary = {
  samples: number;
  current: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
};

export type PerformanceFrameView = {
  id: number;
  rafMs: number;
  cpuMs: number;
  renderMs: number;
  gpuMs: number | null;
  overheadMs: number;
  calls: number;
  triangles: number;
  phases: Record<string, number>;
};

export type PerformanceProfilerSnapshot = {
  enabled: boolean;
  frozen: boolean;
  gpuStatus: 'disabled' | 'unsupported' | 'measuring' | 'measured' | 'discarded-disjoint';
  frameTimeMs: PerformanceSeriesSummary;
  fps: PerformanceSeriesSummary;
  cpuWorkMs: PerformanceSeriesSummary;
  renderMs: PerformanceSeriesSummary;
  gpuMs: PerformanceSeriesSummary;
  overheadMs: PerformanceSeriesSummary;
  cpuBudgetRemainingP95Ms: number;
  longFrames: number;
  dropped30HzFrames: number;
  phaseCosts: Array<{ name: string; currentMs: number; meanMs: number; p95Ms: number }>;
  current: PerformanceFrameView | null;
  selected: PerformanceFrameView | null;
  history: Array<{ id: number; rafMs: number; cpuMs: number; renderMs: number; gpuMs: number | null }>;
  phaseHistory: { names: string[]; frames: number[][] };
};

type RendererFrame = {
  callbackCpuMs: number;
  renderCpuMs: number;
  calls: number;
  triangles: number;
};

type PendingGpuQuery = { query: WebGLQuery; frameId: number };
type GpuExtension = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };

const round = (value: number): number => Number(value.toFixed(3));

function summary(values: readonly number[], current = values[values.length - 1] ?? 0): PerformanceSeriesSummary {
  if (!values.length) return { samples: 0, current: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))] ?? 0;
  let total = 0;
  for (const value of values) total += value;
  return {
    samples: values.length,
    current: round(current),
    min: round(sorted[0] ?? 0),
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted[sorted.length - 1] ?? 0),
    mean: round(total / values.length),
  };
}

class PerformanceFrameProfiler {
  private readonly sources = new Set<string>();
  private readonly frameIds = new Float64Array(PERFORMANCE_FRAME_HISTORY);
  private readonly rafMs = new Float32Array(PERFORMANCE_FRAME_HISTORY);
  private readonly cpuMs = new Float32Array(PERFORMANCE_FRAME_HISTORY);
  private readonly renderMs = new Float32Array(PERFORMANCE_FRAME_HISTORY);
  private readonly gpuMs = new Float32Array(PERFORMANCE_FRAME_HISTORY);
  private readonly gpuValid = new Uint8Array(PERFORMANCE_FRAME_HISTORY);
  private readonly overheadMs = new Float32Array(PERFORMANCE_FRAME_HISTORY);
  private readonly calls = new Uint32Array(PERFORMANCE_FRAME_HISTORY);
  private readonly triangles = new Float64Array(PERFORMANCE_FRAME_HISTORY);
  private readonly phases = Array.from(
    { length: PERFORMANCE_FRAME_HISTORY },
    () => new Float32Array(MAX_PHASES),
  );
  private readonly currentPhases = new Float32Array(MAX_PHASES);
  private readonly phaseNames: string[] = [];
  private readonly phaseIndices = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private cursor = 0;
  private count = 0;
  private frameId = 0;
  private lastRafAt: number | null = null;
  private currentRafMs = 0;
  private currentOverheadMs = 0;
  private selectedFrameId: number | null = null;
  private frozen = false;
  private clockReadCostMs = 0;
  private gl: WebGL2RenderingContext | null = null;
  private gpuExt: GpuExtension | null | undefined;
  private gpuEnabled = false;
  private gpuDisjoint = false;
  private readonly pendingGpu: PendingGpuQuery[] = [];

  setSourceActive(source: string, active: boolean): void {
    if (active) {
      this.sources.add(source);
      if (this.clockReadCostMs === 0) this.calibrateClock();
    } else this.sources.delete(source);
  }

  isActive(): boolean { return this.sources.size > 0; }

  setFrozen(frozen: boolean): void { this.frozen = frozen; }
  isFrozen(): boolean { return this.frozen; }

  configureGpu(renderer: THREE.WebGLRenderer): void {
    try {
      const context = renderer.getContext();
      this.gl = typeof WebGL2RenderingContext !== 'undefined' && context instanceof WebGL2RenderingContext
        ? context
        : null;
    } catch { this.gl = null; }
    this.gpuExt = undefined;
  }

  setGpuEnabled(enabled: boolean): void {
    this.gpuEnabled = enabled;
    if (!enabled) this.clearGpuQueries();
  }

  isGpuEnabled(): boolean { return this.gpuEnabled; }

  beginGpuScope(): WebGLQuery | null {
    if (!this.isActive() || !this.gpuEnabled || !this.gl) return null;
    const ext = this.extension();
    if (!ext) return null;
    try {
      const query = this.gl.createQuery();
      if (!query) return null;
      this.gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      return query;
    } catch { return null; }
  }

  endGpuScope(query: WebGLQuery | null): void {
    if (!query || !this.gl) return;
    const ext = this.extension();
    if (!ext) { this.gl.deleteQuery(query); return; }
    try {
      this.gl.endQuery(ext.TIME_ELAPSED_EXT);
      this.pendingGpu.push({ query, frameId: this.frameId });
    } catch { this.gl.deleteQuery(query); }
  }

  beginFrame(rafAt: number): void {
    if (!this.isActive()) return;
    const started = performance.now();
    this.frameId++;
    this.currentRafMs = this.lastRafAt === null ? 0 : Math.max(0, rafAt - this.lastRafAt);
    this.lastRafAt = rafAt;
    this.currentPhases.fill(0);
    this.currentOverheadMs = performance.now() - started;
  }

  recordPhase(name: string, elapsedMs: number): void {
    if (!this.isActive()) return;
    let index = this.phaseIndices.get(name);
    if (index === undefined) {
      if (this.phaseNames.length >= MAX_PHASES) return;
      index = this.phaseNames.length;
      this.phaseNames.push(name);
      this.phaseIndices.set(name, index);
    }
    this.currentPhases[index] += elapsedMs;
    this.currentOverheadMs += this.clockReadCostMs * 2;
  }

  addOverhead(elapsedMs: number): void {
    if (!this.isActive() || !Number.isFinite(elapsedMs) || this.count === 0) return;
    const latestSlot = (this.cursor - 1 + PERFORMANCE_FRAME_HISTORY) % PERFORMANCE_FRAME_HISTORY;
    this.overheadMs[latestSlot] += Math.max(0, elapsedMs);
  }

  endFrame(frame: RendererFrame): void {
    if (!this.isActive()) return;
    const started = performance.now();
    const slot = this.cursor;
    this.frameIds[slot] = this.frameId;
    this.rafMs[slot] = this.currentRafMs;
    this.cpuMs[slot] = frame.callbackCpuMs;
    this.renderMs[slot] = frame.renderCpuMs;
    this.overheadMs[slot] = this.currentOverheadMs;
    this.calls[slot] = Math.max(0, frame.calls);
    this.triangles[slot] = Math.max(0, frame.triangles);
    this.gpuMs[slot] = 0;
    this.gpuValid[slot] = 0;
    this.phases[slot].set(this.currentPhases);
    this.cursor = (slot + 1) % PERFORMANCE_FRAME_HISTORY;
    this.count = Math.min(PERFORMANCE_FRAME_HISTORY, this.count + 1);
    this.pollGpuQueries();
    this.currentOverheadMs += performance.now() - started;
    const listenerStarted = performance.now();
    for (const listener of this.listeners) listener();
    this.currentOverheadMs += performance.now() - listenerStarted;
    this.overheadMs[slot] = this.currentOverheadMs;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  selectFrame(id: number | null): void { this.selectedFrameId = id; }

  snapshot(): PerformanceProfilerSnapshot {
    const slots = this.orderedSlots();
    const rafValues = slots.map((slot) => this.rafMs[slot]).filter((value) => value > 0);
    const cpuValues = slots.map((slot) => this.cpuMs[slot]);
    const renderValues = slots.map((slot) => this.renderMs[slot]);
    const overheadValues = slots.map((slot) => this.overheadMs[slot]);
    const gpuValues = slots.filter((slot) => this.gpuValid[slot] !== 0).map((slot) => this.gpuMs[slot]);
    const fpsValues = rafValues.map((value) => 1_000 / Math.max(0.001, value));
    const latestSlot = slots[slots.length - 1];
    let slowSlot = latestSlot;
    for (const slot of slots) if (slowSlot === undefined || this.rafMs[slot] > this.rafMs[slowSlot]) slowSlot = slot;
    const selectedSlot = this.selectedFrameId === null
      ? slowSlot
      : slots.find((slot) => this.frameIds[slot] === this.selectedFrameId) ?? slowSlot;
    const phaseCosts = this.phaseNames.map((name, index) => {
      const values = slots.map((slot) => this.phases[slot][index]);
      const stats = summary(values, latestSlot === undefined ? 0 : this.phases[latestSlot][index]);
      return { name, currentMs: stats.current, meanMs: stats.mean, p95Ms: stats.p95 };
    }).sort((a, b) => b.currentMs - a.currentMs);
    const graphedPhases = phaseCosts.slice(0, 8).map((phase) => phase.name);
    const graphedIndices = graphedPhases.map((name) => this.phaseIndices.get(name) ?? -1);
    const cpuStats = summary(cpuValues);
    return {
      enabled: this.isActive(),
      frozen: this.frozen,
      gpuStatus: this.gpuStatus(),
      frameTimeMs: summary(rafValues),
      fps: summary(fpsValues),
      cpuWorkMs: cpuStats,
      renderMs: summary(renderValues),
      gpuMs: summary(gpuValues),
      overheadMs: summary(overheadValues),
      cpuBudgetRemainingP95Ms: round(FRAME_BUDGET_60_MS - cpuStats.p95),
      longFrames: rafValues.filter((value) => value > FRAME_BUDGET_60_MS).length,
      dropped30HzFrames: rafValues.filter((value) => value >= 1_000 / 30).length,
      phaseCosts,
      current: latestSlot === undefined ? null : this.frameView(latestSlot),
      selected: selectedSlot === undefined ? null : this.frameView(selectedSlot),
      history: slots.map((slot) => ({
        id: this.frameIds[slot],
        rafMs: this.rafMs[slot],
        cpuMs: this.cpuMs[slot],
        renderMs: this.renderMs[slot],
        gpuMs: this.gpuValid[slot] ? this.gpuMs[slot] : null,
      })),
      phaseHistory: {
        names: graphedPhases,
        frames: slots.map((slot) => graphedIndices.map((index) => index < 0 ? 0 : this.phases[slot][index])),
      },
    };
  }

  private calibrateClock(): void {
    const reads = 64;
    const started = performance.now();
    for (let i = 0; i < reads; i++) performance.now();
    this.clockReadCostMs = Math.max(0.00001, (performance.now() - started) / (reads + 2));
  }

  private extension(): GpuExtension | null {
    if (this.gpuExt !== undefined) return this.gpuExt;
    const extension = (this.gl?.getExtension('EXT_disjoint_timer_query_webgl2') ?? null) as GpuExtension | null;
    this.gpuExt = extension;
    return extension;
  }

  private pollGpuQueries(): void {
    const gl = this.gl;
    const ext = this.extension();
    if (!gl || !ext || !this.pendingGpu.length) return;
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      this.gpuDisjoint = true;
      this.clearGpuQueries();
      return;
    }
    const keep: PendingGpuQuery[] = [];
    for (const pending of this.pendingGpu) {
      if (!gl.getQueryParameter(pending.query, gl.QUERY_RESULT_AVAILABLE)) {
        if (this.frameId - pending.frameId <= 120) keep.push(pending);
        else gl.deleteQuery(pending.query);
        continue;
      }
      const nanoseconds = gl.getQueryParameter(pending.query, gl.QUERY_RESULT) as number;
      gl.deleteQuery(pending.query);
      const slot = this.slotForFrame(pending.frameId);
      if (slot !== undefined && Number.isFinite(nanoseconds)) {
        this.gpuMs[slot] += nanoseconds / 1_000_000;
        this.gpuValid[slot] = 1;
      }
    }
    this.pendingGpu.length = 0;
    this.pendingGpu.push(...keep);
  }

  private clearGpuQueries(): void {
    for (const pending of this.pendingGpu) this.gl?.deleteQuery(pending.query);
    this.pendingGpu.length = 0;
  }

  private gpuStatus(): PerformanceProfilerSnapshot['gpuStatus'] {
    if (!this.gpuEnabled) return 'disabled';
    if (!this.gl || !this.extension()) return 'unsupported';
    if (this.gpuDisjoint) return 'discarded-disjoint';
    return this.gpuValid.some((value) => value !== 0) ? 'measured' : 'measuring';
  }

  private orderedSlots(): number[] {
    const slots: number[] = [];
    const start = (this.cursor - this.count + PERFORMANCE_FRAME_HISTORY) % PERFORMANCE_FRAME_HISTORY;
    for (let i = 0; i < this.count; i++) slots.push((start + i) % PERFORMANCE_FRAME_HISTORY);
    return slots;
  }

  private slotForFrame(id: number): number | undefined {
    for (const slot of this.orderedSlots()) if (this.frameIds[slot] === id) return slot;
    return undefined;
  }

  private frameView(slot: number): PerformanceFrameView {
    const phases: Record<string, number> = {};
    for (let index = 0; index < this.phaseNames.length; index++) {
      const value = this.phases[slot][index];
      if (value > 0) phases[this.phaseNames[index]] = round(value);
    }
    return {
      id: this.frameIds[slot],
      rafMs: round(this.rafMs[slot]),
      cpuMs: round(this.cpuMs[slot]),
      renderMs: round(this.renderMs[slot]),
      gpuMs: this.gpuValid[slot] ? round(this.gpuMs[slot]) : null,
      overheadMs: round(this.overheadMs[slot]),
      calls: this.calls[slot],
      triangles: Math.round(this.triangles[slot]),
      phases,
    };
  }
}

export const performanceFrameProfiler = new PerformanceFrameProfiler();
