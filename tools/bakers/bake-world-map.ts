/** Asset conversion utility. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DBC_DIR = (process.env.DBC_SOURCE_DIR || path.join(process.cwd(), 'data/dbcs'));
// Resolve casing from the files the browser will actually request. The MPQ lookup used by
// Build 5875 is case-insensitive, while URL paths are not: raw WorldMapOverlay.dbc names such as
// STORMWIND must therefore be mapped back to the authored Stormwind*.png filenames extracted by
// the immediately preceding setup step.
const PUBLIC_WORLDMAP_ASSET_SRC = fileURLToPath(new URL('../../apps/client/public/ui/Interface/WorldMap', import.meta.url));
const configuredInterfaceDir = process.env.EXTRACTED_INTERFACE_DIR;
const WORLDMAP_ASSET_SRC = configuredInterfaceDir
  ? (path.basename(configuredInterfaceDir).toLowerCase() === 'worldmap'
      ? configuredInterfaceDir
      : path.join(configuredInterfaceDir, 'WorldMap'))
  : PUBLIC_WORLDMAP_ASSET_SRC;
const OUT = fileURLToPath(new URL('../../apps/client/public/data/world-map.json', import.meta.url));

type DbcRecord = Record<string, number | string>;
type AreaName = {
  id: number;
  mapId: number;
  parentAreaId: number;
  exploreFlag: number;
  areaFlags: number;
  factionGroupMask: number;
  name: string;
};

function readDbc(name: string): DbcRecord[] {
  const json = JSON.parse(readFileSync(`${DBC_DIR}/${name}.json`, 'utf8'));
  return json.records ?? [];
}

function f32(raw: number) {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setInt32(0, raw | 0, true);
  return new DataView(buffer).getFloat32(0, true);
}

function n(record: DbcRecord, field: number) {
  return Number(record[`field_${field}`] ?? 0);
}

function s(record: DbcRecord, field: number) {
  return String(record[`field_${field}_str`] ?? '');
}

function round(value: number) {
  return Math.round(value * 1000000) / 1000000;
}


function overlayCaseMap(mapFileName: string) {
  const dir = path.join(WORLDMAP_ASSET_SRC, mapFileName);
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:blp|png|webp)$/i.test(entry.name)) continue;
    const stem = entry.name.replace(/\.(?:blp|png|webp)$/i, '').replace(/\d+$/, '');
    if (!stem || stem.toLowerCase() === mapFileName.toLowerCase() || /Highlight$/i.test(stem)) continue;
    out.set(stem.toUpperCase(), stem);
  }
  return out;
}

function main() {
  const mapsDbc = readDbc('Map');
  const areaDbc = readDbc('AreaTable');
  const worldMapAreaDbc = readDbc('WorldMapArea');
  const worldMapContinentDbc = readDbc('WorldMapContinent');
  const overlayDbc = readDbc('WorldMapOverlay');
  const poiDbc = readDbc('AreaPOI');

  const maps: Record<number, { id: number; internalName: string; name: string; type: number }> = {};
  for (const row of mapsDbc) {
    const id = n(row, 0);
    maps[id] = {
      id,
      internalName: s(row, 1),
      name: s(row, 4),
      type: n(row, 2),
    };
  }

  const areas: Record<number, AreaName> = {};
  for (const row of areaDbc) {
    const id = n(row, 0);
    areas[id] = {
      id,
      mapId: n(row, 1),
      parentAreaId: n(row, 2),
      exploreFlag: n(row, 3),
      areaFlags: n(row, 4),
      // Build 5875 AreaTable.dbc field 20: 0=contested/unowned, 2=Alliance, 4=Horde.
      factionGroupMask: n(row, 20),
      name: s(row, 11),
    };
  }
  const northshire = areas[9]?.name;
  if (northshire !== 'Northshire Valley') throw new Error(`AreaTable layout check failed: area 9 = "${northshire}"`);

  const worldMapAreas = worldMapAreaDbc.map((row) => {
    const id = n(row, 0);
    const mapId = n(row, 1);
    const areaId = n(row, 2);
    const mapFileName = s(row, 3);
    return {
      id,
      mapId,
      areaId,
      mapFileName,
      name: areaId ? areas[areaId]?.name || mapFileName : maps[mapId]?.name || mapFileName,
      left: round(f32(n(row, 4))),
      right: round(f32(n(row, 5))),
      top: round(f32(n(row, 6))),
      bottom: round(f32(n(row, 7))),
    };
  });
  const elwynn = worldMapAreas.find((a) => a.mapFileName === 'Elwynn');
  if (!elwynn || elwynn.areaId !== 12 || elwynn.mapId !== 0) throw new Error('WorldMapArea Elwynn layout check failed');
  if (worldMapAreas.length !== 51) throw new Error(`WorldMapArea expected 51 rows, got ${worldMapAreas.length}`);
  const mapFileByAreaId = new Map(worldMapAreas.map((area) => [area.id, area.mapFileName]));
  const overlayCaseByMap = new Map(worldMapAreas.map((area) => [area.mapFileName, overlayCaseMap(area.mapFileName)]));

  const continents = worldMapContinentDbc.map((row) => {
    const id = n(row, 0);
    const mapId = n(row, 1);
    return {
      id,
      mapId,
      name: maps[mapId]?.name || (id === 1 ? 'Eastern Kingdoms' : 'Kalimdor'),
      minTileX: n(row, 2),
      maxTileX: n(row, 3),
      minTileY: n(row, 4),
      maxTileY: n(row, 5),
      centerX: round(f32(n(row, 6))),
      centerY: round(f32(n(row, 7))),
      scale: round(f32(n(row, 8))),
      left: round(f32(n(row, 9))),
      right: round(f32(n(row, 10))),
      top: round(f32(n(row, 11))),
      bottom: round(f32(n(row, 12))),
    };
  });

  const overlays = overlayDbc.map((row) => {
    const id = n(row, 0);
    const worldMapAreaId = n(row, 1);
    const mapFileName = mapFileByAreaId.get(worldMapAreaId);
    const rawTextureName = s(row, 8);
    const textureName = mapFileName ? overlayCaseByMap.get(mapFileName)?.get(rawTextureName.toUpperCase()) : undefined;
    if (!mapFileName || !textureName) {
      throw new Error(`WorldMapOverlay ${id} cannot resolve browser asset casing for ${mapFileName ?? `area ${worldMapAreaId}`}/${rawTextureName}`);
    }
    return {
      id,
      worldMapAreaId,
      areaIds: [2, 3, 4, 5].map((field) => n(row, field)).filter(Boolean),
      mapPointX: n(row, 6),
      mapPointY: n(row, 7),
      textureName,
      width: n(row, 9),
      height: n(row, 10),
      offsetX: n(row, 11),
      offsetY: n(row, 12),
      hitRectTop: n(row, 13),
      hitRectLeft: n(row, 14),
      hitRectBottom: n(row, 15),
      hitRectRight: n(row, 16),
    };
  });

  const pois = poiDbc.map((row) => ({
    id: n(row, 0),
    importance: n(row, 1),
    iconIndex: n(row, 2),
    factionId: n(row, 3),
    worldX: round(f32(n(row, 4))),
    worldY: round(f32(n(row, 5))),
    worldZ: round(f32(n(row, 6))),
    mapId: n(row, 7),
    importanceGroup: n(row, 8),
    areaId: n(row, 9),
    name: s(row, 10),
    description: s(row, 28),
  }));

  const areaMeta: Record<number, {
    mapId: number;
    parentAreaId: number;
    exploreFlag: number;
    areaFlags: number;
    factionGroupMask: number;
    name: string;
  }> = {};
  for (const area of Object.values(areas)) {
    if (!area.id) continue;
    areaMeta[area.id] = {
      mapId: area.mapId,
      parentAreaId: area.parentAreaId,
      exploreFlag: area.exploreFlag,
      areaFlags: area.areaFlags,
      factionGroupMask: area.factionGroupMask,
      name: area.name,
    };
  }

  mkdirSync(fileURLToPath(new URL('../../apps/client/public/data/', import.meta.url)), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ version: 1, worldMapAreas, continents, overlays, pois, areaMeta }, null, 2));
  console.log(`world-map.ts: ${worldMapAreas.length} map areas, ${overlays.length} overlays, ${pois.length} POIs`);
}

main();
