import { performanceFrameProfiler } from './performance-frame-profiler';

type ShadowMetrics = {
  updates: number;
  active: number;
  culledInvisible: number;
  culledDistance: number;
  groundSamples: number;
  slopeSamples: number;
  reusedGround: number;
  timedSamples: number;
  sampledMs: number;
  totalMs: number;
  maxMs: number;
};

type M2Metrics = {
  animatorUpdates: number;
  tracksSampled: number;
  cursorHits: number;
  binarySearches: number;
  baselineSearches: number;
  keyComparisons: number;
  materialTracks: number;
  inactiveMaterialsSkipped: number;
  timedSamples: number;
  sampledMs: number;
  totalMs: number;
  maxMs: number;
};

type PickingMetrics = {
  hoverRequests: number;
  hoverCoalesced: number;
  hoverPicks: number;
  forcedClickPicks: number;
  raycasts: number;
  candidates: number;
  hits: number;
  totalMs: number;
  maxMs: number;
};

type MinimapMetrics = {
  backgroundPaints: number;
  overlayPaints: number;
  skippedPaints: number;
  backgroundMs: number;
  overlayMs: number;
  maxMs: number;
};

const emptyShadows = (): ShadowMetrics => ({
  updates: 0, active: 0, culledInvisible: 0, culledDistance: 0, groundSamples: 0,
  slopeSamples: 0, reusedGround: 0, timedSamples: 0, sampledMs: 0, totalMs: 0, maxMs: 0,
});
const emptyM2 = (): M2Metrics => ({
  animatorUpdates: 0, tracksSampled: 0, cursorHits: 0, binarySearches: 0, baselineSearches: 0,
  keyComparisons: 0, materialTracks: 0, inactiveMaterialsSkipped: 0, timedSamples: 0,
  sampledMs: 0, totalMs: 0, maxMs: 0,
});
const emptyPicking = (): PickingMetrics => ({
  hoverRequests: 0, hoverCoalesced: 0, hoverPicks: 0, forcedClickPicks: 0, raycasts: 0,
  candidates: 0, hits: 0, totalMs: 0, maxMs: 0,
});
const emptyMinimap = (): MinimapMetrics => ({
  backgroundPaints: 0, overlayPaints: 0, skippedPaints: 0, backgroundMs: 0, overlayMs: 0, maxMs: 0,
});

let shadows = emptyShadows();
let m2 = emptyM2();
let picking = emptyPicking();
let minimap = emptyMinimap();
const cumulative = {
  shadows: emptyShadows(),
  m2: emptyM2(),
  picking: emptyPicking(),
  minimap: emptyMinimap(),
};
let metricsStartedAt = performance.now();
let metricsActive = false;
let subsystemFrame = 0;
let sampleTrackSearches = false;
let shadowTimingCursor = 0;
let m2TimingCursor = 0;

const TRACK_SEARCH_SAMPLE_STRIDE = 16;
const OBJECT_TIMING_SAMPLE_STRIDE = 32;

const active = (): boolean => performanceFrameProfiler.isActive();
const round = (value: number): number => Number(value.toFixed(3));

export function beginPerformanceSubsystemFrame(): void {
  metricsActive = active();
  if (!metricsActive) return;
  sampleTrackSearches = subsystemFrame++ % TRACK_SEARCH_SAMPLE_STRIDE === 0;
  shadows = emptyShadows();
  m2 = emptyM2();
  picking = emptyPicking();
  minimap = emptyMinimap();
}

export function resetPerformanceSubsystemMetrics(): void {
  shadows = emptyShadows(); m2 = emptyM2(); picking = emptyPicking(); minimap = emptyMinimap();
  cumulative.shadows = emptyShadows(); cumulative.m2 = emptyM2();
  cumulative.picking = emptyPicking(); cumulative.minimap = emptyMinimap();
  metricsActive = active();
  subsystemFrame = 0; sampleTrackSearches = false; shadowTimingCursor = 0; m2TimingCursor = 0;
  metricsStartedAt = performance.now();
}

export const shouldSampleBlobShadowTiming = (): boolean =>
  metricsActive && shadowTimingCursor++ % OBJECT_TIMING_SAMPLE_STRIDE === 0;

