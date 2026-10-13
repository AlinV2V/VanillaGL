/** Asset conversion utility. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { encodePng } from '../utils/png.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const TERRAIN = join(ROOT, 'apps/client/public/terrain');
const TILE = 533.33333;
const N = 129;
const cells = [
  { x: 31, y: 32, originX: -533.33333, originY: 0 },
  { x: 32, y: 32, originX: 0, originY: 0, wmo: true },
  { x: 33, y: 32, originX: 533.33333, originY: 0 },
  { x: 31, y: 31, originX: -533.33333, originY: 533.33333 },
  { x: 32, y: 31, originX: 0, originY: 533.33333 },
  { x: 33, y: 31, originX: 533.33333, originY: 533.33333 },
];
const heights = new Float32Array(N * N); heights.fill(-1000);
const surface = new Uint8Array(512 * 512); // unreachable fallback floor; WMO collision supplies exact material IDs
const ground = encodePng(2, 2, new Uint8Array([20, 20, 20, 255, 20, 20, 20, 255, 20, 20, 20, 255, 20, 20, 20, 255]));
const indexPath = join(TERRAIN, 'index.json');
const index = JSON.parse(readFileSync(indexPath, 'utf8')) as any[];

for (const cell of cells) {
  const key = `WailingCaverns_${cell.x}_${cell.y}`;
  const dir = join(TERRAIN, 'tiles', key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'heights.f32'), Buffer.from(heights.buffer));
  writeFileSync(join(dir, 'surface_map.bin'), Buffer.from(surface.buffer));
  writeFileSync(join(dir, 'ground.png'), ground);
  writeFileSync(join(dir, 'doodads.json'), '{"meshes":[],"textures":[],"instances":[]}');
  writeFileSync(join(dir, 'wmo_doodads.json'), '{"meshes":[],"textures":[],"instances":[]}');
  // Synthetic WDT cells have no ADT/MCLQ. Their pools come from the WMO MLIQ bake below.
  writeFileSync(join(dir, 'water.json'), '{"hasWater":false}');
  if (!cell.wmo) {
    writeFileSync(join(dir, 'wmos.meta.json'), '{"format":"wow-browser-wmo-bin-v1","models":[],"textures":[],"instances":[]}');
    writeFileSync(join(dir, 'wmos.bin'), Buffer.alloc(0));
  }
  const meta = {
    key, n: N, tileSizeYards: TILE, minHeight: -1000, maxHeight: -999,
    source: 'World\\Maps\\WailingCaverns\\WailingCaverns.wdt', map: 43, dir: 'WailingCaverns',
    originX: cell.originX, originY: cell.originY,
    shader: { surfaceResolution: 512, surfaceTextures: [] },
  };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  const existing = index.findIndex((entry) => entry.key === key);
  if (existing >= 0) index[existing] = meta; else index.push(meta);
}
writeFileSync(indexPath, JSON.stringify(index, null, 2));

const center = cells.find((cell) => cell.wmo)!;
const centerKey = `WailingCaverns_${center.x}_${center.y}`;
if (!existsSync(join(TERRAIN, 'tiles', centerKey, 'wmos.meta.json')) || !existsSync(join(TERRAIN, 'tiles', centerKey, 'wmos.bin')) || process.argv.includes('--force')) {
  const result = spawnSync(process.execPath, [join(ROOT, 'tools/bakers/bake-wmos.ts'), centerKey], {
    cwd: ROOT, env: { ...process.env, GLOBAL_WMO: '1', MAX_WMO_VERTS: '1000000' }, stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
{
  const result = spawnSync(process.execPath, [join(ROOT, 'tools/bakers/canonicalize-wmo-owners.ts')], {
    cwd: ROOT, env: process.env, stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
{
  const result = spawnSync(process.execPath, [join(ROOT, 'tools/bakers/bake-doodad-skeletons.ts')], {
    cwd: ROOT, env: process.env, stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log('Wailing Caverns global WMO streaming cells baked.');
