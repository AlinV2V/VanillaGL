import * as THREE from 'three';
import { qaGlobals } from '../qa-globals';
import { runtimeWorkScheduler } from '../platform/runtime-work-scheduler';
import { adaptiveQualityDiagnostics, recordAdaptiveQualityFrame, recordAdaptiveQualityCpu, resetAdaptiveQualityFrameTiming } from '../platform/adaptive-quality';
import { FrameRateGate, shouldRunPerformanceFrame } from '../platform/mobile-frame-rate-gate';
import { getPerformanceProfile } from '../platform/performance-profile';
import { recordRuntimeAttribution, runtimeAttributionDiagnostics } from '../platform/runtime-attribution';
import { contentDeliveryDiagnostics } from '../assets/content-delivery';
import { assetRequestQueue } from '../assets/asset-request-queue';
import { meshoptRuntimeDiagnostics } from '../assets/meshopt-runtime';
import { collisionBvhDiagnostics } from './collision-bvh';
import { worldHydrationDiagnostics } from './world-hydration-scheduler';
import { optimizedTextureDiagnostics } from './optimized-texture-loader';
import { beginTextureUploadFrame, endTextureUploadFrame, textureUploadAdmissionDiagnostics } from './texture-upload-admission';
import { worldRenderAdmissionDiagnostics } from './world-render-admission';
import { worldModelDataCacheDiagnostics } from './world-model-data-cache';
import { worldTextureCacheDiagnostics } from './world-texture-cache';
import { waterFrameTextureDiagnostics } from '../water-material';
import { canvasImageCacheDiagnostics } from '../ui/canvas-image-cache';
import { webglContextDiagnostics } from './webgl-context-registry';
import { m2GpuSkinningDiagnostics } from './m2-gpu-skinning';
import { installPerformanceHud } from './performance-hud';
import { installPerformanceDiagnosis } from './performance-diagnosis-runner';
import { performanceFrameProfiler } from './performance-frame-profiler';
import {
  setPerformanceDetailInstrumentationSource,
  setPerformanceInstrumentationSource,
  onPerformanceControlChange,
} from './performance-controls';
import {
  beginPerformanceSubsystemFrame,
  performanceSubsystemDiagnostics,
  resetPerformanceSubsystemMetrics,
} from './performance-subsystem-metrics';
import { estimateSceneMemory } from './performance-scene-memory';
import { performanceGpuInfo } from './performance-gpu-info';
import { beginCpuScope, cpuScopeProfiler, CpuScopeId, endCpuScope } from './performance-cpu-scopes';
import { RendererAttributionSession, type RendererAttributionOptions } from './performance-renderer-attribution';
import {
  buildPerformanceCaptureReport,
  publishPerformanceCaptureReport,
  roundPerformance,
  type PhaseAccumulator,
  type ResourceRecord,
} from './performance-capture-report';
export { beginCpuScope, CpuScopeId, endCpuScope };
export { summarizePerformanceSeries } from './performance-capture-report';

type RenderSnapshot = {
  calls: number;
  triangles: number;
  points: number;
  lines: number;
  geometries: number;
  textures: number;
  programs: number;
  jsHeapBytes?: number;
};

type RendererWithCompile = THREE.WebGLRenderer & {
  compileAsync?: (object: THREE.Object3D, camera: THREE.Camera, targetScene?: THREE.Scene) => Promise<unknown>;
};

export type PerformanceSupplementalDiagnostics = Record<string, unknown>;

export type AdvancedPerformanceCaptureOptions = {
  /** Active sample duration after the optional countdown. */
  seconds?: number;
  /** Human-readable route/location label included in the report and filename. */
  label?: string;
  /** Delay before sampling starts, so the tester can return focus to the game. */
  countdown?: number;
  /** Download the completed JSON report. Enabled by default. */
  download?: boolean;
  /** Request EXT_disjoint_timer_query_webgl2 measurements when the browser exposes it. */
  gpu?: boolean;
  /** Enable intrusive per-object attribution and full scene/supplemental boundary snapshots. */
  detail?: boolean;
  /** Enable capture-only numeric hierarchical CPU scopes and renderer category attribution. */
  cpuScopes?: boolean;
  /** Optionally run settled baseline/category-off blocks. Keep the camera fixed for this mode. */
  categoryAblations?: RendererAttributionOptions['ablations'];
  /** Capture-only WMO root/group/material correlation and optional settled hierarchical ablations. */
  wmoDrilldown?: RendererAttributionOptions['wmoDrilldown'];
  /** Download a CSV attribution table alongside JSON. */
  csv?: boolean;
};

