import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printProgress } from '../utils/cli-progress.ts';
import { getBakeJobCount, runPool, runTsToolAsync } from '../utils/parallel-bake.ts';
import { runTsToolOrThrow } from '../utils/run-ts-tool.ts';

type ScanTile = { map: string; x: number; y: number; areaIds: number[]; areaNames: string[] };
type Target = ScanTile & { key: string; mapId: number };

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TERRAIN = join(ROOT, 'apps', 'client', 'public', 'terrain');
const SCAN = process.env.ADT_SCAN_JSON ?? join(ROOT, 'data', 'starter_adt_tiles_chunks_all.json');
const MAX_WMO_VERTS = process.env.MAX_WMO_VERTS ?? '1000000';
const MAP_IDS: Record<string, number> = { Azeroth: 0, Kalimdor: 1 };
const REQUIRED = [
  'heights.f32', 'heights_inner.f32', 'normals.f32', 'ground.png',
  'splat_atlas.png', 'tex_array.png', 'chunk_map.png', 'chunk_map.bin',
  'shadow_atlas.png', 'meta.json', 'doodads.json', 'wmos.meta.json', 'wmos.bin',
  'grass.json', 'surface_map.bin', 'water.json',
] as const;
const BASE_REQUIRED = ['heights.f32', 'ground.png', 'meta.json'] as const;

if (!existsSync(SCAN)) throw new Error(`ADT scan missing: ${SCAN}`);
const scan = JSON.parse(readFileSync(SCAN, 'utf8')) as { tiles: ScanTile[] };
const targets = scan.tiles
  .filter((tile) => MAP_IDS[tile.map] !== undefined)
  .map<Target>((tile) => ({ ...tile, key: `${tile.map}_${tile.x}_${tile.y}`, mapId: MAP_IDS[tile.map] }))
  .sort((a, b) => a.map.localeCompare(b.map) || a.x - b.x || a.y - b.y);

const missingFiles = (key: string) => REQUIRED.filter((name) => !existsSync(join(TERRAIN, 'tiles', key, name)));
const incompleteBefore = targets.filter((tile) => missingFiles(tile.key).length > 0);
mkdirSync(join(TERRAIN, 'alpha-1'), { recursive: true });
writeFileSync(join(TERRAIN, 'alpha-1', 'full-world.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: SCAN,
  maps: MAP_IDS,
  maxWmoVerts: Number(MAX_WMO_VERTS),
  total: targets.length,
  incompleteBefore: incompleteBefore.length,
  tiles: targets.map((tile) => ({
    key: tile.key,
    map: tile.mapId,
    dir: tile.map,
    x: tile.x,
    y: tile.y,
    areaIds: tile.areaIds,
    areaNames: tile.areaNames,
  })),
}, null, 2));

console.log(`Full-world coverage: ${targets.length} Azeroth/Kalimdor ADTs; ${incompleteBefore.length} need baking.`);
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
  const base = join(TERRAIN, 'tiles', tile.key);
  const missingBase = BASE_REQUIRED.some((name) => !existsSync(join(base, name)));
  if (!force && !missingBase) continue;
  printProgress(index + 1, Math.max(1, incompleteBefore.length), `Base ADT: ${tile.key}`);
  run('bake-tile', [], { BAKE_TILE: tile.key, BAKE_MAP: String(tile.mapId) }, tile.key);
}

const jobs = getBakeJobCount();
console.log(`Full-world tile-local pipeline: ${jobs} worker${jobs === 1 ? '' : 's'}.`);
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

// Shared manifests/ownership are generated once after every tile-local worker completes.
run('canonicalize-wmo-owners', [], {}, 'full-world WMO ownership');
run('bake-doodad-skeletons', [], {}, 'shared doodad skeletal animations');

const incompleteAfter = targets.filter((tile) => missingFiles(tile.key).length > 0);
if (incompleteAfter.length) {
  throw new Error(`Full-world coverage remains incomplete for ${incompleteAfter.length} tiles: ${incompleteAfter.slice(0, 20).map((tile) => tile.key).join(', ')}`);
}
console.log(`Full-world completion verified: ${targets.length}/${targets.length} complete.`);
