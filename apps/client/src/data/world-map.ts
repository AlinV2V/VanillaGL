import { loadRuntimeData } from '../runtime-data';
export type WorldMapAreaMeta = { id: number; mapId: number; areaId: number; mapFileName: string; name: string; left: number; right: number; top: number; bottom: number };
export type WorldMapContinentMeta = { id: number; mapId: number; name: string; minTileX: number; maxTileX: number; minTileY: number; maxTileY: number; centerX: number; centerY: number; scale: number; left: number; right: number; top: number; bottom: number };
export type WorldMapOverlayMeta = { id: number; worldMapAreaId: number; areaIds: readonly number[]; mapPointX: number; mapPointY: number; textureName: string; width: number; height: number; offsetX: number; offsetY: number; hitRectTop: number; hitRectLeft: number; hitRectBottom: number; hitRectRight: number };
export type WorldMapPoiMeta = { id: number; importance: number; iconIndex: number; factionId: number; worldX: number; worldY: number; worldZ: number; mapId: number; importanceGroup: number; areaId: number; name: string; description: string };
export type AreaMeta = {
  mapId: number;
  parentAreaId: number;
  exploreFlag: number;
  areaFlags?: number;
  /** Build 5875 AreaTable.dbc field 20: Alliance=2, Horde=4, unowned=0. */
  factionGroupMask?: number;
  name: string;
};
type Data = { version?: number; worldMapAreas: WorldMapAreaMeta[]; continents: WorldMapContinentMeta[]; overlays: WorldMapOverlayMeta[]; pois: WorldMapPoiMeta[]; areaMeta: Record<number, AreaMeta> };
const data = await loadRuntimeData<Data>('world-map', { worldMapAreas: [], continents: [], overlays: [], pois: [], areaMeta: {} });
export const WORLD_MAP_AREAS = data.worldMapAreas; export const WORLD_MAP_CONTINENTS = data.continents; export const WORLD_MAP_OVERLAYS = data.overlays; export const WORLD_MAP_POIS = data.pois; export const AREA_META = data.areaMeta;