type GpuQuery = { query: WebGLQuery; frame: number };

type ActiveCapture = {
  id: number;
  label: string;
  startedAt: number;
  durationMs: number;
  download: boolean;
  rafIntervals: number[];
  frameAtMs: number[];
  validity: { hidden: boolean; qualityChanged: boolean };
  stopValidityWatch: () => void;
  callbackCpu: number[];
  renderCpu: number[];
  calls: number[];
  triangles: number[];
  geometries: number[];
  textures: number[];
  programs: number[];
  heapBytes: number[];
  phases: Map<string, PhaseAccumulator>;
  resources: ResourceRecord[];
  longTasks: number[];
  events: number[];
  supplemental: Array<{ atMs: number; value: PerformanceSupplementalDiagnostics }>;
  scene: Array<{ atMs: number; value: ReturnType<typeof collectSceneSnapshot> }>;
  lastRafAt: number | null;
  frame: number;
  detailRequested: boolean;
  cpuScopesRequested: boolean;
  wmoDrilldownRequested: boolean;
  csvRequested: boolean;
  rendererAttribution: RendererAttributionSession | null;
  observer: PerformanceObserver | null;
  gpu: {
    requested: boolean;
    supported: boolean;
    disjoint: boolean;
    ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
    gl: WebGL2RenderingContext | null;
    pending: GpuQuery[];
    byFrame: Map<number, number>;
    incompleteFrames: Set<number>;
  };
  resolve: (report: Record<string, unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
};

const FRAME_SAMPLES = 360;
const frameTimes = new Float32Array(FRAME_SAMPLES);
const renderTimes = new Float32Array(FRAME_SAMPLES);
let sampleCursor = 0;
let sampleCount = 0;
let latest: RenderSnapshot = { calls: 0, triangles: 0, points: 0, lines: 0, geometries: 0, textures: 0, programs: 0 };
let frameCount = 0;
let shaderPrewarms = 0;
let shaderPrewarmFailures = 0;
let shaderPrewarmPending = false;
let lastScene: THREE.Scene | null = null;
let lastCamera: THREE.Camera | null = null;
let primaryWorldScene: THREE.Scene | null = null;
let shaderPrewarmer: ((object: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene) => Promise<void>) | null = null;
let rendererCompiler: ((object: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene) => Promise<unknown>) | null = null;
let shaderPrewarmQueue: Promise<void> = Promise.resolve();
const prewarmedObjects = new WeakMap<THREE.Object3D, Promise<void>>();
let currentRenderCalls = 0;
let currentRenderTriangles = 0;
let currentRenderPoints = 0;
let currentRenderLines = 0;
let captureSequence = 0;
let activeCapture: ActiveCapture | null = null;
let supplementalDiagnostics: (() => PerformanceSupplementalDiagnostics) | null = null;
let lightweightDiagnostics: (() => PerformanceSupplementalDiagnostics) | null = null;
let lastCaptureReport: Record<string, unknown> | null = null;
let currentPhaseCpuToken = -1;

/** Returns -1 while no advanced capture is active, avoiding performance.now() in normal play. */
export function startPerformancePhase(cpuScope?: CpuScopeId): number {
  currentPhaseCpuToken = cpuScope === undefined ? -1 : cpuScopeProfiler.begin(cpuScope);
  return activeCapture || performanceFrameProfiler.isActive() ? performance.now() : -1;
}

/** Records one named main-loop phase only while the explicit console capture is active. */
export function endPerformancePhase(name: string, startedAt: number): void {
  const cpuToken = currentPhaseCpuToken; currentPhaseCpuToken = -1;
  const capture = activeCapture;
  if (startedAt < 0) { cpuScopeProfiler.end(cpuToken); return; }
  const elapsed = performance.now() - startedAt;
  performanceFrameProfiler.recordPhase(name, elapsed);
  cpuScopeProfiler.end(cpuToken);
  if (!capture) return;
  let accumulator = capture.phases.get(name);
  if (!accumulator) {
    accumulator = { values: [], totalMs: 0, maxMs: 0 };
    capture.phases.set(name, accumulator);
  }
  accumulator.values.push(elapsed);
  accumulator.totalMs += elapsed;
  accumulator.maxMs = Math.max(accumulator.maxMs, elapsed);
}

export function setPerformanceSupplementalDiagnostics(
  provider: (() => PerformanceSupplementalDiagnostics) | null,
): void {
  supplementalDiagnostics = provider;
}

export function setPerformanceLightweightDiagnostics(provider: (() => PerformanceSupplementalDiagnostics) | null): void {
  lightweightDiagnostics = provider;
}

export function setPerformancePrimaryScene(scene: THREE.Scene | null): void {
  primaryWorldScene = scene;
}

export function setPerformanceShaderPrewarmer(
  prewarmer: ((object: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene) => Promise<void>) | null,
): void {
  shaderPrewarmer = prewarmer;
}

/**
 * Compile one staged streamed root exactly once. Callers opt in at a tile/model boundary; ordinary
 * Object3D.add() calls deliberately do not trigger compilation of the entire live world.
 */
export function prewarmPerformanceObject(
  object: THREE.Object3D,
  camera: THREE.Camera,
  scene: THREE.Scene,
  signal?: AbortSignal,
): Promise<void> {
  const existing = prewarmedObjects.get(object);
  if (existing) return existing;
  const compile = async () => {
    const started = performance.now();
    shaderPrewarmPending = true;
    try {
      if (signal?.aborted) return;
      if (shaderPrewarmer) await shaderPrewarmer(object, camera, scene);
      else if (rendererCompiler) await rendererCompiler(object, camera, scene);
      shaderPrewarms++;
    } catch {
      shaderPrewarmFailures++;
    } finally {
      shaderPrewarmPending = false;
      recordRuntimeAttribution('shader-prewarm', 'streamed-root', performance.now() - started);
    }
  };
  const pending = shaderPrewarmQueue.then(compile, compile);
  shaderPrewarmQueue = pending.catch(() => undefined);
  prewarmedObjects.set(object, pending);
  return pending;
}

function collectSceneSnapshot(scene: THREE.Scene | null) {
  let objects = 0;
  let visibleObjects = 0;
  let meshes = 0;
  let visibleMeshes = 0;
  let instancedMeshes = 0;
  let visibleInstances = 0;
  let hiddenInstances = 0;
  let skinnedMeshes = 0;
  let lights = 0;
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const instanceAttributes: (THREE.BufferAttribute | THREE.InterleavedBufferAttribute)[] = [];
  if (scene) scene.traverse((object) => {
    objects++;
    if (object.visible) visibleObjects++;
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) {
      meshes++;
      if (mesh.visible) visibleMeshes++;
      if (mesh.geometry) geometries.add(mesh.geometry);
      const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of meshMaterials) if (material) materials.add(material);
    }
    const instanced = object as THREE.InstancedMesh;
    if (instanced.isInstancedMesh) {
      instancedMeshes++;
      instanceAttributes.push(instanced.instanceMatrix); if (instanced.instanceColor) instanceAttributes.push(instanced.instanceColor);
      if (instanced.visible) visibleInstances += instanced.count;
      else hiddenInstances += instanced.count;
    }
    if ((object as THREE.SkinnedMesh).isSkinnedMesh) skinnedMeshes++;
    if ((object as THREE.Light).isLight) lights++;
  });
  return {
    objects,
    visibleObjects,
    meshes,
    visibleMeshes,
    instancedMeshes,
    visibleInstances,
    hiddenInstances,
    skinnedMeshes,
    lights,
    uniqueGeometries: geometries.size,
    uniqueMaterials: materials.size,
    memoryEstimate: estimateSceneMemory(geometries, materials, instanceAttributes),
  };
}

