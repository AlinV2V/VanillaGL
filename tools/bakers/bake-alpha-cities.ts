import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printProgress } from '../utils/cli-progress.ts';
import { getBakeJobCount, runPool, runTsToolAsync } from '../utils/parallel-bake.ts';
import { runTsToolOrThrow } from '../utils/run-ts-tool.ts';

type CityTile = { city: string; map: number; dir: 'Azeroth' | 'Kalimdor'; x: number; y: number };

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TERRAIN = join(ROOT, 'apps', 'client', 'public', 'terrain');
const TILE_WORLD_SIZE = 533.3333333333334;
const MAX_WMO_VERTS = '1000000';

const cityTiles: CityTile[] = [
  ...[[31, 47], [30, 48], [30, 49], [30, 47], [31, 48], [29, 47], [29, 48]].map(([x, y]) => ({ city: 'Stormwind', map: 0, dir: 'Azeroth' as const, x, y })),
  { city: 'Ironforge', map: 0, dir: 'Azeroth', x: 33, y: 41 },
  ...[[41, 27], [40, 27], [40, 29], [39, 28], [40, 28], [41, 28], [39, 29]].map(([x, y]) => ({ city: 'Orgrimmar', map: 1, dir: 'Kalimdor' as const, x, y })),
  ...[[31, 28], [32, 28], [31, 29], [32, 29]].map(([x, y]) => ({ city: 'Undercity', map: 0, dir: 'Azeroth', x, y })),
  ...[[27, 13], [28, 13], [26, 13], [28, 12]].map(([x, y]) => ({ city: 'Darnassus', map: 1, dir: 'Kalimdor' as const, x, y })),
  ...[[32, 34], [31, 33], [31, 34], [32, 33]].map(([x, y]) => ({ city: 'Thunder Bluff', map: 1, dir: 'Kalimdor' as const, x, y })),
];

const keyFor = (tile: CityTile) => `${tile.dir}_${tile.x}_${tile.y}`;
const worldCenter = (tile: CityTile) => ({
  wx: (32 - tile.y - 0.5) * TILE_WORLD_SIZE,
  wy: (32 - tile.x - 0.5) * TILE_WORLD_SIZE,
});
const required = [
  'heights.f32', 'heights_inner.f32', 'normals.f32', 'ground.png',
  'splat_atlas.png', 'tex_array.png', 'chunk_map.png', 'chunk_map.bin',
  'shadow_atlas.png', 'meta.json', 'doodads.json', 'wmos.meta.json', 'wmos.bin', 'water.json', 'grass.json',
  'surface_map.bin',
] as const;
const BASE_REQUIRED = ['heights.f32', 'ground.png', 'meta.json'] as const;
const SHADER_REQUIRED = ['splat_atlas.png', 'tex_array.png', 'chunk_map.png', 'chunk_map.bin', 'shadow_atlas.png', 'surface_map.bin'] as const;
const tileMissing = (tile: CityTile) => required.some((name) => !existsSync(join(TERRAIN, 'tiles', keyFor(tile), name)));

const plan = {
  generatedAt: new Date().toISOString(),
  maxWmoVerts: Number(MAX_WMO_VERTS),
  pipeline: ['bake-tile', 'bake-doodads', 'bake-wmos', 'bake-water', 'bake-terrain-shader', 'bake-inner-heights', 'bake-grass'],
  cities: [...new Set(cityTiles.map((tile) => tile.city))],
  total: cityTiles.length,
  tiles: cityTiles.map((tile) => ({ ...tile, key: keyFor(tile), ...worldCenter(tile) })),
};
mkdirSync(join(TERRAIN, 'alpha-1'), { recursive: true });
writeFileSync(join(TERRAIN, 'alpha-1', 'cities.json'), JSON.stringify(plan, null, 2));
console.log(`Capital-city plan: ${plan.total} tiles across ${plan.cities.join(', ')}`);

if (!process.argv.includes('--bake')) process.exit(0);

function run(tool: string, args: readonly string[], env: NodeJS.ProcessEnv, label: string): void {
  runTsToolOrThrow({ script: `tools/bakers/${tool}.ts`, args, env }, `${tool} for ${label}`);
}

