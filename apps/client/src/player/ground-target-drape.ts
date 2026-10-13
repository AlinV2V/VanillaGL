/** Asset conversion utility. */
/** One reticle grid node per this many yards, and a hard cap on the resulting grid. */
export const RETICLE_YARDS_PER_SEGMENT = 1.5;
export const RETICLE_MAX_SEGMENTS = 24;

/**
 * Grid resolution for a reticle of the given radius: fine enough to follow relief, capped so a
 * large radius cannot explode the per-node heightmap reads done on every pointer move.
 */
export function reticleSegmentsFor(radius: number): number {
  return Math.max(8, Math.min(RETICLE_MAX_SEGMENTS, Math.ceil((radius * 2) / RETICLE_YARDS_PER_SEGMENT)));
}

/**
 * Drape a plane's vertices over the ground: each node's Z becomes the terrain height beneath it,
 * relative to the decal's centre (the group origin carries the absolute height).
 *
 * A node off the loaded heightmap samples non-finite; it stays on the centre plane rather than
 * collapsing to z=0 and shooting a spike through the world.
 */
export function drapeGrid(
  getXY: (i: number) => { x: number; y: number },
  setZ: (i: number, z: number) => void,
  count: number,
  centreX: number,
  centreY: number,
  centreZ: number,
  sample: (x: number, y: number) => number,
): void {
  for (let i = 0; i < count; i++) {
    const { x, y } = getXY(i);
    const height = sample(centreX + x, centreY + y);
    setZ(i, Number.isFinite(height) ? height - centreZ : 0);
  }
}