function safeSupplementalSnapshot(): PerformanceSupplementalDiagnostics {
  let supplemental: PerformanceSupplementalDiagnostics = {};
  try { supplemental = supplementalDiagnostics?.() ?? {}; }
  catch (error) { supplemental = { error: (error as Error).message }; }
  return {
    ...(lightweightDiagnostics?.() ?? {}),
    ...supplemental,
    runtimePipeline: runtimePipelineSnapshot(),
  };
}

function captureBoundarySnapshot(deep: boolean): PerformanceSupplementalDiagnostics {
  if (deep) return safeSupplementalSnapshot();
  return {
    ...(lightweightDiagnostics?.() ?? {}),
    subsystemCosts: performanceSubsystemDiagnostics(),
    runtimePipeline: runtimePipelineSnapshot(),
  };
}

function runtimePipelineSnapshot() {
  return {
    scheduler: runtimeWorkScheduler.stats(),
    hydration: worldHydrationDiagnostics(),
    attribution: runtimeAttributionDiagnostics(),
    shader: { prewarms: shaderPrewarms, failures: shaderPrewarmFailures, pending: shaderPrewarmPending },
    textures: optimizedTextureDiagnostics(),
    textureUploads: textureUploadAdmissionDiagnostics(),
    delivery: contentDeliveryDiagnostics(),
    assetRequests: assetRequestQueue.stats(),
    geometry: meshoptRuntimeDiagnostics(),
    collision: collisionBvhDiagnostics(),
    renderAdmission: worldRenderAdmissionDiagnostics(),
    modelDataCache: worldModelDataCacheDiagnostics(),
    worldTextureCache: worldTextureCacheDiagnostics(),
    waterFrameTextures: waterFrameTextureDiagnostics(),
    canvasImages: canvasImageCacheDiagnostics(),
    webglContexts: webglContextDiagnostics(),
    m2GpuSkinning: m2GpuSkinningDiagnostics(),
  };
}

