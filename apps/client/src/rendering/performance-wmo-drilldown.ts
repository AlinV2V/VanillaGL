import * as THREE from 'three';
import {
  WmoVisibilityAuditSession,
  type WmoVisibilityAuditOptions,
  type WmoVisibilityAuditSnapshot,
} from './performance-wmo-visibility-audit';

export type WmoBucketLevel = 'root' | 'group' | 'material';

export type WmoDrilldownOptions = {
  slowCpuMs?: number;
  topBucketsPerFrame?: number;
  slowFrameBuffer?: number;
  discoveryFrames?: number;
  reusePreviousCandidates?: boolean;
  /** Sample effective far clip, group/batch bounds, frustum and portal decisions. */
  visibilityAudit?: boolean | WmoVisibilityAuditOptions;
  ablations?: {
    levels?: readonly WmoBucketLevel[];
    candidateLimit?: number;
    settleFrames?: number;
    sampleFrames?: number;
    repeats?: number;
  };
};

type Bucket = {
  id: number; level: WmoBucketLevel; parentId: number; key: string; label: string;
  objects: THREE.Object3D[];
};

type ObjectBuckets = { root: number; group: number; material: number };

type AblationTest = {
  bucketId: number; complete: boolean; counts: Uint16Array;
  cpu: Float32Array; render: Float32Array; calls: Float32Array; triangles: Float32Array;
  long: Uint8Array; frames: Uint32Array; gpu: Float32Array; gpuValid: Uint8Array;
};

export type WmoDrilldownSnapshot = {
  schema: 'vanillagl.wmo-drilldown/v2'; active: boolean; intrusive: true; frames: number;
  limits: { maxBuckets: number; topBucketsPerSlowFrame: number; slowFrameBuffer: number };
  discovery: { requestedFrames: number; capturedFrames: number; slowCpuMs: number; slowFrames: number; normalFrames: number; rootCandidateSource: 'previous-correlation' | 'current-capture' };
  buckets: Array<{
    id: number; level: WmoBucketLevel; parentId: number; key: string; label: string;
    meanDraws: number; slowMeanDraws: number; normalMeanDraws: number; slowDrawUplift: number;
    meanTriangles: number; slowPresence: number; normalPresence: number;
  }>;
  slowFrames: Array<{
    id: number; cpuMs: number; renderMs: number; calls: number; triangles: number;
    camera: { x: number; y: number; z: number; yaw: number; pitch: number };
    topBuckets: Array<{ id: number; label: string; level: WmoBucketLevel; draws: number }>;
  }>;
  ablation: {
    enabled: boolean; status: string; current: { bucketId: number; label: string; variant: 'baseline' | 'hidden'; progress: number } | null;
    results: Array<{
      bucketId: number; level: WmoBucketLevel; label: string; baselineSamples: number; hiddenSamples: number;
      renderSubmitCpuDeltaMs: number | null; totalCpuDeltaMs: number | null; drawCallDelta: number | null;
      triangleDelta: number | null; gpuTimeDeltaMs: number | null; longFrameDelta: number | null;
      gpuStatus: 'measured' | 'unavailable-unattributed' | 'invalid-disjoint'; complete: boolean;
    }>;
  };
  visibilityAudit: WmoVisibilityAuditSnapshot | null;
  overhead: { timingPerDraw: false; note: string };
};

const MAX_BUCKETS = 16384;
const MAX_SAMPLES_PER_VARIANT = 600;
const LEVEL_ORDER: readonly WmoBucketLevel[] = ['root', 'group', 'material'];
const round = (value: number): number => Number(value.toFixed(3));
let previousRootCandidateKeys: string[] = [];

const median = (values: Float32Array, offset: number, count: number): number => {
  if (!count) return 0;
  const copy = Array.from(values.subarray(offset, offset + count)).sort((a, b) => a - b);
  return copy[Math.floor((copy.length - 1) / 2)] ?? 0;
};

