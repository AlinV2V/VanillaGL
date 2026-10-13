import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { MeshBVH, validateBounds } from 'three-mesh-bvh';
import {
  WMO_BVH_FORMAT,
  WMO_BVH_LIBRARY_VERSION,
  WMO_BVH_OPTIONS,
  WMO_BVH_SERIALIZATION_VERSION,
  type WmoBvhBinaryRef as BinaryRef,
  type WmoBvhIndexRef as IndexRef,
  type WmoBvhSurfaceMeta as SurfaceMeta,
  wmoBvhContractJson,
} from '../../apps/client/src/rendering/wmo-bvh-format.ts';
import { hydrateWmoBinary } from '../utils/wmo-binary.ts';
import { getBakeJobCount, runPool, runTsToolAsync } from '../utils/parallel-bake.ts';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PUBLIC = join(ROOT, 'apps', 'client', 'public');
const TILES = join(PUBLIC, 'terrain', 'tiles');
const DATA = join(PUBLIC, 'data');
const MANIFEST = join(DATA, 'bvh-assets.json');
const WORKER_FLAG = '--worker';

type TileReport = {
  tile: string;
  meta: string;
  binary: string;
  surfaces: number;
  triangles: number;
  bytes: number;
};

function logical(file: string) {
  return `/${relative(PUBLIC, file).replaceAll('\\', '/')}`;
}

function tilePaths(tileDir: string) {
  return {
    sourceMeta: join(tileDir, 'wmos.meta.json'),
    sourceBin: join(tileDir, 'wmos.bin'),
    meta: join(tileDir, 'wmos.bvh.meta.json'),
    binary: join(tileDir, 'wmos.bvh.bin'),
    report: join(tileDir, 'wmos.bvh.report.json'),
  };
}

function argValue(name: string): string | undefined {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function discoverTiles(requestedTile?: string): string[] {
  if (!existsSync(TILES)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(TILES, { withFileTypes: true })) {
    if (!entry.isDirectory() || (requestedTile && entry.name !== requestedTile)) continue;
    const dir = join(TILES, entry.name);
    const paths = tilePaths(dir);
    if (existsSync(paths.sourceMeta) && existsSync(paths.sourceBin)) out.push(dir);
  }
  return out;
}

function align4(value: number) { return (value + 3) & ~3; }
function sha256(value: ArrayBufferView | ArrayBuffer | string): string {
  const hash = createHash('sha256');
  if (typeof value === 'string') hash.update(value);
  else if (value instanceof ArrayBuffer) hash.update(new Uint8Array(value));
  else hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return hash.digest('hex');
}

function bruteRayDistance(ray: THREE.Ray, positions: Float32Array, indices: ArrayLike<number>): number | null {
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3();
  let nearest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < indices.length; i += 3) {
    a.fromArray(positions, indices[i] * 3);
    b.fromArray(positions, indices[i + 1] * 3);
    c.fromArray(positions, indices[i + 2] * 3);
    if (ray.intersectTriangle(a, b, c, false, hit)) nearest = Math.min(nearest, ray.origin.distanceTo(hit));
  }
  return Number.isFinite(nearest) ? nearest : null;
}

function validateSerializedSurface(
  serialized: ReturnType<typeof MeshBVH.serialize>,
  positions: Float32Array,
  sourceIndices: ArrayLike<number>,
  label: string,
): void {
  if ((serialized as any).version !== WMO_BVH_SERIALIZATION_VERSION) {
    throw new Error(`${label}: unsupported serialization version ${String((serialized as any).version)}`);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(serialized.index!, 1));
  const restored = MeshBVH.deserialize(serialized, geometry, { setIndex: false });
  if (!validateBounds(restored)) throw new Error(`${label}: deserialized bounds validation failed`);

  const picks = [0, Math.floor(sourceIndices.length / 6) * 3, Math.max(0, sourceIndices.length - 3)];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const center = new THREE.Vector3(), normal = new THREE.Vector3(), origin = new THREE.Vector3();
  for (const offset of picks) {
    a.fromArray(positions, sourceIndices[offset] * 3);
    b.fromArray(positions, sourceIndices[offset + 1] * 3);
    c.fromArray(positions, sourceIndices[offset + 2] * 3);
    center.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    normal.subVectors(b, a).cross(c.clone().sub(a)).normalize();
    if (normal.lengthSq() < 0.5) continue;
    origin.copy(center).addScaledVector(normal, 10);
    const ray = new THREE.Ray(origin.clone(), normal.clone().negate());
    const expected = bruteRayDistance(ray, positions, sourceIndices);
    const actual = restored.raycastFirst(ray, THREE.DoubleSide)?.distance ?? null;
    if (expected === null || actual === null || Math.abs(expected - actual) > 1e-4) {
      throw new Error(`${label}: validation ray mismatch (${String(expected)} vs ${String(actual)})`);
    }
  }
  geometry.dispose();
}

