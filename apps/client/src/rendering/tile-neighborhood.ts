import type { TileEntry } from '../tile-utils';

function coordinates(entry: Pick<TileEntry, 'key'>): { x: number; y: number } | null {
  const match = /_(\d+)_(\d+)$/.exec(entry.key);
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
}

export function tileStreamRadius(entry: Pick<TileEntry, 'streamRadius'>): number {
  return Math.max(1, Math.min(2, entry.streamRadius ?? 1));
}

export function tileNeighborhoodKeys(
  entries: readonly TileEntry[],
  center: TileEntry,
  radius = tileStreamRadius(center),
): Set<string> {
  const centerCoords = coordinates(center);
  if (!centerCoords) return new Set([center.key]);
  const keys = new Set<string>();
  for (const candidate of entries) {
    if (candidate.dir !== center.dir) continue;
    const candidateCoords = coordinates(candidate);
    if (!candidateCoords) continue;
    if (Math.max(
      Math.abs(candidateCoords.x - centerCoords.x),
      Math.abs(candidateCoords.y - centerCoords.y),
    ) <= radius) keys.add(candidate.key);
  }
  return keys;
}

export function tileStreamingDiagnostics(
  entries: readonly TileEntry[],
  requestedKey: string,
  loadedKeys: Iterable<string>,
  loadingKeys: Iterable<string>,
) {
  const requested = entries.find((entry) => entry.key === requestedKey) ?? null;
  const activeKeys = requested ? tileNeighborhoodKeys(entries, requested) : new Set<string>();
  let activeLoaded = 0, retiringLoaded = 0, activeLoading = 0, staleLoading = 0;
  let loaded = 0, loading = 0;
  for (const key of loadedKeys) {
    loaded++;
    activeKeys.has(key) ? activeLoaded++ : retiringLoaded++;
  }
  for (const key of loadingKeys) {
    loading++;
    activeKeys.has(key) ? activeLoading++ : staleLoading++;
  }
  return {
    requested: requested?.key ?? null,
    radius: requested ? tileStreamRadius(requested) : 0,
    loaded,
    loading,
    activeLoaded,
    activeLoading,
    prefetchLoaded: 0,
    retiringLoaded,
    staleLoading,
  };
}

/** True when an async tile result still belongs to the most recently requested neighborhood. */
export function tileWithinRequestedNeighborhood(
  entries: readonly TileEntry[],
  requestedKey: string,
  candidate: TileEntry,
  radius?: number,
): boolean {
  if (!requestedKey) return true;
  const center = entries.find((entry) => entry.key === requestedKey);
  if (!center) return true;
  if (candidate.dir !== center.dir) return false;
  const centerCoords = coordinates(center), candidateCoords = coordinates(candidate);
  if (!centerCoords || !candidateCoords) return true;
  const requestedRadius = radius ?? tileStreamRadius(center);
  return Math.max(
    Math.abs(candidateCoords.x - centerCoords.x),
    Math.abs(candidateCoords.y - centerCoords.y),
  ) <= requestedRadius;
}
