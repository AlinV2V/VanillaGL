/** Asset conversion utility. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ClientArchiveSet,
  openClientArchive,
  openClientArchives,
  readVanillaWmoLiquid,
} from '@vanillagl/assets';

const ROOT = resolve(import.meta.dirname, '../..');
const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const TILES = join(ROOT, 'apps/client/public/terrain/tiles');

const rootFlags = (bytes: Uint8Array): number => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 8 + 0x3e <= bytes.length; offset++) {
    if (
      bytes[offset] === 0x44
      && bytes[offset + 1] === 0x48
      && bytes[offset + 2] === 0x4f
      && bytes[offset + 3] === 0x4d
    ) return view.getUint16(offset + 8 + 0x3c, true);
  }
  return 0;
};

const ownersByModel = new Map<string, Set<string>>();
for (const key of readdirSync(TILES)) {
  const path = join(TILES, key, 'wmos.meta.json');
  if (!existsSync(path)) continue;
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  for (let modelIndex = 0; modelIndex < (meta.models?.length ?? 0); modelIndex++) {
    const model = meta.models[modelIndex];
    if (!model?.name || model.proxy) continue;
    const ownsModel = (meta.instances ?? []).some(
      (instance: any) => instance.m === modelIndex && (instance.ownerKey ?? key) === key,
    );
    if (!ownsModel) continue;
    const owners = ownersByModel.get(model.name) ?? new Set<string>();
    owners.add(key);
    ownersByModel.set(model.name, owners);
  }
}

const patches = await openClientArchives(CACHE, []);
const base = await openClientArchive(CACHE, 'wmo.MPQ');
const wmos = new ClientArchiveSet([...patches, base]);
const liquidModels: string[] = [];
const ownerKeys = new Set<string>();
let liquidGroups = 0;
let wetTiles = 0;

try {
  for (const [modelName, owners] of ownersByModel) {
    if (!wmos.has(modelName)) continue;
    const flags = rootFlags(wmos.extract(modelName));
    const stem = modelName.replace(/\.wmo$/i, '');
    let modelLiquidGroups = 0;
    for (let index = 0; ; index++) {
      const groupName = `${stem}_${String(index).padStart(3, '0')}.wmo`;
      if (!wmos.has(groupName)) break;
      const liquid = readVanillaWmoLiquid(wmos.extract(groupName), flags);
      if (!liquid) continue;
      modelLiquidGroups++;
      liquidGroups++;
      wetTiles += liquid.flags.filter((value) => (value & 0x0f) !== 0x0f).length;
    }
    if (!modelLiquidGroups) continue;
    liquidModels.push(modelName);
    for (const key of owners) ownerKeys.add(key);
  }
} finally {
  wmos.close();
}

const keys = [...ownerKeys].sort();
console.log(
  `WMO MLIQ corpus: ${liquidModels.length} models, ${liquidGroups} liquid groups, `
  + `${wetTiles} wet tiles, ${keys.length} owner ADTs.`,
);
for (const key of keys) console.log(`  ${key}`);

if (process.argv.includes('--bake')) {
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    console.log(`[${index + 1}/${keys.length}] rebaking WMO liquid owner ${key}`);
    const result = spawnSync(process.execPath, [join(ROOT, 'tools/bakers/bake-wmos.ts'), key], {
      cwd: ROOT,
      env: key.startsWith('WailingCaverns_')
        ? { ...process.env, GLOBAL_WMO: '1', MAX_WMO_VERTS: '1000000' }
        : process.env,
      stdio: 'inherit',
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  const canonicalize = spawnSync(process.execPath, [join(ROOT, 'tools/bakers/canonicalize-wmo-owners.ts')], {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  if (canonicalize.status !== 0) process.exit(canonicalize.status ?? 1);
}
