import type * as THREE from 'three';
import type { LoadedTile } from '../wow-app-types';
import { TILE_HALF } from '../tile-utils';
import { isPointInIndoorMask } from './wmo-interiors';
import { sampleTerrainHeightGrid } from './terrain-height-sampling';

export function sampleTileHeight(tile: LoadedTile, worldX: number, worldY: number, maskPoint: THREE.Vector3, maskScratch: THREE.Vector3): number {
  const { heights, innerHeights, n, step } = tile;
  const tileX = worldX - tile.centerX;
  const tileY = worldY - tile.centerY;
  const rowF = Math.max(0, Math.min(n - 1, (TILE_HALF - tileX) / step));
  const colF = Math.max(0, Math.min(n - 1, (TILE_HALF - tileY) / step));
  const r0 = Math.max(0, Math.min(n - 2, Math.floor(rowF)));
  const c0 = Math.max(0, Math.min(n - 2, Math.floor(colF)));
  if (tile.holes) {
    const chunkY = r0 >> 3;
    const chunkX = c0 >> 3;
    const mask = tile.holes[chunkY * 16 + chunkX] ?? 0;
    if (mask) {
      const holeY = ((r0 & 7) / 2) | 0;
      const holeX = ((c0 & 7) / 2) | 0;
      if ((mask & (1 << (holeY * 4 + holeX))) !== 0) return tile.meta.minHeight - 200;
    }
  }
  const terrainHeight = sampleTerrainHeightGrid(heights, innerHeights, n, rowF, colF);
  if (tile.indoorMasks.length) {
    maskPoint.set(tileX, tileY, terrainHeight);
    if (isPointInIndoorMask(maskPoint, tile.indoorMasks, maskScratch, 0.6, 24)) return tile.meta.minHeight - 200;
  }
  return terrainHeight;
}
