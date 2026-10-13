/** Build 5875 MoveSplineFlag::Cyclic. */
export const SPLINEFLAG_CYCLIC = 0x00100000;
const TRANSLATING_MOVE_FLAGS = 0x0000000f;

export type UnitSplineClockInput = {
  flags: number;
  fullTime: number;
  startedAt?: number;
};

export type UnitSplineClock = {
  progress: number;
  moving: boolean;
  completed: boolean;
  cyclic: boolean;
};

/** Resolve a server spline against the render clock without confusing presence with activity. */
export function unitSplineClock(spline: UnitSplineClockInput | undefined, now: number): UnitSplineClock {
  const cyclic = !!spline && (spline.flags & SPLINEFLAG_CYCLIC) !== 0;
  if (!spline || !(spline.fullTime > 0) || spline.startedAt === undefined || !Number.isFinite(spline.startedAt)) {
    return { progress: 0, moving: false, completed: false, cyclic };
  }
  const elapsed = Math.max(0, now - spline.startedAt);
  if (cyclic) {
    return { progress: (elapsed % spline.fullTime) / spline.fullTime, moving: true, completed: false, cyclic: true };
  }
  const completed = elapsed >= spline.fullTime;
  return {
    progress: completed ? 1 : elapsed / spline.fullTime,
    moving: !completed,
    completed,
    cyclic: false,
  };
}

/** A completed creature path is a stop: discard the stale path and direction bits together. */
export function retireCompletedUnitSpline(entity: { spline?: unknown; flags?: number }) {
  entity.spline = undefined;
  entity.flags = (entity.flags ?? 0) & ~TRANSLATING_MOVE_FLAGS;
}

/** Consume vMaNGOS MoveSplineInit::SetStop packets before stale movement flags reach animation. */
export function retireStoppedUnitSpline(entity: {
  spline?: UnitSplineClockInput;
  flags?: number;
}): boolean {
  if (!entity.spline || entity.spline.fullTime > 0) return false;
  retireCompletedUnitSpline(entity);
  return true;
}
