export class TileAssetError extends Error {
  constructor(readonly status: number, url: string) { super(`tile asset failed: ${status} ${url}`); }
}
export type TileLoadFailure = { attempt: number; state: 'retrying' | 'degraded' | 'missing'; error: string };
export const isMissingTileAsset = (error: unknown): boolean => error instanceof TileAssetError && (error.status === 404 || error.status === 410);

/** LoadedTile is committed only after terrain, WMO and collision hydration all complete. */
export function tileReadiness(loaded: Iterable<string>, loading: Iterable<string>, failures: ReadonlyMap<string, TileLoadFailure>) {
  const rows = new Map<string, { key: string; state: string; terrainRender: boolean; collision: boolean; wmo: boolean; decoration: boolean; attempt?: number; error?: string }>();
  for (const key of loading) rows.set(key, { key, state: 'loading', terrainRender: false, collision: false, wmo: false, decoration: false });
  for (const [key, failure] of failures) rows.set(key, { key, ...failure, terrainRender: false, collision: false, wmo: false, decoration: false });
  for (const key of loaded) rows.set(key, { key, state: 'ready', terrainRender: true, collision: true, wmo: true, decoration: true });
  return [...rows.values()];
}
