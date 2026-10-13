/** Restore the four ordinary ADTs present in the legacy verifier but absent from tier coverage. */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTsToolOrThrow } from '../utils/run-ts-tool.ts';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TILES = join(ROOT, 'apps', 'client', 'public', 'terrain', 'tiles');
const targets = [
  { key: 'Azeroth_32_44', map: 0 },
  { key: 'Azeroth_34_37', map: 0 },
  { key: 'Kalimdor_32_29', map: 1 },
  { key: 'Kalimdor_39_43', map: 1 },
] as const;
const required = [
  'heights.f32', 'heights_inner.f32', 'normals.f32', 'ground.png', 'splat_atlas.png',
  'tex_array.png', 'chunk_map.png', 'chunk_map.bin', 'shadow_atlas.png', 'meta.json',
  'doodads.json', 'wmos.meta.json', 'wmos.bin', 'water.json', 'grass.json', 'surface_map.bin',
] as const;

function run(tool: string, args: readonly string[], env: NodeJS.ProcessEnv, label: string) {
  runTsToolOrThrow({ script: `tools/bakers/${tool}.ts`, args, env }, `${tool} for ${label}`);
}

for (const target of targets) {
  const dir = join(TILES, target.key);
  if (!existsSync(join(dir, 'meta.json'))) run('bake-tile', [], { BAKE_TILE: target.key, BAKE_MAP: String(target.map) }, target.key);
  if (!existsSync(join(dir, 'doodads.json'))) run('bake-doodads', [], { TILE_KEY: target.key }, target.key);
  if (!existsSync(join(dir, 'wmos.meta.json')) || !existsSync(join(dir, 'wmos.bin'))) run('bake-wmos', [], { TILE_KEY: target.key }, target.key);
  if (!existsSync(join(dir, 'water.json'))) run('bake-water', [], { TILE_KEY: target.key }, target.key);
  if (!existsSync(join(dir, 'splat_atlas.png')) || !existsSync(join(dir, 'surface_map.bin'))) run('bake-terrain-shader', [target.key], {}, target.key);
  if (!existsSync(join(dir, 'heights_inner.f32')) || !existsSync(join(dir, 'normals.f32'))) run('bake-inner-heights', [target.key], {}, target.key);
  if (!existsSync(join(dir, 'grass.json'))) run('bake-grass', [target.key], {}, target.key);
  const missing = required.filter((file) => !existsSync(join(dir, file)));
  if (missing.length) throw new Error(`${target.key} remains incomplete: ${missing.join(', ')}`);
}

run('canonicalize-wmo-owners', [], {}, 'legacy gap ownership');
console.log(`Legacy parity ADTs restored: ${targets.map((target) => target.key).join(', ')}`);
