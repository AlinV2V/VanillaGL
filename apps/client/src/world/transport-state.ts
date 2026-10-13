export type TransportSource = {
  entry?: number;
  gameObjectType?: number;
  x?: number;
  y?: number;
  z?: number;
  o?: number;
  gameObjectRotation?: [number, number, number, number];
  transportPathTimer?: number;
  transportPathReceivedAt?: number;
};

const GAMEOBJECT_ROTATION = 0x0a;
const bits = new DataView(new ArrayBuffer(4));
const u32ToFloat = (value: number) => {
  bits.setUint32(0, value, true);
  return bits.getFloat32(0, true);
};

/** Apply the separately serialized UPDATEFLAG_TRANSPORT path clock at receipt time. */
export function applyTransportClock(
  target: TransportSource,
  timer: number | undefined,
  receivedAt = performance.now(),
) {
  if (timer === undefined) return;
  target.transportPathTimer = timer;
  target.transportPathReceivedAt = receivedAt;
}

/** Decode one of the four public Build 5875 GAMEOBJECT_ROTATION float fields. */
export function applyGameObjectRotationField(target: TransportSource, index: number, value: number) {
  if (index < GAMEOBJECT_ROTATION || index >= GAMEOBJECT_ROTATION + 4) return false;
  target.gameObjectRotation ??= [0, 0, 0, 1];
  target.gameObjectRotation[index - GAMEOBJECT_ROTATION] = u32ToFloat(value);
  return true;
}
