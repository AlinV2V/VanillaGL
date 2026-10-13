/** Asset conversion utility. */
/**
 * How far the rendered body may lag its target before we stop calling it "moving". Chosen, not
 * measured: above interpolation noise, below a visible slide. 0.05 yd is ~7 ms of travel at run
 * speed.
 */
export const RENDER_CONVERGED_EPSILON = 0.05;

export type PlanarPoint = { x: number; y: number };

/** True while the body still has ground to cover horizontally. */
export function isConvergingToTarget(
  position: PlanarPoint,
  target: PlanarPoint | undefined,
  epsilon = RENDER_CONVERGED_EPSILON,
): boolean {
  if (!target) return false;
  return Math.hypot(position.x - target.x, position.y - target.y) > epsilon;
}