function installCaptureObserver(capture: ActiveCapture): PerformanceObserver | null {
  if (typeof PerformanceObserver === 'undefined') return null;
  const supported = new Set(PerformanceObserver.supportedEntryTypes ?? []);
  const types = ['resource', 'longtask', 'event'].filter((type) => supported.has(type));
  if (!types.length) return null;
  try {
    const observer = new PerformanceObserver((list) => {
      if (activeCapture !== capture) return;
      for (const entry of list.getEntries()) {
        if (entry.entryType === 'resource') {
          const resource = entry as PerformanceResourceTiming;
          capture.resources.push({
            name: resource.name,
            initiatorType: resource.initiatorType,
            durationMs: resource.duration,
            transferBytes: resource.transferSize,
            encodedBytes: resource.encodedBodySize,
          });
        } else if (entry.entryType === 'longtask') {
          capture.longTasks.push(entry.duration);
        } else if (entry.entryType === 'event' && entry.duration >= 16) {
          capture.events.push(entry.duration);
        }
      }
    });
    observer.observe({ entryTypes: types });
    return observer;
  } catch {
    return null;
  }
}

function beginGpuQuery(capture: ActiveCapture): WebGLQuery | null {
  const { gl, ext } = capture.gpu;
  if (!capture.gpu.supported || !gl || !ext) return null;
  if (capture.gpu.pending.length >= 256) { capture.gpu.incompleteFrames.add(capture.frame); capture.gpu.byFrame.delete(capture.frame); return null; }
  try {
    const query = gl.createQuery();
    if (!query) { capture.gpu.incompleteFrames.add(capture.frame); return null; }
    gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    return query;
  } catch {
    capture.gpu.supported = false;
    return null;
  }
}

function endGpuQuery(capture: ActiveCapture, query: WebGLQuery | null): void {
  const { gl, ext } = capture.gpu;
  if (!query || !gl || !ext) return;
  try {
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    capture.gpu.pending.push({ query, frame: capture.frame });
  } catch {
    gl.deleteQuery(query);
    capture.gpu.supported = false;
  }
}

function pollGpuQueries(capture: ActiveCapture): void {
  const { gl, ext } = capture.gpu;
  if (!gl || !ext) return;
  capture.gpu.disjoint ||= Boolean(gl.getParameter(ext.GPU_DISJOINT_EXT));
  if (capture.gpu.disjoint) capture.gpu.byFrame.clear();
  const keep: GpuQuery[] = [];
  for (const pending of capture.gpu.pending) {
    const available = gl.getQueryParameter(pending.query, gl.QUERY_RESULT_AVAILABLE) as boolean;
    if (!available) { keep.push(pending); continue; }
    const nanoseconds = gl.getQueryParameter(pending.query, gl.QUERY_RESULT) as number;
    gl.deleteQuery(pending.query);
    if (!capture.gpu.disjoint && !capture.gpu.incompleteFrames.has(pending.frame) && Number.isFinite(nanoseconds)) {
      capture.gpu.byFrame.set(pending.frame, (capture.gpu.byFrame.get(pending.frame) ?? 0) + nanoseconds / 1_000_000);
    }
  }
  capture.gpu.pending = keep;
}

