export type SpellLocation = { x: number; y: number; z: number };
export type SpellDestination = SpellLocation;

// SpellCastTargetFlags from vMaNGOS SpellDefines.h, serialized as a Build-5875 uint16.
export const TARGET_FLAG_UNIT = 0x0002;
export const TARGET_FLAG_UNIT_RAID = 0x0004;
export const TARGET_FLAG_UNIT_PARTY = 0x0008;
export const TARGET_FLAG_ITEM = 0x0010;
export const TARGET_FLAG_SOURCE_LOCATION = 0x0020;
export const TARGET_FLAG_DEST_LOCATION = 0x0040;
export const TARGET_FLAG_UNIT_ENEMY = 0x0080;
export const TARGET_FLAG_UNIT_ALLY = 0x0100;
export const TARGET_FLAG_CORPSE_ENEMY = 0x0200;
export const TARGET_FLAG_UNIT_DEAD = 0x0400;
export const TARGET_FLAG_GAMEOBJECT = 0x0800;
export const TARGET_FLAG_TRADE_ITEM = 0x1000;
export const TARGET_FLAG_STRING = 0x2000;
export const TARGET_FLAG_LOCKED = 0x4000;
export const TARGET_FLAG_CORPSE_ALLY = 0x8000;

export type SpellCastTargets = {
  targetMask: number;
  unitGuid?: string;
  gameObjectGuid?: string;
  corpseGuid?: string;
  itemGuid?: string;
  source?: SpellLocation;
  destination?: SpellLocation;
  stringTarget?: string;
};

export type SpellTargetReader = {
  u8(): number;
  u16(): number;
  f32(): number;
  cstring(): string;
};

const DESTINATION_IMPLICIT_TARGETS = new Set([8, 16, 28, 29, 31, 34, 52]);
const SOURCE_IMPLICIT_TARGETS = new Set([7, 15, 30, 33, 51]);
const UNIT_IMPLICIT_TARGETS = new Set([6, 21, 25, 35, 45, 53, 57, 61, 63]);

export type SpellTargetWorkflow =
  | 'self'
  | 'unit'
  | 'gameObject'
  | 'locked'
  | 'item'
  | 'tradeItem'
  | 'corpse'
  | 'source'
  | 'destination'
  | 'string';
/** Asset conversion utility. */
export function spellTargetWorkflow(
  explicitMask: number | undefined,
  implicitTargets: readonly number[] | undefined,
): SpellTargetWorkflow {
  const mask = explicitMask ?? 0;
  if ((mask & TARGET_FLAG_TRADE_ITEM) !== 0) return 'tradeItem';
  if ((mask & TARGET_FLAG_ITEM) !== 0) return 'item';
  if ((mask & TARGET_FLAG_LOCKED) !== 0 || implicitTargets?.includes(26)) return 'locked';
  if ((mask & (TARGET_FLAG_CORPSE_ENEMY | TARGET_FLAG_CORPSE_ALLY | TARGET_FLAG_UNIT_DEAD)) !== 0) {
    return 'corpse';
  }
  if ((mask & TARGET_FLAG_GAMEOBJECT) !== 0 || implicitTargets?.includes(23)) return 'gameObject';
  if ((mask & TARGET_FLAG_STRING) !== 0) return 'string';
  if (
    (mask & TARGET_FLAG_DEST_LOCATION) !== 0
    || implicitTargets?.some((target) => DESTINATION_IMPLICIT_TARGETS.has(target))
  ) return 'destination';
  if (
    (mask & TARGET_FLAG_SOURCE_LOCATION) !== 0
    || implicitTargets?.some((target) => SOURCE_IMPLICIT_TARGETS.has(target))
  ) return 'source';
  if (
    (mask & TARGET_FLAG_UNIT) !== 0
    || implicitTargets?.some((target) => UNIT_IMPLICIT_TARGETS.has(target))
  ) return 'unit';
  return 'self';
}

export function spellNeedsDestination(implicitTargets: readonly number[] | undefined): boolean {
  return spellTargetWorkflow(0, implicitTargets) === 'destination';
}

function guidHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .reverse()
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function readPackedGuid(reader: SpellTargetReader): string {
  const mask = reader.u8();
  const bytes = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    if ((mask & (1 << i)) !== 0) bytes[i] = reader.u8();
  }
  return guidHex(bytes);
}

function guidBytes(guid: string): Uint8Array {
  if (!/^[0-9a-f]{1,16}$/i.test(guid)) throw new Error(`invalid Vanilla GUID "${guid}"`);
  const hex = guid.padStart(16, '0');
  const bytes = new Uint8Array(8);
  for (let i = 0; i < 8; i++) bytes[i] = Number.parseInt(hex.slice(14 - i * 2, 16 - i * 2), 16);
  return bytes;
}

export function packSpellTargetGuid(guid: string): Uint8Array {
  const raw = guidBytes(guid);
  let mask = 0;
  const bytes: number[] = [];
  for (let i = 0; i < 8; i++) {
    if (raw[i] === 0) continue;
    mask |= 1 << i;
    bytes.push(raw[i]);
  }
  return new Uint8Array([mask, ...bytes]);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function u16(value: number) {
  const result = new Uint8Array(2);
  new DataView(result.buffer).setUint16(0, value & 0xffff, true);
  return result;
}

function u32(value: number) {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value >>> 0, true);
  return result;
}

