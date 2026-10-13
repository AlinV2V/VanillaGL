import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printProgress } from '../utils/cli-progress.ts';
import { getBakeJobCount, runPool, runTsToolAsync } from '../utils/parallel-bake.ts';
import { runTsToolOrThrow } from '../utils/run-ts-tool.ts';

type ScanTile = { map: string; x: number; y: number; areaIds: number[]; areaNames: string[] };
type StarterZone = {
  slug: string;
  name: string;
  mapId: number;
  mapDir: 'Azeroth' | 'Kalimdor';
  zoneId: number;
  areaIds: readonly number[];
  previewAreaIds: readonly number[];
};
type Target = { key: string; mapId: number; dir: string; x: number; y: number; zones: string[] };

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TERRAIN = join(ROOT, 'apps', 'client', 'public', 'terrain');
const SCAN = process.env.ADT_SCAN_JSON ?? join(ROOT, 'data', 'starter_adt_tiles_chunks_all.json');
const MAX_WMO_VERTS = '1000000';

const ZONES: readonly StarterZone[] = [
  { slug: 'elwynn', name: 'Elwynn Forest', mapId: 0, mapDir: 'Azeroth', zoneId: 12, areaIds: [12, 9, 24, 23, 59], previewAreaIds: [9, 24, 23, 59] },
  { slug: 'dun-morogh', name: 'Dun Morogh', mapId: 0, mapDir: 'Azeroth', zoneId: 1, areaIds: [1, 132, 800], previewAreaIds: [132, 800] },
  { slug: 'teldrassil', name: 'Teldrassil', mapId: 1, mapDir: 'Kalimdor', zoneId: 141, areaIds: [141, 188], previewAreaIds: [188] },
  { slug: 'durotar', name: 'Durotar', mapId: 1, mapDir: 'Kalimdor', zoneId: 14, areaIds: [14, 363], previewAreaIds: [363] },
  { slug: 'mulgore', name: 'Mulgore', mapId: 1, mapDir: 'Kalimdor', zoneId: 215, areaIds: [215, 221], previewAreaIds: [221] },
  { slug: 'tirisfal', name: 'Tirisfal Glades', mapId: 0, mapDir: 'Azeroth', zoneId: 85, areaIds: [85, 154], previewAreaIds: [154] },
] as const;

// Four off-grid designer-corner ADTs report AreaTable 1 but are not Dun Morogh.
const SKIPPED_KEYS = new Set(['Azeroth_3_58', 'Azeroth_3_59', 'Azeroth_4_58', 'Azeroth_4_59']);
const REQUIRED = [
  'heights.f32', 'heights_inner.f32', 'normals.f32', 'ground.png',
  'splat_atlas.png', 'tex_array.png', 'chunk_map.png', 'chunk_map.bin',
  'shadow_atlas.png', 'meta.json', 'doodads.json', 'wmos.meta.json', 'wmos.bin', 'grass.json',
  'surface_map.bin', 'water.json',
] as const;
const BASE_REQUIRED = ['heights.f32', 'ground.png', 'meta.json'] as const;

if (!existsSync(SCAN)) throw new Error(`ADT scan missing: ${SCAN}`);
const scan = JSON.parse(readFileSync(SCAN, 'utf8')) as { tiles: ScanTile[] };

