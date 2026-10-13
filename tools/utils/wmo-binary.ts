export type WmoBinaryScalar = 'f32' | 'u32' | 'u16' | 'u8';

export type WmoBinaryRef = {
  $bin: WmoBinaryScalar;
  offset: number;
  count: number;
};

type NumericArray = ArrayLike<number>;

type TileIndexEntry = { key: string; map: number; originX: number; originY: number };
const TILE = 533.33333;

const ownerFor = (index: TileIndexEntry[], map: number, x: number, y: number) => index.find((tile) =>
  tile.map === map && x <= tile.originX + 1 && x >= tile.originX - TILE - 1 && y <= tile.originY + 1 && y >= tile.originY - TILE - 1,
);
/** Asset conversion utility. */
export function canonicalizeWmoTile(source: any, key: string, tileMeta: any, index: TileIndexEntry[]): any {
  const map = Number(index.find((entry) => entry.key === key)?.map ?? tileMeta.map ?? 0);
  const centerX = Number(tileMeta.originX) - TILE / 2;
  const centerY = Number(tileMeta.originY) - TILE / 2;
  const instances = (source.instances ?? []).map((instance: any) => {
    if (tileMeta.globalWmoOwner === true) return { ...instance, ownerKey: key };
    if (typeof instance.ownerKey === 'string') return instance;
    const owner = ownerFor(index, map, centerX + Number(instance.x), centerY + Number(instance.y));
    return { ...instance, ownerKey: owner?.key ?? key };
  });
  const ownsInstance = (instance: any) => {
    if (typeof instance.ownerKey === 'string') return instance.ownerKey === key;
    const owner = ownerFor(index, map, centerX + Number(instance.x), centerY + Number(instance.y));
    return !owner || owner.key === key;
  };
  const fullModels = new Set<number>();
  for (const instance of instances) if (ownsInstance(instance)) fullModels.add(instance.m);
  const models = (source.models ?? []).map((model: any, modelIndex: number) => {
    if (fullModels.has(modelIndex)) return model;
    return {
      ...model,
      proxy: true,
      portalVertices: [],
      portals: [],
      portalRelations: [],
      groups: (model.groups ?? []).map((group: any) => ({
        flags: group.flags ?? 0,
        lightRefs: group.lightRefs ?? [],
        portalStart: 0,
        portalCount: 0,
        bspNodes: [],
        bbox: group.bbox ?? null,
        positions: [], normals: [], uvs: [], colors: [], rawMocv: [], mopyFlags: [], indices: [],
        collisionIndices: [], collisionGroups: [], batches: [], bspFaces: [],
        liquid: null,
      })),
    };
  });
  return { ...source, models, instances };
}

export function hydrateWmoBinary(meta: any, binary: Uint8Array): any {
  const read = (ref: WmoBinaryRef): Float32Array | Uint32Array | Uint16Array | Uint8Array => {
    const width = byteWidth(ref.$bin);
    const absoluteOffset = binary.byteOffset + ref.offset;
    const bytes = ref.count * width;
    const buffer = absoluteOffset % width === 0
      ? binary.buffer
      : binary.buffer.slice(absoluteOffset, absoluteOffset + bytes);
    const offset = absoluteOffset % width === 0 ? absoluteOffset : 0;
    if (ref.$bin === 'f32') return new Float32Array(buffer, offset, ref.count);
    if (ref.$bin === 'u32') return new Uint32Array(buffer, offset, ref.count);
    if (ref.$bin === 'u16') return new Uint16Array(buffer, offset, ref.count);
    return new Uint8Array(buffer, offset, ref.count);
  };
  for (const model of meta.models ?? []) {
    model.portalVertices = read(model.portalVertices);
    for (const group of model.groups ?? []) {
      for (const field of ['positions', 'normals', 'uvs', 'colors', 'rawMocv', 'mopyFlags', 'indices', 'collisionIndices', 'bspFaces']) {
        group[field] = group[field] ? read(group[field]) : new Uint8Array();
      }
      if (group.liquid) {
        group.liquid.heights = read(group.liquid.heights);
        group.liquid.flags = read(group.liquid.flags);
      }
      for (const surface of group.collisionGroups ?? []) surface.indices = read(surface.indices);
    }
  }
  delete meta.format;
  return meta;
}

/** WMO doodads are emitted into every overlapped ADT by old bakes. Store each
 * placement on the tile containing its transformed world position instead. */
