export type SpatialDoodadInstance = { x?: number; y?: number; z?: number };
export type SpatialDoodadBatch = {
  key: string;
  indices: Uint32Array;
  cellX: number;
  cellY: number;
};

export type SpatialBatchCheckpoint = (completed: number) => Promise<void>;

/** Measured CPU/GPU balance; see docs/PERFORMANCE_AUDIT.md. */
export const SPATIAL_DOODAD_CELL_SIZES = Object.freeze({
  grass: 128,
  wmo: 192,
  terrain: 224,
});

export type DoodadBatchPlan = {
  mode: 'spatial' | 'whole';
  cellSize: number;
  policy: 'forced-spatial' | 'forced-whole' | 'terrain-spatial' | 'wmo-spatial' | 'grass-spatial';
};

/**
 * Keep logical visibility cells independent from physical render-object packing. Whole-source and
 * coarse-cell candidates reduced object count but did not improve CPU and inflated submitted
 * triangles in repeated Stormwind captures. Physical part grouping now removes render objects
 * without weakening these measured visibility bounds. URL overrides remain exact diagnostic A/Bs.
 */
export function selectDoodadBatchPlan(input: {
  kind: 'grass' | 'wmo' | 'terrain';
  instanceCount: number;
  trianglesPerInstance: number;
  objectRadius: number;
  override?: 'spatial' | 'whole' | null;
}): DoodadBatchPlan {
  const base = SPATIAL_DOODAD_CELL_SIZES[input.kind];
  if (input.override === 'whole') return { mode: 'whole', cellSize: base, policy: 'forced-whole' };
  if (input.override === 'spatial') return { mode: 'spatial', cellSize: base, policy: 'forced-spatial' };
  if (input.kind === 'grass') return { mode: 'spatial', cellSize: base, policy: 'grass-spatial' };
  return { mode: 'spatial', cellSize: base, policy: input.kind === 'wmo' ? 'wmo-spatial' : 'terrain-spatial' };
}

/**
 * Partition one logical source mesh into bounded world cells. Instancing remains per
 * geometry/material, but visibility can now reject a small cell instead of keeping a
 * whole 533-yard ADT batch resident because one tree at the edge is visible.
 */
export function buildSpatialDoodadBatches(
  instances: readonly SpatialDoodadInstance[],
  sourceIndices: readonly number[],
  cellSize: number,
  mode: 'spatial' | 'whole' = 'spatial',
): SpatialDoodadBatch[] {
  if (mode === 'whole') {
    return sourceIndices.length ? [{ key: 'whole', indices: Uint32Array.from(sourceIndices), cellX: 0, cellY: 0 }] : [];
  }
  const size = Math.max(16, Math.min(512, cellSize));
  const cells = countSpatialCells(instances, sourceIndices, size);
  const batches = allocateSpatialCells(cells);
  for (const index of sourceIndices) {
    const instance = instances[index];
    if (!instance) continue;
    const batch = batches.get(cellKey(instance, size))!;
    batch.indices[batch.cursor++] = index;
  }
  return [...batches.values()].map(({ cursor: _cursor, ...batch }) => batch);
}

type CountedCell = { key: string; cellX: number; cellY: number; count: number };
type MutableBatch = SpatialDoodadBatch & { cursor: number };
const cellKey = (instance: SpatialDoodadInstance, size: number) =>
  `${Math.floor(Number(instance.x ?? 0) / size)}:${Math.floor(Number(instance.y ?? 0) / size)}`;
const countSpatialCells = (instances: readonly SpatialDoodadInstance[], sourceIndices: readonly number[], size: number) => {
  const cells = new Map<string, CountedCell>();
  for (const index of sourceIndices) {
    const instance = instances[index]; if (!instance) continue;
    const cellX = Math.floor(Number(instance.x ?? 0) / size), cellY = Math.floor(Number(instance.y ?? 0) / size);
    const key = `${cellX}:${cellY}`, cell = cells.get(key);
    if (cell) cell.count++; else cells.set(key, { key, cellX, cellY, count: 1 });
  }
  return cells;
};
const allocateSpatialCells = (cells: Map<string, CountedCell>) => new Map(
  [...cells].map(([key, cell]) => [key, { key, cellX: cell.cellX, cellY: cell.cellY, indices: new Uint32Array(cell.count), cursor: 0 }]),
);

/** Cooperative variant used while streaming large tile manifests. */
export async function buildSpatialDoodadBatchesProgressive(
  instances: readonly SpatialDoodadInstance[],
  sourceIndices: readonly number[],
  cellSize: number,
  checkpoint: SpatialBatchCheckpoint,
  mode: 'spatial' | 'whole' = 'spatial',
): Promise<SpatialDoodadBatch[]> {
  if (mode === 'whole') {
    return sourceIndices.length ? [{ key: 'whole', indices: Uint32Array.from(sourceIndices), cellX: 0, cellY: 0 }] : [];
  }
  const size = Math.max(16, Math.min(512, cellSize));
  const cells = new Map<string, CountedCell>();
  for (let offset = 0; offset < sourceIndices.length; offset++) {
    const index = sourceIndices[offset];
    const instance = instances[index];
    if (instance) {
      const cellX = Math.floor(Number(instance.x ?? 0) / size);
      const cellY = Math.floor(Number(instance.y ?? 0) / size);
      const key = `${cellX}:${cellY}`;
      const cell = cells.get(key);
      if (cell) cell.count++; else cells.set(key, { key, cellX, cellY, count: 1 });
    }
    if ((offset & 127) === 127) await checkpoint(offset + 1);
  }
  const batches = allocateSpatialCells(cells);
  for (let offset = 0; offset < sourceIndices.length; offset++) {
    const index = sourceIndices[offset], instance = instances[index];
    if (instance) { const batch = batches.get(cellKey(instance, size))!; batch.indices[batch.cursor++] = index; }
    if ((offset & 127) === 127) await checkpoint(sourceIndices.length + offset + 1);
  }
  return [...batches.values()].map(({ cursor: _cursor, ...batch }) => batch);
}
