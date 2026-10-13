const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;
const numericBits = new DataView(new ArrayBuffer(8));

const mix = (hash: number, value: number) => Math.imul(hash ^ value, 16_777_619) >>> 0;

function mixString(hash: number, value: string): number {
  let next = mix(hash, value.length);
  for (let index = 0; index < value.length; index++) next = mix(next, value.charCodeAt(index));
  return next;
}

function hashValue(hash: number, value: unknown): number {
  if (value === null) return mix(hash, 0x10);
  if (value === undefined) return mix(hash, 0x11);
  if (typeof value === 'boolean') return mix(hash, value ? 0x21 : 0x20);
  if (typeof value === 'number') {
    numericBits.setFloat64(0, value);
    return mix(mix(mix(hash, 0x30), numericBits.getUint32(0)), numericBits.getUint32(4));
  }
  if (typeof value === 'string') return mixString(mix(hash, 0x40), value);
  if (typeof value !== 'object') return mixString(hash, typeof value);
  if (Array.isArray(value)) {
    let next = mix(hash, value.length);
    for (const item of value) next = hashValue(next, item);
    return next;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    let id = objectIds.get(value);
    if (!id) { id = nextObjectId++; objectIds.set(value, id); }
    return mix(hash, id);
  }
  let next = mix(hash, 0x50);
  for (const key in value as Record<string, unknown>) {
    next = mixString(next, key);
    next = hashValue(next, (value as Record<string, unknown>)[key]);
  }
  return next;
}

/** Allocation-light structural signature for the frequently refreshed mobile HUD model. */
export const mobileHudViewModelSignature = (model: unknown): number => hashValue(2_166_136_261, model);
