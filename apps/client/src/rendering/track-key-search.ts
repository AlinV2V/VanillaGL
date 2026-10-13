import { recordM2TrackSearch } from './performance-subsystem-metrics';

const MAX_CURSOR_ADVANCES = 4;

export type TrackKeyCursor = {
  index: number;
  start: number;
  end: number;
  time: number;
};

export const createTrackKeyCursor = (): TrackKeyCursor => ({ index: 0, start: -1, end: -1, time: -Infinity });

/**
 * Return the lower key of the authored segment containing `time`.
 *
 * Exact key boundaries select the preceding segment by default, matching the bone samplers.
 * `exactUsesNext` retains the material-track scanner's authored step boundary. Monotonic playback advances a per-track cursor;
 * sequence switches, wraparound, reverse playback and random access use lower-bound binary search.
 */
export function findTrackKey(
  timestamps: readonly number[],
  start: number,
  end: number,
  time: number,
  cursor: TrackKeyCursor,
  cached: boolean,
  exactUsesNext = false,
): number {
  let comparisons = 1;
  if (start >= end || time <= (timestamps[start] ?? time)) {
    cursor.index = start; cursor.start = start; cursor.end = end; cursor.time = time;
    recordM2TrackSearch(cached ? 'binary' : 'baseline', comparisons);
    return start;
  }
  comparisons++;
  if (time >= (timestamps[end] ?? time)) {
    cursor.index = end; cursor.start = start; cursor.end = end; cursor.time = time;
    recordM2TrackSearch(cached ? 'binary' : 'baseline', comparisons);
    return end;
  }

  if (!cached) {
    let index = start;
    for (let i = start; i < end; i++) {
      comparisons++;
      if (time >= timestamps[i] && (exactUsesNext ? time < timestamps[i + 1] : time <= timestamps[i + 1])) { index = i; break; }
    }
    cursor.index = index; cursor.start = start; cursor.end = end; cursor.time = time;
    recordM2TrackSearch('baseline', comparisons);
    return index;
  }

  if (cursor.start === start && cursor.end === end && time >= cursor.time) {
    let index = Math.max(start, Math.min(end, cursor.index));
    let advances = 0;
    comparisons++;
    if (time >= timestamps[index]) {
      while (index < end && (exactUsesNext ? time >= timestamps[index + 1] : time > timestamps[index + 1]) && advances < MAX_CURSOR_ADVANCES) {
        index++; advances++; comparisons++;
      }
      if (index >= end || (exactUsesNext ? time < timestamps[index + 1] : time <= timestamps[index + 1])) {
        cursor.index = index; cursor.time = time;
        recordM2TrackSearch('cursor', comparisons);
        return index;
      }
    }
  }

  // lower_bound(first timestamp >= time), then choose its predecessor. This preserves the legacy
  // inclusive upper boundary for step tracks while remaining O(log n) after discontinuities.
  let low = start + 1;
  let high = end;
  while (low < high) {
    const mid = (low + high) >>> 1;
    comparisons++;
    if (exactUsesNext ? timestamps[mid] <= time : timestamps[mid] < time) low = mid + 1;
    else high = mid;
  }
  const index = Math.max(start, low - 1);
  cursor.index = index; cursor.start = start; cursor.end = end; cursor.time = time;
  recordM2TrackSearch('binary', comparisons);
  return index;
}