async function bakeTile(tileDir: string): Promise<TileReport | null> {
  const paths = tilePaths(tileDir);
  if (!existsSync(paths.sourceMeta) || !existsSync(paths.sourceBin)) return null;
  const rawMeta = JSON.parse(readFileSync(paths.sourceMeta, 'utf8'));
  const sourceBinary = readFileSync(paths.sourceBin);
  const rawBinary = new Uint8Array(sourceBinary.buffer, sourceBinary.byteOffset, sourceBinary.byteLength);
  const wmo = hydrateWmoBinary(rawMeta, rawBinary);

  const chunks: Buffer[] = [];
  let offset = 0;
  const append = (value: ArrayBufferView | ArrayBuffer): BinaryRef => {
    const buffer = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const aligned = align4(offset);
    if (aligned > offset) chunks.push(Buffer.alloc(aligned - offset));
    offset = aligned;
    const ref = { offset, byteLength: buffer.byteLength };
    chunks.push(Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength));
    offset += buffer.byteLength;
    return ref;
  };
  const appendIndex = (value: Uint16Array | Uint32Array): IndexRef => ({
    ...append(value),
    component: value instanceof Uint16Array ? 'u16' : 'u32',
    count: value.length,
  });

  const surfaces: SurfaceMeta[] = [];
  let triangleCount = 0;
  for (let mi = 0; mi < (wmo.models ?? []).length; mi++) {
    const model = wmo.models[mi];
    for (let gi = 0; gi < (model.groups ?? []).length; gi++) {
      const group = model.groups[gi];
      const positions = group.positions as Float32Array;
      if (!positions?.length) continue;
      const explicit = Array.isArray(group.collisionGroups) && group.collisionGroups.length
        ? group.collisionGroups.map((surface: any, surfaceIndex: number) => ({ surfaceIndex, indices: surface.indices }))
        : [{ surfaceIndex: -1, indices: group.collisionIndices }];

      for (const entry of explicit) {
        const sourceIndices = entry.indices as ArrayLike<number>;
        if (!sourceIndices?.length || sourceIndices.length % 3 !== 0) continue;
        const maxIndex = positions.length / 3 - 1;
        let invalid = false;
        for (let i = 0; i < sourceIndices.length; i++) {
          if (sourceIndices[i] < 0 || sourceIndices[i] > maxIndex) { invalid = true; break; }
        }
        if (invalid) continue;

        const indexArray = maxIndex <= 65535 ? Uint16Array.from(sourceIndices) : Uint32Array.from(sourceIndices);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
        const bvh = new MeshBVH(geometry, WMO_BVH_OPTIONS);
        const serialized = MeshBVH.serialize(bvh, { cloneBuffers: false });
        if (!serialized.index) continue;
        validateSerializedSurface(serialized, positions, sourceIndices, `${relative(TILES, tileDir)}:${mi}:${gi}:${entry.surfaceIndex}`);
        const roots = serialized.roots.map((root) => append(root));
        const index = appendIndex(serialized.index instanceof Uint16Array ? serialized.index : Uint32Array.from(serialized.index));
        const indirect = serialized.indirectBuffer
          ? appendIndex(serialized.indirectBuffer instanceof Uint16Array ? serialized.indirectBuffer : Uint32Array.from(serialized.indirectBuffer))
          : undefined;
        const triangles = Math.floor(serialized.index.length / 3);
        surfaces.push({
          model: mi,
          group: gi,
          surface: entry.surfaceIndex,
          positionCount: positions.length / 3,
          sourceIndexCount: sourceIndices.length,
          roots,
          index,
          ...(indirect ? { indirect } : {}),
          triangles,
        });
        triangleCount += triangles;
        geometry.dispose();
      }
    }
  }

  if (!surfaces.length) {
    // Canonical WMO ownership can move every placement away from a former owner tile.
    // Remove its old BVH triplet so validation never binds collision to a now-empty wmos.bin.
    for (const stale of [paths.meta, paths.binary, paths.report]) if (existsSync(stale)) rmSync(stale);
    return null;
  }
  const binary = Buffer.concat(chunks, offset);
  const contract = {
    format: WMO_BVH_FORMAT,
    meshBvhVersion: WMO_BVH_LIBRARY_VERSION,
    serializationVersion: WMO_BVH_SERIALIZATION_VERSION,
    options: WMO_BVH_OPTIONS,
    sourceBinarySha256: sha256(sourceBinary),
    bvhBinarySha256: sha256(binary),
    surfaces,
  };
  const meta = { ...contract, generatedAt: new Date().toISOString(), contractSha256: sha256(wmoBvhContractJson(contract)) };
  mkdirSync(dirname(paths.meta), { recursive: true });
  writeFileSync(paths.meta, JSON.stringify(meta));
  writeFileSync(paths.binary, binary);
  const report: TileReport = {
    tile: relative(TILES, tileDir).replaceAll('\\', '/'),
    meta: logical(paths.meta),
    binary: logical(paths.binary),
    surfaces: surfaces.length,
    triangles: triangleCount,
    bytes: binary.byteLength + Buffer.byteLength(JSON.stringify(meta)),
  };
  writeFileSync(paths.report, JSON.stringify(report));
  return report;
}

