import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printProgress } from '../utils/cli-progress.ts';
import { getBakeJobCount, runPool, runTsToolAsync } from '../utils/parallel-bake.ts';
import { runTsToolOrThrow } from '../utils/run-ts-tool.ts';

type ScanTile = { map: string; x: number; y: number; areaIds: number[]; areaNames: string[] };

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PUBLIC = join(ROOT, 'apps', 'client', 'public', 'terrain');
const SCAN = process.env.ADT_SCAN_JSON ?? join(ROOT, 'data', 'starter_adt_tiles_chunks_all.json');

const zones = new Map<number, string>([
  [44, 'Redridge Mountains'], [38, 'Loch Modan'], [10, 'Duskwood'], [11, 'Wetlands'],
  [17, 'The Barrens'], [130, 'Silverpine Forest'], [406, 'Stonetalon Mountains'],
  [267, 'Hillsbrad Foothills'], [45, 'Arathi Highlands'], [33, 'Stranglethorn Vale'],
  [400, 'Thousand Needles'], [439, 'The Shimmering Flats'],
]);
const mapIds: Record<string, number> = {
  Azeroth: 0, Kalimdor: 1, DeadminesInstance: 36, MonasteryInstances: 189,
  Shadowfang: 33, RazorfenKraulInstance: 47, RazorfenDowns: 129,
};
const instanceMaps = new Set(['DeadminesInstance', 'MonasteryInstances', 'Shadowfang', 'RazorfenKraulInstance', 'RazorfenDowns']);
const REQUIRED = [
  'heights.f32', 'heights_inner.f32', 'normals.f32', 'ground.png',
  'splat_atlas.png', 'tex_array.png', 'chunk_map.png', 'chunk_map.bin',
  'shadow_atlas.png', 'meta.json', 'doodads.json', 'wmos.meta.json', 'wmos.bin',
  'water.json', 'grass.json', 'surface_map.bin',
] as const;
const BASE_REQUIRED = ['heights.f32', 'ground.png', 'meta.json'] as const;
const SHADER_REQUIRED = ['splat_atlas.png', 'tex_array.png', 'chunk_map.png', 'chunk_map.bin', 'shadow_atlas.png', 'surface_map.bin'] as const;

if (!existsSync(SCAN)) throw new Error(`ADT scan missing: ${SCAN}`);
const scan = JSON.parse(readFileSync(SCAN, 'utf8')) as { tiles: ScanTile[] };
const requested = scan.tiles.filter((tile) =>
  (tile.map === 'Azeroth' || tile.map === 'Kalimdor') && tile.areaIds.some((id) => zones.has(id)));
const dungeons = scan.tiles.filter((tile) => instanceMaps.has(tile.map));
const selected = [...new Map([...requested, ...dungeons].map((tile) => [`${tile.map}_${tile.x}_${tile.y}`, tile])).values()]
  .sort((a, b) => a.map.localeCompare(b.map) || a.x - b.x || a.y - b.y);
const keyFor = (tile: ScanTile) => `${tile.map}_${tile.x}_${tile.y}`;
const tileMissing = (tile: ScanTile) => REQUIRED.some((name) => !existsSync(join(PUBLIC, 'tiles', keyFor(tile), name)));

const manifest = {
  generatedAt: new Date().toISOString(),
  source: SCAN,
  note: 'Wailing Caverns map 43 is a WDT global-WMO instance and is handled separately.',
  zoneAreaIds: Object.fromEntries(zones),
  total: selected.length,
  tiles: selected.map((tile) => ({
    key: keyFor(tile),
    map: mapIds[tile.map], dir: tile.map, x: tile.x, y: tile.y,
    areas: tile.areaIds.filter((id) => zones.has(id)).map((id) => zones.get(id)),
  })),
};
mkdirSync(join(PUBLIC, 'alpha-1'), { recursive: true });
writeFileSync(join(PUBLIC, 'alpha-1', 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Core world manifest: ${selected.length} ADT tiles (${requested.length} zone + ${dungeons.length} dungeon records)`);

if (!process.argv.includes('--bake')) process.exit(0);

function run(tool: string, args: readonly string[], env: NodeJS.ProcessEnv, label: string): void {
  runTsToolOrThrow({ script: `tools/bakers/${tool}.ts`, args, env }, `${tool} for ${label}`);
}

async function runAsync(tool: string, args: readonly string[], env: NodeJS.ProcessEnv, label: string): Promise<void> {
  await runTsToolAsync({ script: `tools/bakers/${tool}.ts`, args, env, label: `${tool} for ${label}` });
}

const force = process.env.BAKE_FORCE === '1';
const workItems = force ? selected : selected.filter(tileMissing);
const keys = selected.map(keyFor);
for (let index = 0; index < workItems.length; index++) {
  const tile = workItems[index];
  const key = keyFor(tile);
  const base = join(PUBLIC, 'tiles', key);
  const missingBase = BASE_REQUIRED.some((name) => !existsSync(join(base, name)));
  if (!force && !missingBase) continue;
  printProgress(index + 1, Math.max(1, workItems.length), `Base ADT: ${key}`);
  run('bake-tile', [], { BAKE_TILE: key, BAKE_MAP: String(mapIds[tile.map]) }, key);
}

const jobs = getBakeJobCount();
console.log(`Core-world tile-local pipeline: ${workItems.length} tile${workItems.length === 1 ? '' : 's'}, ${jobs} worker${jobs === 1 ? '' : 's'}.`);
await runPool(workItems, async (tile) => {
  const key = keyFor(tile);
  const base = join(PUBLIC, 'tiles', key);
  if (force || !existsSync(join(base, 'doodads.json'))) await runAsync('bake-doodads', [], { TILE_KEY: key }, key);
  if (force || !existsSync(join(base, 'wmos.meta.json')) || !existsSync(join(base, 'wmos.bin'))) {
    await runAsync('bake-wmos', [], { TILE_KEY: key }, key);
  }
  if (force || !existsSync(join(base, 'water.json'))) await runAsync('bake-water', [], { TILE_KEY: key }, key);
  if (force || SHADER_REQUIRED.some((name) => !existsSync(join(base, name)))) {
    await runAsync('bake-terrain-shader', [key], {}, key);
  }
  if (force || !existsSync(join(base, 'heights_inner.f32')) || !existsSync(join(base, 'normals.f32'))) {
    await runAsync('bake-inner-heights', [key], {}, key);
  }
  if (force || !existsSync(join(base, 'grass.json'))) await runAsync('bake-grass', [key], {}, key);
}, {
  jobs,
  onComplete: (done, total, tile) => printProgress(done, total, `${keyFor(tile)} complete`),
});

if (workItems.length) {
  // Global/shared outputs are intentionally behind the tile worker barrier.
  run('canonicalize-wmo-owners', [], {}, 'core-world WMO ownership');
  run('bake-doodad-skeletons', [], {}, 'shared doodad skeletal animations');
}

const incomplete = keys.filter((key) => REQUIRED.some((name) => !existsSync(join(PUBLIC, 'tiles', key, name))));
if (incomplete.length) {
  throw new Error(`Core world bake incomplete for ${incomplete.length} tiles: ${incomplete.slice(0, 12).join(', ')}`);
}
console.log(`Core world terrain verified: ${keys.length}/${keys.length} complete.`);
