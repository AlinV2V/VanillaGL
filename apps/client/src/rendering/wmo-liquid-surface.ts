import * as THREE from 'three';
import { createWaterMaterial } from '../water-material';
/** Asset conversion utility. */
export type BakedWmoLiquid = {
  corner: [number, number, number];
  xverts: number;
  yverts: number;
  xtiles: number;
  ytiles: number;
  type: number;
  heights: ArrayLike<number>;
  flags: ArrayLike<number>;
};

export type WmoLiquidInstance = {
  id: string;
  root: THREE.Object3D;
  mesh: THREE.Mesh;
  liquid: BakedWmoLiquid;
};

export function wmoLiquidWorldBounds(instance: WmoLiquidInstance, target: THREE.Box3): THREE.Box3 {
  instance.mesh.updateWorldMatrix(true, false);
  const bounds = instance.mesh.geometry.boundingBox;
  return bounds ? target.copy(bounds).applyMatrix4(instance.mesh.matrixWorld) : target.makeEmpty();
}

export function sampleAdtLiquid(
  tile: { water?: { type: number; grid: Float32Array } | null; n: number; step: number; centerX: number; centerY: number } | undefined,
  worldX: number,
  worldY: number,
  tileHalf: number,
): { height: number; type: number } {
  if (!tile?.water) return { height: -Infinity, type: -1 };
  const { grid, type } = tile.water, { n, step } = tile;
  const row = Math.max(0, Math.min(n - 2, Math.floor((tileHalf - (worldX - tile.centerX)) / step)));
  const column = Math.max(0, Math.min(n - 2, Math.floor((tileHalf - (worldY - tile.centerY)) / step)));
  let sum = 0, count = 0;
  for (const [dr, dc] of [[0, 0], [0, 1], [1, 0], [1, 1]] as const) {
    const height = grid[(row + dr) * n + column + dc];
    if (!Number.isNaN(height)) { sum += height; count++; }
  }
  return { height: count ? sum / count : -Infinity, type };
}

// Vanilla WMO liquid vertices use the same 4.16666-yard grid as ADT liquid.
const LIQUID_TILE_SIZE = 533.3333333333334 / 128;

const isWetTile = (liquid: BakedWmoLiquid, x: number, y: number) =>
  (Number(liquid.flags[y * liquid.xtiles + x]) & 0x0f) !== 0x0f;

export function createWmoLiquidMesh(liquid: BakedWmoLiquid): THREE.Mesh | null {
  if (
    liquid.xverts !== liquid.xtiles + 1
    || liquid.yverts !== liquid.ytiles + 1
    || liquid.heights.length !== liquid.xverts * liquid.yverts
    || liquid.flags.length !== liquid.xtiles * liquid.ytiles
  ) return null;

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const vertexMap = new Map<number, number>();

  const vertex = (x: number, y: number) => {
    const sourceIndex = y * liquid.xverts + x;
    const existing = vertexMap.get(sourceIndex);
    if (existing !== undefined) return existing;
    const index = positions.length / 3;
    positions.push(
      liquid.corner[0] + x * LIQUID_TILE_SIZE,
      liquid.corner[1] + y * LIQUID_TILE_SIZE,
      Number(liquid.heights[sourceIndex]),
    );
    uvs.push(x / 8, y / 8);
    vertexMap.set(sourceIndex, index);
    return index;
  };

  for (let y = 0; y < liquid.ytiles; y++) {
    for (let x = 0; x < liquid.xtiles; x++) {
      if (!isWetTile(liquid, x, y)) continue;
      const a = vertex(x, y);
      const b = vertex(x + 1, y);
      const c = vertex(x, y + 1);
      const d = vertex(x + 1, y + 1);
      indices.push(a, b, d, a, d, c);
    }
  }
  if (!indices.length) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  // The two pre-height floats in a Vanilla MLIQ vertex are not documented well
  // enough to treat as depth. Use a neutral depth value instead of guessing.
  const depth = new Float32Array(positions.length / 3);
  depth.fill(1);
  geometry.setAttribute('waterDepth', new THREE.BufferAttribute(depth, 1));

  const mesh = new THREE.Mesh(geometry, createWaterMaterial(liquid.type));
  mesh.renderOrder = 5;
  mesh.userData.wowWmoLiquid = true;
  return mesh;
}

export function sampleWmoLiquid(
  instance: WmoLiquidInstance,
  renderX: number,
  renderY: number,
): { height: number; type: number } | null {
  const { liquid, root } = instance;
  const rootPosition = root.getWorldPosition(new THREE.Vector3());
  const local = root.worldToLocal(new THREE.Vector3(renderX, renderY, rootPosition.z));
  const fx = (local.x - liquid.corner[0]) / LIQUID_TILE_SIZE;
  const fy = (local.y - liquid.corner[1]) / LIQUID_TILE_SIZE;
  const approximateX = Math.floor(fx);
  const approximateY = Math.floor(fy);

  const projectedHeight = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): number | null => {
    const denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(denominator) < 1e-8) return null;
    const wa = ((b.y - c.y) * (renderX - c.x) + (c.x - b.x) * (renderY - c.y)) / denominator;
    const wb = ((c.y - a.y) * (renderX - c.x) + (a.x - c.x) * (renderY - c.y)) / denominator;
    const wc = 1 - wa - wb;
    if (wa < -1e-5 || wb < -1e-5 || wc < -1e-5) return null;
    return wa * a.z + wb * b.z + wc * c.z;
  };

  const sampleCell = (x: number, y: number): number | null => {
    if (x < 0 || y < 0 || x >= liquid.xtiles || y >= liquid.ytiles || !isWetTile(liquid, x, y)) return null;
    const point = (vx: number, vy: number) => root.localToWorld(new THREE.Vector3(
      liquid.corner[0] + vx * LIQUID_TILE_SIZE,
      liquid.corner[1] + vy * LIQUID_TILE_SIZE,
      Number(liquid.heights[vy * liquid.xverts + vx]),
    ));
    const a = point(x, y);
    const b = point(x + 1, y);
    const c = point(x, y + 1);
    const d = point(x + 1, y + 1);
    // Same diagonal/two triangles as vMaNGOS WmoLiquid::GetLiquidHeight.
    return projectedHeight(a, b, d) ?? projectedHeight(a, d, c);
  };

  // MODF placements are yaw-only in normal terrain, but the current corpus has
  // one slightly tilted liquid WMO. Test nearby projected triangles so the
  // gameplay height agrees with the rendered mesh even for that placement.
  for (let radius = 0; radius <= 8; radius++) {
    for (let y = approximateY - radius; y <= approximateY + radius; y++) {
      for (let x = approximateX - radius; x <= approximateX + radius; x++) {
        if (radius > 0 && x !== approximateX - radius && x !== approximateX + radius
          && y !== approximateY - radius && y !== approximateY + radius) continue;
        const height = sampleCell(x, y);
        if (height !== null) return { height, type: liquid.type };
      }
    }
  }
  return null;
}
