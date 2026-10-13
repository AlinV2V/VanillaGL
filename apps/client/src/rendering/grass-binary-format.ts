export const GRASS_BINARY_FORMAT = 'vanillagl-grass-v1' as const;
export const GRASS_BINARY_VERSION = 1 as const;
export const GRASS_BINARY_FILE = 'grass.bin' as const;
export const GRASS_BINARY_FALLBACK_FILE = 'grass.legacy.json' as const;
export const GRASS_BINARY_CELL_SIZE = 128;

const MAGIC = Uint8Array.of(0x56, 0x47, 0x4c, 0x47, 0x52, 0x53, 0x31, 0x00); // VGLGRS1\0
const HEADER_BYTES = 64;
const MATRIX_FLOATS = 16;
const MATRIX_BYTES = MATRIX_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const METADATA_BYTES = 12;
const CELL_BYTES = 40;

export type GrassBinaryManifest = {
  format: typeof GRASS_BINARY_FORMAT;
  url: typeof GRASS_BINARY_FILE;
  byteLength: number;
  sha256: string;
  instanceCount: number;
  cellCount: number;
  cellSize: number;
  fallbackUrl?: typeof GRASS_BINARY_FALLBACK_FILE;
};

export type GrassBinarySourceInstance = {
  m: number;
  x: number;
  y: number;
  z: number;
  qx?: number;
  qy?: number;
  qz?: number;
  qw?: number;
  s: number;
  sh?: number;
  d?: number;
  ge?: number;
  gd?: number;
  c?: number;
};

export type GrassBinaryCell = {
  meshIndex: number;
  cellX: number;
  cellY: number;
  instanceStart: number;
  instanceCount: number;
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
  maxScale: number;
};

export type DecodedGrassBinary = {
  instanceCount: number;
  cellSize: number;
  matrices: Float32Array;
  cells: GrassBinaryCell[];
  groundEffectAt: (index: number) => number;
  groundDoodadAt: (index: number) => number;
  detailAt: (index: number) => number;
  shadowAt: (index: number) => number;
  chunkAt: (index: number) => number;
  sourceIndexAt: (index: number) => number;
};

type MutableCell = GrassBinaryCell & { sourceIndices: number[] };

function align4(value: number): number {
  return (value + 3) & ~3;
}

function writeMatrix(target: Float32Array, offset: number, instance: GrassBinarySourceInstance): void {
  const x = Number(instance.qx ?? 0), y = Number(instance.qy ?? 0);
  const z = Number(instance.qz ?? 0), w = Number(instance.qw ?? 1);
  const scale = Number(instance.s ?? 1);
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  target[offset] = (1 - (yy + zz)) * scale;
  target[offset + 1] = (xy + wz) * scale;
  target[offset + 2] = (xz - wy) * scale;
  target[offset + 3] = 0;
  target[offset + 4] = (xy - wz) * scale;
  target[offset + 5] = (1 - (xx + zz)) * scale;
  target[offset + 6] = (yz + wx) * scale;
  target[offset + 7] = 0;
  target[offset + 8] = (xz + wy) * scale;
  target[offset + 9] = (yz - wx) * scale;
  target[offset + 10] = (1 - (xx + yy)) * scale;
  target[offset + 11] = 0;
  target[offset + 12] = Number(instance.x);
  target[offset + 13] = Number(instance.y);
  target[offset + 14] = Number(instance.z);
  target[offset + 15] = 1;
}

