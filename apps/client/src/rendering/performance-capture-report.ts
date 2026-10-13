import type { CpuScopeSnapshot } from './performance-cpu-scopes';
import type { RendererAttributionSnapshot } from './performance-renderer-attribution';
import { PERFORMANCE_BUILD_INFO } from './performance-build-info';
import { performanceControlState } from './performance-controls';
import { performanceGpuInfo } from './performance-gpu-info';
import { downloadPerformanceArtifact, performanceAttributionCsv, safePerformanceLabel } from './performance-capture-export';
import { wmoBatchExperimentSnapshot } from './wmo-batched-experiment';
import { diagnoseCapture } from './performance-diagnosis';
import { particleSubmissionDiagnostics } from './particle-submission';

export type NumericSummary = {
  samples: number; min: number; p50: number; p95: number; p99: number; max: number; mean: number;
};
export type PhaseAccumulator = { values: number[]; totalMs: number; maxMs: number };
export type ResourceRecord = { name: string; initiatorType: string; durationMs: number; transferBytes: number; encodedBytes: number };

export type PerformanceCaptureReportSource = {
  label: string;
  download: boolean;
  csvRequested: boolean;
  detailRequested: boolean;
  cpuScopesRequested: boolean;
  wmoDrilldownRequested: boolean;
  rafIntervals: number[];
  frameAtMs?: number[];
  validity?: { hidden: boolean; qualityChanged: boolean };
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
  supplemental: Array<{ atMs: number; value: Record<string, unknown> }>;
  scene: Array<{ atMs: number; value: unknown }>;
  gpu: {
    requested: boolean; supported: boolean; disjoint: boolean;
    gl: WebGL2RenderingContext | null; byFrame: Map<number, number>;
  };
};

export const roundPerformance = (value: number, digits = 3): number => Number(value.toFixed(digits));

export function summarizePerformanceSeries(values: readonly number[]): NumericSummary {
  if (!values.length) return { samples: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))] ?? 0;
  let total = 0; for (const value of values) total += value;
  return {
    samples: values.length, min: roundPerformance(sorted[0] ?? 0), p50: roundPerformance(at(0.5)),
    p95: roundPerformance(at(0.95)), p99: roundPerformance(at(0.99)),
    max: roundPerformance(sorted[sorted.length - 1] ?? 0), mean: roundPerformance(total / values.length),
  };
}

function resourceSummary(resources: readonly ResourceRecord[]) {
  const groups = new Map<string, { requests: number; transferBytes: number; durationMs: number }>();
  let transferBytes = 0, encodedBytes = 0;
  for (const resource of resources) {
    transferBytes += resource.transferBytes; encodedBytes += resource.encodedBytes;
    let pathname = resource.name; try { pathname = new URL(resource.name).pathname; } catch { /* keep raw value */ }
    const current = groups.get(pathname) ?? { requests: 0, transferBytes: 0, durationMs: 0 };
    current.requests++; current.transferBytes += resource.transferBytes; current.durationMs += resource.durationMs;
    groups.set(pathname, current);
  }
  const repeated = [...groups.entries()].filter(([, value]) => value.requests > 1)
    .sort((a, b) => b[1].requests - a[1].requests || b[1].transferBytes - a[1].transferBytes).slice(0, 25)
    .map(([name, value]) => ({ name, ...value, durationMs: roundPerformance(value.durationMs) }));
  const slowest = [...resources].sort((a, b) => b.durationMs - a.durationMs).slice(0, 25)
    .map((value) => ({ ...value, durationMs: roundPerformance(value.durationMs) }));
  return { requests: resources.length, transferBytes, encodedBytes, repeated, slowest };
}

function numericDeltas(start: unknown, end: unknown, prefix = '', out: Record<string, number> = {}): Record<string, number> {
  if (typeof start === 'number' && typeof end === 'number' && Number.isFinite(start) && Number.isFinite(end)) {
    out[prefix] = roundPerformance(end - start); return out;
  }
  if (!start || !end || typeof start !== 'object' || typeof end !== 'object' || Array.isArray(start) || Array.isArray(end)) return out;
  for (const key of Object.keys(end as Record<string, unknown>)) {
    if (!(key in (start as Record<string, unknown>))) continue;
    const next = prefix ? `${prefix}.${key}` : key;
    numericDeltas((start as Record<string, unknown>)[key], (end as Record<string, unknown>)[key], next, out);
  }
  return out;
}