async function finishCapture(capture: ActiveCapture): Promise<void> {
  if (activeCapture !== capture) return;
  activeCapture = null;
  const endedAt = performance.now();
  clearTimeout(capture.timer);
  capture.stopValidityWatch();
  capture.observer?.disconnect();
  pollGpuQueries(capture);
  for (const pending of capture.gpu.pending) {
    capture.gpu.byFrame.delete(pending.frame); // Never report a partly measured multi-pass frame.
    capture.gpu.gl?.deleteQuery(pending.query);
  }
  capture.gpu.pending.length = 0;
  for (const frame of capture.gpu.incompleteFrames) capture.gpu.byFrame.delete(frame);
  capture.rendererAttribution?.applyGpuSamples(
    capture.gpu.byFrame,
    capture.gpu.disjoint ? 'invalid-disjoint' : capture.gpu.supported ? 'measured' : 'unavailable-unattributed',
  );
  const cpuScopes = capture.cpuScopesRequested ? cpuScopeProfiler.snapshot() : null;
  const rendererAttribution = capture.rendererAttribution?.snapshot() ?? null;
  capture.rendererAttribution?.dispose();
  capture.rendererAttribution = null;
  cpuScopeProfiler.setEnabled(false);
  setPerformanceInstrumentationSource('capture', false);
  setPerformanceDetailInstrumentationSource('capture-detail', false);

  const durationMs = endedAt - capture.startedAt;
  // Full scene traversal is intentionally sampled only at the boundaries. Doing it from the
  // one-second in-frame sampler turns the profiler itself into a periodic long task in dense
  // scenes (Goldshire has roughly 14k objects), contaminating the FPS result it is measuring.
  capture.supplemental.push({ atMs: roundPerformance(durationMs), value: captureBoundarySnapshot(capture.detailRequested) });
  if (capture.detailRequested) {
    capture.scene.push({ atMs: roundPerformance(durationMs), value: collectSceneSnapshot(primaryWorldScene ?? lastScene) });
  }
  const report = buildPerformanceCaptureReport({ capture, durationMs, cpuScopes, rendererAttribution });
  lastCaptureReport = report;
  qaGlobals.__vanillaPerfLastCapture = report;
  publishPerformanceCaptureReport(report, capture, cpuScopes, rendererAttribution);
  capture.resolve(report);
}