export function encodeGrassBinary(
  instances: readonly GrassBinarySourceInstance[],
  cellSize = GRASS_BINARY_CELL_SIZE,
): { buffer: ArrayBuffer; cells: GrassBinaryCell[] } {
  const size = Math.max(16, Math.min(256, cellSize));
  const cellMap = new Map<string, MutableCell>();
  for (let sourceIndex = 0; sourceIndex < instances.length; sourceIndex++) {
    const instance = instances[sourceIndex];
    const meshIndex = Math.max(0, Math.min(0xffff, Number(instance.m) | 0));
    const cellX = Math.floor(Number(instance.x) / size);
    const cellY = Math.floor(Number(instance.y) / size);
    const key = `${meshIndex}:${cellX}:${cellY}`;
    let cell = cellMap.get(key);
    if (!cell) {
      cell = {
        meshIndex, cellX, cellY, instanceStart: 0, instanceCount: 0,
        centerX: 0, centerY: 0, centerZ: 0, radius: 0, maxScale: 0,
        sourceIndices: [],
      };
      cellMap.set(key, cell);
    }
    cell.sourceIndices.push(sourceIndex);
  }
  const mutableCells = [...cellMap.values()].sort((a, b) =>
    a.meshIndex - b.meshIndex || a.cellY - b.cellY || a.cellX - b.cellX,
  );
  let orderedCount = 0;
  for (const cell of mutableCells) {
    cell.instanceStart = orderedCount;
    cell.instanceCount = cell.sourceIndices.length;
    orderedCount += cell.instanceCount;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const sourceIndex of cell.sourceIndices) {
      const instance = instances[sourceIndex];
      minX = Math.min(minX, instance.x); maxX = Math.max(maxX, instance.x);
      minY = Math.min(minY, instance.y); maxY = Math.max(maxY, instance.y);
      minZ = Math.min(minZ, instance.z); maxZ = Math.max(maxZ, instance.z);
      cell.maxScale = Math.max(cell.maxScale, Number(instance.s ?? 1));
    }
    cell.centerX = (minX + maxX) / 2;
    cell.centerY = (minY + maxY) / 2;
    cell.centerZ = (minZ + maxZ) / 2;
    cell.radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2;
  }

  const matrixOffset = HEADER_BYTES;
  const metadataOffset = align4(matrixOffset + instances.length * MATRIX_BYTES);
  const cellOffset = align4(metadataOffset + instances.length * METADATA_BYTES);
  const byteLength = cellOffset + mutableCells.length * CELL_BYTES;
  const buffer = new ArrayBuffer(byteLength);
  const bytes = new Uint8Array(buffer);
  bytes.set(MAGIC, 0);
  const header = new DataView(buffer);
  header.setUint32(8, GRASS_BINARY_VERSION, true);
  header.setUint32(12, HEADER_BYTES, true);
  header.setUint32(16, instances.length, true);
  header.setUint32(20, mutableCells.length, true);
  header.setUint32(24, matrixOffset, true);
  header.setUint32(28, metadataOffset, true);
  header.setUint32(32, cellOffset, true);
  header.setUint32(36, METADATA_BYTES, true);
  header.setUint32(40, CELL_BYTES, true);
  header.setFloat32(44, size, true);
  header.setUint32(48, byteLength, true);
  const matrices = new Float32Array(buffer, matrixOffset, instances.length * MATRIX_FLOATS);
  const metadata = new DataView(buffer, metadataOffset, instances.length * METADATA_BYTES);
  let orderedIndex = 0;
  for (const cell of mutableCells) {
    for (const sourceIndex of cell.sourceIndices) {
      const instance = instances[sourceIndex];
      writeMatrix(matrices, orderedIndex * MATRIX_FLOATS, instance);
      const offset = orderedIndex * METADATA_BYTES;
      metadata.setUint32(offset, sourceIndex, true);
      metadata.setUint16(offset + 4, Math.max(0, Math.min(0xffff, Number(instance.ge ?? 0) | 0)), true);
      metadata.setUint16(offset + 6, Math.max(0, Math.min(0xffff, Number(instance.gd ?? 0) | 0)), true);
      metadata.setUint8(offset + 8, Math.max(0, Math.min(2, Number(instance.d ?? 0) | 0)));
      metadata.setUint8(offset + 9, Math.round(Math.max(0, Math.min(1, Number(instance.sh ?? 1))) * 255));
      metadata.setUint8(offset + 10, Math.max(0, Math.min(255, Number(instance.c ?? 0) | 0)));
      orderedIndex++;
    }
  }
  const cells: GrassBinaryCell[] = [];
  for (let index = 0; index < mutableCells.length; index++) {
    const cell = mutableCells[index];
    const offset = cellOffset + index * CELL_BYTES;
    header.setUint16(offset, cell.meshIndex, true);
    header.setInt16(offset + 2, cell.cellX, true);
    header.setInt16(offset + 4, cell.cellY, true);
    header.setUint32(offset + 8, cell.instanceStart, true);
    header.setUint32(offset + 12, cell.instanceCount, true);
    header.setFloat32(offset + 16, cell.centerX, true);
    header.setFloat32(offset + 20, cell.centerY, true);
    header.setFloat32(offset + 24, cell.centerZ, true);
    header.setFloat32(offset + 28, cell.radius, true);
    header.setFloat32(offset + 32, cell.maxScale, true);
    cells.push({
      meshIndex: cell.meshIndex, cellX: cell.cellX, cellY: cell.cellY,
      instanceStart: cell.instanceStart, instanceCount: cell.instanceCount,
      centerX: cell.centerX, centerY: cell.centerY, centerZ: cell.centerZ,
      radius: cell.radius, maxScale: cell.maxScale,
    });
  }
  return { buffer, cells };
}