export class WmoDrilldownSession {
  private readonly buckets: Bucket[] = [];
  private readonly byKey = new Map<string, number>();
  private readonly objectBuckets = new WeakMap<THREE.Object3D, ObjectBuckets>();
  private readonly currentDraws = new Uint32Array(MAX_BUCKETS);
  private readonly currentTriangles = new Float64Array(MAX_BUCKETS);
  private readonly totalDraws = new Float64Array(MAX_BUCKETS);
  private readonly totalTriangles = new Float64Array(MAX_BUCKETS);
  private readonly slowDraws = new Float64Array(MAX_BUCKETS);
  private readonly normalDraws = new Float64Array(MAX_BUCKETS);
  private readonly slowPresence = new Uint32Array(MAX_BUCKETS);
  private readonly normalPresence = new Uint32Array(MAX_BUCKETS);
  private readonly activeIds = new Uint16Array(MAX_BUCKETS);
  private activeCount = 0;
  private readonly slowIds: Uint32Array; private readonly slowCpu: Float32Array; private readonly slowRender: Float32Array;
  private readonly slowCalls: Uint32Array; private readonly slowTriangles: Float64Array; private readonly slowCamera: Float32Array;
  private readonly slowTopIds: Int32Array; private readonly slowTopDraws: Uint32Array;
  private slowCursor = 0; private slowCount = 0; private slowFrames = 0; private normalFrames = 0;
  private frameId = 0; private cameraX = 0; private cameraY = 0; private cameraZ = 0; private cameraYaw = 0; private cameraPitch = 0;
  private readonly slowCpuMs: number; private readonly topK: number; private readonly ringSize: number; private readonly discoveryFrames: number;
  private readonly levels: WmoBucketLevel[]; private readonly candidateLimit: number; private readonly settleFrames: number;
  private readonly sampleFrames: number; private readonly repeats: number;
  private readonly seededRootKeys: readonly string[];
  private levelIndex = -1; private parentWinner = -1; private candidates: number[] = []; private candidateIndex = -1;
  private intervalStep = 0; private intervalFrame = 0; private currentTest: AblationTest | null = null;
  private readonly tests: AblationTest[] = []; private readonly hidden: THREE.Object3D[] = [];
  private readonly visibilityAudit: WmoVisibilityAuditSession | null;
  private gpuStatus: WmoDrilldownSnapshot['ablation']['results'][number]['gpuStatus'] = 'unavailable-unattributed';
  private disposed = false;

  constructor(options: WmoDrilldownOptions = {}) {
    this.slowCpuMs = Math.max(4, Math.min(100, Number(options.slowCpuMs ?? 1_000 / 60)));
    this.topK = Math.max(1, Math.min(32, Math.floor(options.topBucketsPerFrame ?? 12)));
    this.ringSize = Math.max(8, Math.min(600, Math.floor(options.slowFrameBuffer ?? 120)));
    this.discoveryFrames = Math.max(1, Math.min(3600, Math.floor(options.discoveryFrames ?? 180)));
    const requestedLevels = options.ablations?.levels ?? [];
    if (options.visibilityAudit && requestedLevels.length) throw new Error('Run WMO visibilityAudit and WMO ablations in separate settled captures.');
    this.levels = LEVEL_ORDER.filter((level) => requestedLevels.includes(level));
    this.candidateLimit = Math.max(1, Math.min(12, Math.floor(options.ablations?.candidateLimit ?? 4)));
    this.settleFrames = Math.max(1, Math.min(60, Math.floor(options.ablations?.settleFrames ?? 8)));
    this.sampleFrames = Math.max(1, Math.min(120, Math.floor(options.ablations?.sampleFrames ?? 30)));
    this.repeats = Math.max(1, Math.min(5, Math.floor(options.ablations?.repeats ?? 2)));
    this.visibilityAudit = options.visibilityAudit
      ? new WmoVisibilityAuditSession(options.visibilityAudit === true ? {} : options.visibilityAudit)
      : null;
    this.seededRootKeys = options.reusePreviousCandidates === false ? [] : previousRootCandidateKeys.slice();
    this.slowIds = new Uint32Array(this.ringSize); this.slowCpu = new Float32Array(this.ringSize); this.slowRender = new Float32Array(this.ringSize);
    this.slowCalls = new Uint32Array(this.ringSize); this.slowTriangles = new Float64Array(this.ringSize); this.slowCamera = new Float32Array(this.ringSize * 5);
    this.slowTopIds = new Int32Array(this.ringSize * this.topK); this.slowTopIds.fill(-1); this.slowTopDraws = new Uint32Array(this.ringSize * this.topK);
  }

