import { TRANSPORT_ANIMATIONS } from '../data/transport-animations';
import { SHIP_PATHS } from '../data/ship-paths';
import type { TransportSource } from '../world/transport-state';

export type TransportAnimationNode = { time: number; x: number; y: number; z: number };
export type TransportAnimation = { totalTime: number; nodes: TransportAnimationNode[] };
export type TransportAnimationAsset = { version: 1; elevators: Record<string, TransportAnimation> };

export type TransportWorldPose = { x: number; y: number; z: number; o: number };

type V3 = { x: number; y: number; z: number };
type ShipFrame = {
  x: number; y: number; z: number; arrive: number; depart: number; nextArrive: number;
  distSinceStop: number; distUntilStop: number; timeFrom: number; timeTo: number;
  nextDistFromPrev: number; initialO: number; arrivalO?: number; segment?: [V3, V3, V3, V3];
};
type ShipPath = { period: number; speed: number; accel: number; accelTime: number; accelDist: number; frames: ShipFrame[] };

const GAMEOBJECT_TYPE_TRANSPORT = 11;
const GAMEOBJECT_TYPE_MO_TRANSPORT = 15;

const catmull = (segment: readonly V3[], t: number, derivative = false): V3 => {
  const t2 = t * t;
  const weights = derivative
    ? [-1.5 * t2 + 2 * t - 0.5, 4.5 * t2 - 5 * t, -4.5 * t2 + 4 * t + 0.5, 1.5 * t2 - t]
    : [-0.5 * t2 * t + t2 - 0.5 * t, 1.5 * t2 * t - 2.5 * t2 + 1,
      -1.5 * t2 * t + 2 * t2 + 0.5 * t, 0.5 * t2 * t - 0.5 * t2];
  return { x: segment.reduce((sum, point, index) => sum + point.x * weights[index], 0),
    y: segment.reduce((sum, point, index) => sum + point.y * weights[index], 0),
    z: segment.reduce((sum, point, index) => sum + point.z * weights[index], 0) };
};

/** Match vMaNGOS ShipTransport::Update/CalculateSegmentPos over baked TaxiPathNode key frames. */
export function shipWorldPose(source: TransportSource, path: ShipPath | undefined, nowMs: number): TransportWorldPose | undefined {
  if (source.gameObjectType !== GAMEOBJECT_TYPE_MO_TRANSPORT || !path || path.period <= 0
    || source.transportPathTimer === undefined || source.transportPathReceivedAt === undefined) return undefined;
  const progress = (source.transportPathTimer + Math.max(0, nowMs - source.transportPathReceivedAt)) % path.period;
  const frame = path.frames.find((candidate) => (progress >= candidate.arrive && progress < candidate.depart)
    || (progress >= candidate.depart && progress < candidate.nextArrive));
  if (!frame) return undefined;
  if (progress < frame.depart || !frame.segment || frame.nextDistFromPrev <= 0) {
    return { x: frame.x, y: frame.y, z: frame.z, o: frame.arrivalO ?? frame.initialO };
  }
  const seconds = progress * 0.001;
  const sinceStop = frame.timeFrom + (seconds - frame.depart * 0.001);
  const untilStop = frame.timeTo - (seconds - frame.depart * 0.001);
  let segmentDistance: number;
  if (sinceStop < untilStop) {
    const distance = sinceStop < path.accelTime
      ? 0.5 * path.accel * sinceStop * sinceStop
      : path.accelDist + (sinceStop - path.accelTime) * path.speed;
    segmentDistance = distance - frame.distSinceStop;
  } else {
    const distance = untilStop < path.accelTime
      ? 0.5 * path.accel * untilStop * untilStop
      : path.accelDist + (untilStop - path.accelTime) * path.speed;
    segmentDistance = frame.distUntilStop - distance;
  }
  const t = Math.max(0, Math.min(1, segmentDistance / frame.nextDistFromPrev));
  const position = catmull(frame.segment, t);
  const direction = catmull(frame.segment, t, true);
  return { ...position, o: Math.atan2(direction.y, direction.x) + Math.PI };
}

