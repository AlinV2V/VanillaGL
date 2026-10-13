/** Asset conversion utility. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { encodePng } from '../utils/png.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const TERRAIN = join(ROOT, 'apps/client/public/terrain');
const TILE = 533.33333;
const N = 129;
const xOrigins = [-TILE, 0, TILE];
const yOrigins = [-TILE, 0, TILE, TILE * 2, TILE * 3, TILE * 4, TILE * 5];
const ownerOrigin = { x: 0, y: TILE * 3 };
const cells = xOrigins.flatMap((originX) => yOrigins.map((originY) => ({
  x: 32 + Math.round(originX / TILE),
  y: 32 - Math.round(originY / TILE),
  originX, originY,
  wmo: originX === ownerOrigin.x && originY === ownerOrigin.y,
})));
const heights = new Float32Array(N * N); heights.fill(-1000);
const surface = new Uint8Array(512 * 512);
const ground = encodePng(2, 2, new Uint8Array([
  20, 20, 20, 255, 20, 20, 20, 255, 20, 20, 20, 255, 20, 20, 20, 255,
]));
const emptyDoodads = '{"meshes":[],"textures":[],"instances":[]}';
const emptyWmos = '{"format":"wow-browser-wmo-bin-v1","models":[],"textures":[],"instances":[]}';
const grass = JSON.stringify({
  schemaVersion: 3,
  source: { map: 'DeeprunTram', adt: null },
  profiles: [], meshes: [], textures: [], instances: [],
  diagnostics: { status: 'not-applicable', reason: 'tile is represented by a WDT global object rather than an ADT',
    source: 'World\\Maps\\DeeprunTram\\DeeprunTram.wdt', rawChunkCount: 0,
    rawTextureLayerCount: 0, rawGroundEffectLayerCount: 0, generatedInstances: 0 },
});
const indexPath = join(TERRAIN, 'index.json');
const index = JSON.parse(readFileSync(indexPath, 'utf8')) as Array<{ key: string; map: number }>;

for (const cell of cells) {
  const key = `DeeprunTram_${cell.x}_${cell.y}`;
  const dir = join(TERRAIN, 'tiles', key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'heights.f32'), Buffer.from(heights.buffer));
  writeFileSync(join(dir, 'surface_map.bin'), Buffer.from(surface.buffer));
  writeFileSync(join(dir, 'ground.png'), ground);
  writeFileSync(join(dir, 'doodads.json'), emptyDoodads);
  writeFileSync(join(dir, 'wmo_doodads.json'), emptyDoodads);
  writeFileSync(join(dir, 'water.json'), '{"hasWater":false}');
  writeFileSync(join(dir, 'grass.json'), grass);
  if (!cell.wmo) {
    writeFileSync(join(dir, 'wmos.meta.json'), emptyWmos);
    writeFileSync(join(dir, 'wmos.bin'), Buffer.alloc(0));
  }
  const meta = {
    key, n: N, tileSizeYards: TILE, minHeight: -1000, maxHeight: -999,
    source: 'World\\Maps\\DeeprunTram\\DeeprunTram.wdt', map: 369, dir: 'DeeprunTram',
    originX: cell.originX, originY: cell.originY, streamRadius: 2, globalWmoOwner: cell.wmo,
    shader: { surfaceResolution: 512, surfaceTextures: [], layerScale: 128,
      compressedMipFormat: null, mipLevels: 0, authoredMipStatus: 'not-applicable' },
  };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  const existing = index.findIndex((entry) => entry.key === key);
  if (existing >= 0) index[existing] = meta; else index.push(meta);
}
writeFileSync(indexPath, JSON.stringify(index, null, 2));

const ownerKey = `DeeprunTram_${32 + Math.round(ownerOrigin.x / TILE)}_${32 - Math.round(ownerOrigin.y / TILE)}`;
if (!existsSync(join(TERRAIN, 'tiles', ownerKey, 'wmos.meta.json'))
  || !existsSync(join(TERRAIN, 'tiles', ownerKey, 'wmos.bin')) || process.argv.includes('--force')) {
  const result = spawnSync(process.execPath, [join(ROOT, 'tools/bakers/bake-wmos.ts'), ownerKey], {
    cwd: ROOT, env: { ...process.env, GLOBAL_WMO: '1', MAX_WMO_VERTS: '1000000' }, stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
for (const tool of ['canonicalize-wmo-owners.ts', 'bake-doodad-skeletons.ts']) {
  const result = spawnSync(process.execPath, [join(ROOT, 'tools', 'bakers', tool)], { cwd: ROOT, env: process.env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Deeprun Tram global WMO baked into ${cells.length} streaming cells; owner ${ownerKey}.`);
