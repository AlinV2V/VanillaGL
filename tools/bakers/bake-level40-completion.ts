import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printProgress } from '../utils/cli-progress.ts';
import { getBakeJobCount, runPool, runTsToolAsync } from '../utils/parallel-bake.ts';
import { runTsToolOrThrow } from '../utils/run-ts-tool.ts';

type ScanTile = { map: string; x: number; y: number; areaIds: number[]; areaNames: string[] };
type Target = ScanTile & { key: string; mapId: number; zones: string[] };

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TERRAIN = join(ROOT, 'apps', 'client', 'public', 'terrain');
const SCAN = process.env.ADT_SCAN_JSON ?? join(ROOT, 'data', 'starter_adt_tiles_chunks_all.json');
const MAX_WMO_VERTS = '1000000';

// AreaTable IDs in the supported level 10-40 questing chains.
const ZONES = new Map<number, string>([
  [40, 'Westfall'],
  [38, 'Loch Modan'], [11, 'Wetlands'], [267, 'Hillsbrad Foothills'],
  [45, 'Arathi Highlands'], [36, 'Alterac Mountains'], [33, 'Stranglethorn Vale'],
  [3, 'Badlands'], [148, 'Darkshore'], [331, 'Ashenvale'],
  [406, 'Stonetalon Mountains'], [405, 'Desolace'], [400, 'Thousand Needles'],
  [8, 'Swamp of Sorrows'], [15, 'Dustwallow Marsh'], [357, 'Feralas'],
]);
const MAP_IDS: Record<string, number> = { Azeroth: 0, Kalimdor: 1 };
const EXPLICIT_EDGES = [
  'Azeroth_29_49', 'Azeroth_29_50',
  'Azeroth_39_50',
  'Azeroth_34_47',
];
const STORMWIND_WMO_REBAKE = ['Azeroth_30_50', 'Azeroth_31_49'];
const REQUIRED = [
  'heights.f32', 'heights_inner.f32', 'normals.f32', 'ground.png',
  'splat_atlas.png', 'tex_array.png', 'chunk_map.png', 'chunk_map.bin',
  'shadow_atlas.png', 'meta.json', 'doodads.json', 'wmos.meta.json', 'wmos.bin', 'grass.json',
  'surface_map.bin', 'water.json',
] as const;
const BASE_REQUIRED = ['heights.f32', 'ground.png', 'meta.json'] as const;

if (!existsSync(SCAN)) throw new Error(`ADT scan missing: ${SCAN}`);
const scan = JSON.parse(readFileSync(SCAN, 'utf8')) as { tiles: ScanTile[] };
const scanned = scan.tiles
  .filter((tile) => MAP_IDS[tile.map] !== undefined && tile.areaIds.some((id) => ZONES.has(id)))
  .map<Target>((tile) => ({
    ...tile,
    key: `${tile.map}_${tile.x}_${tile.y}`,
    mapId: MAP_IDS[tile.map],
    zones: [...new Set(tile.areaIds.filter((id) => ZONES.has(id)).map((id) => ZONES.get(id)!))],
  }));

const byKey = new Map(scanned.map((tile) => [tile.key, tile]));
for (const key of EXPLICIT_EDGES) {
  if (byKey.has(key)) continue;
  const [, xs, ys] = key.split('_');
  byKey.set(key, {
    map: 'Azeroth', mapId: 0, x: Number(xs), y: Number(ys), key,
    areaIds: [], areaNames: [], zones: ['Requested border coverage'],
  });
}
const targets = [...byKey.values()].sort((a, b) => a.map.localeCompare(b.map) || a.x - b.x || a.y - b.y);
const missingFiles = (key: string) => REQUIRED.filter((name) => !existsSync(join(TERRAIN, 'tiles', key, name)));
const incompleteBefore = targets.filter((tile) => missingFiles(tile.key).length > 0);

const manifest = {
  generatedAt: new Date().toISOString(),
  source: SCAN,
  maxWmoVerts: Number(MAX_WMO_VERTS),
  pipeline: ['bake-tile', 'bake-doodads', 'bake-wmos', 'bake-water', 'bake-terrain-shader', 'bake-inner-heights', 'bake-grass'],
  zoneAreaIds: Object.fromEntries(ZONES),
  requestedBorderTiles: EXPLICIT_EDGES,
  stormwindWmoRebake: STORMWIND_WMO_REBAKE,
  total: targets.length,
  incompleteBefore: incompleteBefore.length,
  tiles: targets.map((tile) => ({ key: tile.key, map: tile.mapId, dir: tile.map, x: tile.x, y: tile.y, zones: tile.zones })),
};
mkdirSync(join(TERRAIN, 'alpha-1'), { recursive: true });
writeFileSync(join(TERRAIN, 'alpha-1', 'level40-completion.json'), JSON.stringify(manifest, null, 2));
console.log(`Level 1-40 completion: ${targets.length} requested tiles; ${incompleteBefore.length} need baking.`);

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
console.log(`Level 1-40 tile-local pipeline: ${jobs} worker${jobs === 1 ? '' : 's'}.`);
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

for (const key of STORMWIND_WMO_REBAKE) {
  if (!existsSync(join(TERRAIN, 'tiles', key, 'meta.json'))) continue;
  run('bake-wmos', [], { TILE_KEY: key, MAX_WMO_VERTS }, key);
}

// Global/shared outputs are intentionally behind the tile worker barrier.
run('canonicalize-wmo-owners', [], {}, 'level 1-40 WMO ownership');
run('bake-doodad-skeletons', [], {}, 'shared doodad skeletal animations');

const incompleteAfter = targets.filter((tile) => missingFiles(tile.key).length > 0);
if (incompleteAfter.length) {
  throw new Error(`Coverage remains incomplete: ${incompleteAfter.map((tile) => tile.key).join(', ')}`);
}
console.log(`Level 1-40 completion verified: ${targets.length}/${targets.length} complete.`);
