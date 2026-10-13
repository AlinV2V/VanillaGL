import * as THREE from 'three';
import { beginCpuScope, CpuScopeId, endCpuScope } from './performance-cpu-scopes';
import { wmoBatchedSubmissionMetrics } from './wmo-batched-experiment';
import {
  WmoDrilldownSession,
  type WmoDrilldownOptions,
  type WmoDrilldownSnapshot,
} from './performance-wmo-drilldown';

export const enum RendererCategoryId {
  Terrain,
  WmoBuildings,
  WmoDoodads,
  TerrainDoodads,
  Grass,
  Entities,
  Particles,
  Shadows,
  Water,
  Ui,
  Other,
}

export const RENDERER_CATEGORY_NAMES = [
  'terrain', 'wmo-buildings', 'wmo-doodads', 'terrain-doodads', 'grass', 'entities',
  'particles', 'shadows', 'water', 'ui', 'other',
] as const;

const CATEGORY_COUNT = RENDERER_CATEGORY_NAMES.length;
const FRAME_HISTORY = 360;
const MAX_ABLATION_SAMPLES = 120;
const SLOW_FRAME_MS = 1_000 / 60;

type CategoryEntry = {
  object: THREE.Object3D;
  category: RendererCategoryId;
  original: THREE.Object3D['onBeforeRender'];
  wrapper: THREE.Object3D['onBeforeRender'];
  wmoRoot: string | null;
  wmoGroup: string | null;
  doodadSource: string | null;
  doodadCell: string | null;
  doodadPart: string | null;
  lastSeenFrame: number;
  savedVisible: boolean;
};

type MatrixEntry = {
  object: THREE.Object3D;
  original: THREE.Object3D['updateMatrixWorld'];
  wrapper: THREE.Object3D['updateMatrixWorld'];
};

export type RendererAttributionOptions = {
  ablations?: {
    categories?: readonly string[];
    settleFrames?: number;
    sampleFrames?: number;
  };
  wmoDrilldown?: WmoDrilldownOptions;
  wmoOnly?: boolean;
};

type MetricSummary = { samples: number; current: number; p50: number; p95: number; max: number; mean: number };

export type RendererAttributionSnapshot = {
  schema: 'vanillagl.renderer-attribution/v2';
  active: boolean;
  intrusive: true;
  cameraChanged: boolean;
  viewSignature: readonly number[] | null;
  frames: number;
  profilerOverhead: { measuredBookkeepingMs: number; meanFrameMs: number; note: string };
  categories: Array<{
    id: number; name: string; visibleObjects: MetricSummary; submittedDraws: MetricSummary;
    triangles: MetricSummary; instancedMeshes: MetricSummary; visibleInstances: MetricSummary;
  }>;
  current: {
    wmoRoots: number; wmoGroups: number; wmoBatches: number; wmoMaterials: number;
    doodadSources: number; doodadCells: number; doodadParts: number;
    materialSwitches: number; programSwitches: null; programSwitchesNote: string;
  };
  frameSamples: Array<{ id: number; categories: Array<{ name: string; visibleObjects: number; submittedDraws: number; triangles: number; instancedMeshes: number; visibleInstances: number }> }>;
  ablations: Array<{
    category: string; baselineSamples: number; ablatedSamples: number;
    renderSubmitCpuDeltaMs: number | null; totalCpuDeltaMs: number | null;
    drawCallDelta: number | null; triangleDelta: number | null; longFrameDelta: number | null;
    gpuTimeDeltaMs: number | null; gpuStatus: 'measured' | 'unavailable-unattributed' | 'invalid-disjoint'; complete: boolean;
  }>;
  wmoDrilldown: WmoDrilldownSnapshot | null;
  nativeRendererInternals: { projectObject: 'native-sampler-only'; renderListSort: 'native-sampler-only'; renderBufferDirect: 'native-sampler-only'; uniforms: 'native-sampler-only' };
};