function createCapture(
  renderer: THREE.WebGLRenderer,
  options: AdvancedPerformanceCaptureOptions,
  resolve: (report: Record<string, unknown>) => void,
): ActiveCapture {
  const requestedDetail = options.detail === true;
  const requestedCpuScopes = options.cpuScopes === true;
  const requestedWmoDrilldown = options.wmoDrilldown !== undefined;
  if (options.categoryAblations?.categories?.length && options.wmoDrilldown) {
    throw new Error('Run categoryAblations and wmoDrilldown in separate settled captures.');
  }
  setPerformanceInstrumentationSource('capture', true);
  setPerformanceDetailInstrumentationSource('capture-detail', requestedDetail);
  cpuScopeProfiler.setEnabled(requestedCpuScopes);
  resetPerformanceSubsystemMetrics();
  const seconds = Math.max(0.05, Math.min(300, Number(options.seconds ?? 30)));
  const requestedGpu = options.gpu === true;
  let gl: WebGL2RenderingContext | null = null;
  let ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  try {
    const context = renderer.getContext?.();
    if (requestedGpu && typeof WebGL2RenderingContext !== 'undefined' && context instanceof WebGL2RenderingContext) {
      gl = context;
      ext = context.getExtension('EXT_disjoint_timer_query_webgl2');
    }
  } catch { /* extension remains unavailable */ }
  let rendererAttribution: RendererAttributionSession | null = null;
  try {
    if (requestedCpuScopes || requestedWmoDrilldown || options.categoryAblations?.categories?.length) rendererAttribution = new RendererAttributionSession(
      renderer,
      () => primaryWorldScene ?? lastScene,
      {
        ablations: options.categoryAblations,
        wmoDrilldown: options.wmoDrilldown,
        wmoOnly: requestedWmoDrilldown && !requestedCpuScopes && !options.categoryAblations?.categories?.length,
      },
    );
  } catch (error) {
    cpuScopeProfiler.setEnabled(false);
    setPerformanceInstrumentationSource('capture', false);
    setPerformanceDetailInstrumentationSource('capture-detail', false);
    throw error;
  }
  const capture: ActiveCapture = {
    id: ++captureSequence,
    label: String(options.label ?? 'walk'),
    startedAt: 0,
    durationMs: seconds * 1_000,
    download: options.download !== false,
    rafIntervals: [], frameAtMs: [], callbackCpu: [], renderCpu: [], calls: [], triangles: [], geometries: [], textures: [], programs: [], heapBytes: [],
    validity: { hidden: typeof document !== 'undefined' && document.hidden, qualityChanged: false }, stopValidityWatch: () => {},
    phases: new Map(), resources: [], longTasks: [], events: [], supplemental: [], scene: [],
    lastRafAt: null, frame: 0, detailRequested: requestedDetail, cpuScopesRequested: requestedCpuScopes,
    wmoDrilldownRequested: requestedWmoDrilldown,
    csvRequested: options.csv === true, rendererAttribution, observer: null,
    gpu: {
      requested: requestedGpu,
      supported: Boolean(gl && ext),
      disjoint: false,
      ext,
      gl,
      pending: [],
      byFrame: new Map(),
      incompleteFrames: new Set(),
    },
    resolve,
    timer: 0 as unknown as ReturnType<typeof setTimeout>,
  };
  capture.supplemental.push({ atMs: 0, value: captureBoundarySnapshot(requestedDetail) });
  if (requestedDetail) capture.scene.push({ atMs: 0, value: collectSceneSnapshot(primaryWorldScene ?? lastScene) });
  capture.startedAt = performance.now();
  const hidden = () => { capture.validity.hidden ||= document.hidden; };
  const quality = () => { capture.validity.qualityChanged = true; };
  const stopControlWatch = onPerformanceControlChange(quality);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', hidden);
  if (typeof window !== 'undefined') {
    window.addEventListener('vanillagl-adaptive-quality', quality);
    window.addEventListener('resize', quality);
  }
  capture.stopValidityWatch = () => {
    stopControlWatch();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', hidden);
    if (typeof window !== 'undefined') {
      window.removeEventListener('vanillagl-adaptive-quality', quality);
      window.removeEventListener('resize', quality);
    }
  };
  capture.observer = installCaptureObserver(capture);
  capture.timer = setTimeout(() => { void finishCapture(capture); }, capture.durationMs);
  return capture;
}

function quantile(values: Float32Array, count: number, q: number): number {
  if (!count) return 0;
  const copy = Array.from(values.subarray(0, count)).sort((a, b) => a - b);
  return copy[Math.min(copy.length - 1, Math.max(0, Math.floor((copy.length - 1) * q)))] ?? 0;
}

function heapBytes(): number | undefined {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
  return memory?.usedJSHeapSize;
}