export function decodeGrassBinary(buffer: ArrayBuffer, manifest?: Partial<GrassBinaryManifest>): DecodedGrassBinary {
  if (buffer.byteLength < HEADER_BYTES) throw new Error('grass binary header is truncated');
  const bytes = new Uint8Array(buffer);
  if (MAGIC.some((value, index) => bytes[index] !== value)) throw new Error('grass binary magic mismatch');
  const view = new DataView(buffer);
  const version = view.getUint32(8, true);
  const headerBytes = view.getUint32(12, true);
  const instanceCount = view.getUint32(16, true);
  const cellCount = view.getUint32(20, true);
  const matrixOffset = view.getUint32(24, true);
  const metadataOffset = view.getUint32(28, true);
  const cellOffset = view.getUint32(32, true);
  const metadataStride = view.getUint32(36, true);
  const cellStride = view.getUint32(40, true);
  const cellSize = view.getFloat32(44, true);
  const declaredBytes = view.getUint32(48, true);
  if (version !== GRASS_BINARY_VERSION || headerBytes !== HEADER_BYTES) throw new Error(`unsupported grass binary version ${version}`);
  if (metadataStride !== METADATA_BYTES || cellStride !== CELL_BYTES) throw new Error('grass binary stride mismatch');
  if (declaredBytes !== buffer.byteLength || manifest?.byteLength && manifest.byteLength !== buffer.byteLength) throw new Error('grass binary byte length mismatch');
  if (manifest?.instanceCount !== undefined && manifest.instanceCount !== instanceCount) throw new Error('grass binary instance count mismatch');
  if (manifest?.cellCount !== undefined && manifest.cellCount !== cellCount) throw new Error('grass binary cell count mismatch');
  if (matrixOffset + instanceCount * MATRIX_BYTES > buffer.byteLength
    || metadataOffset + instanceCount * METADATA_BYTES > buffer.byteLength
    || cellOffset + cellCount * CELL_BYTES > buffer.byteLength) throw new Error('grass binary section exceeds payload');
  const matrices = new Float32Array(buffer, matrixOffset, instanceCount * MATRIX_FLOATS);
  const metadata = new DataView(buffer, metadataOffset, instanceCount * METADATA_BYTES);
  const cells: GrassBinaryCell[] = [];
  for (let index = 0; index < cellCount; index++) {
    const offset = cellOffset + index * CELL_BYTES;
    const cell: GrassBinaryCell = {
      meshIndex: view.getUint16(offset, true),
      cellX: view.getInt16(offset + 2, true),
      cellY: view.getInt16(offset + 4, true),
      instanceStart: view.getUint32(offset + 8, true),
      instanceCount: view.getUint32(offset + 12, true),
      centerX: view.getFloat32(offset + 16, true),
      centerY: view.getFloat32(offset + 20, true),
      centerZ: view.getFloat32(offset + 24, true),
      radius: view.getFloat32(offset + 28, true),
      maxScale: view.getFloat32(offset + 32, true),
    };
    if (cell.instanceStart + cell.instanceCount > instanceCount) throw new Error(`grass binary cell ${index} range is invalid`);
    cells.push(cell);
  }
  return {
    instanceCount,
    cellSize,
    matrices,
    cells,
    groundEffectAt: (index) => metadata.getUint16(index * METADATA_BYTES + 4, true),
    groundDoodadAt: (index) => metadata.getUint16(index * METADATA_BYTES + 6, true),
    detailAt: (index) => metadata.getUint8(index * METADATA_BYTES + 8),
    shadowAt: (index) => metadata.getUint8(index * METADATA_BYTES + 9) / 255,
    chunkAt: (index) => metadata.getUint8(index * METADATA_BYTES + 10),
    sourceIndexAt: (index) => metadata.getUint32(index * METADATA_BYTES, true),
  };
}
