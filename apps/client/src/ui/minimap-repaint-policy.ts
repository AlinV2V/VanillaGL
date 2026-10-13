export const MINIMAP_BACKGROUND_MOVEMENT_PX = 0.2;
export const MINIMAP_HEADING_DELTA_RAD = 0.003;

export function minimapBackgroundNeedsPaint(
  x: number,
  y: number,
  paintedX: number,
  paintedY: number,
  pixelsPerYard: number,
): boolean {
  const movedPixels = Math.hypot(x - paintedX, y - paintedY) * pixelsPerYard;
  return !Number.isFinite(movedPixels) || movedPixels >= MINIMAP_BACKGROUND_MOVEMENT_PX;
}

export function minimapHeadingNeedsPaint(heading: number, paintedHeading: number): boolean {
  const delta = Math.abs(Math.atan2(Math.sin(heading - paintedHeading), Math.cos(heading - paintedHeading)));
  return !Number.isFinite(delta) || delta >= MINIMAP_HEADING_DELTA_RAD;
}
