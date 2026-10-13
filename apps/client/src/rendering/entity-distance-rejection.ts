export type EntityDistancePoint = { x: number; y: number };

/** Allocation-free horizontal distance used by cold admission and the hot presentation loop. */
export function entityDistanceSquared(a: EntityDistancePoint, b: EntityDistancePoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function entityBeyondDrawDistance(
  position: EntityDistancePoint,
  view: EntityDistancePoint | null,
  drawDistance: number,
): boolean {
  if (!view) return false;
  const limit = Number.isFinite(drawDistance) ? Math.max(1, drawDistance) : Number.POSITIVE_INFINITY;
  return entityDistanceSquared(position, view) > limit * limit;
}