export function installPerformanceRuntime(renderer: THREE.WebGLRenderer, log?: (message: string) => void): void {
  const wrapped = renderer as RendererWithCompile & { __vglPerformanceRuntime?: boolean };
  if (wrapped.__vglPerformanceRuntime) return;
  wrapped.__vglPerformanceRuntime = true;
  rendererCompiler = typeof wrapped.compileAsync === 'function'
    ? (object, camera, scene) => wrapped.compileAsync!(object, camera, scene)
    : null;

  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  const requestedBudget = Number(params?.get('workbudget') ?? 1.25);
  const mainThreadBudgetMs = Number.isFinite(requestedBudget) ? Math.max(0.25, Math.min(4, requestedBudget)) : 1.25;

  const originalRender = renderer.render.bind(renderer);
  performanceFrameProfiler.configureGpu(renderer);
  renderer.render = ((scene: THREE.Object3D, camera: THREE.Camera) => {
    if (scene instanceof THREE.Scene) { lastScene = scene; lastCamera = camera; }
    const info = renderer.info;
    const before = info.autoReset ? null : { ...info.render };
    const capture = activeCapture;
    const gpuQuery = capture ? beginGpuQuery(capture) : null;
    const profilerGpuQuery = capture ? null : performanceFrameProfiler.beginGpuScope();
    const started = performance.now();
    let result: ReturnType<typeof originalRender>;
    try {
      result = originalRender(scene as THREE.Scene, camera);
    } finally {
      if (capture) endGpuQuery(capture, gpuQuery);
      else performanceFrameProfiler.endGpuScope(profilerGpuQuery);
    }
    const elapsed = performance.now() - started;
    renderTimes[sampleCursor] += elapsed;
    currentRenderCalls += info.render.calls - (before?.calls ?? 0);
    currentRenderTriangles += info.render.triangles - (before?.triangles ?? 0);
    currentRenderPoints += info.render.points - (before?.points ?? 0);
    currentRenderLines += info.render.lines - (before?.lines ?? 0);
    return result;
  }) as typeof renderer.render;

  const originalSetAnimationLoop = renderer.setAnimationLoop.bind(renderer);
  const mobileFrameGate = new FrameRateGate();
  const resetMobileFrameCadence = () => {
    mobileFrameGate.reset();
    resetAdaptiveQualityFrameTiming();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', resetMobileFrameCadence);
  renderer.setAnimationLoop = ((callback: XRFrameRequestCallback | null) => {
    runtimeWorkScheduler.setAnimationLoopActive(callback !== null);
    if (!callback) { originalSetAnimationLoop(null); return; }
    resetMobileFrameCadence();
    const wrappedCallback: XRFrameRequestCallback = (time, frame) => {
      const profile = getPerformanceProfile();
      const xrPresenting = renderer.xr?.isPresenting ?? false;
      if (!shouldRunPerformanceFrame(mobileFrameGate, profile, xrPresenting, time)) return;
      if ((profile.device.mobile || profile.device.tier !== 'high') && !xrPresenting) recordAdaptiveQualityFrame(time);
      const started = performance.now();
      const capture = activeCapture;
      let finishAfterFrame = false;
      cpuScopeProfiler.beginFrame(time);
      capture?.rendererAttribution?.beginFrame();
      performanceFrameProfiler.beginFrame(time);
      beginPerformanceSubsystemFrame();
      beginTextureUploadFrame(time);
      if (capture) {
        capture.frame++;
        if (capture.lastRafAt !== null) capture.rafIntervals.push(time - capture.lastRafAt);
        capture.lastRafAt = time;
      }
      renderTimes[sampleCursor] = 0;
      currentRenderCalls = 0;
      currentRenderTriangles = 0;
      currentRenderPoints = 0;
      currentRenderLines = 0;
      const schedulerStarted = startPerformancePhase(CpuScopeId.RuntimeWorkScheduler);
      runtimeWorkScheduler.pump(mainThreadBudgetMs);
      endPerformancePhase('runtime-work-scheduler', schedulerStarted);
      callback(time, frame);
      const frameMs = performance.now() - started;
      if ((profile.device.mobile || profile.device.tier !== 'high') && !xrPresenting) recordAdaptiveQualityCpu(frameMs, renderTimes[sampleCursor]);
      endTextureUploadFrame(frameMs);
      frameTimes[sampleCursor] = frameMs;
      if (capture && activeCapture === capture) {
        capture.callbackCpu.push(frameMs);
        capture.renderCpu.push(renderTimes[sampleCursor]);
        capture.calls.push(currentRenderCalls);
        capture.triangles.push(currentRenderTriangles);
        capture.geometries.push(renderer.info.memory.geometries);
        capture.textures.push(renderer.info.memory.textures);
        capture.programs.push(renderer.info.programs?.length ?? 0);
        const heap = heapBytes();
        if (heap !== undefined) capture.heapBytes.push(heap);
        pollGpuQueries(capture);
        const elapsed = performance.now() - capture.startedAt;
        capture.frameAtMs.push(elapsed);
        finishAfterFrame = elapsed >= capture.durationMs;
      }
      cpuScopeProfiler.endFrame({
        cpuMs: frameMs, renderMs: renderTimes[sampleCursor], calls: currentRenderCalls, triangles: currentRenderTriangles,
      });
      capture?.rendererAttribution?.endFrame({ cpuMs: frameMs, calls: currentRenderCalls, triangles: currentRenderTriangles });
      performanceFrameProfiler.endFrame({
        callbackCpuMs: frameMs,
        renderCpuMs: renderTimes[sampleCursor],
        calls: currentRenderCalls,
        triangles: currentRenderTriangles,
      });
      sampleCursor = (sampleCursor + 1) % FRAME_SAMPLES;
      sampleCount = Math.min(FRAME_SAMPLES, sampleCount + 1);
      frameCount++;
      if (finishAfterFrame && capture) void finishCapture(capture);

      if (frameCount % 60 === 0) {
        const info = renderer.info;
        latest = {
          calls: currentRenderCalls,
          triangles: currentRenderTriangles,
          points: currentRenderPoints,
          lines: currentRenderLines,
          geometries: info.memory.geometries,
          textures: info.memory.textures,
          programs: info.programs?.length ?? 0,
          jsHeapBytes: heapBytes(),
        };
      }
    };
    originalSetAnimationLoop(wrappedCallback);
  }) as typeof renderer.setAnimationLoop;

  const diagnostics = () => ({
    frame: {
      samples: sampleCount,
      p50Ms: quantile(frameTimes, sampleCount, 0.5),
      p95Ms: quantile(frameTimes, sampleCount, 0.95),
      p99Ms: quantile(frameTimes, sampleCount, 0.99),
      renderP95Ms: quantile(renderTimes, sampleCount, 0.95),
      target120HzMs: 1000 / 120,
      target60HzMs: 1000 / 60,
    },
    renderer: latest,
    mobile: {
      profile: getPerformanceProfile().id,
      adaptiveQuality: adaptiveQualityDiagnostics(),
      effectivePixelRatio: renderer.getPixelRatio?.() ?? 1,
      drawingBufferWidth: renderer.domElement?.width ?? 0,
      drawingBufferHeight: renderer.domElement?.height ?? 0,
    },
    gpuInfo: performanceGpuInfo(renderer.getContext?.()),
    ...runtimePipelineSnapshot(),
    subsystems: safeSupplementalSnapshot(),
  });

  qaGlobals.__vanillaPerf = diagnostics;
  qaGlobals.__vanillaPerfFrameSamples = () => sampleCount;
  qaGlobals.__vanillaWorkQueue = () => runtimeWorkScheduler.stats();
  qaGlobals.__vanillaPerfLastCapture = lastCaptureReport;
  qaGlobals.__vanillaPerfCpuProfile = async (options: { label?: string; seconds?: number } = {}) => {
    const nativeConsole = console as Console & { profile?: (label?: string) => void; profileEnd?: (label?: string) => void };
    const label = String(options.label ?? 'VanillaGL Stormwind');
    const seconds = Math.max(1, Math.min(300, Number(options.seconds ?? 10)));
    if (typeof nativeConsole.profile !== 'function' || typeof nativeConsole.profileEnd !== 'function') {
      throw new Error('Chrome native CPU profiling is unavailable. Open DevTools and use the Performance panel CPU profiler.');
    }
    console.warn('Starting external Chrome/V8 sampling. This data is not part of the in-page attribution report.');
    nativeConsole.profile(label);
    await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1_000));
    nativeConsole.profileEnd(label);
    return { source: 'external-chrome-devtools', label, seconds, exportedByPage: false };
  };
  const runPerformanceCapture = async (options: AdvancedPerformanceCaptureOptions = {}) => {
    if (activeCapture) throw new Error(`A performance capture is already active (${activeCapture.label}).`);
    const countdown = Math.max(0, Math.min(10, Number(options.countdown ?? 3)));
    console.log(
      `VanillaGL capture will begin in ${countdown}s and run for ${Math.max(0.05, Math.min(300, Number(options.seconds ?? 30)))}s. ` +
      (options.categoryAblations ? 'Keep the camera and character still; categories will temporarily disappear.' : 'Follow the same route for comparable captures.') + ' Keep this tab visible.',
    );
    if (countdown > 0) await new Promise<void>((resolve) => setTimeout(resolve, countdown * 1_000));
    const captureDuringCountdown = activeCapture as ActiveCapture | null;
    if (captureDuringCountdown) throw new Error(`A performance capture started during the countdown (${captureDuringCountdown.label}).`);
    return new Promise<Record<string, unknown>>((resolve) => {
      const capture = createCapture(renderer, options, resolve);
      activeCapture = capture;
      console.log(`VanillaGL capture started: ${capture.label} (${capture.durationMs / 1_000}s).`);
    });
  };
  qaGlobals.__vanillaPerfCapture = runPerformanceCapture;
  installPerformanceDiagnosis(runPerformanceCapture);
  qaGlobals.__vanillaMobileSoak = (options: AdvancedPerformanceCaptureOptions = {}) => runPerformanceCapture({
    seconds: 120, countdown: 3, download: true, gpu: true, label: 'mobile-soak', ...options,
  });
  installPerformanceHud(diagnostics);
  log?.(`Performance runtime: ${mainThreadBudgetMs.toFixed(2)}ms/frame work budget, shader prewarm enabled`);
}
