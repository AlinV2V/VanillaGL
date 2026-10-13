import { loadRuntimeData } from '../runtime-data';
export type ShipPathsData = { version: number; ships: Record<string, unknown>; coverage: { tileSize: number; routes: unknown[] } };
export const SHIP_PATHS = await loadRuntimeData<ShipPathsData>('ship-paths', { version: 2, ships: {}, coverage: { tileSize: 533.3333333333, routes: [] } });