export const shouldSampleM2AnimatorTiming = (): boolean =>
  metricsActive && m2TimingCursor++ % OBJECT_TIMING_SAMPLE_STRIDE === 0;

export function recordBlobShadow(sample: {
  elapsedMs?: number;
  visible: boolean;
  culled?: 'invisible' | 'distance';
  groundSamples?: number;
  slopeSamples?: number;
  reusedGround?: boolean;
}): void {
  if (!metricsActive) return;
  shadows.updates++; cumulative.shadows.updates++;
  if (sample.visible) { shadows.active++; cumulative.shadows.active++; }
  if (sample.culled === 'invisible') { shadows.culledInvisible++; cumulative.shadows.culledInvisible++; }
  if (sample.culled === 'distance') { shadows.culledDistance++; cumulative.shadows.culledDistance++; }
  const groundSamples = sample.groundSamples ?? 0;
  const slopeSamples = sample.slopeSamples ?? 0;
  shadows.groundSamples += groundSamples; cumulative.shadows.groundSamples += groundSamples;
  shadows.slopeSamples += slopeSamples; cumulative.shadows.slopeSamples += slopeSamples;
  if (sample.reusedGround) { shadows.reusedGround++; cumulative.shadows.reusedGround++; }
  if (sample.elapsedMs !== undefined) {
    shadows.timedSamples++; cumulative.shadows.timedSamples++;
    shadows.sampledMs += sample.elapsedMs; cumulative.shadows.sampledMs += sample.elapsedMs;
    shadows.totalMs += sample.elapsedMs * OBJECT_TIMING_SAMPLE_STRIDE;
    cumulative.shadows.totalMs += sample.elapsedMs * OBJECT_TIMING_SAMPLE_STRIDE;
    shadows.maxMs = Math.max(shadows.maxMs, sample.elapsedMs);
    cumulative.shadows.maxMs = Math.max(cumulative.shadows.maxMs, sample.elapsedMs);
  }
}

export function recordM2Animator(elapsedMs?: number): void {
  if (!metricsActive) return;
  m2.animatorUpdates++; cumulative.m2.animatorUpdates++;
  if (elapsedMs !== undefined) {
    m2.timedSamples++; cumulative.m2.timedSamples++;
    m2.sampledMs += elapsedMs; cumulative.m2.sampledMs += elapsedMs;
    m2.totalMs += elapsedMs * OBJECT_TIMING_SAMPLE_STRIDE;
    cumulative.m2.totalMs += elapsedMs * OBJECT_TIMING_SAMPLE_STRIDE;
    m2.maxMs = Math.max(m2.maxMs, elapsedMs);
    cumulative.m2.maxMs = Math.max(cumulative.m2.maxMs, elapsedMs);
  }
}

export function recordM2TrackSearch(kind: 'cursor' | 'binary' | 'baseline', comparisons: number): void {
  if (!metricsActive || !sampleTrackSearches) return;
  m2.tracksSampled += TRACK_SEARCH_SAMPLE_STRIDE; cumulative.m2.tracksSampled += TRACK_SEARCH_SAMPLE_STRIDE;
  const field = kind === 'cursor' ? 'cursorHits' : kind === 'binary' ? 'binarySearches' : 'baselineSearches';
  m2[field] += TRACK_SEARCH_SAMPLE_STRIDE; cumulative.m2[field] += TRACK_SEARCH_SAMPLE_STRIDE;
  m2.keyComparisons += comparisons * TRACK_SEARCH_SAMPLE_STRIDE;
  cumulative.m2.keyComparisons += comparisons * TRACK_SEARCH_SAMPLE_STRIDE;
}

export function recordAnimatedMaterialTrack(skipped: boolean): void {
  if (!metricsActive) return;
  if (skipped) { m2.inactiveMaterialsSkipped++; cumulative.m2.inactiveMaterialsSkipped++; }
  else { m2.materialTracks++; cumulative.m2.materialTracks++; }
}

