import type { SplineInfo } from '../world-entities';
import { buildServerSplinePath, finalServerSplineOrientation, sampleServerSpline, type ServerSplinePath } from '../player/server-spline';
import { unitSplineClock } from './unit-spline-state';

export type PresentationWorldTransform = { x: number; y: number; z: number; o: number };

export type UnitSplinePresentationState = {
  cache?: ServerSplinePath;
  ownedSpline?: SplineInfo;
  retiredSpline?: SplineInfo;
  world?: PresentationWorldTransform;
};

export type UnitSplinePresentationFrame = {
  moving: boolean;
  retired: boolean;
  world?: PresentationWorldTransform;
};

export const ownsUnitSpline = (state: UnitSplinePresentationState, spline: SplineInfo | undefined) =>
  spline !== undefined && state.ownedSpline === spline;

export const retiredUnitSpline = (state: UnitSplinePresentationState, spline: SplineInfo | undefined) =>
  spline !== undefined && state.retiredSpline === spline;

/** Sample immutable server spline state without writing presentation coordinates back to it. */
export function advanceUnitSplinePresentation(
  spline: SplineInfo | undefined,
  state: UnitSplinePresentationState,
  now: number,
  finalTarget?: { x: number; y: number; z: number },
): UnitSplinePresentationFrame {
  if (!spline) return { moving: false, retired: false };
  if (retiredUnitSpline(state, spline)) return { moving: false, retired: true };
  if (!(spline.fullTime > 0)) {
    state.retiredSpline = spline; state.ownedSpline = spline; state.cache = undefined;
    return { moving: false, retired: true };
  }
  let cache = state.cache;
  if (!cache || cache.spline !== spline) {
    cache = buildServerSplinePath(spline);
    if (!cache) return { moving: false, retired: false };
    state.cache = cache; state.ownedSpline = spline;
  }
  if (cache.total <= 0.001) {
    state.retiredSpline = spline; state.cache = undefined;
    return { moving: false, retired: true };
  }
  const clock = unitSplineClock(spline, now), sample = sampleServerSpline(cache, now);
  if (!sample) return { moving: false, retired: false };
  const orientation = clock.completed
    ? finalServerSplineOrientation(spline, sample, finalTarget) ?? sample.o
    : sample.o;
  const world = { x: sample.x, y: sample.y, z: sample.z, o: orientation };
  state.world = world;
  if (clock.completed) { state.retiredSpline = spline; state.cache = undefined; }
  return { moving: clock.moving, retired: clock.completed, world };
}
