/** Backfill authored M2 normals into existing terrain and WMO doodad manifests. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClientArchiveSet, readVanillaM2 } from '@vanillagl/assets';

type DoodadMesh = {
  source?: string;
  positions?: ArrayLike<number>;
  normals?: ArrayLike<number>;
};

type DoodadManifest = { meshes?: DoodadMesh[] };

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CACHE = join(ROOT, '.client-cache');
const TILES = join(ROOT, 'apps', 'client', 'public', 'terrain', 'tiles');
const MANIFESTS = ['doodads.json', 'wmo_doodads.json'] as const;
const normalizeSource = (source: string) => source.replace(/\//g, '\\').replace(/\.(mdx|mdl)$/i, '.m2');

const modelSet = await ClientArchiveSet.open(CACHE, ['model.MPQ']);
const normalCache = new Map<string, Float32Array | null>();
const failures: string[] = [];
let files = 0, changedFiles = 0, meshes = 0, changedMeshes = 0;

try {
  const tileNames = readdirSync(TILES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const tile of tileNames) {
    for (const manifestName of MANIFESTS) {
      const path = join(TILES, tile, manifestName);
      if (!existsSync(path)) continue;
      const data = JSON.parse(readFileSync(path, 'utf8')) as DoodadManifest;
      let changed = false;
      files++;
      for (const mesh of data.meshes ?? []) {
        meshes++;
        const positionCount = mesh.positions?.length ?? 0;
        if (positionCount === 0) {
          if ((mesh.normals?.length ?? 0) !== 0) {
            mesh.normals = [];
            changed = true;
            changedMeshes++;
          }
          continue;
        }
        if ((mesh.normals?.length ?? 0) === positionCount) continue;
        if (!mesh.source) {
          failures.push(`${tile}/${manifestName}: geometry mesh has no source`);
          continue;
        }
        const source = normalizeSource(mesh.source);
        const key = source.toLowerCase();
        let normals = normalCache.get(key);
        if (normals === undefined) {
          try {
            normals = modelSet.has(source) ? readVanillaM2(modelSet.extract(source)).normals : null;
          } catch {
            normals = null;
          }
          normalCache.set(key, normals);
        }
        if (!normals || normals.length !== positionCount) {
          failures.push(`${tile}/${manifestName}: ${source} positions=${positionCount} normals=${normals?.length ?? 0}`);
          continue;
        }
        mesh.normals = Array.from(normals);
        changed = true;
        changedMeshes++;
      }
      if (changed) {
        writeFileSync(path, JSON.stringify(data));
        changedFiles++;
      }
    }
  }
} finally {
  modelSet.close();
}

if (failures.length) {
  throw new Error(`Doodad normal backfill failed for ${failures.length} meshes:\n${failures.slice(0, 20).join('\n')}`);
}
console.log(
  `Doodad normals: ${changedMeshes}/${meshes} meshes backfilled in ${changedFiles}/${files} manifests; ` +
  `${normalCache.size} source M2s inspected.`,
);