  register(object: THREE.Object3D): void {
    this.visibilityAudit?.register(object);
    const trackGroups = this.levels.includes('group') || this.levels.includes('material');
    const trackMaterials = this.levels.includes('material');
    const requiredBuckets = 1 + (trackGroups ? 1 : 0) + (trackMaterials ? 1 : 0);
    if (this.disposed || this.objectBuckets.has(object) || this.buckets.length > MAX_BUCKETS - requiredBuckets) return;
    let root: THREE.Object3D | null = null; let batch: Record<string, any> | null = null;
    for (let current: THREE.Object3D | null = object; current; current = current.parent) {
      if (current.userData.wmoPick?.kind === 'wmo') root = current;
      if (current.userData.wmoPick?.kind === 'wmoBatch') batch = current.userData.wmoPick;
    }
    if (!root || !batch) return;
    const rootPick = root.userData.wmoPick as Record<string, any>;
    const rootLabel = `${String(rootPick.model ?? 'unknown')}#${String(rootPick.uniqueId ?? '?')}@${String(rootPick.tile ?? '?')}`;
    const rootId = this.ensureBucket('root', -1, `root:${root.uuid}`, rootLabel, root);
    const groupIndex = String(batch.groupIndex ?? '?');
    const groupId = trackGroups ? this.ensureBucket('group', rootId, `group:${root.uuid}:${groupIndex}`, `${rootLabel} / group ${groupIndex}`, object) : -1;
    let materialId = -1;
    if (trackMaterials) {
      const meshMaterial = (object as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      const material = Array.isArray(meshMaterial) ? meshMaterial[0] : meshMaterial;
      const shader = String((material?.userData as Record<string, any> | undefined)?.wowShader ?? '?');
      const materialKey = `${String(batch.tex ?? '?')}:${shader}:${String(batch.blendMode ?? '?')}:${material?.uuid ?? '?'}`;
      materialId = this.ensureBucket('material', groupId, `material:${root.uuid}:${groupIndex}:${materialKey}`, `${rootLabel} / group ${groupIndex} / tex ${String(batch.tex ?? '?')} shader ${shader} blend ${String(batch.blendMode ?? '?')}`, object);
    }
    this.objectBuckets.set(object, { root: rootId, group: groupId, material: materialId });
  }

  beginFrame(): void {
    for (let index = 0; index < this.activeCount; index++) {
      const id = this.activeIds[index]; this.currentDraws[id] = 0; this.currentTriangles[id] = 0;
    }
    this.activeCount = 0; this.frameId++; this.visibilityAudit?.beginFrame();
  }

  observeCamera(camera: THREE.Camera): void {
    this.visibilityAudit?.observeCamera(camera);
    this.cameraX = camera.position.x; this.cameraY = camera.position.y; this.cameraZ = camera.position.z;
    this.cameraYaw = camera.rotation.y; this.cameraPitch = camera.rotation.x;
  }

  record(object: THREE.Object3D, triangles: number): void {
    this.visibilityAudit?.record(object);
    const ids = this.objectBuckets.get(object); if (!ids) return;
    this.increment(ids.root, triangles); if (ids.group >= 0) this.increment(ids.group, triangles); if (ids.material >= 0) this.increment(ids.material, triangles);
  }

  applyAblation(): void {
    this.hidden.length = 0;
    if (!this.currentTest || this.currentVariant() === 0) return;
    const bucket = this.buckets[this.currentTest.bucketId]; if (!bucket) return;
    for (const object of bucket.objects) if (object.visible) { object.visible = false; this.hidden.push(object); }
  }

  restoreAblation(): void {
    for (const object of this.hidden) object.visible = true;
    this.hidden.length = 0;
  }

  endFrame(meta: { cpuMs: number; renderMs: number; calls: number; triangles: number }): void {
    if (this.disposed) return;
    this.visibilityAudit?.endFrame();
    if (this.frameId <= this.discoveryFrames || !this.levels.length) this.recordDiscovery(meta);
    if (!this.levels.length || this.frameId < this.discoveryFrames) return;
    if (this.levelIndex < 0) this.startNextLevel();
    if (!this.currentTest) return;
    if (this.intervalFrame >= this.settleFrames) this.recordTest(this.currentTest, this.currentVariant(), meta);
    this.intervalFrame++;
    if (this.intervalFrame < this.settleFrames + this.sampleFrames) return;
    this.intervalFrame = 0; this.intervalStep++;
    if (this.intervalStep < this.repeats * 2) return;
    this.currentTest.complete = true; this.startNextCandidate();
  }

  applyGpuSamples(samples: ReadonlyMap<number, number>, status: typeof this.gpuStatus): void {
    this.gpuStatus = status; if (status !== 'measured') return;
    for (const test of this.tests) for (let variant = 0; variant < 2; variant++) {
      const offset = variant * MAX_SAMPLES_PER_VARIANT;
      for (let index = 0; index < test.counts[variant]; index++) {
        const value = samples.get(test.frames[offset + index]);
        if (value !== undefined && Number.isFinite(value)) { test.gpu[offset + index] = value; test.gpuValid[offset + index] = 1; }
      }
    }
  }

  snapshot(): WmoDrilldownSnapshot {
    const bucketViews = this.buckets.map((bucket) => {
      const frames = Math.max(1, this.slowFrames + this.normalFrames);
      const slowMean = this.slowDraws[bucket.id] / Math.max(1, this.slowFrames);
      const normalMean = this.normalDraws[bucket.id] / Math.max(1, this.normalFrames);
      return { id: bucket.id, level: bucket.level, parentId: bucket.parentId, key: bucket.key, label: bucket.label,
        meanDraws: round(this.totalDraws[bucket.id] / frames), slowMeanDraws: round(slowMean), normalMeanDraws: round(normalMean), slowDrawUplift: round(slowMean - normalMean),
        meanTriangles: round(this.totalTriangles[bucket.id] / frames), slowPresence: this.slowPresence[bucket.id], normalPresence: this.normalPresence[bucket.id] };
    });
    const slowFrames = this.slowFrameViews();
    if (!this.levels.length) previousRootCandidateKeys = bucketViews.filter((bucket) => bucket.level === 'root')
      .sort((a, b) => b.slowDrawUplift - a.slowDrawUplift || b.meanDraws - a.meanDraws).slice(0, this.candidateLimit).map((bucket) => bucket.key);
    const currentBucket = this.currentTest ? this.buckets[this.currentTest.bucketId] : null;
    return {
      schema: 'vanillagl.wmo-drilldown/v2', active: !this.disposed, intrusive: true, frames: this.frameId,
      limits: { maxBuckets: MAX_BUCKETS, topBucketsPerSlowFrame: this.topK, slowFrameBuffer: this.ringSize },
      discovery: { requestedFrames: this.discoveryFrames, capturedFrames: Math.min(this.frameId, this.discoveryFrames), slowCpuMs: round(this.slowCpuMs), slowFrames: this.slowFrames, normalFrames: this.normalFrames, rootCandidateSource: this.seededRootKeys.length ? 'previous-correlation' : 'current-capture' },
      buckets: bucketViews, slowFrames,
      ablation: { enabled: this.levels.length > 0, status: this.status(), current: currentBucket ? { bucketId: currentBucket.id, label: currentBucket.label, variant: this.currentVariant() ? 'hidden' : 'baseline', progress: round(this.intervalFrame / (this.settleFrames + this.sampleFrames)) } : null,
        results: this.tests.map((test) => this.testView(test)) },
      visibilityAudit: this.visibilityAudit?.snapshot() ?? null,
      overhead: { timingPerDraw: false, note: 'WMO buckets use fixed numeric counters and make no performance.now() call per draw. Frame-boundary wrapper cost is reported separately; compare against a clean capture to bound aggregate counter cost.' },
    };
  }

  dispose(): void { if (this.disposed) return; this.restoreAblation(); this.visibilityAudit?.dispose(); this.disposed = true; }

  private ensureBucket(level: WmoBucketLevel, parentId: number, key: string, label: string, object: THREE.Object3D): number {
    const existing = this.byKey.get(key);
    if (existing !== undefined) { const objects = this.buckets[existing].objects; if (!objects.includes(object)) objects.push(object); return existing; }
    if (this.buckets.length >= MAX_BUCKETS) return 0;
    const id = this.buckets.length; this.buckets.push({ id, level, parentId, key, label, objects: [object] }); this.byKey.set(key, id); return id;
  }

  private increment(id: number, triangles: number): void {
    if (this.currentDraws[id] === 0 && this.activeCount < this.activeIds.length) this.activeIds[this.activeCount++] = id;
    this.currentDraws[id]++; this.currentTriangles[id] += triangles;
  }

  private recordDiscovery(meta: { cpuMs: number; renderMs: number; calls: number; triangles: number }): void {
    const slow = meta.cpuMs >= this.slowCpuMs; if (slow) this.slowFrames++; else this.normalFrames++;
    for (let index = 0; index < this.activeCount; index++) {
      const id = this.activeIds[index]; const draws = this.currentDraws[id];
      this.totalDraws[id] += draws; this.totalTriangles[id] += this.currentTriangles[id];
      if (slow) { this.slowDraws[id] += draws; this.slowPresence[id]++; } else { this.normalDraws[id] += draws; this.normalPresence[id]++; }
    }
    if (!slow) return;
    const slot = this.slowCursor; this.slowIds[slot] = this.frameId; this.slowCpu[slot] = meta.cpuMs; this.slowRender[slot] = meta.renderMs;
    this.slowCalls[slot] = meta.calls; this.slowTriangles[slot] = meta.triangles;
    const camera = slot * 5; this.slowCamera[camera] = this.cameraX; this.slowCamera[camera + 1] = this.cameraY; this.slowCamera[camera + 2] = this.cameraZ; this.slowCamera[camera + 3] = this.cameraYaw; this.slowCamera[camera + 4] = this.cameraPitch;
    const top = slot * this.topK; for (let index = 0; index < this.topK; index++) { this.slowTopIds[top + index] = -1; this.slowTopDraws[top + index] = 0; }
    for (let index = 0; index < this.activeCount; index++) {
      const id = this.activeIds[index]; if (this.buckets[id]?.level !== 'root') continue;
      const draws = this.currentDraws[id]; let position = this.topK - 1;
      if (draws <= this.slowTopDraws[top + position]) continue;
      while (position > 0 && draws > this.slowTopDraws[top + position - 1]) { this.slowTopDraws[top + position] = this.slowTopDraws[top + position - 1]; this.slowTopIds[top + position] = this.slowTopIds[top + position - 1]; position--; }
      this.slowTopDraws[top + position] = draws; this.slowTopIds[top + position] = id;
    }
    this.slowCursor = (slot + 1) % this.ringSize; this.slowCount = Math.min(this.ringSize, this.slowCount + 1);
  }

  private ranked(level: WmoBucketLevel, parentId: number): number[] {
    if (level === 'root' && parentId < 0 && this.seededRootKeys.length) {
      const seeded = this.seededRootKeys.map((key) => this.byKey.get(key)).filter((id): id is number => id !== undefined);
      if (seeded.length) return seeded.slice(0, this.candidateLimit);
    }
    return this.buckets.filter((bucket) => bucket.level === level && (parentId < 0 || bucket.parentId === parentId))
      .sort((a, b) => {
        const upliftA = this.slowDraws[a.id] / Math.max(1, this.slowFrames) - this.normalDraws[a.id] / Math.max(1, this.normalFrames);
        const upliftB = this.slowDraws[b.id] / Math.max(1, this.slowFrames) - this.normalDraws[b.id] / Math.max(1, this.normalFrames);
        return upliftB - upliftA || this.totalDraws[b.id] - this.totalDraws[a.id];
      }).slice(0, this.candidateLimit).map((bucket) => bucket.id);
  }

  private startNextLevel(): void {
    this.levelIndex++;
    if (this.levelIndex >= this.levels.length) { this.currentTest = null; return; }
    const level = this.levels[this.levelIndex]; this.candidates = this.ranked(level, level === 'root' ? -1 : this.parentWinner); this.candidateIndex = -1;
    if (!this.candidates.length) { this.startNextLevel(); return; }
    this.startNextCandidate();
  }

  private startNextCandidate(): void {
    this.candidateIndex++;
    if (this.candidateIndex >= this.candidates.length) {
      const levelTests = this.tests.filter((test) => this.buckets[test.bucketId]?.level === this.levels[this.levelIndex] && test.complete);
      levelTests.sort((a, b) => this.renderDelta(a) - this.renderDelta(b)); this.parentWinner = levelTests[0]?.bucketId ?? -1;
      this.startNextLevel(); return;
    }
    const capacity = MAX_SAMPLES_PER_VARIANT * 2;
    const test: AblationTest = { bucketId: this.candidates[this.candidateIndex], complete: false, counts: new Uint16Array(2), cpu: new Float32Array(capacity), render: new Float32Array(capacity), calls: new Float32Array(capacity), triangles: new Float32Array(capacity), long: new Uint8Array(capacity), frames: new Uint32Array(capacity), gpu: new Float32Array(capacity), gpuValid: new Uint8Array(capacity) };
    this.tests.push(test); this.currentTest = test; this.intervalStep = 0; this.intervalFrame = 0;
  }

  private currentVariant(): number {
    const repeat = Math.floor(this.intervalStep / 2); const withinRepeat = this.intervalStep % 2;
    return repeat % 2 === 0 ? withinRepeat : 1 - withinRepeat;
  }

  private recordTest(test: AblationTest, variant: number, meta: { cpuMs: number; renderMs: number; calls: number; triangles: number }): void {
    const sample = Math.min(MAX_SAMPLES_PER_VARIANT - 1, test.counts[variant]); const offset = variant * MAX_SAMPLES_PER_VARIANT + sample;
    test.cpu[offset] = meta.cpuMs; test.render[offset] = meta.renderMs; test.calls[offset] = meta.calls; test.triangles[offset] = meta.triangles;
    test.long[offset] = meta.cpuMs >= this.slowCpuMs ? 1 : 0; test.frames[offset] = this.frameId;
    test.counts[variant] = Math.min(MAX_SAMPLES_PER_VARIANT, test.counts[variant] + 1);
  }

  private renderDelta(test: AblationTest): number {
    return median(test.render, MAX_SAMPLES_PER_VARIANT, test.counts[1]) - median(test.render, 0, test.counts[0]);
  }

  private testView(test: AblationTest): WmoDrilldownSnapshot['ablation']['results'][number] {
    const base = test.counts[0], hidden = test.counts[1];
    const delta = (values: Float32Array) => base && hidden ? round(median(values, MAX_SAMPLES_PER_VARIANT, hidden) - median(values, 0, base)) : null;
    let baseLong = 0, hiddenLong = 0, baseGpu = 0, hiddenGpu = 0;
    const baseGpuValues = new Float32Array(base), hiddenGpuValues = new Float32Array(hidden);
    for (let index = 0; index < base; index++) { baseLong += test.long[index]; if (test.gpuValid[index]) baseGpuValues[baseGpu++] = test.gpu[index]; }
    for (let index = 0; index < hidden; index++) { const offset = MAX_SAMPLES_PER_VARIANT + index; hiddenLong += test.long[offset]; if (test.gpuValid[offset]) hiddenGpuValues[hiddenGpu++] = test.gpu[offset]; }
    const gpuDelta = baseGpu && hiddenGpu ? round(median(hiddenGpuValues, 0, hiddenGpu) - median(baseGpuValues, 0, baseGpu)) : null;
    const bucket = this.buckets[test.bucketId];
    return { bucketId: bucket.id, level: bucket.level, label: bucket.label, baselineSamples: base, hiddenSamples: hidden,
      renderSubmitCpuDeltaMs: delta(test.render), totalCpuDeltaMs: delta(test.cpu), drawCallDelta: delta(test.calls), triangleDelta: delta(test.triangles), gpuTimeDeltaMs: gpuDelta,
      longFrameDelta: base && hidden ? hiddenLong - baseLong : null, gpuStatus: this.gpuStatus, complete: test.complete };
  }

  private slowFrameViews(): WmoDrilldownSnapshot['slowFrames'] {
    const result: WmoDrilldownSnapshot['slowFrames'] = []; const start = (this.slowCursor - this.slowCount + this.ringSize) % this.ringSize;
    for (let index = 0; index < this.slowCount; index++) {
      const slot = (start + index) % this.ringSize; const camera = slot * 5; const top = slot * this.topK;
      const topBuckets: WmoDrilldownSnapshot['slowFrames'][number]['topBuckets'] = [];
      for (let rank = 0; rank < this.topK; rank++) { const id = this.slowTopIds[top + rank]; if (id < 0) continue; const bucket = this.buckets[id]; topBuckets.push({ id, label: bucket.label, level: bucket.level, draws: this.slowTopDraws[top + rank] }); }
      result.push({ id: this.slowIds[slot], cpuMs: round(this.slowCpu[slot]), renderMs: round(this.slowRender[slot]), calls: this.slowCalls[slot], triangles: Math.round(this.slowTriangles[slot]),
        camera: { x: round(this.slowCamera[camera]), y: round(this.slowCamera[camera + 1]), z: round(this.slowCamera[camera + 2]), yaw: round(this.slowCamera[camera + 3]), pitch: round(this.slowCamera[camera + 4]) }, topBuckets });
    }
    return result;
  }

  private status(): string {
    if (!this.levels.length) return 'correlation-only';
    if (this.frameId < this.discoveryFrames) return `discovering ${this.frameId}/${this.discoveryFrames}`;
    if (this.levelIndex >= this.levels.length) return 'complete';
    return this.currentTest ? `ablating ${this.levels[this.levelIndex]} ${this.candidateIndex + 1}/${this.candidates.length}` : 'preparing';
  }
}
