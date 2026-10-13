import * as THREE from 'three';
import { isPointInIndoorMask, type IndoorMaskVolume } from './wmo-interiors';
import type { WorldHydrationCheckpoint } from './world-hydration-scheduler';

type TerrainGeometryBuildOptions = {
  n: number;
  step: number;
  tileHalf: number;
  heights: Float32Array;
  innerHeights: Float32Array | null;
  holes: Uint16Array | null;
  indoorMasks: IndoorMaskVolume[];
  hydration: WorldHydrationCheckpoint;
};

export type TerrainGeometryBuild = {
  geometry: THREE.BufferGeometry;
  positions: Float32Array;
  maskedTriangles: number;
  holedTriangles: number;
};

/** Build terrain arrays cooperatively; no single row monopolizes a transition frame. */
export async function buildTerrainGeometry({
  n,
  step,
  tileHalf,
  heights,
  innerHeights,
  holes,
  indoorMasks,
  hydration,
}: TerrainGeometryBuildOptions): Promise<TerrainGeometryBuild> {
  const innerN = n - 1;
  const outerCount = n * n;
  const innerCount = innerHeights ? innerN * innerN : 0;
  const positions = new Float32Array((outerCount + innerCount) * 3);
  const uvs = new Float32Array((outerCount + innerCount) * 2);
  const indices: number[] = [];
  const maskPoint = new THREE.Vector3(), maskScratch = new THREE.Vector3();
  let maskedTriangles = 0, holedTriangles = 0;

  const terrainHoleMasked = (a: number, b: number, c: number) => {
    if (!holes) return false;
    const x = (positions[a * 3] + positions[b * 3] + positions[c * 3]) / 3;
    const y = (positions[a * 3 + 1] + positions[b * 3 + 1] + positions[c * 3 + 1]) / 3;
    const row = Math.max(0, Math.min(127, Math.floor((tileHalf - x) / step)));
    const col = Math.max(0, Math.min(127, Math.floor((tileHalf - y) / step)));
    const mask = holes[(row >> 3) * 16 + (col >> 3)] ?? 0;
    return !!mask && (mask & (1 << ((((row & 7) / 2) | 0) * 4 + (((col & 7) / 2) | 0)))) !== 0;
  };
  const triangleMasked = (a: number, b: number, c: number) => {
    if (!indoorMasks.length) return false;
    maskPoint.set(
      (positions[a * 3] + positions[b * 3] + positions[c * 3]) / 3,
      (positions[a * 3 + 1] + positions[b * 3 + 1] + positions[c * 3 + 1]) / 3,
      (positions[a * 3 + 2] + positions[b * 3 + 2] + positions[c * 3 + 2]) / 3,
    );
    return isPointInIndoorMask(maskPoint, indoorMasks, maskScratch, 0.35, 8);
  };
  const pushTriangle = (a: number, b: number, c: number) => {
    if (terrainHoleMasked(a, b, c)) { holedTriangles++; return; }
    if (triangleMasked(a, b, c)) { maskedTriangles++; return; }
    indices.push(a, b, c);
  };

  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const i = row * n + col;
      positions[i * 3] = tileHalf - row * step;
      positions[i * 3 + 1] = tileHalf - col * step;
      positions[i * 3 + 2] = heights[i];
      uvs[i * 2] = col / innerN;
      uvs[i * 2 + 1] = 1 - row / innerN;
    }
    if ((row & 7) === 7) await hydration.checkpoint(row * n);
  }
  if (innerHeights) {
    for (let row = 0; row < innerN; row++) {
      for (let col = 0; col < innerN; col++) {
        const i = outerCount + row * innerN + col;
        positions[i * 3] = tileHalf - (row + 0.5) * step;
        positions[i * 3 + 1] = tileHalf - (col + 0.5) * step;
        positions[i * 3 + 2] = innerHeights[row * innerN + col];
        uvs[i * 2] = (col + 0.5) / innerN;
        uvs[i * 2 + 1] = 1 - (row + 0.5) / innerN;
      }
      if ((row & 7) === 7) await hydration.checkpoint(outerCount + row * innerN);
    }
    for (let row = 0; row < innerN; row++) {
      for (let col = 0; col < innerN; col++) {
        const a = row * n + col, b = (row + 1) * n + col;
        const c = b + 1, d = a + 1, inner = outerCount + row * innerN + col;
        pushTriangle(a, b, inner); pushTriangle(b, c, inner);
        pushTriangle(c, d, inner); pushTriangle(d, a, inner);
      }
      if ((row & 3) === 3) await hydration.checkpoint(row * innerN);
    }
  } else {
    for (let row = 0; row < innerN; row++) {
      for (let col = 0; col < innerN; col++) {
        const a = row * n + col, b = (row + 1) * n + col, c = b + 1, d = a + 1;
        pushTriangle(a, b, d); pushTriangle(b, c, d);
      }
      if ((row & 3) === 3) await hydration.checkpoint(row * innerN);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return { geometry, positions, maskedTriangles, holedTriangles };
}
