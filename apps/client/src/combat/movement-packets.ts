import type { MovementInfo } from '../world-entities';

const MOVEFLAG_FALLING = 0x00002000;
const MOVEFLAG_SWIMMING = 0x00200000;
const MOVEFLAG_ONTRANSPORT = 0x02000000;
const MOVEFLAG_SPLINE_ELEVATION = 0x04000000;

class Cursor {
  offset = 0;
  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  get remaining() {
    return this.data.length - this.offset;
  }

  private ensure(length: number) {
    if (length < 0 || this.offset + length > this.data.length) {
      throw new Error(
        `movement packet truncated at ${this.offset}: need ${length}, have ${this.remaining}`,
      );
    }
  }

  u8() {
    this.ensure(1);
    return this.data[this.offset++];
  }

  u32() {
    this.ensure(4);
    const value = new DataView(
      this.data.buffer,
      this.data.byteOffset + this.offset,
      4,
    ).getUint32(0, true);
    this.offset += 4;
    return value;
  }

  f32() {
    this.ensure(4);
    const value = new DataView(
      this.data.buffer,
      this.data.byteOffset + this.offset,
      4,
    ).getFloat32(0, true);
    this.offset += 4;
    return value;
  }

  rawGuid() {
    this.ensure(8);
    const bytes = this.data.slice(this.offset, this.offset + 8);
    this.offset += 8;
    return guidHex(bytes);
  }

  packedGuid() {
    const mask = this.u8();
    const bytes = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
      if (mask & (1 << i)) bytes[i] = this.u8();
    }
    return guidHex(bytes);
  }

  end(label: string) {
    if (this.remaining !== 0) {
      throw new Error(`${label} left ${this.remaining} trailing bytes`);
    }
  }
}

function guidHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .reverse()
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function readMovementInfo(cursor: Cursor): MovementInfo {
  const flags = cursor.u32();
  const movement: MovementInfo = {
    flags,
    time: cursor.u32(),
    x: cursor.f32(),
    y: cursor.f32(),
    z: cursor.f32(),
    o: cursor.f32(),
    fallTime: 0,
  };
  if ((flags & MOVEFLAG_ONTRANSPORT) !== 0) {
    movement.transportGuid = cursor.rawGuid();
    movement.transportX = cursor.f32();
    movement.transportY = cursor.f32();
    movement.transportZ = cursor.f32();
    movement.transportO = cursor.f32();
  }
  if ((flags & MOVEFLAG_SWIMMING) !== 0) movement.swimPitch = cursor.f32();
  movement.fallTime = cursor.u32();
  if ((flags & MOVEFLAG_FALLING) !== 0) {
    movement.jumpVelocity = cursor.f32();
    movement.jumpCosAngle = cursor.f32();
    movement.jumpSinAngle = cursor.f32();
    movement.jumpXYSpeed = cursor.f32();
  }
  if ((flags & MOVEFLAG_SPLINE_ELEVATION) !== 0) {
    movement.splineElevation = cursor.f32();
  }
  return movement;
}

export function decodeSplineSpeedBody(
  body: Uint8Array,
): { guid: string; speed: number } {
  const cursor = new Cursor(body);
  const guid = cursor.packedGuid();
  const speed = cursor.f32();
  cursor.end('spline speed');
  return { guid, speed };
}

export function decodeObserverSpeedBody(
  body: Uint8Array,
): { guid: string; movement: MovementInfo; speed: number } {
  const cursor = new Cursor(body);
  const guid = cursor.packedGuid();
  const movement = readMovementInfo(cursor);
  const speed = cursor.f32();
  cursor.end('observer speed');
  return { guid, movement, speed };
}

export function decodeSplineModeBody(body: Uint8Array): { guid: string } {
  const cursor = new Cursor(body);
  const guid = cursor.packedGuid();
  cursor.end('spline movement mode');
  return { guid };
}

export function decodeObserverModeBody(
  body: Uint8Array,
): { guid: string; movement: MovementInfo } {
  const cursor = new Cursor(body);
  const guid = cursor.packedGuid();
  const movement = readMovementInfo(cursor);
  cursor.end('observer movement mode');
  return { guid, movement };
}

export function decodeForceSpeedBody(
  body: Uint8Array,
): { guid: string; movementCounter: number; speed: number } {
  const cursor = new Cursor(body);
  const guid = cursor.packedGuid();
  const movementCounter = cursor.u32();
  const speed = cursor.f32();
  cursor.end('force speed');
  return { guid, movementCounter, speed };
}

export function encodeForceSpeedAckBody(
  guid: string,
  movementCounter: number,
  movementInfoBody: Uint8Array,
  speed: number,
): Uint8Array {
  const out = new Uint8Array(8 + 4 + movementInfoBody.length + 4);
  const cleanGuid = guid.padStart(16, '0');
  for (let i = 0; i < 8; i++) {
    out[7 - i] = Number.parseInt(cleanGuid.slice(i * 2, i * 2 + 2), 16);
  }
  const view = new DataView(out.buffer);
  view.setUint32(8, movementCounter >>> 0, true);
  out.set(movementInfoBody, 12);
  view.setFloat32(12 + movementInfoBody.length, speed, true);
  return out;
}
