import { estimateDecodedBytes } from '../platform/byte-budget-promise-cache';

type NumericArray = ArrayLike<number>;

type DoodadGeometry = {
  positions: NumericArray;
  normals: NumericArray;
  uvs: NumericArray;
  partIndices: Array<{ indices: NumericArray; lods: NumericArray[] }>;
  collision: { positions?: NumericArray; indices?: NumericArray } | null;
};

type WmoGeometry = {
  portalVertices?: NumericArray;
  groups: Array<{
    fields: Record<string, NumericArray>;
    collisionGroups: NumericArray[];
    liquid: { heights: NumericArray; flags: NumericArray } | null;
  }>;
};

const doodadGeometry = new Map<string, DoodadGeometry>();
const wmoGeometry = new Map<string, WmoGeometry>();
const MAX_DOODAD_MODELS = 2_048;
const MAX_WMO_MODELS = 1_024;
const MAX_DOODAD_BYTES = 128 * 1024 * 1024;
const MAX_WMO_BYTES = 256 * 1024 * 1024;
let doodadHits = 0, doodadMisses = 0, wmoHits = 0, wmoMisses = 0, sharedArrays = 0;
const doodadSizes = new Map<string, number>(), wmoSizes = new Map<string, number>();
const doodadBudget = { bytes: 0, peakBytes: 0, evictedBytes: 0 };
const wmoBudget = { bytes: 0, peakBytes: 0, evictedBytes: 0 };

