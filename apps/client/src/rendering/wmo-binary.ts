type WmoBinaryScalar = 'f32' | 'u32' | 'u16' | 'u8';
type WmoBinaryRef = { $bin: WmoBinaryScalar; offset: number; count: number };

const hydrateRef = (ref: WmoBinaryRef, buffer: ArrayBuffer): Float32Array | Uint32Array | Uint16Array | Uint8Array => {
  if (!ref || !Number.isInteger(ref.offset) || !Number.isInteger(ref.count)) throw new Error('malformed WMO binary reference');
  const width = ref.$bin === 'u8' ? 1 : ref.$bin === 'u16' ? 2 : 4;
  if (ref.offset < 0 || ref.count < 0 || ref.offset % width !== 0 || ref.offset + ref.count * width > buffer.byteLength) {
    throw new Error('WMO binary reference outside blob');
  }
  if (ref.$bin === 'f32') return new Float32Array(buffer, ref.offset, ref.count);
  if (ref.$bin === 'u32') return new Uint32Array(buffer, ref.offset, ref.count);
  if (ref.$bin === 'u16') return new Uint16Array(buffer, ref.offset, ref.count);
  return new Uint8Array(buffer, ref.offset, ref.count);
};

export async function loadWmoBinary(base: string, signal?: AbortSignal): Promise<any | null> {
  const [metaResponse, binaryResponse] = await Promise.all([
    fetch(`${base}/wmos.meta.json`, { signal }),
    fetch(`${base}/wmos.bin`, { signal }),
  ]);
  const metaAbsent = metaResponse.status === 404 || metaResponse.headers.get('content-type')?.includes('text/html');
  const binaryAbsent = binaryResponse.status === 404 || binaryResponse.headers.get('content-type')?.includes('text/html');
  if (metaAbsent && binaryAbsent) return null;
  if (!metaResponse.ok || !binaryResponse.ok || metaAbsent || binaryAbsent) {
    throw new Error(`incomplete WMO binary pair: meta ${metaResponse.status}, data ${binaryResponse.status}`);
  }
  const [meta, buffer] = await Promise.all([metaResponse.json(), binaryResponse.arrayBuffer()]);
  if (meta?.format !== 'wow-browser-wmo-bin-v1') throw new Error(`unsupported WMO binary format ${String(meta?.format)}`);
  Object.defineProperty(meta, '__wmoBinarySource', { value: buffer, enumerable: false, configurable: true });
  for (const model of meta.models ?? []) {
    model.portalVertices = hydrateRef(model.portalVertices, buffer);
    for (const group of model.groups ?? []) {
      for (const field of ['positions', 'normals', 'uvs', 'colors', 'rawMocv', 'mopyFlags', 'indices', 'collisionIndices', 'bspFaces']) {
        group[field] = group[field] ? hydrateRef(group[field], buffer) : new Uint8Array();
      }
      if (group.liquid) {
        group.liquid.heights = hydrateRef(group.liquid.heights, buffer);
        group.liquid.flags = hydrateRef(group.liquid.flags, buffer);
      }
      for (const surface of group.collisionGroups ?? []) surface.indices = hydrateRef(surface.indices, buffer);
    }
  }
  return meta;
}