const byKey = new Map<string, Target>();
const zoneManifest = ZONES.map((zone) => {
  const matching = scan.tiles.filter((tile) =>
    tile.map === zone.mapDir
    && tile.areaIds.some((id) => zone.areaIds.includes(id))
    && !SKIPPED_KEYS.has(`${tile.map}_${tile.x}_${tile.y}`));
  const preview = matching.filter((tile) => tile.areaIds.some((id) => zone.previewAreaIds.includes(id)));

  for (const tile of matching) {
    const key = `${tile.map}_${tile.x}_${tile.y}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.zones.includes(zone.name)) existing.zones.push(zone.name);
    } else {
      byKey.set(key, { key, mapId: zone.mapId, dir: tile.map, x: tile.x, y: tile.y, zones: [zone.name] });
    }
  }

  const toTileId = (tile: ScanTile) => `${tile.x}_${tile.y}`;
  return {
    slug: zone.slug,
    name: zone.name,
    mapId: zone.mapId,
    mapDir: zone.mapDir,
    zoneId: zone.zoneId,
    previewRequiredTiles: [...new Set(preview.map(toTileId))].sort(),
    completeZoneRequiredTiles: [...new Set(matching.map(toTileId))].sort(),
  };
});

for (const zone of zoneManifest) {
  if (!zone.completeZoneRequiredTiles.length) {
    throw new Error(`ADT scan produced no terrain for starter zone ${zone.name}`);
  }
}

mkdirSync(TERRAIN, { recursive: true });
writeFileSync(
  join(TERRAIN, 'starter-zones.json'),
  JSON.stringify({ generatedFrom: [SCAN], zones: zoneManifest }, null, 2),
);

const targets = [...byKey.values()].sort((a, b) => a.dir.localeCompare(b.dir) || a.x - b.x || a.y - b.y);
const missingFiles = (key: string) => REQUIRED.filter((name) => !existsSync(join(TERRAIN, 'tiles', key, name)));
const incompleteBefore = targets.filter((tile) => missingFiles(tile.key).length > 0);

mkdirSync(join(TERRAIN, 'alpha-1'), { recursive: true });
writeFileSync(join(TERRAIN, 'alpha-1', 'starter-completion.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: SCAN,
  skippedKeys: [...SKIPPED_KEYS],
  total: targets.length,
  incompleteBefore: incompleteBefore.length,
  zones: zoneManifest.map((zone) => ({ zone: zone.name, required: zone.completeZoneRequiredTiles.length })),
  tiles: targets.map((tile) => ({ key: tile.key, map: tile.mapId, dir: tile.dir, x: tile.x, y: tile.y, zones: tile.zones })),
}, null, 2));

console.log(`Starter-zone coverage: ${targets.length} required tiles; ${incompleteBefore.length} need baking.`);
if (!process.argv.includes('--bake')) process.exit(0);

function run(tool: string, args: readonly string[], env: NodeJS.ProcessEnv, label: string): void {
  runTsToolOrThrow({ script: `tools/bakers/${tool}.ts`, args, env }, `${tool} for ${label}`);
}

async function runAsync(tool: string, args: readonly string[], env: NodeJS.ProcessEnv, label: string): Promise<void> {
  await runTsToolAsync({ script: `tools/bakers/${tool}.ts`, args, env, label: `${tool} for ${label}` });
}

const force = process.env.BAKE_FORCE === '1';
for (let index = 0; index < incompleteBefore.length; index++) {
  const tile = incompleteBefore[index];
  const tileDir = join(TERRAIN, 'tiles', tile.key);
  const missingBase = BASE_REQUIRED.some((name) => !existsSync(join(tileDir, name)));
  if (!force && !missingBase) continue;
  printProgress(index + 1, Math.max(1, incompleteBefore.length), `Base ADT: ${tile.key}`);
  run('bake-tile', [], { BAKE_TILE: tile.key, BAKE_MAP: String(tile.mapId) }, tile.key);
}

const jobs = getBakeJobCount();
console.log(`Starter tile-local pipeline: ${jobs} worker${jobs === 1 ? '' : 's'}.`);
await runPool(incompleteBefore, async (tile) => {
  await runAsync('bake-doodads', [], { TILE_KEY: tile.key }, tile.key);
  await runAsync('bake-wmos', [], { TILE_KEY: tile.key, MAX_WMO_VERTS }, tile.key);
  await runAsync('bake-water', [], { TILE_KEY: tile.key }, tile.key);
  await runAsync('bake-terrain-shader', [tile.key], {}, tile.key);
  await runAsync('bake-inner-heights', [tile.key], {}, tile.key);
  await runAsync('bake-grass', [tile.key], {}, tile.key);
  const missing = missingFiles(tile.key);
  if (missing.length) throw new Error(`${tile.key} incomplete after bake: ${missing.join(', ')}`);
}, {
  jobs,
  onComplete: (done, total, tile) => printProgress(done, total, `${tile.key} complete`),
});

// Global/shared outputs are intentionally behind the tile worker barrier.
run('canonicalize-wmo-owners', [], {}, 'starter-zone WMO ownership');
run('bake-doodad-skeletons', [], {}, 'shared doodad skeletal animations');

const incompleteAfter = targets.filter((tile) => missingFiles(tile.key).length > 0);
if (incompleteAfter.length) {
  throw new Error(`Starter coverage remains incomplete: ${incompleteAfter.map((tile) => tile.key).join(', ')}`);
}
console.log(`Starter-zone completion verified: ${targets.length}/${targets.length} complete.`);
