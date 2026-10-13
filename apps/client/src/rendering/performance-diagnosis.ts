import type { PerformanceCaptureReportSource } from './performance-capture-report';
import type { RendererAttributionSnapshot } from './performance-renderer-attribution';

const round = (n: number) => Math.round(n * 1000) / 1000;
const percentile = (values: number[], q: number): number | null => {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return round(values[Math.floor((values.length - 1) * q)]);
};

/** Post-capture analysis only: no scene traversals or timers added to ordinary gameplay. */
export function diagnoseCapture(source: PerformanceCaptureReportSource, attribution: RendererAttributionSnapshot | null) {
  const warnings: string[] = [];
  const gpuValid = source.gpu.requested && source.gpu.supported && !source.gpu.disjoint;
  const gpuCoverage = gpuValid ? source.gpu.byFrame.size / Math.max(1, source.callbackCpu.length) : 0;
  if (gpuCoverage < 0.8) warnings.push('GPU timing missing or below 80% coverage; GPU headroom is inconclusive.');
  if (source.validity?.hidden) warnings.push('Tab was hidden: frame pacing and comparisons are invalid.');
  if (source.validity?.qualityChanged || attribution?.cameraChanged) warnings.push('Camera, resolution or quality changed: rerun fixed-view comparisons.');
  if (attribution) warnings.push('Intrusive category instrumentation changes CPU cost. Savings are candidates, not promised optimization gains.');
  if (attribution?.ablations.some(a => !a.complete)) warnings.push('Some category tests did not finish. Increase scan seconds on slow devices.');
  const timeline = [];
  const times = source.frameAtMs ?? [];
  for (let start = 0; start < times.length;) {
    const bucket = Math.floor(times[start] / 10000);
    let end = start + 1;
    while (end < times.length && Math.floor(times[end] / 10000) === bucket) end++;
    const gpu = [];
    for (let i = start; i < end; i++) {
      const value = gpuValid ? source.gpu.byFrame.get(i + 1) : undefined;
      if (value !== undefined) gpu.push(value);
    }
    timeline.push({
      atSeconds: bucket * 10, frames: end - start,
      rafP95Ms: percentile(source.rafIntervals.slice(Math.max(0, start - 1), Math.max(0, end - 1)), .95),
      cpuP95Ms: percentile(source.callbackCpu.slice(start, end), .95),
      renderSubmitP95Ms: percentile(source.renderCpu.slice(start, end), .95),
      gpuP95Ms: gpu.length >= (end - start) * .8 ? percentile(gpu, .95) : null,
      drawCallsP50: percentile(source.calls.slice(start, end), .5),
      trianglesP50: percentile(source.triangles.slice(start, end), .5),
      textures: source.textures[end - 1], geometries: source.geometries[end - 1],
      heapBytes: source.heapBytes[end - 1] ?? null,
    });
    start = end;
  }
  const cpu = percentile([...source.callbackCpu], .95);
  const gpu = gpuCoverage >= .8 ? percentile([...source.gpu.byFrame.values()], .95) : null;
  const status = (ms: number | null) => ms === null ? 'unmeasured' : ms > 16.667 ? 'over-60fps-budget' : 'within-60fps-budget';
  const phases = [...source.phases].map(([name, phase]) => ({
    name, msPerCapturedFrame: round(phase.totalMs / Math.max(1, source.callbackCpu.length)),
    p95PerInvocationMs: percentile([...phase.values], .95),
  })).sort((a, b) => b.msPerCapturedFrame - a.msPerCapturedFrame);
  return {
    cpu: { p95Ms: cpu, status: status(cpu) }, gpu: { p95Ms: gpu, status: status(gpu), coverage: round(gpuCoverage) },
    warnings, timeline, phases,
    limitations: [
      'CPU and GPU overlap; never add their times. CPU callback excludes other tasks and presentation.',
      'GPU timing covers this renderer render() calls, not other contexts, browser composition or all uploads.',
      'Phase scopes can overlap. Within budget is observed headroom, not proof a system cannot be optimized.',
      'A rising timeline alone does not prove a leak or thermal throttling; compare identical workloads.',
    ],
  };
}

type ScanCapture = {
  validity?: { hidden: boolean; qualityChanged: boolean };
  rendererAttribution?: RendererAttributionSnapshot | null;
};

/** Require the effect to survive reversed test order. Positive numbers mean time saved by hiding. */
export function compareDiagnosisScans(first: ScanCapture, second: ScanCapture) {
  const viewA = first.rendererAttribution?.viewSignature, viewB = second.rendererAttribution?.viewSignature;
  const differentViews = !!viewA && !!viewB && (viewA.length !== viewB.length || viewA.some((v, i) => Math.abs(v - viewB[i]) > .00001));
  const invalid = differentViews || [first, second].some(r => r.validity?.hidden || r.validity?.qualityChanged || r.rendererAttribution?.cameraChanged);
  const a = first.rendererAttribution?.ablations ?? [];
  const b = second.rendererAttribution?.ablations ?? [];
  return a.map(left => {
    const right = b.find(row => row.category === left.category);
    const cpuSavings = [left.totalCpuDeltaMs, right?.totalCpuDeltaMs].map(n => typeof n === 'number' ? round(-n) : null);
    const gpuSavings = [left, right].map(row => row?.gpuStatus === 'measured' && row.gpuTimeDeltaMs !== null ? round(-row.gpuTimeDeltaMs) : null);
    const repeat = (values: (number | null)[]) => values.every(n => n !== null && n > .5);
    const complete = !!right?.complete && left.complete;
    const usable = complete && !invalid;
    return {
      category: left.category, status: !complete ? 'incomplete' : invalid ? 'confounded' :
        repeat(cpuSavings) || repeat(gpuSavings) ? 'repeatable-cost-candidate' : 'no-repeatable-saving-above-0.5ms',
      cpuSavedMs: cpuSavings, gpuSavedMs: gpuSavings,
      conservativeSavingMs: usable ? Math.max(0, ...[cpuSavings, gpuSavings].filter(repeat).map(v => Math.min(...v as number[]))) : null,
      drawCallsRemoved: [left.drawCallDelta, right?.drawCallDelta].map(n => typeof n === 'number' ? -n : null),
    };
  }).sort((a, b) => (b.conservativeSavingMs ?? -1) - (a.conservativeSavingMs ?? -1));
}