let liveSession: RendererAttributionSession | null = null;
let latestSnapshot: RendererAttributionSnapshot | null = null;
export const rendererAttributionSnapshot = (): RendererAttributionSnapshot | null => liveSession?.snapshot() ?? latestSnapshot;
export const registerPerformanceWmoObject = (object: THREE.Object3D): void => { liveSession?.registerWmoObject(object); };

const round = (value: number): number => Number(value.toFixed(3));

function stats(values: Float32Array, offset: number, count: number): MetricSummary {
  if (!count) return { samples: 0, current: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  const copy = Array.from(values.subarray(offset, offset + count)).sort((a, b) => a - b);
  let total = 0; for (let index = 0; index < count; index++) total += values[offset + index];
  const at = (q: number) => copy[Math.min(count - 1, Math.floor((count - 1) * q))] ?? 0;
  return { samples: count, current: round(values[offset + count - 1]), p50: round(at(.5)), p95: round(at(.95)), max: round(copy[count - 1] ?? 0), mean: round(total / count) };
}

function categoryFromName(name: string): RendererCategoryId | null {
  const index = RENDERER_CATEGORY_NAMES.indexOf(name.toLowerCase() as typeof RENDERER_CATEGORY_NAMES[number]);
  return index < 0 || index === RendererCategoryId.Other ? null : index as RendererCategoryId;
}

function explicitCategory(value: unknown): RendererCategoryId | null {
  return typeof value === 'string' ? categoryFromName(value) : null;
}

function classify(object: THREE.Object3D, defaultCategory: RendererCategoryId): RendererCategoryId {
  for (let current: THREE.Object3D | null = object; current; current = current.parent) {
    const data = current.userData as Record<string, any>;
    const explicit = explicitCategory(data.vanillaPerfCategory);
    if (explicit !== null) return explicit;
    if (data.isBlobShadow) return RendererCategoryId.Shadows;
    if (data.wowWmoLiquid || data.wowWater) return RendererCategoryId.Water;
    if (data.wowDoodad?.packedGrass || data.wowDoodad?.grass) return RendererCategoryId.Grass;
    if (data.wowDoodad?.kind === 'wmoDoodad') return RendererCategoryId.WmoDoodads;
    if (data.wowDoodad?.kind === 'terrainDoodad') return RendererCategoryId.TerrainDoodads;
    if (data.wmoPick?.kind === 'wmoBatch') return RendererCategoryId.WmoBuildings;
    if (data.worldEntityGuid) return RendererCategoryId.Entities;
  }
  return defaultCategory;
}

function renderMetadata(object: THREE.Object3D) {
  let root: THREE.Object3D | null = null; let batch: Record<string, any> | null = null; let doodad: Record<string, any> | null = null;
  for (let current: THREE.Object3D | null = object; current; current = current.parent) {
    if (current.userData.wmoPick?.kind === 'wmo') root = current;
    if (current.userData.wmoPick?.kind === 'wmoBatch') batch = current.userData.wmoPick;
    if (current.userData.wowDoodad) doodad = current.userData.wowDoodad;
  }
  return {
    wmoRoot: root?.uuid ?? null,
    wmoGroup: root && batch ? `${root.uuid}:${String(batch.groupIndex ?? '?')}` : null,
    doodadSource: typeof doodad?.source === 'string' ? doodad.source : null,
    doodadCell: typeof doodad?.spatialCell === 'string' ? doodad.spatialCell : null,
    doodadPart: doodad ? `${String(doodad.source ?? '?')}:${String(doodad.meshIndex ?? '?')}:${String(doodad.part ?? '?')}` : null,
  };
}

export class RendererAttributionSession {
  private readonly entries: CategoryEntry[] = [];
  private readonly matrices: MatrixEntry[] = [];
  private readonly instrumented = new WeakSet<THREE.Object3D>();
  private readonly instrumentedScenes = new WeakSet<THREE.Object3D>();
  private readonly sceneScanFrame = new WeakMap<THREE.Object3D, number>();
  private readonly hidden: CategoryEntry[] = [];
  private readonly visibleObjects = new Uint32Array(CATEGORY_COUNT);
  private readonly draws = new Uint32Array(CATEGORY_COUNT);
  private readonly triangles = new Float64Array(CATEGORY_COUNT);
  private readonly instancedMeshes = new Uint32Array(CATEGORY_COUNT);
  private readonly instances = new Uint32Array(CATEGORY_COUNT);
  private readonly visibleHistory = new Float32Array(FRAME_HISTORY * CATEGORY_COUNT);
  private readonly drawHistory = new Float32Array(FRAME_HISTORY * CATEGORY_COUNT);
  private readonly triangleHistory = new Float32Array(FRAME_HISTORY * CATEGORY_COUNT);
  private readonly instancedHistory = new Float32Array(FRAME_HISTORY * CATEGORY_COUNT);
  private readonly instanceHistory = new Float32Array(FRAME_HISTORY * CATEGORY_COUNT);
  private readonly wmoRoots = new Set<string>(); private readonly wmoGroups = new Set<string>();
  private readonly wmoMaterials = new Set<string>(); private readonly doodadSources = new Set<string>();
  private readonly doodadCells = new Set<string>(); private readonly doodadParts = new Set<string>();
  private readonly ablationCategories: RendererCategoryId[];
  private readonly ablationCounts = new Uint16Array(CATEGORY_COUNT * 2);
  private readonly ablationCpu = new Float32Array(CATEGORY_COUNT * 2 * MAX_ABLATION_SAMPLES);
  private readonly ablationRender = new Float32Array(CATEGORY_COUNT * 2 * MAX_ABLATION_SAMPLES);
  private readonly ablationCalls = new Float32Array(CATEGORY_COUNT * 2 * MAX_ABLATION_SAMPLES);
  private readonly ablationTriangles = new Float32Array(CATEGORY_COUNT * 2 * MAX_ABLATION_SAMPLES);
  private readonly ablationLong = new Float32Array(CATEGORY_COUNT * 2 * MAX_ABLATION_SAMPLES);
  private readonly ablationFrames = new Uint32Array(CATEGORY_COUNT * 2 * MAX_ABLATION_SAMPLES);
  private readonly ablationGpu = new Float32Array(CATEGORY_COUNT * 2 * MAX_ABLATION_SAMPLES);
  private readonly ablationGpuValid = new Uint8Array(CATEGORY_COUNT * 2 * MAX_ABLATION_SAMPLES);
  private readonly settleFrames: number; private readonly sampleFrames: number;
  private frameId = 0; private cursor = 0; private count = 0; private currentRenderMs = 0;
  private currentAblation = -1; private currentComparison = -1; private currentVariant = 0; private currentSample = false;
  private materialSwitches = 0; private lastMaterial = ''; private measuredOverheadMs = 0; private disposed = false;
  private cameraSignature: number[] | null = null; private cameraChanged = false;
  private ablationGpuStatus: RendererAttributionSnapshot['ablations'][number]['gpuStatus'] = 'unavailable-unattributed';
  private readonly originalRender: THREE.WebGLRenderer['render'];
  private readonly renderWrapper: THREE.WebGLRenderer['render'];
  private readonly wmoDrilldown: WmoDrilldownSession | null;
  private readonly wmoOnly: boolean;

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly primaryScene: () => THREE.Scene | null, options: RendererAttributionOptions = {}) {
    const requested = options.ablations?.categories?.map(categoryFromName).filter((value): value is RendererCategoryId => value !== null) ?? [];
    this.ablationCategories = [...new Set(requested)];
    this.settleFrames = Math.max(1, Math.min(60, Math.floor(options.ablations?.settleFrames ?? 8)));
    this.sampleFrames = Math.max(1, Math.min(MAX_ABLATION_SAMPLES, Math.floor(options.ablations?.sampleFrames ?? 30)));
    this.wmoDrilldown = options.wmoDrilldown ? new WmoDrilldownSession(options.wmoDrilldown) : null;
    this.wmoOnly = options.wmoOnly === true;
    this.originalRender = renderer.render;
    const session = this;
    this.renderWrapper = function (scene: THREE.Object3D, camera: THREE.Camera) {
      const setupStarted = performance.now();
      const primaryWorldRender = scene === session.primaryScene();
      if (primaryWorldRender && session.ablationCategories.length) {
        const signature = [...camera.matrixWorld.elements, ...camera.projectionMatrix.elements, renderer.getPixelRatio?.() ?? 1];
        if (session.cameraSignature?.some((value, index) => Math.abs(value - signature[index]) > 0.00001)) session.cameraChanged = true;
        session.cameraSignature ??= signature;
      }
      session.instrumentScene(scene, primaryWorldRender ? RendererCategoryId.Other : RendererCategoryId.Ui);
      session.applyAblation(); session.wmoDrilldown?.applyAblation(); if (primaryWorldRender) session.wmoDrilldown?.observeCamera(camera);
      const submitStarted = performance.now(); session.measuredOverheadMs += submitStarted - setupStarted;
      const token = beginCpuScope(CpuScopeId.RendererSubmission);
      try { return session.originalRender.call(renderer, scene as THREE.Scene, camera); }
      finally {
        endCpuScope(token); const submitEnded = performance.now(); session.currentRenderMs += submitEnded - submitStarted;
        session.wmoDrilldown?.restoreAblation(); session.restoreAblation(); const overheadEnded = performance.now(); session.measuredOverheadMs += overheadEnded - submitEnded;
      }
    } as THREE.WebGLRenderer['render'];
    renderer.render = this.renderWrapper;
    liveSession = this;
    const primary = primaryScene(); if (primary) this.instrumentScene(primary, RendererCategoryId.Other);
  }

  beginFrame(): void {
    if (this.disposed) return;
    this.frameId++; this.currentRenderMs = 0; this.lastMaterial = ''; this.materialSwitches = 0;
    this.wmoDrilldown?.beginFrame();
    this.visibleObjects.fill(0); this.draws.fill(0); this.triangles.fill(0); this.instancedMeshes.fill(0); this.instances.fill(0);
    this.wmoRoots.clear(); this.wmoGroups.clear(); this.wmoMaterials.clear(); this.doodadSources.clear(); this.doodadCells.clear(); this.doodadParts.clear();
    const span = this.settleFrames + this.sampleFrames; const pair = span * 2; const zero = this.frameId - 1;
    const comparisonIndex = Math.floor(zero / pair); const offset = zero % pair;
    this.currentComparison = this.ablationCategories[comparisonIndex] ?? -1;
    this.currentVariant = offset >= span ? 1 : 0; this.currentAblation = this.currentVariant ? this.currentComparison : -1;
    this.currentSample = this.currentComparison >= 0 && (offset % span) >= this.settleFrames;
  }

  endFrame(meta: { cpuMs: number; calls: number; triangles: number }): void {
    if (this.disposed) return;
    const slot = this.cursor; const offset = slot * CATEGORY_COUNT;
    this.visibleHistory.set(this.visibleObjects, offset); this.drawHistory.set(this.draws, offset);
    this.triangleHistory.set(this.triangles, offset); this.instancedHistory.set(this.instancedMeshes, offset); this.instanceHistory.set(this.instances, offset);
    this.cursor = (slot + 1) % FRAME_HISTORY; this.count = Math.min(FRAME_HISTORY, this.count + 1);
    this.wmoDrilldown?.endFrame({ cpuMs: meta.cpuMs, renderMs: this.currentRenderMs, calls: meta.calls, triangles: meta.triangles });
    if (!this.currentSample) return;
    const category = this.currentComparison; const variant = this.currentVariant; const countIndex = category * 2 + variant;
    const sample = Math.min(MAX_ABLATION_SAMPLES - 1, this.ablationCounts[countIndex]); const base = countIndex * MAX_ABLATION_SAMPLES + sample;
    this.ablationCpu[base] = meta.cpuMs; this.ablationRender[base] = this.currentRenderMs;
    this.ablationCalls[base] = meta.calls; this.ablationTriangles[base] = meta.triangles;
    this.ablationLong[base] = meta.cpuMs > SLOW_FRAME_MS ? 1 : 0;
    this.ablationFrames[base] = this.frameId;
    this.ablationCounts[countIndex] = Math.min(MAX_ABLATION_SAMPLES, this.ablationCounts[countIndex] + 1);
  }

  snapshot(): RendererAttributionSnapshot {
    const ordered = (slot: number, category: number, source: Float32Array) => source[slot * CATEGORY_COUNT + category];
    const slots: number[] = []; const start = (this.cursor - this.count + FRAME_HISTORY) % FRAME_HISTORY;
    for (let index = 0; index < this.count; index++) slots.push((start + index) % FRAME_HISTORY);
    const metric = (source: Float32Array, category: number) => {
      const values = new Float32Array(this.count); for (let index = 0; index < slots.length; index++) values[index] = ordered(slots[index], category, source);
      return stats(values, 0, values.length);
    };
    const categories = Array.from({ length: CATEGORY_COUNT }, (_, id) => ({
      id, name: RENDERER_CATEGORY_NAMES[id], visibleObjects: metric(this.visibleHistory, id), submittedDraws: metric(this.drawHistory, id),
      triangles: metric(this.triangleHistory, id), instancedMeshes: metric(this.instancedHistory, id), visibleInstances: metric(this.instanceHistory, id),
    }));
    const frameSamples = slots.map((slot) => ({ id: this.frameId - this.count + slots.indexOf(slot) + 1, categories: categories.map((category) => ({
      name: category.name, visibleObjects: ordered(slot, category.id, this.visibleHistory), submittedDraws: ordered(slot, category.id, this.drawHistory),
      triangles: Math.round(ordered(slot, category.id, this.triangleHistory)), instancedMeshes: ordered(slot, category.id, this.instancedHistory), visibleInstances: ordered(slot, category.id, this.instanceHistory),
    })) }));
    const snapshot: RendererAttributionSnapshot = {
      schema: 'vanillagl.renderer-attribution/v2', active: !this.disposed, intrusive: true, cameraChanged: this.cameraChanged, viewSignature: this.cameraSignature, frames: this.count,
      profilerOverhead: { measuredBookkeepingMs: round(this.measuredOverheadMs), meanFrameMs: round(this.measuredOverheadMs / Math.max(1, this.frameId)), note: this.wmoOnly
        ? 'Frame-boundary WMO wrapper bookkeeping only. Per-draw counters intentionally avoid timers; quantify their aggregate cost with a clean capture A/B.'
        : 'Capture-only wrapper bookkeeping and category callbacks; native renderer work is excluded.' },
      categories, current: {
        wmoRoots: this.wmoRoots.size, wmoGroups: this.wmoGroups.size, wmoBatches: this.draws[RendererCategoryId.WmoBuildings], wmoMaterials: this.wmoMaterials.size,
        doodadSources: this.doodadSources.size, doodadCells: this.doodadCells.size, doodadParts: this.doodadParts.size,
        materialSwitches: this.materialSwitches, programSwitches: null, programSwitchesNote: 'Three.js does not expose reliable per-draw program switches through its public API.',
      }, frameSamples, ablations: this.ablationCategories.map((category) => this.ablationView(category)),
      wmoDrilldown: this.wmoDrilldown?.snapshot() ?? null,
      nativeRendererInternals: { projectObject: 'native-sampler-only', renderListSort: 'native-sampler-only', renderBufferDirect: 'native-sampler-only', uniforms: 'native-sampler-only' },
    };
    latestSnapshot = snapshot;
    return snapshot;
  }

  applyGpuSamples(samples: ReadonlyMap<number, number>, status: RendererAttributionSnapshot['ablations'][number]['gpuStatus']): void {
    this.ablationGpuStatus = status;
    this.wmoDrilldown?.applyGpuSamples(samples, status);
    if (status !== 'measured') return;
    for (let index = 0; index < this.ablationFrames.length; index++) {
      const frame = this.ablationFrames[index]; const value = frame ? samples.get(frame) : undefined;
      if (value !== undefined && Number.isFinite(value)) { this.ablationGpu[index] = value; this.ablationGpuValid[index] = 1; }
    }
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    if (this.renderer.render === this.renderWrapper) this.renderer.render = this.originalRender;
    for (const entry of this.entries) if (entry.object.onBeforeRender === entry.wrapper) entry.object.onBeforeRender = entry.original;
    for (const entry of this.matrices) if (entry.object.updateMatrixWorld === entry.wrapper) entry.object.updateMatrixWorld = entry.original;
    this.wmoDrilldown?.dispose(); this.restoreAblation();
    if (liveSession === this) liveSession = null;
  }

  registerWmoObject(object: THREE.Object3D): void {
    if (!this.disposed) this.instrumentObject(object, RendererCategoryId.WmoBuildings);
  }

  private instrumentScene(scene: THREE.Object3D, fallback: RendererCategoryId): void {
    if (this.wmoOnly && this.instrumentedScenes.has(scene)) return;
    const lastScan = this.sceneScanFrame.get(scene) ?? -Infinity;
    if (this.frameId - lastScan < 60) return; this.sceneScanFrame.set(scene, this.frameId);
    if (!this.instrumentedScenes.has(scene)) {
      this.instrumentedScenes.add(scene);
      if (!this.wmoOnly) {
        const originalMatrix = scene.updateMatrixWorld; const matrixEntry = {} as MatrixEntry;
        const matrixWrapper = function (force?: boolean) { const token = beginCpuScope(CpuScopeId.SceneTraversalMatrixUpdates); try { return originalMatrix.call(scene, force); } finally { endCpuScope(token); } };
        Object.assign(matrixEntry, { object: scene, original: originalMatrix, wrapper: matrixWrapper }); this.matrices.push(matrixEntry); scene.updateMatrixWorld = matrixWrapper;
      }
    }
    scene.traverse((object) => this.instrumentObject(object, fallback));
  }

  private instrumentObject(object: THREE.Object3D, fallback: RendererCategoryId): void {
    if (this.instrumented.has(object) || (!(object as THREE.Mesh).isMesh && !(object as THREE.Sprite).isSprite && !(object as THREE.Points).isPoints)) return;
    const category = classify(object, fallback); if (this.wmoOnly && category !== RendererCategoryId.WmoBuildings) return;
    this.instrumented.add(object); const metadata = renderMetadata(object); const original = object.onBeforeRender; const session = this;
    const entry = { object, category, original, wmoRoot: metadata.wmoRoot, wmoGroup: metadata.wmoGroup, doodadSource: metadata.doodadSource, doodadCell: metadata.doodadCell, doodadPart: metadata.doodadPart, lastSeenFrame: -1, savedVisible: false } as CategoryEntry;
    if (category === RendererCategoryId.WmoBuildings) this.wmoDrilldown?.register(object);
    const wrapper: THREE.Object3D['onBeforeRender'] = function (this: THREE.Object3D, renderer, scene, camera, geometry, material, group) {
      original.call(this, renderer, scene, camera, geometry, material, group);
      if (session.wmoOnly) session.record(entry, geometry as THREE.BufferGeometry, material as THREE.Material, group as THREE.Group | null);
      else {
        const started = performance.now(); session.record(entry, geometry as THREE.BufferGeometry, material as THREE.Material, group as THREE.Group | null);
        session.measuredOverheadMs += performance.now() - started;
      }
    };
    entry.wrapper = wrapper; this.entries.push(entry); object.onBeforeRender = wrapper;
  }

  private record(entry: CategoryEntry, geometry: THREE.BufferGeometry, material: THREE.Material, group: THREE.Group | null): void {
    const id = entry.category; const object = entry.object as THREE.InstancedMesh;
    if (entry.lastSeenFrame !== this.frameId) {
      entry.lastSeenFrame = this.frameId; this.visibleObjects[id]++;
      if (object.isInstancedMesh) { this.instancedMeshes[id]++; this.instances[id] += Math.max(0, object.count); }
      if (entry.wmoRoot) this.wmoRoots.add(entry.wmoRoot); if (entry.wmoGroup) this.wmoGroups.add(entry.wmoGroup);
      if (entry.doodadSource) this.doodadSources.add(entry.doodadSource); if (entry.doodadCell) this.doodadCells.add(entry.doodadCell); if (entry.doodadPart) this.doodadParts.add(entry.doodadPart);
    }
    const batched = wmoBatchedSubmissionMetrics(entry.object);
    const drawCount = group?.count ?? (Number.isFinite(geometry.drawRange.count) ? geometry.drawRange.count : geometry.index?.count) ?? geometry.getAttribute('position')?.count ?? 0;
    const instanceCount = object.isInstancedMesh ? Math.max(0, object.count) : 1;
    const submittedTriangles = batched?.lastTriangles ?? Math.floor(Math.max(0, drawCount) / 3) * instanceCount;
    this.draws[id] += batched?.lastApiSubmissions ?? 1; this.triangles[id] += submittedTriangles;
    if (id === RendererCategoryId.WmoBuildings) this.wmoDrilldown?.record(entry.object, submittedTriangles);
    if (material.uuid !== this.lastMaterial) { this.lastMaterial = material.uuid; this.materialSwitches++; }
    if (id === RendererCategoryId.WmoBuildings) this.wmoMaterials.add(material.uuid);
  }

  private applyAblation(): void {
    this.hidden.length = 0; if (this.currentAblation < 0) return;
    for (const entry of this.entries) if (entry.category === this.currentAblation && entry.object.visible) {
      entry.savedVisible = true; entry.object.visible = false; this.hidden.push(entry);
    }
  }

  private restoreAblation(): void {
    for (const entry of this.hidden) if (entry.savedVisible) { entry.object.visible = true; entry.savedVisible = false; }
    this.hidden.length = 0;
  }

  private ablationView(category: RendererCategoryId): RendererAttributionSnapshot['ablations'][number] {
    const baseIndex = category * 2; const baseCount = this.ablationCounts[baseIndex]; const offCount = this.ablationCounts[baseIndex + 1];
    const metric = (source: Float32Array, variant: number, count: number) => stats(source, (baseIndex + variant) * MAX_ABLATION_SAMPLES, count);
    const delta = (source: Float32Array) => baseCount && offCount ? round(metric(source, 1, offCount).p50 - metric(source, 0, baseCount).p50) : null;
    let baselineLong = 0, ablatedLong = 0;
    for (let index = 0; index < baseCount; index++) baselineLong += this.ablationLong[baseIndex * MAX_ABLATION_SAMPLES + index];
    for (let index = 0; index < offCount; index++) ablatedLong += this.ablationLong[(baseIndex + 1) * MAX_ABLATION_SAMPLES + index];
    const gpuValues = (variant: number, count: number) => {
      const values = new Float32Array(count); let valid = 0; const offset = (baseIndex + variant) * MAX_ABLATION_SAMPLES;
      for (let index = 0; index < count; index++) if (this.ablationGpuValid[offset + index]) values[valid++] = this.ablationGpu[offset + index];
      return { values, valid };
    };
    const baselineGpu = gpuValues(0, baseCount), ablatedGpu = gpuValues(1, offCount);
    const gpuDelta = baselineGpu.valid > 0 && ablatedGpu.valid > 0 && baselineGpu.valid >= baseCount * .8 && ablatedGpu.valid >= offCount * .8
      ? round(stats(ablatedGpu.values, 0, ablatedGpu.valid).p50 - stats(baselineGpu.values, 0, baselineGpu.valid).p50) : null;
    return { category: RENDERER_CATEGORY_NAMES[category], baselineSamples: baseCount, ablatedSamples: offCount,
      renderSubmitCpuDeltaMs: delta(this.ablationRender), totalCpuDeltaMs: delta(this.ablationCpu), drawCallDelta: delta(this.ablationCalls), triangleDelta: delta(this.ablationTriangles), longFrameDelta: baseCount && offCount ? ablatedLong - baselineLong : null,
      gpuTimeDeltaMs: gpuDelta, gpuStatus: this.ablationGpuStatus, complete: baseCount >= this.sampleFrames && offCount >= this.sampleFrames };
  }
}
