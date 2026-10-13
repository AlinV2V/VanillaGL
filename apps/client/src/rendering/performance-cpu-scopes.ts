export const CPU_SCOPE_HISTORY = 360;
const CALL_HISTORY = 256;
const STACK_LIMIT = 64;
const SLOW_FRAME_MS = 1_000 / 60;

export const enum CpuScopeId {
  Frame,
  RuntimeWorkScheduler,
  InputCamera,
  WorldUpdate,
  NetworkSnapshot,
  EntityHydrationPresentation,
  M2AnimationSampling,
  DoodadSkeletalAnimation,
  AnimatedMaterials,
  Lighting,
  BlobShadowsGroundSampling,
  CollisionBvhRaycasts,
  HoverPicking,
  TerrainStreaming,
  AssetDecodeUpload,
  HydrationAdmissionQueues,
  WmoPortalGroupVisibility,
  SceneTraversalMatrixUpdates,
  RenderListBuildSort,
  RendererSubmission,
  MaterialProgramUniformSetup,
  Ui,
  MinimapBackground,
  MinimapOverlays,
  AudioSynchronization,
  DoodadCulling,
  PlayerAnimation,
  SpellModelEffects,
  WorldDoodadEffects,
  Weather,
  Auxiliary3dUi,
  MovementCollisionStreaming,
}

export const CPU_SCOPE_NAMES = [
  'frame', 'runtime-work-scheduler', 'input-camera', 'world-update', 'network-snapshot-processing',
  'entity-hydration-presentation', 'm2-animation-sampling', 'doodad-skeletal-animation',
  'animated-materials', 'lighting', 'blob-shadows-ground-sampling', 'collision-bvh-raycasts',
  'hover-picking', 'terrain-streaming', 'asset-decode-upload', 'hydration-admission-queues',
  'wmo-portal-group-visibility', 'three-scene-traversal-matrix-updates', 'three-render-list-build-sort',
  'renderer-submission', 'material-program-uniform-setup', 'ui', 'minimap-background',
  'minimap-overlays', 'audio-synchronization', 'doodad-culling', 'player-animation',
  'spell-model-effects', 'world-doodad-effects', 'weather', 'auxiliary-3d-ui',
  'movement-collision-streaming',
] as const;

export type CpuScopeFrameMeta = {
  cpuMs: number;
  renderMs: number;
  calls: number;
  triangles: number;
};

export type CpuScopeSummary = {
  id: number;
  name: string;
  calls: number;
  inclusiveMs: number;
  selfMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  slowFrameCount: number;
  parents: Array<{ id: number; name: string; calls: number; inclusiveMs: number }>;
  children: Array<{ id: number; name: string; calls: number; inclusiveMs: number }>;
};

export type CpuScopeFrameSample = {
  id: number;
  rafMs: number;
  cpuMs: number;
  renderMs: number;
  overheadMs: number;
  calls: number;
  triangles: number;
  slow: boolean;
  topScope: { id: number; name: string; inclusiveMs: number } | null;
  scopes: Array<{ id: number; name: string; inclusiveMs: number; selfMs: number }>;
};

export type CpuScopeSnapshot = {
  schema: 'vanillagl.cpu-scopes/v1';
  enabled: boolean;
  intrusive: boolean;
  buffer: { frameCapacity: number; retainedFrames: number; callSamplesPerScope: number };
  overhead: { totalMs: number; meanFrameMs: number; p95FrameMs: number; percentOfCpu: number };
  stackErrors: number;
  scopes: CpuScopeSummary[];
  frames: CpuScopeFrameSample[];
  slowFrames: CpuScopeFrameSample[];
  slowestFrame: CpuScopeFrameSample | null;
};

const round = (value: number): number => Number(value.toFixed(4));

function percentile(values: Float32Array, offset: number, count: number, q: number): number {
  if (!count) return 0;
  const copy = Array.from(values.subarray(offset, offset + count)).sort((a, b) => a - b);
  return copy[Math.min(count - 1, Math.floor((count - 1) * q))] ?? 0;
}

