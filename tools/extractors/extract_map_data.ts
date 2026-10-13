/** Asset conversion utility. */
import { ClientArchiveSet } from '@vanillagl/assets';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CACHE_DIR, DATA_DIR, DBC_DIR, RUNTIME_TERRAIN_DIR } from '../utils/paths.ts';
import {
  MINIMAP_INDEX_PATH,
  MINIMAP_TRANSLATION_PATH,
  MINIMAP_TRS_ARCHIVE_PATH,
  parseMinimapTranslation,
} from '../utils/minimap-index.ts';

function intToFloat(val: number): number {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setInt32(0, val, true);
  return new DataView(buf).getFloat32(0, true);
}

async function main() {
  console.log('=== Minimap & World Map Data Extractor ===');

  const worldMapAreaPath = path.join(DBC_DIR, 'WorldMapArea.json');
  if (!fs.existsSync(worldMapAreaPath)) {
    throw new Error(`Missing WorldMapArea.json: ${worldMapAreaPath}`);
  }

  const areas = JSON.parse(fs.readFileSync(worldMapAreaPath, 'utf8')).records;
  const mappedAreas = areas.map((r: any) => ({
    worldMapAreaId: r.field_0,
    mapId: r.field_1,
    areaTableId: r.field_2,
    zoneName: r.field_3_str || r.field_1_str || `Zone_${r.field_0}`,
    bounds: {
      y1_west: intToFloat(r.field_4),
      y2_east: intToFloat(r.field_5),
      x1_north: intToFloat(r.field_6),
      x2_south: intToFloat(r.field_7),
    },
  }));

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(RUNTIME_TERRAIN_DIR, { recursive: true });
  const worldMapCoordsPath = path.join(RUNTIME_TERRAIN_DIR, 'world_map_coords.json');
  fs.writeFileSync(worldMapCoordsPath, JSON.stringify({ areas: mappedAreas }, null, 2));
  console.log(`Saved world_map_coords.json to ${worldMapCoordsPath}`);

  console.log(`Reading ${MINIMAP_TRS_ARCHIVE_PATH}...`);
  const archives = await ClientArchiveSet.open(CACHE_DIR, ['texture.MPQ']);
  try {
    if (!archives.has(MINIMAP_TRS_ARCHIVE_PATH)) {
      throw new Error(`${MINIMAP_TRS_ARCHIVE_PATH} was not found in the patch-aware texture archive set`);
    }

    const trs = new TextDecoder('utf-8').decode(archives.extract(MINIMAP_TRS_ARCHIVE_PATH));
    fs.writeFileSync(MINIMAP_TRANSLATION_PATH, trs);

    const minimapIndex = parseMinimapTranslation(trs);
    const mapNames = Object.keys(minimapIndex.maps);
    const tileCount = Object.values(minimapIndex.maps)
      .reduce((sum, tiles) => sum + Object.keys(tiles).length, 0);
    if (!mapNames.length || !tileCount) {
      throw new Error(`Parsed ${MINIMAP_TRS_ARCHIVE_PATH} but found no minimap tile mappings`);
    }

    fs.writeFileSync(MINIMAP_INDEX_PATH, JSON.stringify(minimapIndex, null, 2));
    console.log(`Saved minimap_tile_index.json to ${MINIMAP_INDEX_PATH}: ${mapNames.length} maps, ${tileCount} tiles`);
  } finally {
    archives.close();
  }

  const specContent = `# Vanilla WoW 1.12.1 Minimap and World Map Reference

## 1. Minimap Rendering Specification

Vanilla's logical minimap tiles are named \`<MapName>\\map<tx>_<ty>.blp\`. The client resolves those
logical names through \`Textures\\Minimap\\md5translate.trs\` to the physical BLP files stored under
\`Textures\\Minimap\\\`. The setup pipeline preserves that translation as
\`data/minimap_tile_index.json\` and bakes each logical tile to \`/minimap/<MapName>/<tx>_<ty>.png\`.

Each tile is 256x256 pixels and covers one 533.33333-yard ADT tile. To project 3D world coordinates
\`(wx, wy)\` to the current ADT/minimap tile:

- \`tx = floor(32 - wy / 533.33333)\`
- \`ty = floor(32 - wx / 533.33333)\`
- \`U = ((32 - tx) * 533.33333 - wy) / 533.33333\`
- \`V = ((32 - ty) * 533.33333 - wx) / 533.33333\`

## 2. World Map Coordinate Boundaries

\`WorldMapArea.dbc\` supplies the world-to-map bounds used for zone-map positioning. The extracted
coordinates are written to \`terrain/world_map_coords.json\`.

Zone-map artwork remains under \`Interface\\WorldMap\\<ZoneName>\\...\` in the client archives.
`;

  fs.writeFileSync(path.join(DATA_DIR, 'map_minimap_spec.md'), specContent);
  console.log('Saved map_minimap_spec.md.');
  console.log('=== Completed map extraction successfully. ===');
}

main().catch((error) => {
  console.error('FATAL', error);
  process.exitCode = 1;
});
