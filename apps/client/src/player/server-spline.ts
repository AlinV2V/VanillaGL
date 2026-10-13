import type { SplineInfo } from '../world-entities';

type Point3 = { x: number; y: number; z: number };

type ServerSplineSegment = {
  p0: Point3;
  p1: Point3;
  p2: Point3;
  p3: Point3;
  length: number;
};

export type ServerSplinePath = {
  spline: SplineInfo;
  smooth: boolean;
  segments: ServerSplineSegment[];
  lengths: number[];
  total: number;
};

export type ServerSplineSample = Point3 & {
  o: number;
  complete: boolean;
};

export function finalServerSplineOrientation(
  spline: SplineInfo,
  position: Point3,
  target?: Point3,
): number | undefined {
  if (spline.finalO !== undefined) return spline.finalO;
  if (spline.finalX !== undefined && spline.finalY !== undefined) {
    return Math.atan2(spline.finalY - position.y, spline.finalX - position.x);
  }
  if (spline.finalTargetGuid && target) return Math.atan2(target.y - position.y, target.x - position.x);
  return undefined;
}

// MoveSplineFlag::Flying (0x200) is the Vanilla smooth/Catmull-Rom mode. vMaNGOS taxi flights
// select it through FlightPathMovementGenerator::Reset -> MoveSplineInit::SetFly().
const SPLINEFLAG_FLYING = 0x00000200;
const SPLINEFLAG_CYCLIC = 0x00100000;
// vMaNGOS SplineBase::SegLengthCatmullRom uses exactly three samples per segment when assigning
// timestamps. Matching that approximation keeps our segment selection aligned with the server.
const CATMULL_LENGTH_STEPS = 3;

function samePoint(a: Point3, b: Point3) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= 0.001;
}

function catmullPoint(segment: ServerSplineSegment, t: number): Point3 {
  const t2 = t * t;
  const t3 = t2 * t;
  const w0 = -0.5 * t3 + t2 - 0.5 * t;
  const w1 = 1.5 * t3 - 2.5 * t2 + 1;
  const w2 = -1.5 * t3 + 2 * t2 + 0.5 * t;
  const w3 = 0.5 * t3 - 0.5 * t2;
  return {
    x: segment.p0.x * w0 + segment.p1.x * w1 + segment.p2.x * w2 + segment.p3.x * w3,
    y: segment.p0.y * w0 + segment.p1.y * w1 + segment.p2.y * w2 + segment.p3.y * w3,
    z: segment.p0.z * w0 + segment.p1.z * w1 + segment.p2.z * w2 + segment.p3.z * w3,
  };
}

function catmullDerivative(segment: ServerSplineSegment, t: number): Point3 {
  const t2 = t * t;
  const w0 = -1.5 * t2 + 2 * t - 0.5;
  const w1 = 4.5 * t2 - 5 * t;
  const w2 = -4.5 * t2 + 4 * t + 0.5;
  const w3 = 1.5 * t2 - t;
  return {
    x: segment.p0.x * w0 + segment.p1.x * w1 + segment.p2.x * w2 + segment.p3.x * w3,
    y: segment.p0.y * w0 + segment.p1.y * w1 + segment.p2.y * w2 + segment.p3.y * w3,
    z: segment.p0.z * w0 + segment.p1.z * w1 + segment.p2.z * w2 + segment.p3.z * w3,
  };
}

function segmentLength(segment: ServerSplineSegment, smooth: boolean) {
  if (!smooth) {
    return Math.hypot(
      segment.p2.x - segment.p1.x,
      segment.p2.y - segment.p1.y,
      segment.p2.z - segment.p1.z,
    );
  }
  let previous = segment.p1;
  let length = 0;
  for (let step = 1; step <= CATMULL_LENGTH_STEPS; step++) {
    const next = catmullPoint(segment, step / CATMULL_LENGTH_STEPS);
    length += Math.hypot(next.x - previous.x, next.y - previous.y, next.z - previous.z);
    previous = next;
  }
  return length;
}

/** Build the path once per received SMSG_MONSTER_MOVE chunk. */
export function buildServerSplinePath(spline: SplineInfo): ServerSplinePath | undefined {
  if (spline.startX === undefined || spline.startY === undefined || spline.startZ === undefined) return undefined;
  const points: Point3[] = [{ x: spline.startX, y: spline.startY, z: spline.startZ }];
  for (const point of spline.points) if (!samePoint(points[points.length - 1], point)) points.push(point);
  const cyclic = (spline.flags & SPLINEFLAG_CYCLIC) !== 0;
  const end = { x: spline.endX, y: spline.endY, z: spline.endZ };
  if (cyclic) {
    if (points.length > 1 && samePoint(points[points.length - 1], points[0])) points.pop();
  } else if (!samePoint(points.at(-1) ?? end, end)) points.push(end);
  if (points.length < 2) return undefined;

  const smooth = (spline.flags & SPLINEFLAG_FLYING) !== 0;
  const segments: ServerSplineSegment[] = [];
  const lengths: number[] = [];
  let total = 0;
  const segmentCount = cyclic ? points.length : points.length - 1;
  for (let i = 0; i < segmentCount; i++) {
    // This is the same endpoint padding used by SplineBase::InitCatmullRom for a non-cyclic path:
    // extrapolate one virtual point before the start and duplicate the final control point.
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    const p0 = cyclic ? points[(i - 1 + points.length) % points.length] : points[i - 1] ?? {
      x: p1.x * 2 - p2.x,
      y: p1.y * 2 - p2.y,
      z: p1.z * 2 - p2.z,
    };
    const p3 = cyclic ? points[(i + 2) % points.length] : points[i + 2] ?? p2;
    const segment = { p0, p1, p2, p3, length: 0 };
    segment.length = segmentLength(segment, smooth);
    total += segment.length;
    segments.push(segment);
    lengths.push(total);
  }
  return { spline, smooth, segments, lengths, total };
}

/** Sample a received Vanilla server spline at the same time/segment parameter the server uses. */
export function sampleServerSpline(path: ServerSplinePath, nowMs: number): ServerSplineSample | undefined {
  const { spline, segments, lengths, total } = path;
  if (!spline.fullTime || !segments.length || total <= 0.001) return undefined;
  const elapsed = Math.max(0, nowMs - (spline.startedAt ?? nowMs));
  const cyclic = (spline.flags & SPLINEFLAG_CYCLIC) !== 0;
  const progress = cyclic
    ? (elapsed % spline.fullTime) / spline.fullTime
    : Math.min(1, elapsed / spline.fullTime);
  const distance = progress * total;
  let index = lengths.findIndex((length) => distance <= length);
  if (index < 0) index = lengths.length - 1;
  const previousLength = index === 0 ? 0 : lengths[index - 1];
  const segment = segments[index];
  const t = segment.length > 0 ? (distance - previousLength) / segment.length : 0;
  const point = path.smooth
    ? catmullPoint(segment, Math.max(0, Math.min(1, t)))
    : {
      x: segment.p1.x + (segment.p2.x - segment.p1.x) * t,
      y: segment.p1.y + (segment.p2.y - segment.p1.y) * t,
      z: segment.p1.z + (segment.p2.z - segment.p1.z) * t,
    };
  const direction = path.smooth
    ? catmullDerivative(segment, Math.max(0, Math.min(1, t)))
    : {
      x: segment.p2.x - segment.p1.x,
      y: segment.p2.y - segment.p1.y,
      z: segment.p2.z - segment.p1.z,
    };
  return {
    ...point,
    o: Math.atan2(direction.y, direction.x),
    complete: !cyclic && progress >= 1,
  };
}
