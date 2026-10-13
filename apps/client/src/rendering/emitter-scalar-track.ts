import type { ScalarEmitterTrack } from '../spell-visuals';

export type EmitterFrame = {
  sequenceIndex: number;
  sequenceTimeMs: number;
  globalTimeMs: number;
  globalSequences: number[];
};

export function sampleScalarTrack(track: ScalarEmitterTrack | undefined, fallback: number, frame: EmitterFrame): number {
  if (!track?.values.length || !track.timestamps.length) return fallback;
  const count = Math.min(track.values.length, track.timestamps.length);
  if (count === 1) return track.values[0] ?? fallback;
  const globalDuration = track.globalSequence >= 0 ? frame.globalSequences[track.globalSequence] ?? 0 : 0;
  const range = globalDuration > 0 ? undefined : track.ranges[frame.sequenceIndex];
  const start = Math.max(0, Math.min(count - 1, range?.[0] ?? 0));
  const end = Math.max(start, Math.min(count - 1, range?.[1] ?? count - 1));
  const time = globalDuration > 0 ? frame.globalTimeMs % globalDuration : frame.sequenceTimeMs;
  if (time <= track.timestamps[start]) return track.values[start] ?? fallback;
  if (time >= track.timestamps[end]) return track.values[end] ?? fallback;
  let a = start;
  for (let i = start; i < end; i++) {
    if (time >= track.timestamps[i] && time <= track.timestamps[i + 1]) {
      a = i;
      break;
    }
  }
  if (track.interpolation === 0) return track.values[a] ?? fallback;
  const b = Math.min(end, a + 1);
  const ta = track.timestamps[a] ?? time;
  const tb = track.timestamps[b] ?? ta;
  const mix = tb > ta ? Math.max(0, Math.min(1, (time - ta) / (tb - ta))) : 0;
  const av = track.values[a] ?? fallback;
  const bv = track.values[b] ?? av;
  return av + (bv - av) * mix;
}

const DEFAULT_SCALES = [0.55, 0.55, 0] as const;
export function sampleLifeScale(scales: readonly number[] | undefined, midpoint: number, t: number): number {
  const values = scales ?? DEFAULT_SCALES;
  const middle = Math.max(0.001, Math.min(0.999, Number.isFinite(midpoint) ? midpoint : 0.5));
  const left = t <= middle, f = left ? t / middle : (t - middle) / (1 - middle);
  const a = values[left ? 0 : 1], b = values[left ? 1 : 2];
  return a + (b - a) * f;
}