export function recordHoverRequest(coalesced: boolean): void {
  if (!metricsActive) return;
  picking.hoverRequests++; cumulative.picking.hoverRequests++;
  if (coalesced) { picking.hoverCoalesced++; cumulative.picking.hoverCoalesced++; }
}

export function recordPick(sample: {
  elapsedMs: number;
  candidates: number;
  hit: boolean;
  forcedClick: boolean;
}): void {
  if (!metricsActive) return;
  if (sample.forcedClick) { picking.forcedClickPicks++; cumulative.picking.forcedClickPicks++; }
  else { picking.hoverPicks++; cumulative.picking.hoverPicks++; }
  picking.raycasts++; cumulative.picking.raycasts++;
  picking.candidates += sample.candidates; cumulative.picking.candidates += sample.candidates;
  if (sample.hit) { picking.hits++; cumulative.picking.hits++; }
  picking.totalMs += sample.elapsedMs; cumulative.picking.totalMs += sample.elapsedMs;
  picking.maxMs = Math.max(picking.maxMs, sample.elapsedMs);
  cumulative.picking.maxMs = Math.max(cumulative.picking.maxMs, sample.elapsedMs);
}

export function recordMinimapPaint(kind: 'background' | 'overlay' | 'skipped', elapsedMs = 0): void {
  if (!metricsActive) return;
  if (kind === 'background') {
    minimap.backgroundPaints++; cumulative.minimap.backgroundPaints++;
    minimap.backgroundMs += elapsedMs; cumulative.minimap.backgroundMs += elapsedMs;
  } else if (kind === 'overlay') {
    minimap.overlayPaints++; cumulative.minimap.overlayPaints++;
    minimap.overlayMs += elapsedMs; cumulative.minimap.overlayMs += elapsedMs;
  } else {
    minimap.skippedPaints++; cumulative.minimap.skippedPaints++;
  }
  minimap.maxMs = Math.max(minimap.maxMs, elapsedMs);
  cumulative.minimap.maxMs = Math.max(cumulative.minimap.maxMs, elapsedMs);
}

function rounded<T extends Record<string, number>>(value: T): T {
  return Object.fromEntries(Object.entries(value).map(([key, metric]) => [key, round(metric)])) as T;
}

export function performanceSubsystemDiagnostics() {
  const elapsedSeconds = Math.max(0.001, (performance.now() - metricsStartedAt) / 1_000);
  return {
    enabled: active(),
    sampling: {
      m2TrackSearchStride: TRACK_SEARCH_SAMPLE_STRIDE,
      objectTimingStride: OBJECT_TIMING_SAMPLE_STRIDE,
      note: 'Track counts and totalMs are sampled estimates; timedSamples/sampledMs are raw samples and maxMs is sampled.',
    },
    currentFrame: {
      shadows: rounded({ ...shadows, drawCalls: shadows.active }),
      m2: rounded({ ...m2, cacheHitRate: m2.tracksSampled ? m2.cursorHits / m2.tracksSampled : 0 }),
      picking: rounded({ ...picking, meanCandidates: picking.raycasts ? picking.candidates / picking.raycasts : 0 }),
      minimap: rounded(minimap),
    },
    cumulative: {
      shadows: rounded({ ...cumulative.shadows, drawCalls: cumulative.shadows.active, groundSamplesPerSecond: cumulative.shadows.groundSamples / elapsedSeconds }),
      m2: rounded({ ...cumulative.m2, cacheHitRate: cumulative.m2.tracksSampled ? cumulative.m2.cursorHits / cumulative.m2.tracksSampled : 0, tracksPerSecond: cumulative.m2.tracksSampled / elapsedSeconds }),
      picking: rounded({ ...cumulative.picking, meanCandidates: cumulative.picking.raycasts ? cumulative.picking.candidates / cumulative.picking.raycasts : 0, raycastsPerSecond: cumulative.picking.raycasts / elapsedSeconds }),
      minimap: rounded({ ...cumulative.minimap, backgroundPaintsPerSecond: cumulative.minimap.backgroundPaints / elapsedSeconds, overlayPaintsPerSecond: cumulative.minimap.overlayPaints / elapsedSeconds }),
    },
  };
}