const keyFor = (value: unknown) => String(value ?? '').replace(/\//g, '\\').toLowerCase();
const touch = <T>(
  cache: Map<string, T>, sizes: Map<string, number>, key: string, value: T,
  limit: number, byteLimit: number, budget: { bytes: number; peakBytes: number; evictedBytes: number },
) => {
  const size = cache.get(key) === value ? sizes.get(key) ?? estimateDecodedBytes(value) : estimateDecodedBytes(value);
  budget.bytes -= sizes.get(key) ?? 0;
  cache.delete(key);
  sizes.delete(key);
  cache.set(key, value);
  sizes.set(key, size);
  budget.bytes += size;
  budget.peakBytes = Math.max(budget.peakBytes, budget.bytes);
  while (cache.size > limit || budget.bytes > byteLimit) {
    const oldest = cache.keys().next().value!;
    const evicted = sizes.get(oldest) ?? 0;
    cache.delete(oldest); sizes.delete(oldest);
    budget.bytes = Math.max(0, budget.bytes - evicted);
    budget.evictedBytes += evicted;
  }
};

const floatArray = (value: any): NumericArray => value instanceof Float32Array
  ? value
  : ArrayBuffer.isView(value)
    ? Float32Array.from(value as unknown as ArrayLike<number>)
    : Float32Array.from(value ?? []);

const indexArray = (value: any): NumericArray => {
  if (value instanceof Uint16Array || value instanceof Uint32Array) return value;
  let max = 0;
  for (let index = 0; index < (value?.length ?? 0); index++) max = Math.max(max, value[index] ?? 0);
  return max <= 65_535 ? Uint16Array.from(value ?? []) : Uint32Array.from(value ?? []);
};

const compatible = (left: NumericArray | undefined, right: NumericArray | undefined) =>
  (left?.length ?? 0) === (right?.length ?? 0);

/** Share immutable source-model arrays while keeping per-cell BufferAttributes and LOD state local. */
export function canonicalizeDoodadMeshGeometry(mesh: any): void {
  const key = keyFor(mesh?.source);
  if (!key) return;
  const cached = doodadGeometry.get(key);
  const parts = Array.isArray(mesh.parts) ? mesh.parts : [];
  const cacheCompatible = cached
    && compatible(cached.positions, mesh.positions)
    && compatible(cached.normals, mesh.normals)
    && compatible(cached.uvs, mesh.uvs)
    && cached.partIndices.length === parts.length
    && cached.partIndices.every((part, index) => compatible(part.indices, parts[index]?.indices));
  if (cacheCompatible && cached) {
    mesh.positions = cached.positions;
    mesh.normals = cached.normals;
    mesh.uvs = cached.uvs;
    for (let index = 0; index < parts.length; index++) {
      parts[index].indices = cached.partIndices[index].indices;
      const lods = Array.isArray(parts[index].lods) ? parts[index].lods : [];
      for (let lod = 0; lod < Math.min(lods.length, cached.partIndices[index].lods.length); lod++) {
        lods[lod].indices = cached.partIndices[index].lods[lod];
      }
    }
    if (mesh.collision && cached.collision) {
      mesh.collision.positions = cached.collision.positions;
      mesh.collision.indices = cached.collision.indices;
    }
    sharedArrays += 3 + parts.length;
    doodadHits++;
    touch(doodadGeometry, doodadSizes, key, cached, MAX_DOODAD_MODELS, MAX_DOODAD_BYTES, doodadBudget);
    return;
  }
  mesh.positions = floatArray(mesh.positions);
  mesh.normals = floatArray(mesh.normals);
  mesh.uvs = floatArray(mesh.uvs);
  const partIndices = parts.map((part: any) => {
    part.indices = indexArray(part.indices);
    const lods = Array.isArray(part.lods) ? part.lods : [];
    return { indices: part.indices, lods: lods.map((lod: any) => (lod.indices = indexArray(lod.indices))) };
  });
  let collision: DoodadGeometry['collision'] = null;
  if (mesh.collision) {
    mesh.collision.positions = floatArray(mesh.collision.positions);
    mesh.collision.indices = indexArray(mesh.collision.indices);
    collision = { positions: mesh.collision.positions, indices: mesh.collision.indices };
  }
  touch(doodadGeometry, doodadSizes, key, { positions: mesh.positions, normals: mesh.normals, uvs: mesh.uvs, partIndices, collision }, MAX_DOODAD_MODELS, MAX_DOODAD_BYTES, doodadBudget);
  doodadMisses++;
}

const WMO_FIELDS = ['positions', 'normals', 'uvs', 'colors', 'rawMocv', 'mopyFlags', 'indices', 'collisionIndices', 'bspFaces'] as const;

/** Canonicalize binary WMO geometry by model name so overlapping tile manifests share backing data. */
export function canonicalizeWmoModelGeometry(model: any): void {
  const key = keyFor(model?.name);
  if (!key) return;
  const groups = Array.isArray(model.groups) ? model.groups : [];
  const cached = wmoGeometry.get(key);
  const cacheCompatible = cached && cached.groups.length === groups.length
    && cached.groups.every((group, index) => compatible(group.fields.positions, groups[index]?.positions));
  if (cacheCompatible && cached) {
    if (cached.portalVertices) model.portalVertices = cached.portalVertices;
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index], source = cached.groups[index];
      for (const field of WMO_FIELDS) if (source.fields[field]) group[field] = source.fields[field];
      for (let surface = 0; surface < Math.min(group.collisionGroups?.length ?? 0, source.collisionGroups.length); surface++) {
        group.collisionGroups[surface].indices = source.collisionGroups[surface];
      }
      if (group.liquid && source.liquid) Object.assign(group.liquid, source.liquid);
    }
    sharedArrays += groups.length * WMO_FIELDS.length;
    wmoHits++;
    touch(wmoGeometry, wmoSizes, key, cached, MAX_WMO_MODELS, MAX_WMO_BYTES, wmoBudget);
    return;
  }
  const prepared: WmoGeometry = {
    portalVertices: model.portalVertices,
    groups: groups.map((group: any) => ({
      fields: Object.fromEntries(WMO_FIELDS.map((field) => [field, group[field]]).filter(([, value]) => value)),
      collisionGroups: (group.collisionGroups ?? []).map((surface: any) => surface.indices),
      liquid: group.liquid ? { heights: group.liquid.heights, flags: group.liquid.flags } : null,
    })),
  };
  touch(wmoGeometry, wmoSizes, key, prepared, MAX_WMO_MODELS, MAX_WMO_BYTES, wmoBudget);
  wmoMisses++;
}

export const worldModelDataCacheDiagnostics = () => ({
  doodadModels: doodadGeometry.size,
  wmoModels: wmoGeometry.size,
  doodadHits,
  doodadMisses,
  wmoHits,
  wmoMisses,
  sharedArrays,
  doodadBytes: doodadBudget.bytes,
  doodadPeakBytes: doodadBudget.peakBytes,
  doodadEvictedBytes: doodadBudget.evictedBytes,
  wmoBytes: wmoBudget.bytes,
  wmoPeakBytes: wmoBudget.peakBytes,
  wmoEvictedBytes: wmoBudget.evictedBytes,
});