/**
 * Match vMaNGOS ElevatorTransport::Update for Vanilla GAMEOBJECT_TYPE_TRANSPORT.
 * The server sends the stationary spawn and a path-progress clock; TransportAnimation.dbc carries
 * the local offsets. G3D's `Vector3 * Quat` is the transpose/inverse of the usual q*v rotation,
 * followed by the Vanilla-only Y sign flip in Transport.cpp.
 */
export function elevatorWorldPose(
  source: TransportSource,
  animation: TransportAnimation | undefined,
  now: number,
): TransportWorldPose | undefined {
  if (
    source.gameObjectType !== GAMEOBJECT_TYPE_TRANSPORT
    || source.x === undefined || source.y === undefined || source.z === undefined
    || source.transportPathTimer === undefined || source.transportPathReceivedAt === undefined
    || !animation || animation.totalTime <= 0 || animation.nodes.length < 2
  ) return undefined;

  const elapsed = Math.max(0, now - source.transportPathReceivedAt);
  const progress = (source.transportPathTimer + elapsed) % animation.totalTime;
  let nextIndex = animation.nodes.findIndex((node) => node.time >= progress);
  if (nextIndex < 0) nextIndex = animation.nodes.length - 1;
  // vMaNGOS intentionally returns no previous node at t <= the first key. Use the authored first
  // position for that sub-millisecond boundary instead of emitting no frame for the browser.
  const previous = animation.nodes[Math.max(0, nextIndex - 1)];
  const next = animation.nodes[nextIndex];
  const duration = next.time - previous.time;
  const alpha = duration > 0 ? Math.max(0, Math.min(1, (progress - previous.time) / duration)) : 0;
  const px = previous.x + (next.x - previous.x) * alpha;
  const py = previous.y + (next.y - previous.y) * alpha;
  const pz = previous.z + (next.z - previous.z) * alpha;

  const [qx, qy, qz, qw] = source.gameObjectRotation ?? [0, 0, 0, 1];
  // Quaternion inverse rotation. Keep the scalar formula here so the protocol math is independent
  // of three.js and can be verified directly in Node against the server implementation.
  const ix = qw * px - qy * pz + qz * py;
  const iy = qw * py - qz * px + qx * pz;
  const iz = qw * pz - qx * py + qy * px;
  const iw = qx * px + qy * py + qz * pz;
  const rx = ix * qw + iw * qx + iy * qz - iz * qy;
  const ry = iy * qw + iw * qy + iz * qx - ix * qz;
  const rz = iz * qw + iw * qz + ix * qy - iy * qx;

  return { x: source.x + rx, y: source.y - ry, z: source.z + rz, o: source.o ?? 0 };
}

export class TransportLocomotion {
  pose(source: TransportSource, now: number) {
    const asset = TRANSPORT_ANIMATIONS as TransportAnimationAsset;
    const animation = source.entry === undefined ? undefined : asset.elevators[String(source.entry)];
    return elevatorWorldPose(source, animation, now)
      ?? shipWorldPose(source, source.entry === undefined ? undefined
        : (SHIP_PATHS.ships as Record<string, ShipPath>)[String(source.entry)], now);
  }
}

type LocalPoint = { x: number; y: number };
type RenderTarget = { position: { set(x: number, y: number, z: number): unknown }; rotation: { z: number } };

/** Owns transport clocks/frames so the entity renderer only supplies coordinate conversion. */
export class TransportRuntime {
  private readonly locomotion = new TransportLocomotion();
  private readonly frames = new Map<string, TransportWorldPose>();

  constructor(private readonly worldToLocal: (x: number, y: number) => LocalPoint | null) {}

  positioned<T extends TransportSource>(source: T, now: number): T {
    const pose = this.locomotion.pose(source, now);
    return pose ? { ...source, ...pose } : source;
  }

  frame(guid: string) { return this.frames.get(guid); }
  remove(guid: string) { this.frames.delete(guid); }

  advance(source: TransportSource & { guid: string }, target: RenderTarget, now: number) {
    const pose = this.locomotion.pose(source, now);
    if (!pose) {
      this.frames.delete(source.guid);
      return;
    }
    const local = this.worldToLocal(pose.x, pose.y);
    if (!local) return;
    this.frames.set(source.guid, pose);
    target.position.set(local.x, local.y, pose.z);
    target.rotation.z = pose.o;
  }
}
