/** Bake synthetic streaming cells for Build 5875 WDT global-WMO instances. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { encodePng } from '../utils/png.ts';

type Bounds = { minX: number; maxX: number; minY: number; maxY: number };
type Instance = { dir: string; mapId: number; name: string; bounds: Bounds; entry?: { x: number; y: number } };
type Cell = { key: string; x: number; y: number; originX: number; originY: number; owner: boolean };

const ROOT = resolve(import.meta.dirname, '../..');
const TERRAIN = join(ROOT, 'apps/client/public/terrain');
const TILE = 533.33333;
const N = 129;
// Bounds are the active patch-10 creature/GameObject extents from the official vMaNGOS DB.
const INSTANCES: Instance[] = [
  { dir: 'StormwindJail', mapId: 34, name: 'The Stockade', bounds: { minX: 66, maxX: 193, minY: -146, maxY: 148 } },
  { dir: 'Blackfathom', mapId: 48, name: 'Blackfathom Deeps', bounds: { minX: -871, maxX: -178, minY: -478, maxY: 412 } },
  { dir: 'Uldaman', mapId: 70, name: 'Uldaman', bounds: { minX: -364, maxX: 162, minY: -55, maxY: 456 } },
  { dir: 'GnomeragonInstance', mapId: 90, name: 'Gnomeregan', bounds: { minX: -911, maxX: -360, minY: -140, maxY: 721 } },
  { dir: 'OnyxiaLairInstance', mapId: 249, name: "Onyxia's Lair", bounds: { minX: -200, maxX: 50, minY: -277, maxY: -98 }, entry: { x: 29.1607, y: -71.3372 } },
  { dir: 'OrgrimmarInstance', mapId: 389, name: 'Ragefire Chasm', bounds: { minX: -413, maxX: 67, minY: -97, maxY: 266 } },
];

const mapArgIndex = process.argv.indexOf('--map-id');
const requestedMapId = mapArgIndex >= 0 ? Number(process.argv[mapArgIndex + 1]) : null;
const selectedInstances = requestedMapId === null ? INSTANCES : INSTANCES.filter((instance) => instance.mapId === requestedMapId);
if (!selectedInstances.length) throw new Error(`No registered global-WMO instance for map ${requestedMapId}`);

const heights = new Float32Array(N * N); heights.fill(-1000);
const surface = new Uint8Array(512 * 512);
const ground = encodePng(2, 2, new Uint8Array([20, 20, 20, 255, 20, 20, 20, 255, 20, 20, 20, 255, 20, 20, 20, 255]));
const indexPath = join(TERRAIN, 'index.json');
const index = JSON.parse(readFileSync(indexPath, 'utf8')) as Array<{ key: string; map?: number; dir?: string }>;
const manifest: Array<Instance & { cells: string[]; owner: string }> = [];

function cellsFor(instance: Instance): Cell[] {
  const xs = [];
  const ys = [];
  // A baked tile's origin is its upper world-space edge: it covers [origin - TILE, origin].
  // ADT filenames are Y-first and decrease as world coordinates increase.
  for (let value = Math.ceil(instance.bounds.minX / TILE) * TILE; value <= Math.ceil(instance.bounds.maxX / TILE) * TILE; value += TILE) xs.push(value);
  for (let value = Math.ceil(instance.bounds.minY / TILE) * TILE; value <= Math.ceil(instance.bounds.maxY / TILE) * TILE; value += TILE) ys.push(value);
  const centerX = instance.entry?.x ?? (instance.bounds.minX + instance.bounds.maxX) / 2;
  const centerY = instance.entry?.y ?? (instance.bounds.minY + instance.bounds.maxY) / 2;
  let ownerDistance = Infinity;
  let ownerKey = '';
  const cells = [];
  for (const originX of xs) for (const originY of ys) {
    const x = 32 - Math.round(originY / TILE);
    const y = 32 - Math.round(originX / TILE);
    const key = `${instance.dir}_${x}_${y}`;
    const distance = Math.abs(centerX - (originX - TILE / 2)) + Math.abs(centerY - (originY - TILE / 2));
    if (distance < ownerDistance) { ownerDistance = distance; ownerKey = key; }
    cells.push({ key, x, y, originX, originY, owner: false });
  }
  return cells.map((cell) => ({ ...cell, owner: cell.key === ownerKey }));
}

function run(script: string, args: string[] = [], env = process.env): void {
  const result = spawnSync(process.execPath, [join(ROOT, `tools/bakers/${script}.ts`), ...args], { cwd: ROOT, env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${script} failed with status ${result.status}`);
}

for (const instance of selectedInstances) {
  const cells = cellsFor(instance);
  const desiredKeys = new Set(cells.map((cell) => cell.key));
  for (let i = index.length - 1; i >= 0; i--) {
    const entry = index[i];
    if (entry.map !== instance.mapId || entry.dir !== instance.dir || desiredKeys.has(entry.key)) continue;
    rmSync(join(TERRAIN, 'tiles', entry.key), { recursive: true, force: true });
    index.splice(i, 1);
  }
  for (const cell of cells) {
    const dir = join(TERRAIN, 'tiles', cell.key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'heights.f32'), Buffer.from(heights.buffer));
    writeFileSync(join(dir, 'surface_map.bin'), Buffer.from(surface.buffer));
    writeFileSync(join(dir, 'ground.png'), ground);
    writeFileSync(join(dir, 'doodads.json'), '{"meshes":[],"textures":[],"instances":[]}');
    writeFileSync(join(dir, 'grass.json'), '{"meshes":[],"textures":[],"instances":[]}');
    writeFileSync(join(dir, 'wmo_doodads.json'), '{"meshes":[],"textures":[],"instances":[]}');
    writeFileSync(join(dir, 'water.json'), '{"hasWater":false}');
    if (!cell.owner) {
      writeFileSync(join(dir, 'wmos.meta.json'), '{"format":"wow-browser-wmo-bin-v1","models":[],"textures":[],"instances":[]}');
      writeFileSync(join(dir, 'wmos.bin'), Buffer.alloc(0));
    }
    const meta = { key: cell.key, n: N, tileSizeYards: TILE, minHeight: -1000, maxHeight: -999,
      source: `World\\Maps\\${instance.dir}\\${instance.dir}.wdt`, map: instance.mapId, dir: instance.dir,
      originX: cell.originX, originY: cell.originY, shader: { surfaceResolution: 512, surfaceTextures: [] } };
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    const existing = index.findIndex((entry) => entry.key === cell.key);
    if (existing >= 0) index[existing] = meta; else index.push(meta);
  }
  writeFileSync(indexPath, JSON.stringify(index, null, 2));
  const owner = cells.find((cell) => cell.owner)!;
  if (!existsSync(join(TERRAIN, 'tiles', owner.key, 'wmos.meta.json')) || process.argv.includes('--force')) {
    run('bake-wmos', [owner.key], { ...process.env, GLOBAL_WMO: '1', MAX_WMO_VERTS: '1000000' });
  }
  manifest.push({ ...instance, cells: cells.map((cell) => cell.key), owner: owner.key });
}

run('canonicalize-wmo-owners');
run('bake-doodad-skeletons');
mkdirSync(join(TERRAIN, 'alpha-1'), { recursive: true });
const completionPath = join(TERRAIN, 'alpha-1', 'global-instance-completion.json');
const prior = existsSync(completionPath)
  ? JSON.parse(readFileSync(completionPath, 'utf8')) as { instances?: Array<Instance & { cells: string[]; owner: string }> }
  : {};
const completedByMap = new Map((prior.instances ?? []).map((instance) => [instance.mapId, instance]));
for (const instance of manifest) completedByMap.set(instance.mapId, instance);
writeFileSync(completionPath, JSON.stringify({
  generatedAt: new Date().toISOString(), source: 'official vMaNGOS patch-10 spawn bounds + Build 5875 WDT global WMOs',
  instances: [...completedByMap.values()].sort((a, b) => a.mapId - b.mapId),
}, null, 2));
console.log(`Global instance completion: ${manifest.length} selected map(s) baked; ${completedByMap.size} registered complete.`);