function locationBytes(location: SpellLocation, label: string) {
  if (![location.x, location.y, location.z].every(Number.isFinite)) {
    throw new Error(`${label} must contain finite coordinates`);
  }
  const result = new Uint8Array(12);
  const view = new DataView(result.buffer);
  view.setFloat32(0, location.x, true);
  view.setFloat32(4, location.y, true);
  view.setFloat32(8, location.z, true);
  return result;
}

function cstring(value: string) {
  if (value.includes('\0')) throw new Error('spell string target contains an embedded NUL');
  const bytes = new TextEncoder().encode(value);
  return concatBytes(bytes, new Uint8Array(1));
}

function requireGuid(value: string | undefined, label: string) {
  if (!value) throw new Error(`${label} flag requires a GUID`);
  return packSpellTargetGuid(value);
}

/**
 * CMSG SpellCastTargets::read order. Unit, GO and corpse masks are independent on client upload;
 * item/trade and ally/enemy corpse pairs each share one packed GUID.
 */
export function encodeSpellCastTargets(targets: SpellCastTargets): Uint8Array {
  const mask = targets.targetMask & 0xffff;
  const parts: Uint8Array[] = [u16(mask)];
  if ((mask & TARGET_FLAG_UNIT) !== 0) parts.push(requireGuid(targets.unitGuid, 'unit target'));
  if ((mask & TARGET_FLAG_GAMEOBJECT) !== 0) {
    parts.push(requireGuid(targets.gameObjectGuid, 'game-object target'));
  }
  if ((mask & (TARGET_FLAG_CORPSE_ALLY | TARGET_FLAG_CORPSE_ENEMY)) !== 0) {
    parts.push(requireGuid(targets.corpseGuid, 'corpse target'));
  }
  if ((mask & (TARGET_FLAG_ITEM | TARGET_FLAG_TRADE_ITEM)) !== 0) {
    parts.push(requireGuid(targets.itemGuid, 'item target'));
  }
  if ((mask & TARGET_FLAG_SOURCE_LOCATION) !== 0) {
    if (!targets.source) throw new Error('source-location flag requires coordinates');
    parts.push(locationBytes(targets.source, 'spell source'));
  }
  if ((mask & TARGET_FLAG_DEST_LOCATION) !== 0) {
    if (!targets.destination) throw new Error('destination-location flag requires coordinates');
    parts.push(locationBytes(targets.destination, 'spell destination'));
  }
  if ((mask & TARGET_FLAG_STRING) !== 0) {
    if (targets.stringTarget === undefined) throw new Error('string-target flag requires text');
    parts.push(cstring(targets.stringTarget));
  }
  return concatBytes(...parts);
}

/**
 * Decode target bodies retained in SMSG_SPELL_START/GO. vMaNGOS server emission writes one
 * object GUID using UNIT > GAMEOBJECT > CORPSE priority, then the optional item/location/string
 * fields. This intentionally differs from the independent client-upload read order above.
 */
export function readServerSpellCastTargets(reader: SpellTargetReader): SpellCastTargets {
  const targetMask = reader.u16();
  const result: SpellCastTargets = { targetMask };
  if ((targetMask & TARGET_FLAG_UNIT) !== 0) result.unitGuid = readPackedGuid(reader);
  else if ((targetMask & TARGET_FLAG_GAMEOBJECT) !== 0) result.gameObjectGuid = readPackedGuid(reader);
  else if ((targetMask & (TARGET_FLAG_CORPSE_ALLY | TARGET_FLAG_CORPSE_ENEMY)) !== 0) {
    result.corpseGuid = readPackedGuid(reader);
  }
  if ((targetMask & (TARGET_FLAG_ITEM | TARGET_FLAG_TRADE_ITEM)) !== 0) {
    result.itemGuid = readPackedGuid(reader);
  }
  if ((targetMask & TARGET_FLAG_SOURCE_LOCATION) !== 0) {
    result.source = { x: reader.f32(), y: reader.f32(), z: reader.f32() };
  }
  if ((targetMask & TARGET_FLAG_DEST_LOCATION) !== 0) {
    result.destination = { x: reader.f32(), y: reader.f32(), z: reader.f32() };
  }
  if ((targetMask & TARGET_FLAG_STRING) !== 0) result.stringTarget = reader.cstring();
  return result;
}

export function primarySpellObjectTarget(targets: SpellCastTargets): string | undefined {
  return targets.unitGuid ?? targets.gameObjectGuid ?? targets.corpseGuid;
}

export function encodeSpellCastRequest(spellId: number, targets: SpellCastTargets): Uint8Array {
  return concatBytes(u32(spellId), encodeSpellCastTargets(targets));
}

export function encodeUseItemRequest(
  bag: number,
  slot: number,
  spellSlot: number,
  targets: SpellCastTargets,
): Uint8Array {
  return concatBytes(
    new Uint8Array([bag & 0xff, slot & 0xff, spellSlot & 0xff]),
    encodeSpellCastTargets(targets),
  );
}

export function encodeDestinationSpellCast(
  spellId: number,
  destination: SpellDestination,
): Uint8Array {
  return encodeSpellCastRequest(spellId, {
    targetMask: TARGET_FLAG_DEST_LOCATION,
    destination,
  });
}