async function workerMain(tileDir: string) {
  const report = await bakeTile(resolve(tileDir));
  if (report) console.log(`[bvh] ${report.tile}: ${report.surfaces} surfaces, ${report.triangles} triangles`);
}

async function parentMain() {
  const requestedTile = argValue('--tile');
  const tiles = discoverTiles(requestedTile);
  const jobs = Math.max(1, getBakeJobCount());
  console.log(`[bvh] serializing WMO collision trees for ${tiles.length} tiles with ${jobs} workers`);
  await runPool(tiles, async (tileDir) => {
    await runTsToolAsync({
      script: 'tools/bakers/bake-wmo-bvh.ts',
      args: [WORKER_FLAG, tileDir],
      label: `WMO BVH ${relative(TILES, tileDir)}`,
    });
  }, {
    jobs,
    onComplete: (done, total) => { if (done === total || done % 25 === 0) console.log(`[bvh] ${done}/${total}`); },
  });

  const reports: TileReport[] = [];
  for (const tileDir of tiles) {
    const path = tilePaths(tileDir).report;
    if (!existsSync(path)) continue;
    try { reports.push(JSON.parse(readFileSync(path, 'utf8')) as TileReport); } catch { /* ignore partial output */ }
  }
  let tilesByName: Record<string, TileReport> = {};
  if (requestedTile && existsSync(MANIFEST)) {
    try {
      const prior = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { tiles?: Record<string, TileReport> };
      tilesByName = { ...(prior.tiles ?? {}) };
    } catch {
      // Replace a malformed prior manifest rather than preserving invalid data.
    }
    delete tilesByName[requestedTile];
  }
  for (const report of reports) tilesByName[report.tile] = report;
  const allReports = Object.values(tilesByName);
  mkdirSync(DATA, { recursive: true });
  writeFileSync(MANIFEST, JSON.stringify({
    version: 2,
    generatedAt: new Date().toISOString(),
    tiles: tilesByName,
    totals: {
      tiles: allReports.length,
      surfaces: allReports.reduce((sum, item) => sum + item.surfaces, 0),
      triangles: allReports.reduce((sum, item) => sum + item.triangles, 0),
      bytes: allReports.reduce((sum, item) => sum + item.bytes, 0),
    },
  }, null, 2));
  console.log(`[bvh] ${allReports.length} cataloged tiles, ${allReports.reduce((sum, item) => sum + item.surfaces, 0)} serialized collision surfaces.`);
}

const workerIndex = process.argv.indexOf(WORKER_FLAG);
if (workerIndex >= 0) await workerMain(process.argv[workerIndex + 1]);
else await parentMain();