export function buildPerformanceCaptureReport(input: {
  capture: PerformanceCaptureReportSource;
  durationMs: number;
  cpuScopes: CpuScopeSnapshot | null;
  rendererAttribution: RendererAttributionSnapshot | null;
}): Record<string, any> {
  const { capture, durationMs, cpuScopes, rendererAttribution } = input;
  const gpuValues = capture.gpu.disjoint ? [] : [...capture.gpu.byFrame.values()];
  const phaseCpu = [...capture.phases.entries()].map(([name, accumulator]) => ({
    name, totalMs: roundPerformance(accumulator.totalMs),
    percentOfCapture: roundPerformance((100 * accumulator.totalMs) / Math.max(1, durationMs), 2),
    ...summarizePerformanceSeries(accumulator.values),
  })).sort((a, b) => b.totalMs - a.totalMs);
  const frameInterval = summarizePerformanceSeries(capture.rafIntervals);
  const callbackCpu = summarizePerformanceSeries(capture.callbackCpu);
  const gpu = summarizePerformanceSeries(gpuValues);
  const startDiagnostics = capture.supplemental[0]?.value ?? {};
  const endDiagnostics = capture.supplemental[capture.supplemental.length - 1]?.value ?? {};
  return {
    schema: 'vanillagl.performance-capture/v2', label: capture.label, capturedAt: new Date().toISOString(),
    validity: capture.validity, diagnosis: diagnoseCapture(capture, rendererAttribution),
    page: typeof location !== 'undefined' ? location.href : '', userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    build: PERFORMANCE_BUILD_INFO, controls: performanceControlState(),
    urlFlags: typeof location !== 'undefined' ? Object.fromEntries(new URLSearchParams(location.search).entries()) : {},
    experiments: { wmoBatching: wmoBatchExperimentSnapshot(), particleSubmission: particleSubmissionDiagnostics() },
    environment: {
      viewport: typeof window !== 'undefined' ? [window.innerWidth, window.innerHeight] : null,
      devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : null,
      crossOriginIsolated: typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false,
      gcEventsAvailable: false, exactGpuMemoryBytesAvailable: false, gpu: performanceGpuInfo(capture.gpu.gl),
    },
    instrumentation: {
      mode: capture.wmoDrilldownRequested ? 'wmo-drilldown-intrusive' : capture.cpuScopesRequested ? 'cpu-attribution' : rendererAttribution ? 'category-ablation-intrusive' : capture.detailRequested ? 'deep-attribution' : 'low-overhead',
      gpuQueries: capture.gpu.requested ? 'enabled' : 'disabled', inFrameSupplementalSnapshots: 0,
      boundarySupplementalSnapshots: 2, boundarySceneTraversals: capture.detailRequested ? 2 : 0,
      cpuScopes: capture.cpuScopesRequested ? 'enabled-intrusive' : 'disabled',
      wmoDrilldown: capture.wmoDrilldownRequested ? 'enabled-intrusive' : 'disabled',
      profilerOverhead: { cpuScopes: cpuScopes?.overhead ?? null, rendererCategoryBookkeeping: rendererAttribution?.profilerOverhead ?? null },
      note: capture.wmoDrilldownRequested
        ? 'WMO drill-down counters and ablations are capture-only and intrusive. Correlation locates candidates; repeated hidden blocks measure causality.'
        : capture.cpuScopesRequested
          ? 'CPU scopes and capture-lifetime renderer category callbacks are intrusive. Do not use this run as the clean FPS baseline.'
        : rendererAttribution || capture.detailRequested ? 'Category/deep attribution is intrusive and is not suitable for FPS baselines.'
          : 'Per-object detail and full scene traversal disabled; GPU queries follow the explicit gpu option.',
    },
    durationMs: roundPerformance(durationMs), frames: capture.callbackCpu.length,
    actualFps: roundPerformance((capture.rafIntervals.length * 1_000) / Math.max(1, durationMs)),
    headroom60Hz: {
      cpuP95Ms: roundPerformance(1000 / 60 - callbackCpu.p95), gpuP95Ms: gpu.samples ? roundPerformance(1000 / 60 - gpu.p95) : null,
      note: 'Positive is spare time inside a 16.667ms frame; negative exceeds the 60Hz budget.',
    },
    timing: {
      rafIntervalMs: frameInterval, callbackCpuMs: callbackCpu, renderSubmissionCpuMs: summarizePerformanceSeries(capture.renderCpu),
      gpuFrameMs: gpu,
      gpuStatus: capture.gpu.requested ? capture.gpu.supported ? capture.gpu.disjoint ? 'discarded-disjoint' : gpu.samples ? 'measured' : 'no-complete-samples' : 'extension-unavailable' : 'not-requested',
      longTaskMs: summarizePerformanceSeries(capture.longTasks), slowInputEventMs: summarizePerformanceSeries(capture.events),
    },
    phaseCpu, cpuAttribution: cpuScopes, rendererAttribution,
    nativeSampling: {
      source: 'external-chrome-devtools', includedInThisReport: false,
      note: 'Arbitrary V8 stacks require the Chrome native CPU sampler; in-page scopes do not infer projectObject/renderBufferDirect stacks.',
    },
    renderer: {
      calls: summarizePerformanceSeries(capture.calls), triangles: summarizePerformanceSeries(capture.triangles),
      geometries: summarizePerformanceSeries(capture.geometries), textures: summarizePerformanceSeries(capture.textures),
      programs: summarizePerformanceSeries(capture.programs),
    },
    memory: {
      jsHeapBytes: summarizePerformanceSeries(capture.heapBytes),
      heapDeltaBytes: capture.heapBytes.length > 1 ? capture.heapBytes.at(-1)! - capture.heapBytes[0]! : null,
    },
    resources: resourceSummary(capture.resources), sceneSamples: capture.scene, subsystemSamples: capture.supplemental,
    subsystemCounterDeltas: numericDeltas(startDiagnostics, endDiagnostics),
    runtimePipeline: (endDiagnostics as { runtimePipeline?: unknown }).runtimePipeline ?? null,
    attributionLimitations: [
      'Static texture uploads are scheduler-attributed; render targets and dynamic texture updates remain inside renderSubmissionCpuMs.',
      'Asynchronous fetch and shader-prewarm durations are wall time, while frame phases and scheduler tasks are main-thread CPU time.',
      'GPU timing, hierarchical scopes, and per-submission category attribution are opt-in because they can change frame cadence.',
      'Three.js projectObject, render-list sorting, renderBufferDirect, program selection, and WebGLUniforms require an external native V8 profile.',
    ],
    startDiagnostics, endDiagnostics,
  };
}

