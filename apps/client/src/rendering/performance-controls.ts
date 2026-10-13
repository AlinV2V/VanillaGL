import { performanceFrameProfiler } from './performance-frame-profiler';
import { resetPerformanceSubsystemMetrics } from './performance-subsystem-metrics';

export type ShadowPerformanceMode = 'baseline' | 'lod' | 'off';
export type M2SamplingMode = 'baseline' | 'cached' | 'off';
export type HoverPickingMode = 'baseline' | 'throttled' | 'off';
export type MinimapRepaintMode = 'baseline' | 'dirty' | 'off';
export type PerformanceControlName = 'shadows' | 'm2Sampling' | 'hoverPicking' | 'minimap' | 'wmoRendering';

export type PerformanceControlState = {
  shadows: ShadowPerformanceMode;
  m2Sampling: M2SamplingMode;
  hoverPicking: HoverPickingMode;
  minimap: MinimapRepaintMode;
  wmoRendering: 'on' | 'off';
  entityLighting: 'on' | 'off';
};

const search = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
const oneOf = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? value as T : fallback;

const state: PerformanceControlState = {
  shadows: oneOf(search.get('blobshadows'), ['baseline', 'lod', 'off'] as const, 'lod'),
  m2Sampling: search.get('entityanimation') === 'off'
    ? 'off'
    : oneOf(search.get('m2sampling'), ['baseline', 'cached', 'off'] as const, 'cached'),
  hoverPicking: oneOf(search.get('hoverpicking'), ['baseline', 'throttled', 'off'] as const, 'throttled'),
  minimap: oneOf(search.get('minimaprepaint'), ['baseline', 'dirty', 'off'] as const, 'dirty'),
  wmoRendering: search.get('wmorender') === 'off' ? 'off' : 'on',
  entityLighting: search.get('entitylighting') === 'off' ? 'off' : 'on',
};

const listeners = new Set<(next: PerformanceControlState) => void>();
const detailRequested = search.get('perfdetail') === '1';
const detailSources = new Set<string>();
const requestedHoverHz = Number(search.get('hoverhz') ?? 30);
const hoverHz = Number.isFinite(requestedHoverHz) ? Math.max(10, Math.min(60, requestedHoverHz)) : 30;
if (detailRequested) detailSources.add('query-detail');
performanceFrameProfiler.setSourceActive('query-detail', detailRequested);

export const performanceAblations = {
  get detail(): boolean { return detailSources.size > 0; },
  get wmoRenderOff(): boolean { return state.wmoRendering === 'off'; },
  get entityLightingOff(): boolean { return state.entityLighting === 'off'; },
  get entityAnimationOff(): boolean { return state.m2Sampling === 'off'; },
};

export function performanceControlState(): PerformanceControlState {
  return { ...state };
}

export const shadowPerformanceMode = (): ShadowPerformanceMode => state.shadows;
export const m2SamplingMode = (): M2SamplingMode => state.m2Sampling;
export const hoverPickingMode = (): HoverPickingMode => state.hoverPicking;
export const hoverPickingHz = (): number => hoverHz;
export const minimapRepaintMode = (): MinimapRepaintMode => state.minimap;

export function setPerformanceControl(name: PerformanceControlName, value: string): void {
  if (name === 'shadows') state.shadows = oneOf(value, ['baseline', 'lod', 'off'] as const, state.shadows);
  else if (name === 'm2Sampling') state.m2Sampling = oneOf(value, ['baseline', 'cached', 'off'] as const, state.m2Sampling);
  else if (name === 'hoverPicking') state.hoverPicking = oneOf(value, ['baseline', 'throttled', 'off'] as const, state.hoverPicking);
  else if (name === 'minimap') state.minimap = oneOf(value, ['baseline', 'dirty', 'off'] as const, state.minimap);
  else if (name === 'wmoRendering') state.wmoRendering = value === 'off' ? 'off' : 'on';
  resetPerformanceSubsystemMetrics();
  for (const listener of listeners) listener(performanceControlState());
}

export function cyclePerformanceControl(name: PerformanceControlName): PerformanceControlState {
  const cycles: Record<PerformanceControlName, readonly string[]> = {
    shadows: ['lod', 'baseline', 'off'],
    m2Sampling: ['cached', 'baseline', 'off'],
    hoverPicking: ['throttled', 'baseline', 'off'],
    minimap: ['dirty', 'baseline', 'off'],
    wmoRendering: ['on', 'off'],
  };
  const values = cycles[name];
  const current = state[name];
  setPerformanceControl(name, values[(values.indexOf(current) + 1) % values.length] ?? values[0]);
  return performanceControlState();
}

export function onPerformanceControlChange(listener: (next: PerformanceControlState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setPerformanceInstrumentationSource(source: string, active: boolean): void {
  performanceFrameProfiler.setSourceActive(source, active);
}

/** Deep per-object/per-submission attribution is deliberately separate from frame profiling. */
export function setPerformanceDetailInstrumentationSource(source: string, active: boolean): void {
  if (active) detailSources.add(source);
  else detailSources.delete(source);
  performanceFrameProfiler.setSourceActive(source, active);
}
