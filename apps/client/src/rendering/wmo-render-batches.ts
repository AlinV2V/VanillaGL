import * as THREE from 'three';

export type PreparedWmoBatch = Record<string, any> & {
  indexStart: number;
  indexCount: number;
  mergedIndices?: Uint16Array | Uint32Array;
  mergedBatchCount: number;
};

/** Give Three a bound for the submitted index range, rather than the WMO group's full position pool. */
export function setWmoBatchGeometryBounds(
  geometry: THREE.BufferGeometry,
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  indexStart: number,
  indexCount: number,
): void {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const end = Math.min(indices.length, indexStart + indexCount);
  for (let offset = Math.max(0, indexStart); offset < end; offset++) {
    const vertex = indices[offset] * 3;
    const x = positions[vertex], y = positions[vertex + 1], z = positions[vertex + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return;
  const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2, centerZ = (minZ + maxZ) / 2;
  let radiusSq = 0;
  for (let offset = Math.max(0, indexStart); offset < end; offset++) {
    const vertex = indices[offset] * 3;
    const dx = positions[vertex] - centerX, dy = positions[vertex + 1] - centerY, dz = positions[vertex + 2] - centerZ;
    radiusSq = Math.max(radiusSq, dx * dx + dy * dy + dz * dz);
  }
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(minX, minY, minZ),
    new THREE.Vector3(maxX, maxY, maxZ),
  );
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(centerX, centerY, centerZ),
    Math.sqrt(radiusSq),
  );
}

const opaqueKey = (batch: any) => [
  batch.tex ?? -1,
  batch.tex2 ?? -1,
  batch.shader ?? 0,
  batch.blendMode ?? 0,
  batch.flags ?? 0,
].join(':');

/** Merge only opaque/cutout ranges with identical material state; translucent order stays authored. */
export function prepareWmoRenderBatches(
  sourceIndices: ArrayLike<number>,
  sourceBatches: readonly any[],
): PreparedWmoBatch[] {
  const output: Array<PreparedWmoBatch & { firstOrder: number; ranges?: any[] }> = [];
  const opaque = new Map<string, PreparedWmoBatch & { firstOrder: number; ranges: any[] }>();
  for (let order = 0; order < sourceBatches.length; order++) {
    const batch = sourceBatches[order];
    if ((batch.blendMode ?? 0) > 1) {
      output.push({ ...batch, mergedBatchCount: 1, firstOrder: order });
      continue;
    }
    const key = opaqueKey(batch);
    let prepared = opaque.get(key);
    if (!prepared) {
      const created: PreparedWmoBatch & { firstOrder: number; ranges: any[] } = {
        ...batch, mergedBatchCount: 0, firstOrder: order, ranges: [],
      };
      opaque.set(key, created);
      output.push(created);
      prepared = created;
    }
    prepared.ranges.push(batch);
    prepared.mergedBatchCount++;
  }
  output.sort((left, right) => left.firstOrder - right.firstOrder);
  let useUint32 = sourceIndices instanceof Uint32Array;
  if (!(sourceIndices instanceof Uint16Array) && !useUint32) {
    for (let index = 0; index < sourceIndices.length && !useUint32; index++) useUint32 = sourceIndices[index] > 65_535;
  }
  for (const prepared of output) {
    const ranges = prepared.ranges;
    if (!ranges || ranges.length <= 1) {
      delete prepared.ranges;
      delete (prepared as any).firstOrder;
      continue;
    }
    const count = ranges.reduce((sum, range) => sum + range.indexCount, 0);
    const merged = useUint32 ? new Uint32Array(count) : new Uint16Array(count);
    let cursor = 0;
    for (const range of ranges) {
      for (let index = 0; index < range.indexCount; index++) merged[cursor++] = sourceIndices[range.indexStart + index];
    }
    prepared.mergedIndices = merged;
    prepared.indexStart = 0;
    prepared.indexCount = merged.length;
    delete prepared.ranges;
    delete (prepared as any).firstOrder;
  }
  return output;
}