export class HierarchicalCpuProfiler {
  private readonly scopeCount = CPU_SCOPE_NAMES.length;
  private readonly totals = new Float64Array(this.scopeCount);
  private readonly selfTotals = new Float64Array(this.scopeCount);
  private readonly maxTimes = new Float32Array(this.scopeCount);
  private readonly calls = new Uint32Array(this.scopeCount);
  private readonly slowCounts = new Uint32Array(this.scopeCount);
  private readonly parentTotals = new Float64Array(this.scopeCount * this.scopeCount);
  private readonly parentCalls = new Uint32Array(this.scopeCount * this.scopeCount);
  private readonly sampleValues = new Float32Array(this.scopeCount * CALL_HISTORY);
  private readonly sampleCursor = new Uint16Array(this.scopeCount);
  private readonly sampleCount = new Uint16Array(this.scopeCount);
  private readonly stackIds = new Uint8Array(STACK_LIMIT);
  private readonly stackStarts = new Float64Array(STACK_LIMIT);
  private readonly stackChildren = new Float64Array(STACK_LIMIT);
  private readonly currentInclusive = new Float32Array(this.scopeCount);
  private readonly currentSelf = new Float32Array(this.scopeCount);
  private readonly frameIds = new Uint32Array(CPU_SCOPE_HISTORY);
  private readonly frameRaf = new Float32Array(CPU_SCOPE_HISTORY);
  private readonly frameCpu = new Float32Array(CPU_SCOPE_HISTORY);
  private readonly frameRender = new Float32Array(CPU_SCOPE_HISTORY);
  private readonly frameOverhead = new Float32Array(CPU_SCOPE_HISTORY);
  private readonly frameCalls = new Uint32Array(CPU_SCOPE_HISTORY);
  private readonly frameTriangles = new Float64Array(CPU_SCOPE_HISTORY);
  private readonly frameTop = new Int16Array(CPU_SCOPE_HISTORY);
  private readonly frameScopes = new Float32Array(CPU_SCOPE_HISTORY * this.scopeCount);
  private readonly frameSelf = new Float32Array(CPU_SCOPE_HISTORY * this.scopeCount);
  private enabled = false;
  private depth = 0;
  private frameOpen = false;
  private lastRafAt: number | null = null;
  private currentRafMs = 0;
  private currentOverheadMs = 0;
  private overheadTotalMs = 0;
  private totalCpuMs = 0;
  private frameCursor = 0;
  private frameCount = 0;
  private frameId = 0;
  private stackErrors = 0;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.frameTop.fill(-1);
  }

  isEnabled(): boolean { return this.enabled; }

  setEnabled(enabled: boolean): void {
    if (enabled && !this.enabled) this.reset();
    this.enabled = enabled;
    if (!enabled) { this.depth = 0; this.frameOpen = false; this.lastRafAt = null; }
  }

  reset(): void {
    for (const values of [this.totals, this.selfTotals, this.maxTimes, this.calls, this.slowCounts,
      this.parentTotals, this.parentCalls, this.sampleValues, this.sampleCursor, this.sampleCount,
      this.currentInclusive, this.currentSelf, this.frameIds, this.frameRaf, this.frameCpu,
      this.frameRender, this.frameOverhead, this.frameCalls, this.frameTriangles, this.frameScopes,
      this.frameSelf]) values.fill(0);
    this.frameTop.fill(-1);
    this.depth = 0; this.frameOpen = false; this.lastRafAt = null; this.currentRafMs = 0;
    this.currentOverheadMs = 0; this.overheadTotalMs = 0; this.totalCpuMs = 0;
    this.frameCursor = 0; this.frameCount = 0; this.frameId = 0; this.stackErrors = 0;
  }

  beginFrame(rafAt: number): void {
    if (!this.enabled) return;
    this.currentInclusive.fill(0); this.currentSelf.fill(0); this.currentOverheadMs = 0;
    this.currentRafMs = this.lastRafAt === null ? 0 : Math.max(0, rafAt - this.lastRafAt);
    this.lastRafAt = rafAt; this.frameOpen = true; this.frameId++;
    this.begin(CpuScopeId.Frame);
  }

  begin(id: CpuScopeId): number {
    if (!this.enabled || !this.frameOpen) return -1;
    const overheadStarted = this.now();
    if (this.depth >= STACK_LIMIT || id < 0 || id >= this.scopeCount) { this.stackErrors++; return -1; }
    const slot = this.depth++;
    this.stackIds[slot] = id; this.stackChildren[slot] = 0;
    const startedAt = this.now(); this.stackStarts[slot] = startedAt;
    this.currentOverheadMs += Math.max(0, startedAt - overheadStarted);
    return this.depth;
  }

  end(token: number): void {
    if (!this.enabled || token < 0 || !this.frameOpen) return;
    const endedAt = this.now();
    if (this.depth === 0 || token !== this.depth) { this.stackErrors++; return; }
    const slot = --this.depth; const id = this.stackIds[slot];
    const inclusive = Math.max(0, endedAt - this.stackStarts[slot]);
    const self = Math.max(0, inclusive - this.stackChildren[slot]);
    this.totals[id] += inclusive; this.selfTotals[id] += self; this.calls[id]++;
    this.maxTimes[id] = Math.max(this.maxTimes[id], inclusive);
    this.currentInclusive[id] += inclusive; this.currentSelf[id] += self;
    const cursor = this.sampleCursor[id]; this.sampleValues[id * CALL_HISTORY + cursor] = inclusive;
    this.sampleCursor[id] = (cursor + 1) % CALL_HISTORY;
    this.sampleCount[id] = Math.min(CALL_HISTORY, this.sampleCount[id] + 1);
    if (slot > 0) {
      const parent = this.stackIds[slot - 1]; const edge = parent * this.scopeCount + id;
      this.stackChildren[slot - 1] += inclusive; this.parentTotals[edge] += inclusive; this.parentCalls[edge]++;
    }
    const overheadEnded = this.now();
    this.currentOverheadMs += Math.max(0, overheadEnded - endedAt);
  }

  endFrame(meta: CpuScopeFrameMeta): void {
    if (!this.enabled || !this.frameOpen) return;
    while (this.depth > 1) { this.stackErrors++; this.end(this.depth); }
    if (this.depth === 1) this.end(1);
    const overheadStarted = this.now();
    const slow = this.currentRafMs > SLOW_FRAME_MS || meta.cpuMs > SLOW_FRAME_MS;
    let top = -1; let topMs = 0;
    for (let id = 1; id < this.scopeCount; id++) {
      const value = this.currentInclusive[id];
      if (slow && value > 0) this.slowCounts[id]++;
      if (value > topMs) { topMs = value; top = id; }
    }
    const slot = this.frameCursor; const offset = slot * this.scopeCount;
    this.frameIds[slot] = this.frameId; this.frameRaf[slot] = this.currentRafMs;
    this.frameCpu[slot] = meta.cpuMs; this.frameRender[slot] = meta.renderMs;
    this.frameCalls[slot] = Math.max(0, meta.calls); this.frameTriangles[slot] = Math.max(0, meta.triangles);
    this.frameTop[slot] = top; this.frameScopes.set(this.currentInclusive, offset); this.frameSelf.set(this.currentSelf, offset);
    this.frameCursor = (slot + 1) % CPU_SCOPE_HISTORY; this.frameCount = Math.min(CPU_SCOPE_HISTORY, this.frameCount + 1);
    this.totalCpuMs += Math.max(0, meta.cpuMs); this.frameOpen = false;
    this.currentOverheadMs += Math.max(0, this.now() - overheadStarted);
    this.frameOverhead[slot] = this.currentOverheadMs; this.overheadTotalMs += this.currentOverheadMs;
  }

  snapshot(): CpuScopeSnapshot {
    const frames: CpuScopeFrameSample[] = [];
    const start = (this.frameCursor - this.frameCount + CPU_SCOPE_HISTORY) % CPU_SCOPE_HISTORY;
    for (let index = 0; index < this.frameCount; index++) frames.push(this.frameView((start + index) % CPU_SCOPE_HISTORY));
    const overheadOrdered = new Float32Array(this.frameCount);
    for (let index = 0; index < this.frameCount; index++) overheadOrdered[index] = frames[index].overheadMs;
    const scopes = Array.from({ length: this.scopeCount }, (_, id) => this.scopeSummary(id))
      .filter((scope) => scope.calls > 0).sort((a, b) => b.inclusiveMs - a.inclusiveMs);
    const slowFrames = frames.filter((frame) => frame.slow);
    let slowestFrame: CpuScopeFrameSample | null = null;
    for (const frame of frames) if (!slowestFrame || frame.cpuMs > slowestFrame.cpuMs) slowestFrame = frame;
    return {
      schema: 'vanillagl.cpu-scopes/v1', enabled: this.enabled, intrusive: this.frameCount > 0,
      buffer: { frameCapacity: CPU_SCOPE_HISTORY, retainedFrames: this.frameCount, callSamplesPerScope: CALL_HISTORY },
      overhead: {
        totalMs: round(this.overheadTotalMs),
        meanFrameMs: round(this.overheadTotalMs / Math.max(1, this.frameCount)),
        p95FrameMs: round(percentile(overheadOrdered, 0, this.frameCount, 0.95)),
        percentOfCpu: round(100 * this.overheadTotalMs / Math.max(0.001, this.totalCpuMs)),
      },
      stackErrors: this.stackErrors, scopes, frames, slowFrames, slowestFrame,
    };
  }

  private scopeSummary(id: number): CpuScopeSummary {
    const parents: CpuScopeSummary['parents'] = []; const children: CpuScopeSummary['children'] = [];
    for (let other = 0; other < this.scopeCount; other++) {
      const parentEdge = other * this.scopeCount + id; const childEdge = id * this.scopeCount + other;
      if (this.parentCalls[parentEdge]) parents.push({ id: other, name: CPU_SCOPE_NAMES[other], calls: this.parentCalls[parentEdge], inclusiveMs: round(this.parentTotals[parentEdge]) });
      if (this.parentCalls[childEdge]) children.push({ id: other, name: CPU_SCOPE_NAMES[other], calls: this.parentCalls[childEdge], inclusiveMs: round(this.parentTotals[childEdge]) });
    }
    const count = this.sampleCount[id]; const sampleOffset = id * CALL_HISTORY;
    return {
      id, name: CPU_SCOPE_NAMES[id], calls: this.calls[id], inclusiveMs: round(this.totals[id]),
      selfMs: round(this.selfTotals[id]), maxMs: round(this.maxTimes[id]),
      p50Ms: round(percentile(this.sampleValues, sampleOffset, count, 0.5)),
      p95Ms: round(percentile(this.sampleValues, sampleOffset, count, 0.95)),
      slowFrameCount: this.slowCounts[id], parents, children,
    };
  }

  private frameView(slot: number): CpuScopeFrameSample {
    const scopes: CpuScopeFrameSample['scopes'] = []; const offset = slot * this.scopeCount;
    for (let id = 1; id < this.scopeCount; id++) if (this.frameScopes[offset + id] > 0) scopes.push({
      id, name: CPU_SCOPE_NAMES[id], inclusiveMs: round(this.frameScopes[offset + id]), selfMs: round(this.frameSelf[offset + id]),
    });
    scopes.sort((a, b) => b.inclusiveMs - a.inclusiveMs);
    const top = this.frameTop[slot];
    return {
      id: this.frameIds[slot], rafMs: round(this.frameRaf[slot]), cpuMs: round(this.frameCpu[slot]),
      renderMs: round(this.frameRender[slot]), overheadMs: round(this.frameOverhead[slot]),
      calls: this.frameCalls[slot], triangles: Math.round(this.frameTriangles[slot]),
      slow: this.frameRaf[slot] > SLOW_FRAME_MS || this.frameCpu[slot] > SLOW_FRAME_MS,
      topScope: top >= 0 ? { id: top, name: CPU_SCOPE_NAMES[top], inclusiveMs: round(this.frameScopes[offset + top]) } : null,
      scopes,
    };
  }
}

export const cpuScopeProfiler = new HierarchicalCpuProfiler();
export const beginCpuScope = (id: CpuScopeId): number => cpuScopeProfiler.begin(id);
export const endCpuScope = (token: number): void => cpuScopeProfiler.end(token);
export function withCpuScope<T>(id: CpuScopeId, run: () => T): T {
  const token = beginCpuScope(id);
  try { return run(); } finally { endCpuScope(token); }
}
