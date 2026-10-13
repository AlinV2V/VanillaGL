import * as THREE from 'three';
import { createWaterMaterial } from '../water-material';

export type LoadedWaterSurface = {
  mesh: THREE.Mesh | null;
  water: { grid: Float32Array; type: number } | null;
};

export const loadWaterSurface = async (opts: {
  base: string;
  n: number;
  step: number;
  tileHalf: number;
  signal?: AbortSignal;
  checkpoint?: () => Promise<void>;
}): Promise<LoadedWaterSurface> => {
  const { base, n, step, tileHalf, signal, checkpoint } = opts;
  const metaResponse = await fetch(`${base}/water.json`, { signal });
  if (metaResponse.status === 404 || metaResponse.headers.get('content-type')?.includes('text/html')) return { mesh: null, water: null };
  if (!metaResponse.ok) throw new Error(`water metadata failed: ${metaResponse.status} ${base}/water.json`);
  const wmeta = await metaResponse.json();
  if (!wmeta?.hasWater) return { mesh: null, water: null };
  const gridResponse = await fetch(`${base}/water.f32`, { signal });
  if (!gridResponse.ok) throw new Error(`water grid failed: ${gridResponse.status} ${base}/water.f32`);
  const grid = new Float32Array(await gridResponse.arrayBuffer());
  const depthResp = await fetch(`${base}/water-depth.u8`, { signal });
  let depthGrid: Uint8Array | null = null;
  if (depthResp.ok && !depthResp.headers.get('content-type')?.includes('text/html')) {
    depthGrid = new Uint8Array(await depthResp.arrayBuffer());
  } else if (depthResp.status !== 404 && !depthResp.headers.get('content-type')?.includes('text/html')) {
    throw new Error(`water depth failed: ${depthResp.status} ${base}/water-depth.u8`);
  }
  if (grid.length !== n * n) throw new Error(`water grid malformed: ${grid.length}/${n * n}`);
  if (depthGrid && depthGrid.length !== n * n) throw new Error(`water depth malformed: ${depthGrid.length}/${n * n}`);

    const wp: number[] = [];
    const wuv: number[] = [];
    const wdepth: number[] = [];
    const widx: number[] = [];
    const vmap = new Int32Array(n * n).fill(-1);
    const vert = (row: number, col: number): number => {
      const gi = row * n + col;
      if (vmap[gi] >= 0) return vmap[gi];
      const id = wp.length / 3;
      wp.push(tileHalf - row * step, tileHalf - col * step, grid[gi]);
      wuv.push(col / 8, row / 8);
      wdepth.push(depthGrid && depthGrid.length > gi ? depthGrid[gi] / 255 : 1);
      vmap[gi] = id;
      return id;
    };
    for (let row = 0; row < n - 1; row++) {
      for (let col = 0; col < n - 1; col++) {
        const i = row * n + col;
        if (Number.isNaN(grid[i]) || Number.isNaN(grid[i + 1]) || Number.isNaN(grid[i + n]) || Number.isNaN(grid[i + n + 1])) continue;
        const a = vert(row, col), b = vert(row, col + 1), c = vert(row + 1, col), d = vert(row + 1, col + 1);
        widx.push(a, c, b, b, c, d);
      }
      if ((row & 3) === 3) await checkpoint?.();
    }

  let mesh: THREE.Mesh | null = null;
  if (widx.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(wuv, 2));
    geo.setAttribute('waterDepth', new THREE.Float32BufferAttribute(wdepth, 1));
    geo.setIndex(widx);
    mesh = new THREE.Mesh(geo, createWaterMaterial(wmeta.type ?? 1)); mesh.userData.wowWater = true;
    mesh.renderOrder = 5;
  }
  return { mesh, water: { grid, type: wmeta.type ?? 1 } };
};
