import type * as THREE from 'three';

type Numeric = ArrayLike<number>;
type SurfaceIndex = { cells: Map<string, number[]>; globalFaces: number[] };

const CELL_SIZE = 8;
const MAX_CELLS_PER_FACE = 256;
const cache = new WeakMap<object, SurfaceIndex>();
const cellKey = (x: number, y: number) => `${x}:${y}`;

const build = (group: object & { positions?: Numeric; indices?: Numeric; mopyFlags?: Numeric }): SurfaceIndex | null => {
  const positions = group.positions, indices = group.indices;
  if (!positions || !indices) return null;
  const cells = new Map<string, number[]>(), globalFaces: number[] = [];
  for (let face = 0; face * 3 + 2 < indices.length; face++) {
    if (((group.mopyFlags?.[face] ?? 0) & 0x08) !== 0) continue;
    const ia = indices[face * 3], ib = indices[face * 3 + 1], ic = indices[face * 3 + 2];
    const minX = Math.floor(Math.min(positions[ia * 3], positions[ib * 3], positions[ic * 3]) / CELL_SIZE);
    const maxX = Math.floor(Math.max(positions[ia * 3], positions[ib * 3], positions[ic * 3]) / CELL_SIZE);
    const minY = Math.floor(Math.min(positions[ia * 3 + 1], positions[ib * 3 + 1], positions[ic * 3 + 1]) / CELL_SIZE);
    const maxY = Math.floor(Math.max(positions[ia * 3 + 1], positions[ib * 3 + 1], positions[ic * 3 + 1]) / CELL_SIZE);
    if ((maxX - minX + 1) * (maxY - minY + 1) > MAX_CELLS_PER_FACE) { globalFaces.push(face); continue; }
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
      const key = cellKey(x, y), list = cells.get(key);
      if (list) list.push(face); else cells.set(key, [face]);
    }
  }
  return { cells, globalFaces };
};

/** Visit only triangles whose XY bounds overlap the sample cell; every candidate remains exact. */
export function visitMocvCandidateFaces(
  group: object & { positions?: Numeric; indices?: Numeric; mopyFlags?: Numeric },
  point: Pick<THREE.Vector3, 'x' | 'y'>,
  visit: (face: number) => void,
): boolean {
  let index = cache.get(group);
  if (!index) {
    const built = build(group);
    if (!built) return false;
    cache.set(group, built); index = built;
  }
  for (const face of index.globalFaces) visit(face);
  for (const face of index.cells.get(cellKey(Math.floor(point.x / CELL_SIZE), Math.floor(point.y / CELL_SIZE))) ?? []) visit(face);
  return true;
}
