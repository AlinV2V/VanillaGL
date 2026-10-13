/** Asset conversion utility. */
export function unitAnimationSampleInterval(
  distanceSquared: number,
  stateChanged: boolean,
  moving: boolean,
  forceFullRate = false,
): number {
  if (forceFullRate) return 0;
  if (stateChanged) return 0;
  if (moving) {
    if (distanceSquared > 60 * 60) return 1 / 15;
    if (distanceSquared > 30 * 30) return 1 / 30;
    return 0;
  }
  if (distanceSquared > 100 * 100) return 0.5;
  if (distanceSquared > 60 * 60) return 0.2;
  if (distanceSquared > 30 * 30) return 1 / 15;
  return 0;
}

/** Deterministically spread a unit's first throttled sample across its interval. */
export function unitAnimationPhaseOffset(guid: string, interval: number): number {
  if (!Number.isFinite(interval) || interval <= 0) return 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < guid.length; i++) {
    hash ^= guid.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000 * interval;
}

export function staggerUnitAnimationAccum(
  accumulated: number,
  guid: string,
  interval: number,
  previousInterval: number | undefined,
): number {
  return interval > 0 && Number.isFinite(interval) && interval !== previousInterval
    ? accumulated + unitAnimationPhaseOffset(guid, interval)
    : accumulated;
}