async function runAsync(tool: string, args: readonly string[], env: NodeJS.ProcessEnv, label: string): Promise<void> {
  await runTsToolAsync({ script: `tools/bakers/${tool}.ts`, args, env, label: `${tool} for ${label}` });
}

const force = process.env.BAKE_FORCE === '1';
const workItems = force ? cityTiles : cityTiles.filter(tileMissing);
for (let index = 0; index < workItems.length; index++) {
  const tile = workItems[index];
  const key = keyFor(tile);
  const base = join(TERRAIN, 'tiles', key);
  const missingBase = BASE_REQUIRED.some((name) => !existsSync(join(base, name)));
  if (!force && !missingBase) continue;
  const { wx, wy } = worldCenter(tile);
  printProgress(index + 1, Math.max(1, workItems.length), `Base ADT ${tile.city}: ${key}`);
  run('bake-tile', [], { BAKE_MAP: String(tile.map), BAKE_WX: String(wx), BAKE_WY: String(wy) }, key);
}

const jobs = getBakeJobCount();
console.log(`Capital-city tile-local pipeline: ${workItems.length} tile${workItems.length === 1 ? '' : 's'}, ${jobs} worker${jobs === 1 ? '' : 's'}.`);
await runPool(workItems, async (tile) => {
  const key = keyFor(tile);
  const base = join(TERRAIN, 'tiles', key);
  if (force || !existsSync(join(base, 'doodads.json'))) await runAsync('bake-doodads', [], { TILE_KEY: key }, key);
  if (force || !existsSync(join(base, 'wmos.meta.json')) || !existsSync(join(base, 'wmos.bin'))) {
    await runAsync('bake-wmos', [], { TILE_KEY: key, MAX_WMO_VERTS }, key);
  }
  if (force || !existsSync(join(base, 'water.json'))) await runAsync('bake-water', [], { TILE_KEY: key }, key);
  if (force || SHADER_REQUIRED.some((name) => !existsSync(join(base, name)))) {
    await runAsync('bake-terrain-shader', [key], {}, key);
  }
  if (force || !existsSync(join(base, 'heights_inner.f32')) || !existsSync(join(base, 'normals.f32'))) {
    await runAsync('bake-inner-heights', [key], {}, key);
  }
  if (force || !existsSync(join(base, 'grass.json'))) await runAsync('bake-grass', [key], {}, key);

  const missing = required.filter((name) => !existsSync(join(base, name)));
  if (missing.length) throw new Error(`${key} incomplete after bake: ${missing.join(', ')}`);
}, {
  jobs,
  onComplete: (done, total, tile) => printProgress(done, total, `${tile.city}: ${keyFor(tile)} complete`),
});

if (workItems.length) {
  // Global/shared outputs are intentionally behind the tile worker barrier.
  run('canonicalize-wmo-owners', [], {}, 'capital-city WMO ownership');
  run('bake-doodad-skeletons', [], {}, 'shared doodad skeletal animations');
}

if (process.env.BAKE_SKIP_CORE_VALIDATION !== '1') {
  const alphaManifestPath = join(TERRAIN, 'alpha-1', 'manifest.json');
  if (!existsSync(alphaManifestPath)) throw new Error('Core world manifest missing; run bake-alpha-1 before capital cities.');
  const alphaManifest = JSON.parse(readFileSync(alphaManifestPath, 'utf8')) as { tiles: Array<{ key: string }> };
  const incompleteZones = alphaManifest.tiles.filter(({ key }) =>
    required.some((name) => !existsSync(join(TERRAIN, 'tiles', key, name))));
  if (incompleteZones.length) {
    throw new Error(`Core level 1-40 bake has ${incompleteZones.length} incomplete tiles: ${incompleteZones.slice(0, 10).map((tile) => tile.key).join(', ')}`);
  }
  console.log(`Capital-city bake verified: ${cityTiles.length} city tiles; ${alphaManifest.tiles.length} core-world tiles remain complete.`);
} else {
  console.log(`Capital-city bake verified: ${cityTiles.length} city tiles (starter-tier validation).`);
}