export function canonicalizeWmoDoodads(source: any, key: string, tileMeta: any, index: TileIndexEntry[]): any {
  if (tileMeta.globalWmoOwner === true) return source;
  const map = Number(index.find((entry) => entry.key === key)?.map ?? tileMeta.map ?? 0);
  const centerX = Number(tileMeta.originX) - TILE / 2;
  const centerY = Number(tileMeta.originY) - TILE / 2;
  const instances = (source.instances ?? []).filter((instance: any) => {
    const owner = ownerFor(index, map, centerX + Number(instance.x), centerY + Number(instance.y));
    return !owner || owner.key === key;
  });
  const usedMeshes = [...new Set<number>(instances.map((instance: any) => instance.m))].sort((a, b) => a - b);
  const remap = new Map(usedMeshes.map((oldIndex, newIndex) => [oldIndex, newIndex]));
  return {
    ...source,
    meshes: usedMeshes.map((oldIndex) => source.meshes[oldIndex]),
    instances: instances.map((instance: any) => ({ ...instance, m: remap.get(instance.m) })),
  };
}

const byteWidth = (type: WmoBinaryScalar) => type === 'u8' ? 1 : type === 'u16' ? 2 : 4;

/**
 * Move the heavyweight WMO geometry arrays into one little-endian binary blob.
 * The remaining JSON is structural metadata only (materials, groups, portals,
 * placements), so parsing it never blocks the browser on millions of numbers.
 */
export function encodeWmoBinary(source: any): { meta: any; binary: Buffer } {
  const chunks: Buffer[] = [];
  let offset = 0;

  const append = (values: NumericArray | undefined, type: WmoBinaryScalar): WmoBinaryRef => {
    const count = values?.length ?? 0;
    const alignment = byteWidth(type);
    const padding = (alignment - (offset % alignment)) % alignment;
    if (padding) {
      chunks.push(Buffer.alloc(padding));
      offset += padding;
    }
    const ref: WmoBinaryRef = { $bin: type, offset, count };
    if (!count) return ref;
    let view: Uint8Array;
    if (type === 'f32') view = new Uint8Array(Float32Array.from(values!).buffer);
    else if (type === 'u32') view = new Uint8Array(Uint32Array.from(values!).buffer);
    else if (type === 'u16') view = new Uint8Array(Uint16Array.from(values!).buffer);
    else view = Uint8Array.from(values!);
    const chunk = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    chunks.push(chunk);
    offset += chunk.byteLength;
    return ref;
  };

  const models = (source.models ?? []).map((model: any) => ({
    ...model,
    portalVertices: append(model.portalVertices, 'f32'),
    groups: (model.groups ?? []).map((group: any) => ({
      ...group,
      positions: append(group.positions, 'f32'),
      normals: append(group.normals, 'f32'),
      uvs: append(group.uvs, 'f32'),
      colors: append(group.colors, 'u8'),
      rawMocv: append(group.rawMocv, 'u8'),
      mopyFlags: append(group.mopyFlags, 'u8'),
      indices: append(group.indices, 'u32'),
      collisionIndices: append(group.collisionIndices, 'u32'),
      bspFaces: append(group.bspFaces, 'u16'),
      liquid: group.liquid ? {
        ...group.liquid,
        heights: append(group.liquid.heights, 'f32'),
        flags: append(group.liquid.flags, 'u8'),
      } : null,
      collisionGroups: (group.collisionGroups ?? []).map((surface: any) => ({
        ...surface,
        indices: append(surface.indices, 'u32'),
      })),
    })),
  }));

  return {
    meta: { format: 'wow-browser-wmo-bin-v1', models, textures: source.textures ?? [], instances: source.instances ?? [] },
    binary: Buffer.concat(chunks, offset),
  };
}

export function validateWmoBinaryMeta(meta: any, byteLength: number): void {
  if (meta?.format !== 'wow-browser-wmo-bin-v1') throw new Error('unsupported WMO binary metadata format');
  const validateRef = (ref: WmoBinaryRef, label: string) => {
    const width = byteWidth(ref?.$bin);
    if (!ref || !Number.isInteger(ref.offset) || ref.offset < 0 || !Number.isInteger(ref.count) || ref.count < 0) {
      throw new Error(`${label}: malformed binary reference`);
    }
    if (ref.offset % width !== 0 || ref.offset + ref.count * width > byteLength) {
      throw new Error(`${label}: binary reference outside blob`);
    }
  };
  for (const [mi, model] of (meta.models ?? []).entries()) {
    validateRef(model.portalVertices, `model ${mi} portals`);
    for (const [gi, group] of (model.groups ?? []).entries()) {
      for (const field of ['positions', 'normals', 'uvs', 'colors', 'rawMocv', 'mopyFlags', 'indices', 'collisionIndices', 'bspFaces']) {
        validateRef(group[field], `model ${mi} group ${gi} ${field}`);
      }
      if (group.liquid) {
        validateRef(group.liquid.heights, `model ${mi} group ${gi} liquid heights`);
        validateRef(group.liquid.flags, `model ${mi} group ${gi} liquid flags`);
      }
      for (const [si, surface] of (group.collisionGroups ?? []).entries()) {
        validateRef(surface.indices, `model ${mi} group ${gi} surface ${si}`);
      }
    }
  }
}