export function publishPerformanceCaptureReport(
  report: Record<string, any>, capture: Pick<PerformanceCaptureReportSource, 'label' | 'download' | 'csvRequested' | 'renderCpu' | 'longTasks'>,
  scopes: CpuScopeSnapshot | null, renderer: RendererAttributionSnapshot | null,
): void {
  console.group(`VanillaGL performance capture: ${capture.label}`);
  console.table({
    fps: { p50: report.actualFps, p95: '', p99: '' }, rafMs: report.timing.rafIntervalMs,
    callbackCpuMs: report.timing.callbackCpuMs, renderCpuMs: summarizePerformanceSeries(capture.renderCpu),
    gpuMs: report.timing.gpuFrameMs, longTaskMs: summarizePerformanceSeries(capture.longTasks),
  });
  console.table(report.phaseCpu);
  console.table(report.diagnosis.timeline);
  for (const warning of report.diagnosis.warnings) console.warn(warning);
  if (renderer?.wmoDrilldown) {
    console.table(renderer.wmoDrilldown.buckets.filter((bucket) => bucket.level === 'root')
      .sort((a, b) => b.slowDrawUplift - a.slowDrawUplift || b.meanDraws - a.meanDraws).slice(0, 12));
    if (renderer.wmoDrilldown.ablation.results.length) console.table(renderer.wmoDrilldown.ablation.results);
    const audit = renderer.wmoDrilldown.visibilityAudit;
    if (audit) {
      console.table({ camera: audit.camera, summary: audit.summary, overhead: audit.overhead });
      console.table(audit.groups.filter((group) => group.submittedBeyondFarFrames || group.submittedOutsideFrustumFrames || group.submittedPortalHiddenFrames)
        .sort((a, b) => b.submittedDraws - a.submittedDraws).slice(0, 30));
    }
  }
  console.log('Full report:', report);
  console.log('Retrieve again with __vanillaPerfLastCapture or run __vanillaPerfCapture again.'); console.groupEnd();
  if (!capture.download) return;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-'); const label = safePerformanceLabel(capture.label);
  downloadPerformanceArtifact(`vanillagl-performance-${label}-${timestamp}.json`, 'application/json', JSON.stringify(report, null, 2));
  if (capture.csvRequested) downloadPerformanceArtifact(
    `vanillagl-performance-${label}-${timestamp}.csv`, 'text/csv', performanceAttributionCsv(scopes, renderer),
  );
}
