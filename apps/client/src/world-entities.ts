import {
  applyUnitMovementModeState,
  applyUnitSpeedState,
  type UnitSpeedsState,
  type UnitSpeedStateKind,
} from './combat/movement-state';
import { PLAYER_FIELDS } from './data/player-field-layout';
import type { VirtualItem } from './combat/virtual-items';
import { applyGameObjectRotationField, applyTransportClock, type TransportSource } from './world/transport-state';
import { SpatialIndex2D } from './platform/spatial-index';
import { UpdateReader } from './protocol/update-reader';
export enum UpdateType {
  VALUES = 0,
  MOVEMENT = 1,
  CREATE_OBJECT = 2,
  CREATE_OBJECT2 = 3,
  OUT_OF_RANGE = 4,
  NEAR_OBJECTS = 5,
}
export enum TypeID {
  OBJECT = 0,
  ITEM = 1,
  CONTAINER = 2,
  UNIT = 3,
  PLAYER = 4,
  GAMEOBJECT = 5,
  DYNAMICOBJECT = 6,
  CORPSE = 7,
}
export type MovementInfo = {
  flags: number;
  time: number;
  x: number;
  y: number;
  z: number;
  o: number;
  fallTime: number;
  transportGuid?: string;
  transportX?: number;
  transportY?: number;
  transportZ?: number;
  transportO?: number;
  swimPitch?: number;
  jumpVelocity?: number;
  jumpCosAngle?: number;
  jumpSinAngle?: number;
  jumpXYSpeed?: number;
  splineElevation?: number;
  spline?: SplineInfo;
};

export type SplineInfo = {
  flags: number;
  startX?: number;
  startY?: number;
  startZ?: number;
  startedAt?: number;
  finalTargetGuid?: string;
  finalO?: number;
  finalX?: number;
  finalY?: number;
  finalZ?: number;
  time: number;
  fullTime: number;
  id: number;
  points: Array<{ x: number; y: number; z: number }>;
  endX: number;
  endY: number;
  endZ: number;
};

export type UnitSpeeds = UnitSpeedsState;
export type UnitSpeedKind = UnitSpeedStateKind;

export type UpdateValue = {
  index: number;
  value: number;
};

export type UpdateBlock = {
  updateType: UpdateType;
  guid: string;
  typeId?: TypeID;
  movement?: MovementInfo;
  speeds?: UnitSpeeds;
  spline?: SplineInfo;
  values?: UpdateValue[];
  relatedGuids?: string[];
  updateFlags?: number;
  lowGuid?: number;
  highGuid?: number;
  attackingTargetGuid?: string;
  transportPathTimer?: number;
  debug?: {
    startOffset?: number;
    endOffset?: number;
    maskBlockCount?: number;
    masks?: number[];
  };
};

export type UpdateParseError = {
  blockIndex: number;
  offset: number;
  message: string;
  context?: string;
  nextBytes?: string;
};

export type ParsedWorldUpdate = {
  blockCount: number;
  hasTransport: boolean;
  blocks: UpdateBlock[];
  errors: UpdateParseError[];
  bytesRemaining: number;
};

export type WorldEntity = TransportSource & {
  guid: string;
  typeId?: TypeID;
  typeName: string;
  flags?: number;
  movementOpcode?: number;
  time?: number;
  fallTime?: number;
  transportGuid?: string;
  transportX?: number;
  transportY?: number;
  transportZ?: number;
  transportO?: number;
  swimPitch?: number;
  predictionAgeMs?: number;
  // Jump arc carried in the vanilla MovementInfo (MOVEFLAG_JUMPING). Used to dead-reckon a
  // remote player's horizontal momentum while airborne so a jump doesn't run-in-place.
  jumpVelocity?: number;
  jumpXYSpeed?: number;
  jumpSinAngle?: number;
  jumpCosAngle?: number;
  jumpStartX?: number;
  jumpStartY?: number;
  jumpStartZ?: number;
  jumpStartedAt?: number;
  speeds?: UnitSpeeds;
  /** Authoritative MovementInfo/spline-mode state, updated after creation. */
  rooted?: boolean;
  waterWalking?: boolean;
  featherFalling?: boolean;
  hovering?: boolean;
  running?: boolean;
  spline?: SplineInfo;
  /**
   * Bumped on every MSG_MOVE_TELEPORT. The renderer hard-snaps instead of interpolating when this
   * changes, because a teleport is a discontinuity, not motion — a Blink under the 10 yd snap
   * threshold would otherwise be rendered as a slide.
   */
  teleportSeq?: number;
  scale?: number;
  health?: number;
  maxHealth?: number;
  powers?: number[];
  maxPowers?: number[];
  auraSpellIds?: number[];
  auraFlags?: number[];
  auraLevels?: number[];
  auraApplications?: number[];
  auraState?: number;
  level?: number;
  faction?: number;
  displayId?: number;
  nativeDisplayId?: number;
  mountDisplayId?: number;
  unitFlags?: number;
  notSelectable?: boolean;
  nonAttackable?: boolean;
  silenced?: boolean;
  pacified?: boolean;
  stunned?: boolean;
  taxiFlight?: boolean;
  disarmed?: boolean;
  confused?: boolean;
  fleeing?: boolean;
  possessed?: boolean;
  dynamicFlags?: number;
  gameObjectState?: number;
  gameObjectLevel?: number;
  gameObjectArtKit?: number;
  gameObjectAnimProgress?: number;
  pvpFlags?: number;
  /** PLAYER_FLAGS (0x0B8); bit 0x10 is Vanilla ghost form. */
  playerFlags?: number;
  /** Shared duel-flag GameObject GUID from PLAYER_DUEL_ARBITER; empty outside a duel. */
  duelArbiterGuid?: string;
  duelArbiterGuidLow?: number;
  duelArbiterGuidHigh?: number;
  duelTeam?: number; // PLAYER_DUEL_TEAM: 1/2 while active, zero on DuelComplete.
  /** UNIT_FIELD_BYTES_1 byte 3 (vis flags); bit 0x01 = UNIT_VIS_FLAGS_GHOST. */
  visFlags?: number;
  /** UNIT_FIELD_BYTES_1 byte 0 (UnitStandStateType): 0 stand, 1 sit, 3 sleep, 4-6 chairs, 8 kneel. */
  standState?: number;
  /** UNIT_FIELD_BYTES_2 byte 0: 0 = weapons sheathed, 1 = melee drawn, 2 = ranged drawn. */
  sheathState?: number;
  npcFlags?: number;
  /** GUID of this unit's current target (UNIT_FIELD_TARGET), '' when none. */
  targetGuid?: string;
  targetGuidLow?: number;
  targetGuidHigh?: number;
  charmGuid?: string;
  charmGuidLow?: number;
  charmGuidHigh?: number;
  charmedByGuid?: string;
  charmedByGuidLow?: number;
  charmedByGuidHigh?: number;
  summonGuid?: string;
  summonGuidLow?: number;
  summonGuidHigh?: number;
  summonedByGuid?: string;
  summonedByGuidLow?: number;
  summonedByGuidHigh?: number;
  createdByGuid?: string;
  createdByGuidLow?: number;
  createdByGuidHigh?: number;
  /**
   * UNIT_FIELD_PERSUADED is retained for packet diagnostics only. vMaNGOS marks
   * SPELL_AURA_PERSUADED obsolete and Build 5875 has no referenced client behavior for it.
   */
  persuadedGuid?: string;
  persuadedGuidLow?: number;
  persuadedGuidHigh?: number;
  channelObjectGuid?: string;
  channelObjectGuidLow?: number;
  channelObjectGuidHigh?: number;
  channelSpellId?: number;
  /**
   * Server-owned summon/totem provenance. vMaNGOS consumes UNIT_CREATED_BY_SPELL for lifecycle
   * and attribution; no independent Build 5875 presentation consumer was found.
   */
  createdBySpellId?: number;
  castSpeedModifier?: number;
  baseAttackTimeMs?: number;
  offHandAttackTimeMs?: number;
  rangedAttackTimeMs?: number;
  virtualItemDisplayIds?: number[];
  virtualItemInfo?: number[];
  /** Decoded UNIT_VIRTUAL_ITEM_* weapons; see combat/virtual-items.ts. */
  virtualItems?: VirtualItem[];
  /** ItemPrototype.SubClass of the attacker's weapon — AttackAnimKits and impact audio key on it. */
  weaponSubclass?: number;
  /** ItemPrototype.Material of the attacker's weapon — Material.dbc flag bit 0 selects the impact row. */
  weaponMaterial?: number;
  /** ITEM_FIELD_DURATION is seconds in Build 5875 (Player::UpdateItemDuration decrements time_t). */
  itemDurationSeconds?: number;
  /** Enchantment field duration is milliseconds; the optional deadline comes from the seconds-based SMSG. */
  itemEnchantments?: Array<{ enchantId: number; durationMs: number; charges: number; expiresAt?: number }>;
  itemExpiresAt?: number;
  npcEmoteState?: number;
  /** CORPSE_FIELD_OWNER for reclaiming the local player's corpse. */
  ownerGuid?: string;
  ownerGuidLow?: number;
  ownerGuidHigh?: number;
  /** Vanilla DynamicObject fields (server-owned persistent area/farsight object). */
  dynamicObjectCasterGuid?: string;
  dynamicObjectCasterGuidLow?: number;
  dynamicObjectCasterGuidHigh?: number;
  /** DYNAMICOBJECT_BYTES byte 0: 1 = area spell, 2 = farsight. */
  dynamicObjectType?: number;
  dynamicObjectSpellId?: number;
  dynamicObjectRadius?: number;
  boundingRadius?: number;
  combatReach?: number;
  // Owner-only paper-doll stats (sent for the local player).
  strength?: number;
  agility?: number;
  stamina?: number;
  intellect?: number;
  spirit?: number;
  armor?: number;
  attackPower?: number;
  rangedAttackPower?: number;
  minDamage?: number;
  maxDamage?: number;
  /** UNIT_FIELD_BASE_MANA, used by percentage-cost spells such as Blink. */
  baseMana?: number;
  /** UNIT_FIELD_BASE_HEALTH, used by percentage health costs. */
  baseHealth?: number;
  minRangedDamage?: number;
  maxRangedDamage?: number;
  race?: number;
  classId?: number;
  gender?: number;
  skin?: number;
  face?: number;
  hairStyle?: number;
  hairColor?: number;
  facialHair?: number;
  /** Owner-only Vanilla progression fields. */
  experience?: number;
  nextLevelExperience?: number;
  restedExperience?: number;
  unspentTalentPoints?: number;
  /** PLAYER_BYTES_2 byte 3: 1 rested, 2 normal. */
  restState?: number;
  visibleItemEntries?: number[];
  visibleItemEnchantments?: Array<{ permanent: number; temporary: number }>;
  // Runtime objects are full ItemInfo (with ItemPrototype.Sheath) once the item query resolves;
  // sheath drives the sheathed weapon socket, so it must not be dropped from this shape. `slot` is
  // the EQUIPMENT_SLOT this item came from (the array is compacted, so the index is not the slot),
  // and classId/subclass are the ItemPrototype class/subclass the attack-animation kits key on.
  visibleEquipment?: {
    displayInfoId: number;
    inventoryType: number;
    sheath?: number;
    slot?: number;
    classId?: number;
    subclass?: number;
    material?: number;
  }[];
  powerType?: number;
  fields: Map<number, number>;
  updatedAt: number;
};

export type WorldEntityChange =
  | { kind: 'none' }
  | { kind: 'create' | 'update'; entity: WorldEntity; changedFields: number[]; discontinuity?: 'teleport' }
  | { kind: 'remove'; guid: string };

const MOVEMENTFLAG_FALLING = 0x00002000;
const MOVEMENTFLAG_WALK_MODE = 0x00000100;
const MOVEMENTFLAG_ROOT = 0x00001000;
const MOVEMENTFLAG_SWIMMING = 0x00200000;
const MOVEMENTFLAG_SPLINE_ENABLED = 0x00400000;
const MOVEMENTFLAG_ONTRANSPORT = 0x02000000;
const MOVEMENTFLAG_SPLINE_ELEVATION = 0x04000000;
const MOVEMENTFLAG_WATERWALKING = 0x10000000;
const MOVEMENTFLAG_SAFE_FALL = 0x20000000;
const MOVEMENTFLAG_HOVER = 0x40000000;
const DEFAULT_JUMP_VELOCITY = 7.95797334;
const WOW_JUMP_GRAVITY = 19.29110527;

// Vanilla 1.12 ObjectUpdateFlags — verified against vmangos Object::BuildMovementUpdate
// 1.12 specification handling.
// byte consumption happened to coincide except VEHICLE (0x80), which does NOT exist in
// vanilla — reading u32+f32 for it would silently shear the rest of the packet.
const UPDATEFLAG_SELF = 0x01;            // marker only, no payload
const UPDATEFLAG_TRANSPORT = 0x02;       // u32 transport progress / ms-time
const UPDATEFLAG_MELEE_ATTACKING = 0x04; // packed victim guid
const UPDATEFLAG_HIGHGUID = 0x08;        // u32 (always 0)
const UPDATEFLAG_ALL = 0x10;             // u32 (always 1)
const UPDATEFLAG_LIVING = 0x20;          // MovementInfo + 6 speeds [+ spline]
const UPDATEFLAG_HAS_POSITION = 0x40;    // x,y,z,o (non-living objects)

const SPLINEFLAG_FINAL_POINT = 0x00010000;
const SPLINEFLAG_FINAL_TARGET = 0x00020000;
const SPLINEFLAG_FINAL_ORIENTATION = 0x00040000;

const OBJECT_FIELD_TYPE = 0x02;
const OBJECT_FIELD_ENTRY = 0x03;
const OBJECT_FIELD_SCALE_X = 0x04;

// Vanilla GameObjectField values are relative to ObjectField.OBJECT_END (0x06).
const GAMEOBJECT_DISPLAYID = 0x08;
const GAMEOBJECT_STATE = 0x0e;
const GAMEOBJECT_POS_X = 0x0f;
const GAMEOBJECT_POS_Y = 0x10;
const GAMEOBJECT_POS_Z = 0x11;
const GAMEOBJECT_FACING = 0x12;
const GAMEOBJECT_DYN_FLAGS = 0x13;
const GAMEOBJECT_FACTION = 0x14;
const GAMEOBJECT_TYPE_ID = 0x15;
const GAMEOBJECT_LEVEL = 0x16;
const GAMEOBJECT_ARTKIT = 0x17;
const GAMEOBJECT_ANIMPROGRESS = 0x18;

// Vanilla DynamicObjectField values (vMaNGOS UpdateFields_1_12_1.h).
const DYNAMICOBJECT_CASTER = 0x06; // GUID, size 2
const DYNAMICOBJECT_BYTES = 0x08;
const DYNAMICOBJECT_SPELLID = 0x09;
const DYNAMICOBJECT_RADIUS = 0x0a;
const DYNAMICOBJECT_POS_X = 0x0b;
const DYNAMICOBJECT_POS_Y = 0x0c;
const DYNAMICOBJECT_POS_Z = 0x0d;
const DYNAMICOBJECT_FACING = 0x0e;

// Vanilla UnitField values are relative to ObjectField.OBJECT_END (0x06).
const UNIT_FIELD_HEALTH = 0x16;
const UNIT_FIELD_CHARM = 0x06;
const UNIT_FIELD_SUMMON = 0x08;
const UNIT_FIELD_CHARMEDBY = 0x0a;
const UNIT_FIELD_SUMMONEDBY = 0x0c;
const UNIT_FIELD_CREATEDBY = 0x0e;
const UNIT_FIELD_POWER1 = 0x17;
const UNIT_FIELD_POWER5 = 0x1b;
const UNIT_FIELD_MAXHEALTH = 0x1c;
const UNIT_FIELD_TARGET = 0x10; // GUID, size 2 (low 0x10, high 0x11)
const UNIT_FIELD_PERSUADED = 0x12;
const UNIT_FIELD_CHANNEL_OBJECT = 0x14;
const UNIT_FIELD_MAXPOWER1 = 0x1d;
const UNIT_FIELD_MAXPOWER5 = 0x21;
const UNIT_FIELD_LEVEL = 0x22;
const UNIT_FIELD_FACTIONTEMPLATE = 0x23;
const UNIT_FIELD_BYTES_0 = 0x24;
const UNIT_VIRTUAL_ITEM_SLOT_DISPLAY = 0x25;
const UNIT_VIRTUAL_ITEM_INFO = 0x28;
// OBJECT_END(0x06)+0x84. Byte 3 is UNIT_BYTES_1_OFFSET_VIS_FLAG; bit 0x01 = UNIT_VIS_FLAGS_GHOST,
// set alongside PLAYER_FLAGS_GHOST by HandleAuraGhost. Verified vs vMaNGOS UpdateFields_1_12_1.h.
const UNIT_FIELD_BYTES_1 = 0x8a;
const UNIT_FIELD_FLAGS = 0x2e;
const UNIT_FIELD_AURA = 0x2f;
const UNIT_FIELD_AURA_END = 0x5e;
const UNIT_FIELD_AURAFLAGS = 0x5f;
const UNIT_FIELD_AURAFLAGS_END = 0x64;
const UNIT_FIELD_AURALEVELS = 0x65;
const UNIT_FIELD_AURALEVELS_END = 0x70;
const UNIT_FIELD_AURAAPPLICATIONS = 0x71;
const UNIT_FIELD_AURAAPPLICATIONS_END = 0x7c;
const UNIT_FIELD_AURASTATE = 0x7d;
const UNIT_FIELD_BASEATTACKTIME = 0x7e;
const UNIT_FIELD_RANGEDATTACKTIME = 0x80;
const UNIT_FIELD_BOUNDINGRADIUS = 0x81;
const UNIT_FIELD_COMBATREACH = 0x82;
// Owner-only paper-doll stats (vMaNGOS UpdateFields_1_12_1, OBJECT_END=0x06).
const UNIT_FIELD_MINDAMAGE = 0x86; // float
const UNIT_FIELD_MAXDAMAGE = 0x87; // float
const UNIT_FIELD_STAT0 = 0x96; // str(0x96) agi sta int spi(0x9a)
const UNIT_FIELD_RESISTANCES = 0x9b; // [0] = armor
const UNIT_FIELD_ATTACK_POWER = 0xa5;
const UNIT_FIELD_RANGED_ATTACK_POWER = 0xa8;
const UNIT_FIELD_MINRANGEDDAMAGE = 0xab; // float
const UNIT_FIELD_MAXRANGEDDAMAGE = 0xac; // float
const UNIT_FIELD_DISPLAYID = 0x83;
const UNIT_FIELD_NATIVEDISPLAYID = 0x84;
const UNIT_FIELD_MOUNTDISPLAYID = 0x85;
const UNIT_DYNAMIC_FLAGS = 0x8f;
const UNIT_CHANNEL_SPELL = 0x90;
const UNIT_MOD_CAST_SPEED = 0x91;
const UNIT_CREATED_BY_SPELL = 0x92;
const UNIT_FIELD_BASE_MANA = 0x0a2;
const UNIT_FIELD_BASE_HEALTH = 0x0a3;
const UNIT_NPC_FLAGS = 0x93;
const UNIT_NPC_EMOTESTATE = 0x94;
const UNIT_FIELD_BYTES_2 = 0xa4; // OBJECT_END(0x06)+0x9E; byte1 = misc flags (PvP/FFA)
const ITEM_FIELD_DURATION = 0x0f;
const ITEM_FIELD_ENCHANTMENT = 0x16;
const ITEM_FIELD_ENCHANTMENT_END = 0x2b; // seven slots x (id, duration, charges)

// Vanilla 1.12.1 player fields. The indices in UpdateFields_1_12_1.h's PLAYER_* COMMENTS are all 6
// below what its own formulas compile to (the comments omit OBJECT_END), so they are resolved by
// data/player-field-layout.ts — see that file. Visible item fields carry
// item entries; CMSG_ITEM_QUERY_SINGLE resolves those to ItemDisplayInfo + InventoryType.
const PLAYER_BYTES = PLAYER_FIELDS.PLAYER_BYTES;
const PLAYER_BYTES_2 = PLAYER_FIELDS.PLAYER_BYTES_2;
const PLAYER_DUEL_ARBITER = PLAYER_FIELDS.PLAYER_DUEL_ARBITER;
const PLAYER_FLAGS = PLAYER_FIELDS.PLAYER_FLAGS;
const PLAYER_DUEL_TEAM = PLAYER_FIELDS.PLAYER_DUEL_TEAM;
const PLAYER_XP = PLAYER_FIELDS.PLAYER_XP;
const PLAYER_NEXT_LEVEL_XP = PLAYER_FIELDS.PLAYER_NEXT_LEVEL_XP;
const PLAYER_REST_STATE_EXPERIENCE = PLAYER_FIELDS.PLAYER_REST_STATE_EXPERIENCE;
const PLAYER_CHARACTER_POINTS1 = PLAYER_FIELDS.PLAYER_CHARACTER_POINTS1;
const PLAYER_FIELD_COMBO_TARGET = PLAYER_FIELDS.PLAYER_FIELD_COMBO_TARGET;
// Reading at stock 0xFE missed every field, leaving visibleItemEntries empty, which forced every
// remote player onto the sheath-less starter-outfit fallback (staff → socket 26 instead of 31).
const PLAYER_VISIBLE_ITEM_1_0 = PLAYER_FIELDS.PLAYER_VISIBLE_ITEM_1_0;
const PLAYER_VISIBLE_ITEM_STRIDE = 12;
const PLAYER_VISIBLE_ITEM_SLOTS = 19;
const CORPSE_FIELD_OWNER = 0x06;
const CORPSE_FIELD_FACING = 0x08;
const CORPSE_FIELD_POS_X = 0x09;
const CORPSE_FIELD_POS_Y = 0x0a;
const CORPSE_FIELD_POS_Z = 0x0b;

function guidHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .reverse()
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Assemble a UNIT_FIELD_TARGET low/high pair into the same guid-hex key the
 *  entity map uses. Returns '' when both halves are zero (no target). */
export function combineFieldGuid(low: number, high: number): string {
  if ((low >>> 0) === 0 && (high >>> 0) === 0) return '';
  const bytes = new Uint8Array(8);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, low >>> 0, true);
  dv.setUint32(4, high >>> 0, true);
  return guidHex(bytes);
}

export function readPackedGuidFromUpdate(r: { u8(): number }): string {
  const mask = r.u8();
  const bytes = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    if (mask & (1 << i)) bytes[i] = r.u8();
  }
  return guidHex(bytes);
}

function parsePackedVector3(r: UpdateReader) {
  const packed = r.i32();
  const signed = (value: number, bits: number) => (value << (32 - bits)) >> (32 - bits);
  return {
    x: signed(packed & 0x7ff, 11) * 0.25,
    y: signed((packed >>> 11) & 0x7ff, 11) * 0.25,
    z: signed((packed >>> 22) & 0x3ff, 10) * 0.25,
  };
}

export function parseMonsterMovePacket(data: Uint8Array, transport = false): { guid: string; spline: SplineInfo } {
  const r = new UpdateReader(data);
  const guid = readPackedGuidFromUpdate(r);
  if (transport) readPackedGuidFromUpdate(r);
  const startX = r.f32();
  const startY = r.f32();
  const startZ = r.f32();
  const id = r.u32();
  const type = r.u8();
  const spline: SplineInfo = {
    flags: 0,
    startX,
    startY,
    startZ,
    time: 0,
    fullTime: 0,
    id,
    points: [],
    endX: startX,
    endY: startY,
    endZ: startZ,
  };
  if (type === 1) return { guid, spline };
  if (type === 2) {
    spline.finalX = r.f32();
    spline.finalY = r.f32();
    spline.finalZ = r.f32();
  } else if (type === 3) {
    spline.finalTargetGuid = r.guid();
  } else if (type === 4) {
    spline.finalO = r.f32();
  } else if (type !== 0) {
    throw new Error(`unknown monster spline type ${type}`);
  }

  spline.flags = r.u32();
  spline.fullTime = r.u32();
  const count = r.u32();
  if (count > 100_000) throw new Error(`unreasonable monster spline point count ${count}`);
  if (spline.flags & 0x00000200) {
    for (let i = 0; i < count; i++) spline.points.push({ x: r.f32(), y: r.f32(), z: r.f32() });
    const end = spline.points.at(-1);
    if (end) {
      spline.endX = end.x;
      spline.endY = end.y;
      spline.endZ = end.z;
    }
  } else {
    spline.endX = r.f32();
    spline.endY = r.f32();
    spline.endZ = r.f32();
    for (let i = 1; i < count; i++) {
      const delta = parsePackedVector3(r);
      spline.points.push({ x: spline.endX - delta.x, y: spline.endY - delta.y, z: spline.endZ - delta.z });
    }
  }
  if (r.remaining !== 0) throw new Error(`monster move left ${r.remaining} unread bytes`);
  return { guid, spline };
}

function parseMovementInfo(r: UpdateReader): MovementInfo {
  const flags = r.u32();
  const time = r.u32();
  const movement: MovementInfo = {
    flags,
    time,
    x: r.f32(),
    y: r.f32(),
    z: r.f32(),
    o: r.f32(),
    fallTime: 0,
  };

  if (flags & MOVEMENTFLAG_ONTRANSPORT) {
    movement.transportGuid = r.guid();
    movement.transportX = r.f32();
    movement.transportY = r.f32();
    movement.transportZ = r.f32();
    movement.transportO = r.f32();
  }
  if (flags & MOVEMENTFLAG_SWIMMING) movement.swimPitch = r.f32();
  movement.fallTime = r.u32();
  if (flags & MOVEMENTFLAG_FALLING) {
    movement.jumpVelocity = r.f32();
    movement.jumpCosAngle = r.f32();
    movement.jumpSinAngle = r.f32();
    movement.jumpXYSpeed = r.f32();
  }
  if (flags & MOVEMENTFLAG_SPLINE_ELEVATION) movement.splineElevation = r.f32();
  return movement;
}

function parseSplineInfo(r: UpdateReader): SplineInfo {
  const flags = r.u32();
  const spline: SplineInfo = {
    flags,
    time: 0,
    fullTime: 0,
    id: 0,
    points: [],
    endX: 0,
    endY: 0,
    endZ: 0,
  };

  if (flags & SPLINEFLAG_FINAL_TARGET) {
    spline.finalTargetGuid = r.guid();
  } else if (flags & SPLINEFLAG_FINAL_ORIENTATION) {
    spline.finalO = r.f32();
  } else if (flags & SPLINEFLAG_FINAL_POINT) {
    spline.finalX = r.f32();
    spline.finalY = r.f32();
    spline.finalZ = r.f32();
  }

  spline.time = r.u32();
  spline.fullTime = r.u32();
  spline.id = r.u32();
  const pointCount = r.u32();
  if (r.remaining < 12 || pointCount > Math.floor((r.remaining - 12) / 12)) {
    throw new Error(`unreasonable spline point count ${pointCount}`);
  }
  for (let i = 0; i < pointCount; i++) {
    spline.points.push({ x: r.f32(), y: r.f32(), z: r.f32() });
  }
  spline.endX = r.f32();
  spline.endY = r.f32();
  spline.endZ = r.f32();
  return spline;
}

function parseUnitSpeeds(r: UpdateReader): UnitSpeeds {
  return {
    walk: r.f32(),
    run: r.f32(),
    runBack: r.f32(),
    swim: r.f32(),
    swimBack: r.f32(),
    turnRate: r.f32(),
  };
}

function parseUpdateMovementBlock(r: UpdateReader, block: UpdateBlock) {
  const updateFlags = r.u8();
  block.updateFlags = updateFlags;

  // Self is a marker only. The remaining flags below determine the payload shape.
  if (updateFlags & UPDATEFLAG_SELF) {
    // No payload.
  }

  if (updateFlags & UPDATEFLAG_LIVING) {
    block.movement = parseMovementInfo(r);
    block.speeds = parseUnitSpeeds(r);
    if (block.movement.flags & MOVEMENTFLAG_SPLINE_ENABLED) {
      block.movement.spline = parseSplineInfo(r);
    }
  } else if (updateFlags & UPDATEFLAG_HAS_POSITION) {
    block.movement = {
      flags: 0,
      time: 0,
      x: r.f32(),
      y: r.f32(),
      z: r.f32(),
      o: r.f32(),
      fallTime: 0,
    };
  }

  // Trailer order per vmangos BuildMovementUpdate: 0x08, 0x10, 0x04, 0x02. Bit 0x80 is
  // undefined in vanilla — if it ever appears the packet is not 1.12-shaped, so fail loudly
  // 1.12 specification handling.
  if (updateFlags & UPDATEFLAG_HIGHGUID) block.lowGuid = r.u32();
  if (updateFlags & UPDATEFLAG_ALL) block.highGuid = r.u32();
  if (updateFlags & UPDATEFLAG_MELEE_ATTACKING) block.attackingTargetGuid = readPackedGuidFromUpdate(r);
  if (updateFlags & UPDATEFLAG_TRANSPORT) block.transportPathTimer = r.u32();
  if (updateFlags & 0x80) throw new Error(`non-vanilla update flag 0x80 in movement block (flags=0x${updateFlags.toString(16)})`);
}

function parseUpdateValues(r: UpdateReader, block: UpdateBlock): UpdateValue[] {
  const maskBlockCount = r.u8();
  if (maskBlockCount > 64) throw new Error(`unreasonable update mask block count ${maskBlockCount}`);

  const masks: number[] = [];
  for (let i = 0; i < maskBlockCount; i++) masks.push(r.u32());
  block.debug = { ...block.debug, maskBlockCount, masks };

  const values: UpdateValue[] = [];
  for (let blockIndex = 0; blockIndex < masks.length; blockIndex++) {
    const mask = masks[blockIndex];
    if (mask === 0) continue;
    for (let bit = 0; bit < 32; bit++) {
      if (mask & (1 << bit)) values.push({ index: blockIndex * 32 + bit, value: r.u32() });
    }
  }
  return values;
}

function parseUpdateBlock(r: UpdateReader, typeLookup: (guid: string) => TypeID | undefined, startOffset: number): UpdateBlock {
  const updateType = r.u8() as UpdateType;
  if (updateType < UpdateType.VALUES || updateType > UpdateType.NEAR_OBJECTS) {
    throw new Error(`unknown update type ${updateType}`);
  }

  if (updateType === UpdateType.OUT_OF_RANGE || updateType === UpdateType.NEAR_OBJECTS) {
    const count = r.i32();
    if (count < 0 || count > r.remaining) throw new Error(`unreasonable guid list count ${count}`);
    const relatedGuids: string[] = [];
    for (let i = 0; i < count; i++) relatedGuids.push(readPackedGuidFromUpdate(r));
    const guid = relatedGuids[0] ?? '0000000000000000';
    const block: UpdateBlock = { updateType, guid, relatedGuids, debug: { startOffset } };
    return block;
  }

  if (updateType === UpdateType.VALUES) {
    const guid = readPackedGuidFromUpdate(r);
    const cachedType = typeLookup(guid) ?? typeFromGuid(guid);
    const block: UpdateBlock = { updateType, guid, typeId: cachedType, debug: { startOffset } };
    block.values = parseUpdateValues(r, block);
    return block;
  }

  if (updateType === UpdateType.MOVEMENT) {
    const guid = r.guid();
    const block: UpdateBlock = {
      updateType,
      guid,
      typeId: typeLookup(guid) ?? typeFromGuid(guid),
      debug: { startOffset },
    };
    parseUpdateMovementBlock(r, block);
    return block;
  }

  const guid = readPackedGuidFromUpdate(r);
  const block: UpdateBlock = { updateType, guid, typeId: r.u8() as TypeID, debug: { startOffset } };
  parseUpdateMovementBlock(r, block);
  block.values = parseUpdateValues(r, block);
  return block;
}

function describeBlock(block: UpdateBlock, index: number) {
  const updateFlags = block.updateFlags !== undefined ? ` updateFlags=0x${block.updateFlags.toString(16)}` : '';
  const flags = block.movement ? ` moveFlags=0x${block.movement.flags.toString(16)}` : '';
  const mask = block.debug?.maskBlockCount !== undefined ? ` maskBlocks=${block.debug.maskBlockCount}` : '';
  const range = block.debug?.startOffset !== undefined ? ` ${block.debug.startOffset}->${block.debug.endOffset ?? '?'}` : '';
  const speeds = block.speeds ? ' speeds=yes' : ' speeds=no';
  return `#${index}${range} update=${block.updateType} type=${block.typeId ?? '?'}${updateFlags}${flags}${speeds}${mask} guid=${block.guid.slice(0, 8)}...`;
}

export function parseWorldUpdatePacket(data: Uint8Array, typeLookup: (guid: string) => TypeID | undefined = () => undefined): ParsedWorldUpdate {
  const r = new UpdateReader(data);
  const blockCount = r.u32();
  const hasTransport = r.remaining > 0 ? r.u8() !== 0 : false;
  const blocks: UpdateBlock[] = [];
  const errors: UpdateParseError[] = [];
  const packetTypes = new Map<string, TypeID>();
  const lookupType = (guid: string) => packetTypes.get(guid) ?? typeLookup(guid);

  for (let i = 0; i < blockCount; i++) {
    const offset = r.offset;
    try {
      const block = parseUpdateBlock(r, lookupType, offset);
      if (block.debug) block.debug.endOffset = r.offset;
      if (block.relatedGuids) {
        for (const guid of block.relatedGuids) blocks.push({ ...block, guid, relatedGuids: undefined });
      } else {
        if (block.typeId !== undefined) packetTypes.set(block.guid, block.typeId);
        blocks.push(block);
      }
    } catch (e) {
      const recent = blocks.slice(-4).map((block, n) => describeBlock(block, blocks.length - Math.min(4, blocks.length) + n)).join(' | ');
      errors.push({ blockIndex: i, offset, message: (e as Error).message, context: recent, nextBytes: r.peekHex(32) });
      break;
    }
  }

  return { blockCount, hasTransport, blocks: errors.length ? [] : blocks, errors, bytesRemaining: r.remaining };
}

function u32ToFloat(value: number) {
  const data = new ArrayBuffer(4);
  const view = new DataView(data);
  view.setUint32(0, value >>> 0, true);
  return view.getFloat32(0, true);
}

function typeName(typeId?: TypeID) {
  switch (typeId) {
    case TypeID.OBJECT:
      return 'object';
    case TypeID.ITEM:
      return 'item';
    case TypeID.CONTAINER:
      return 'container';
    case TypeID.UNIT:
      return 'unit';
    case TypeID.PLAYER:
      return 'player';
    case TypeID.GAMEOBJECT:
      return 'gameobject';
    case TypeID.DYNAMICOBJECT:
      return 'dynamicobject';
    case TypeID.CORPSE:
      return 'corpse';
    default:
      return 'unknown';
  }
}

function typeFromMask(mask: number): TypeID | undefined {
  if (mask & 0x0010) return TypeID.PLAYER;
  if (mask & 0x0008) return TypeID.UNIT;
  if (mask & 0x0080) return TypeID.CORPSE;
  if (mask & 0x0040) return TypeID.DYNAMICOBJECT;
  if (mask & 0x0020) return TypeID.GAMEOBJECT;
  if (mask & 0x0004) return TypeID.CONTAINER;
  if (mask & 0x0002) return TypeID.ITEM;
  if (mask & 0x0001) return TypeID.OBJECT;
  return undefined;
}

function typeFromGuid(guid: string): TypeID | undefined {
  const high = Number.parseInt(guid.slice(0, 4), 16);
  switch (high) {
    case 0xf130:
    case 0xf140:
      return TypeID.UNIT;
    case 0xf110:
    case 0xf120:
      return TypeID.GAMEOBJECT;
    case 0xf100:
      return TypeID.DYNAMICOBJECT;
    case 0xf101:
      return TypeID.CORPSE;
    case 0x4000:
      return TypeID.ITEM;
    case 0x0000:
      return TypeID.PLAYER;
    default:
      return undefined;
  }
}

function setType(entity: WorldEntity, typeId: TypeID | undefined) {
  if (typeId === undefined) return;
  entity.typeId = typeId;
  entity.typeName = typeName(typeId);
}

function applyField(entity: WorldEntity, index: number, value: number) {
  if (entity.typeId === TypeID.ITEM || entity.typeId === TypeID.CONTAINER) {
    if (index === ITEM_FIELD_DURATION) {
      entity.itemDurationSeconds = value;
      return;
    }
    if (index >= ITEM_FIELD_ENCHANTMENT && index < ITEM_FIELD_ENCHANTMENT_END) {
      const relative = index - ITEM_FIELD_ENCHANTMENT;
      const slot = Math.floor(relative / 3);
      const component = relative % 3;
      entity.itemEnchantments ??= [];
      entity.itemEnchantments[slot] ??= { enchantId: 0, durationMs: 0, charges: 0 };
      if (component === 0) entity.itemEnchantments[slot].enchantId = value;
      else if (component === 1) entity.itemEnchantments[slot].durationMs = value;
      else entity.itemEnchantments[slot].charges = value;
      return;
    }
  }

  if (entity.typeId === TypeID.DYNAMICOBJECT) {
    switch (index) {
      case DYNAMICOBJECT_CASTER:
        entity.dynamicObjectCasterGuidLow = value;
        entity.dynamicObjectCasterGuid = combineFieldGuid(value, entity.dynamicObjectCasterGuidHigh ?? 0);
        return;
      case DYNAMICOBJECT_CASTER + 1:
        entity.dynamicObjectCasterGuidHigh = value;
        entity.dynamicObjectCasterGuid = combineFieldGuid(entity.dynamicObjectCasterGuidLow ?? 0, value);
        return;
      case DYNAMICOBJECT_BYTES:
        entity.dynamicObjectType = value & 0xff;
        return;
      case DYNAMICOBJECT_SPELLID:
        entity.dynamicObjectSpellId = value;
        return;
      case DYNAMICOBJECT_RADIUS:
        entity.dynamicObjectRadius = u32ToFloat(value);
        return;
      case DYNAMICOBJECT_POS_X:
        entity.x = u32ToFloat(value);
        return;
      case DYNAMICOBJECT_POS_Y:
        entity.y = u32ToFloat(value);
        return;
      case DYNAMICOBJECT_POS_Z:
        entity.z = u32ToFloat(value);
        return;
      case DYNAMICOBJECT_FACING:
        entity.o = u32ToFloat(value);
        return;
    }
  }

  if (entity.typeId === TypeID.CORPSE) {
    switch (index) {
      case CORPSE_FIELD_OWNER:
        entity.ownerGuidLow = value;
        entity.ownerGuid = combineFieldGuid(value, entity.ownerGuidHigh ?? 0);
        return;
      case CORPSE_FIELD_OWNER + 1:
        entity.ownerGuidHigh = value;
        entity.ownerGuid = combineFieldGuid(entity.ownerGuidLow ?? 0, value);
        return;
      case CORPSE_FIELD_FACING:
        entity.o = u32ToFloat(value);
        return;
      case CORPSE_FIELD_POS_X:
        entity.x = u32ToFloat(value);
        return;
      case CORPSE_FIELD_POS_Y:
        entity.y = u32ToFloat(value);
        return;
      case CORPSE_FIELD_POS_Z:
        entity.z = u32ToFloat(value);
        return;
    }
  }

  const visibleItemOffset = index - PLAYER_VISIBLE_ITEM_1_0;
  if (
    visibleItemOffset >= 0 &&
    visibleItemOffset < PLAYER_VISIBLE_ITEM_SLOTS * PLAYER_VISIBLE_ITEM_STRIDE
  ) {
    const slot = Math.floor(visibleItemOffset / PLAYER_VISIBLE_ITEM_STRIDE);
    const withinSlot = visibleItemOffset % PLAYER_VISIBLE_ITEM_STRIDE;
    if (withinSlot === 0) {
      entity.visibleItemEntries ??= [];
      entity.visibleItemEntries[slot] = value;
      return;
    }
    if (withinSlot === 1 || withinSlot === 2) {
      entity.visibleItemEnchantments ??= [];
      entity.visibleItemEnchantments[slot] ??= { permanent: 0, temporary: 0 };
      if (withinSlot === 1) entity.visibleItemEnchantments[slot].permanent = value;
      else entity.visibleItemEnchantments[slot].temporary = value;
      return;
    }
  }

  if (index >= UNIT_FIELD_AURA && index <= UNIT_FIELD_AURA_END) {
    entity.auraSpellIds ??= [];
    entity.auraSpellIds[index - UNIT_FIELD_AURA] = value;
    return;
  }
  if (index >= UNIT_FIELD_AURAFLAGS && index <= UNIT_FIELD_AURAFLAGS_END) {
    entity.auraFlags ??= [];
    const baseSlot = (index - UNIT_FIELD_AURAFLAGS) * 8;
    for (let i = 0; i < 8; i++) entity.auraFlags[baseSlot + i] = (value >>> (i * 4)) & 0x0f;
    return;
  }
  if (index >= UNIT_FIELD_AURALEVELS && index <= UNIT_FIELD_AURALEVELS_END) {
    entity.auraLevels ??= [];
    const baseSlot = (index - UNIT_FIELD_AURALEVELS) * 4;
    for (let i = 0; i < 4; i++) entity.auraLevels[baseSlot + i] = (value >>> (i * 8)) & 0xff;
    return;
  }
  if (index >= UNIT_FIELD_AURAAPPLICATIONS && index <= UNIT_FIELD_AURAAPPLICATIONS_END) {
    entity.auraApplications ??= [];
    const baseSlot = (index - UNIT_FIELD_AURAAPPLICATIONS) * 4;
    for (let i = 0; i < 4; i++) entity.auraApplications[baseSlot + i] = (value >>> (i * 8)) & 0xff;
    return;
  }
  if (index === UNIT_FIELD_AURASTATE) {
    entity.auraState = value;
    return;
  }

  if (entity.typeId === TypeID.GAMEOBJECT) {
    if (applyGameObjectRotationField(entity, index, value)) return;
    switch (index) {
      case GAMEOBJECT_DISPLAYID:
        entity.displayId = value;
        return;
      case GAMEOBJECT_POS_X:
        entity.x = u32ToFloat(value);
        return;
      case GAMEOBJECT_POS_Y:
        entity.y = u32ToFloat(value);
        return;
      case GAMEOBJECT_POS_Z:
        entity.z = u32ToFloat(value);
        return;
      case GAMEOBJECT_FACING:
        entity.o = u32ToFloat(value);
        return;
      case GAMEOBJECT_DYN_FLAGS:
        entity.dynamicFlags = value;
        return;
      case GAMEOBJECT_FACTION:
        entity.faction = value;
        return;
      case GAMEOBJECT_TYPE_ID:
        entity.gameObjectType = value;
        return;
      case GAMEOBJECT_STATE:
        entity.gameObjectState = value;
        return;
      case GAMEOBJECT_LEVEL:
        entity.gameObjectLevel = value;
        return;
      case GAMEOBJECT_ARTKIT:
        entity.gameObjectArtKit = value;
        return;
      case GAMEOBJECT_ANIMPROGRESS:
        entity.gameObjectAnimProgress = value;
        return;
    }
  }

  switch (index) {
    case OBJECT_FIELD_TYPE:
      setType(entity, typeFromMask(value));
      break;
    case OBJECT_FIELD_ENTRY:
      entity.entry = value;
      break;
    case OBJECT_FIELD_SCALE_X:
      entity.scale = u32ToFloat(value);
      break;
    case UNIT_FIELD_HEALTH:
      entity.health = value;
      break;
    case UNIT_FIELD_POWER1:
    case 0x18:
    case 0x19:
    case 0x1a:
    case UNIT_FIELD_POWER5: {
      entity.powers ??= [];
      entity.powers[index - UNIT_FIELD_POWER1] = value;
      break;
    }
    case UNIT_FIELD_MAXHEALTH:
      entity.maxHealth = value;
      break;
    case UNIT_FIELD_MAXPOWER1:
    case 0x1e:
    case 0x1f:
    case 0x20:
    case UNIT_FIELD_MAXPOWER5: {
      entity.maxPowers ??= [];
      entity.maxPowers[index - UNIT_FIELD_MAXPOWER1] = value;
      break;
    }
    case UNIT_FIELD_LEVEL:
      entity.level = value;
      break;
    case UNIT_FIELD_FACTIONTEMPLATE:
      entity.faction = value;
      break;
    case UNIT_FIELD_BYTES_0:
      entity.race = value & 0xff;
      entity.classId = (value >>> 8) & 0xff;
      entity.gender = (value >>> 16) & 0xff;
      entity.powerType = (value >>> 24) & 0xff;
      break;
    case UNIT_FIELD_BYTES_1:
      // Byte 0 is the stand state (UnitStandStateType: 0 stand, 1 sit, 3 sleep, 4-6 chairs,
      // 8 kneel). vMaNGOS forces SIT on any AURA_INTERRUPT_STANDING_CANCELS aura apply
      // (SpellAuras.cpp) — i.e. eating/drinking sits the unit. Byte 3 holds the unit vis flags;
      // bit 0x01 is the authoritative ghost render flag.
      entity.standState = value & 0xff;
      entity.visFlags = (value >>> 24) & 0xff;
      break;
    case PLAYER_BYTES:
      entity.skin = value & 0xff;
      entity.face = (value >>> 8) & 0xff;
      entity.hairStyle = (value >>> 16) & 0xff;
      entity.hairColor = (value >>> 24) & 0xff;
      break;
    case PLAYER_FLAGS:
      entity.playerFlags = value;
      break;
    case PLAYER_DUEL_ARBITER:
      entity.duelArbiterGuidLow = value;
      entity.duelArbiterGuid = combineFieldGuid(value, entity.duelArbiterGuidHigh ?? 0);
      break;
    case PLAYER_DUEL_ARBITER + 1:
      entity.duelArbiterGuidHigh = value;
      entity.duelArbiterGuid = combineFieldGuid(entity.duelArbiterGuidLow ?? 0, value);
      break;
    case PLAYER_DUEL_TEAM: entity.duelTeam = value; break;
    case PLAYER_BYTES_2:
      entity.facialHair = value & 0xff;
      entity.restState = (value >>> 24) & 0xff;
      break;
    case PLAYER_XP:
      entity.experience = value;
      break;
    case PLAYER_NEXT_LEVEL_XP:
      entity.nextLevelExperience = value;
      break;
    case PLAYER_REST_STATE_EXPERIENCE:
      entity.restedExperience = value;
      break;
    case PLAYER_CHARACTER_POINTS1:
      entity.unspentTalentPoints = value;
      break;
    case UNIT_FIELD_FLAGS:
      entity.unitFlags = value;
      entity.notSelectable = (value & 0x02000000) !== 0;
      entity.nonAttackable = (value & (0x00000080 | 0x00000100 | 0x00000200 | 0x00010000)) !== 0;
      entity.silenced = (value & 0x00002000) !== 0;
      entity.pacified = (value & 0x00020000) !== 0;
      entity.stunned = (value & 0x00040000) !== 0;
      entity.taxiFlight = (value & 0x00100000) !== 0;
      entity.disarmed = (value & 0x00200000) !== 0;
      entity.confused = (value & 0x00400000) !== 0;
      entity.fleeing = (value & 0x00800000) !== 0;
      entity.possessed = (value & 0x01000000) !== 0;
      break;
    case UNIT_FIELD_STAT0:
      entity.strength = value;
      break;
    case UNIT_FIELD_STAT0 + 1:
      entity.agility = value;
      break;
    case UNIT_FIELD_STAT0 + 2:
      entity.stamina = value;
      break;
    case UNIT_FIELD_STAT0 + 3:
      entity.intellect = value;
      break;
    case UNIT_FIELD_STAT0 + 4:
      entity.spirit = value;
      break;
    case UNIT_FIELD_RESISTANCES:
      entity.armor = value; // resistance[0]
      break;
    case UNIT_FIELD_ATTACK_POWER:
      entity.attackPower = value;
      break;
    case UNIT_FIELD_RANGED_ATTACK_POWER:
      entity.rangedAttackPower = value;
      break;
    case UNIT_FIELD_MINDAMAGE:
      entity.minDamage = u32ToFloat(value);
      break;
    case UNIT_FIELD_MAXDAMAGE:
      entity.maxDamage = u32ToFloat(value);
      break;
    case UNIT_FIELD_MINRANGEDDAMAGE:
      entity.minRangedDamage = u32ToFloat(value);
      break;
    case UNIT_FIELD_MAXRANGEDDAMAGE:
      entity.maxRangedDamage = u32ToFloat(value);
      break;
    case UNIT_FIELD_BOUNDINGRADIUS:
      entity.boundingRadius = u32ToFloat(value);
      break;
    case UNIT_FIELD_COMBATREACH:
      entity.combatReach = u32ToFloat(value);
      break;
    case UNIT_FIELD_DISPLAYID:
      entity.displayId = value;
      break;
    case UNIT_FIELD_NATIVEDISPLAYID:
      entity.nativeDisplayId = value;
      break;
    case UNIT_FIELD_MOUNTDISPLAYID:
      entity.mountDisplayId = value;
      break;
    case UNIT_DYNAMIC_FLAGS:
      entity.dynamicFlags = value;
      break;
    case UNIT_FIELD_BYTES_2:
      entity.sheathState = value & 0xff; // byte 0 = SheathState (0 unarmed, 1 melee, 2 ranged)
      entity.pvpFlags = (value >>> 8) & 0xff; // byte 1 = UNIT_BYTES_2_OFFSET_MISC_FLAGS
      break;
    case UNIT_FIELD_TARGET: // low dword
      entity.targetGuidLow = value;
      entity.targetGuid = combineFieldGuid(value, entity.targetGuidHigh ?? 0);
      break;
    case UNIT_FIELD_TARGET + 1: // high dword
      entity.targetGuidHigh = value;
      entity.targetGuid = combineFieldGuid(entity.targetGuidLow ?? 0, value);
      break;
    case UNIT_FIELD_CHARM:
      entity.charmGuidLow = value;
      entity.charmGuid = combineFieldGuid(value, entity.charmGuidHigh ?? 0);
      break;
    case UNIT_FIELD_CHARM + 1:
      entity.charmGuidHigh = value;
      entity.charmGuid = combineFieldGuid(entity.charmGuidLow ?? 0, value);
      break;
    case UNIT_FIELD_SUMMON:
      entity.summonGuidLow = value;
      entity.summonGuid = combineFieldGuid(value, entity.summonGuidHigh ?? 0);
      break;
    case UNIT_FIELD_SUMMON + 1:
      entity.summonGuidHigh = value;
      entity.summonGuid = combineFieldGuid(entity.summonGuidLow ?? 0, value);
      break;
    case UNIT_FIELD_CHARMEDBY:
      entity.charmedByGuidLow = value;
      entity.charmedByGuid = combineFieldGuid(value, entity.charmedByGuidHigh ?? 0);
      break;
    case UNIT_FIELD_CHARMEDBY + 1:
      entity.charmedByGuidHigh = value;
      entity.charmedByGuid = combineFieldGuid(entity.charmedByGuidLow ?? 0, value);
      break;
    case UNIT_FIELD_SUMMONEDBY:
      entity.summonedByGuidLow = value;
      entity.summonedByGuid = combineFieldGuid(value, entity.summonedByGuidHigh ?? 0);
      break;
    case UNIT_FIELD_SUMMONEDBY + 1:
      entity.summonedByGuidHigh = value;
      entity.summonedByGuid = combineFieldGuid(entity.summonedByGuidLow ?? 0, value);
      break;
    case UNIT_FIELD_CREATEDBY:
      entity.createdByGuidLow = value;
      entity.createdByGuid = combineFieldGuid(value, entity.createdByGuidHigh ?? 0);
      break;
    case UNIT_FIELD_CREATEDBY + 1:
      entity.createdByGuidHigh = value;
      entity.createdByGuid = combineFieldGuid(entity.createdByGuidLow ?? 0, value);
      break;
    case UNIT_FIELD_PERSUADED:
      entity.persuadedGuidLow = value;
      entity.persuadedGuid = combineFieldGuid(value, entity.persuadedGuidHigh ?? 0);
      break;
    case UNIT_FIELD_PERSUADED + 1:
      entity.persuadedGuidHigh = value;
      entity.persuadedGuid = combineFieldGuid(entity.persuadedGuidLow ?? 0, value);
      break;
    case UNIT_FIELD_CHANNEL_OBJECT:
      entity.channelObjectGuidLow = value;
      entity.channelObjectGuid = combineFieldGuid(value, entity.channelObjectGuidHigh ?? 0);
      break;
    case UNIT_FIELD_CHANNEL_OBJECT + 1:
      entity.channelObjectGuidHigh = value;
      entity.channelObjectGuid = combineFieldGuid(entity.channelObjectGuidLow ?? 0, value);
      break;
    case UNIT_CHANNEL_SPELL:
      entity.channelSpellId = value;
      break;
    case UNIT_CREATED_BY_SPELL:
      entity.createdBySpellId = value;
      break;
    case UNIT_MOD_CAST_SPEED:
      entity.castSpeedModifier = u32ToFloat(value);
      break;
    case UNIT_FIELD_BASEATTACKTIME:
      entity.baseAttackTimeMs = value;
      break;
    case UNIT_FIELD_BASEATTACKTIME + 1:
      entity.offHandAttackTimeMs = value;
      break;
    case UNIT_FIELD_RANGEDATTACKTIME:
      entity.rangedAttackTimeMs = value;
      break;
    case UNIT_NPC_EMOTESTATE:
      entity.npcEmoteState = value;
      break;
    case UNIT_FIELD_BASE_MANA:
      entity.baseMana = value;
      break;
    case UNIT_FIELD_BASE_HEALTH:
      entity.baseHealth = value;
      break;
    // PLAYER_FIELD_COMBO_TARGET is deliberately NOT decoded into an entity property here: combat/
    // combo-points.ts reads it straight out of `entity.fields` together with PLAYER_FIELD_BYTES,
    // and that is the only consumer. A second decoded copy had no readers and would drift from the
    // shift model in data/player-field-layout.ts the moment one of the two was edited.
    case UNIT_NPC_FLAGS:
      entity.npcFlags = value;
      break;
  }

  if (index >= UNIT_VIRTUAL_ITEM_SLOT_DISPLAY && index < UNIT_VIRTUAL_ITEM_SLOT_DISPLAY + 3) {
    entity.virtualItemDisplayIds ??= [];
    entity.virtualItemDisplayIds[index - UNIT_VIRTUAL_ITEM_SLOT_DISPLAY] = value;
  } else if (index >= UNIT_VIRTUAL_ITEM_INFO && index < UNIT_VIRTUAL_ITEM_INFO + 6) {
    entity.virtualItemInfo ??= [];
    entity.virtualItemInfo[index - UNIT_VIRTUAL_ITEM_INFO] = value;
  }
}

export function isAuraField(index: number) {
  return (
    (index >= UNIT_FIELD_AURA && index <= UNIT_FIELD_AURA_END) ||
    (index >= UNIT_FIELD_AURAFLAGS && index <= UNIT_FIELD_AURAFLAGS_END) ||
    (index >= UNIT_FIELD_AURALEVELS && index <= UNIT_FIELD_AURALEVELS_END) ||
    (index >= UNIT_FIELD_AURAAPPLICATIONS && index <= UNIT_FIELD_AURAAPPLICATIONS_END) ||
    index === UNIT_FIELD_AURASTATE
  );
}

function applyMovement(entity: WorldEntity, movement: MovementInfo, predictionAgeMs: number | undefined, nowMs: number) {
  entity.x = movement.x;
  entity.y = movement.y;
  entity.z = movement.z;
  entity.o = movement.o;
  entity.flags = movement.flags;
  entity.time = movement.time;
  entity.fallTime = movement.fallTime;
  entity.transportGuid = movement.transportGuid;
  entity.transportX = movement.transportX;
  entity.transportY = movement.transportY;
  entity.transportZ = movement.transportZ;
  entity.transportO = movement.transportO;
  entity.swimPitch = movement.swimPitch;
  entity.predictionAgeMs = predictionAgeMs;
  entity.rooted = (movement.flags & MOVEMENTFLAG_ROOT) !== 0;
  entity.waterWalking = (movement.flags & MOVEMENTFLAG_WATERWALKING) !== 0;
  entity.featherFalling = (movement.flags & MOVEMENTFLAG_SAFE_FALL) !== 0;
  entity.hovering = (movement.flags & MOVEMENTFLAG_HOVER) !== 0;
  entity.running = (movement.flags & MOVEMENTFLAG_WALK_MODE) === 0;
  // Carry the jump arc (cleared when not airborne) for remote dead-reckoning.
  if ((movement.flags & MOVEMENTFLAG_FALLING) !== 0) {
    const fallSeconds = Math.max(0, movement.fallTime) / 1000;
    const jumpVelocity = movement.jumpVelocity ?? DEFAULT_JUMP_VELOCITY;
    const jumpXYSpeed = movement.jumpXYSpeed ?? 0;
    const jumpCosAngle = movement.jumpCosAngle ?? Math.cos(movement.o);
    const jumpSinAngle = movement.jumpSinAngle ?? Math.sin(movement.o);
    entity.jumpVelocity = jumpVelocity;
    entity.jumpXYSpeed = jumpXYSpeed;
    entity.jumpSinAngle = jumpSinAngle;
    entity.jumpCosAngle = jumpCosAngle;
    entity.jumpStartX = movement.x - jumpCosAngle * jumpXYSpeed * fallSeconds;
    entity.jumpStartY = movement.y - jumpSinAngle * jumpXYSpeed * fallSeconds;
    entity.jumpStartZ = movement.z - jumpVelocity * fallSeconds + 0.5 * WOW_JUMP_GRAVITY * fallSeconds * fallSeconds;
    entity.jumpStartedAt = nowMs - movement.fallTime;
  } else {
    entity.jumpVelocity = undefined;
    entity.jumpXYSpeed = undefined;
    entity.jumpSinAngle = undefined;
    entity.jumpCosAngle = undefined;
    entity.jumpStartX = undefined;
    entity.jumpStartY = undefined;
    entity.jumpStartZ = undefined;
    entity.jumpStartedAt = undefined;
  }
  if (movement.spline) {
    entity.spline = {
      ...movement.spline,
      startX: movement.x,
      startY: movement.y,
      startZ: movement.z,
      startedAt: nowMs - movement.spline.time,
    };
  }
}

export class WorldEntityStore {
  private readonly entities = new Map<string, WorldEntity>();
  private readonly spatial = new SpatialIndex2D<WorldEntity>(TILE_ENTITY_INDEX_CELL_SIZE);
  private readonly spatialScratch: WorldEntity[] = [];

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly onChange?: (change: WorldEntityChange) => void,
  ) {}

  private publish(change: WorldEntityChange): WorldEntityChange {
    this.onChange?.(change);
    return change;
  }

  get size() {
    return this.entities.size;
  }

  typeOf(guid: string) {
    return this.entities.get(guid)?.typeId;
  }

  get(guid: string) {
    return this.entities.get(guid);
  }

  snapshot() {
    return Array.from(this.entities.values());
  }

  queryBounds(bounds: { minX: number; minY: number; maxX: number; maxY: number }) {
    return this.spatial.queryBounds(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY, this.spatialScratch)
      .filter((entity) => entity.x !== undefined && entity.y !== undefined
        && entity.x >= bounds.minX && entity.x <= bounds.maxX && entity.y >= bounds.minY && entity.y <= bounds.maxY);
  }

  clear() {
    if (this.onChange) {
      for (const guid of this.entities.keys()) this.onChange({ kind: 'remove', guid });
    }
    this.entities.clear();
    this.spatial.clear();
  }

  /** Remove one server object for SMSG_DESTROY_OBJECT / despawn-animation packets. */
  remove(guid: string) {
    const removed = this.entities.delete(guid);
    if (removed) this.spatial.remove(guid);
    if (removed) this.onChange?.({ kind: 'remove', guid });
    return removed;
  }

  applyMovement(guid: string, movement: MovementInfo, predictionAgeMs?: number): WorldEntityChange {
    const entity = this.getOrCreate(guid);
    applyMovement(entity, movement, predictionAgeMs, this.now());
    this.index(entity);
    entity.updatedAt = this.now();
    return this.publish({ kind: 'update', entity, changedFields: [] });
  }

  /**
   * MSG_MOVE_TELEPORT — the observer broadcast of a same-map ("near") teleport. Wire shape is the
   * ordinary packed GUID + MovementInfo (MovementPacketSender::SendTeleportToObservers,
   * MovementPacketSender.cpp:221-239, with the destination written in via
   * MovementInfo::ChangePosition), but the semantics are a discontinuity rather than motion.
   *
   * The server calls DisableSpline() before broadcasting for creatures (Unit::NearTeleportTo,
   * Unit.cpp:10056-10065), so any spline still held here describes a path from the old position
   * and must be dropped or the unit walks back out of the teleport.
   */
  applyTeleport(guid: string, movement: MovementInfo): WorldEntityChange {
    const entity = this.getOrCreate(guid);
    applyMovement(entity, movement, undefined, this.now());
    this.index(entity);
    entity.spline = undefined;
    entity.teleportSeq = (entity.teleportSeq ?? 0) + 1;
    entity.updatedAt = this.now();
    return this.publish({ kind: 'update', entity, changedFields: [], discontinuity: 'teleport' });
  }

  /** MSG_MOVE_TIME_SKIPPED advances the remote mover's protocol clock without changing position. */
  applyTimeSkipped(guid: string, lagMs: number): WorldEntityChange {
    const entity = this.getOrCreate(guid);
    if (entity.time !== undefined) entity.time = (entity.time + (lagMs >>> 0)) >>> 0;
    if (entity.predictionAgeMs !== undefined) {
      entity.predictionAgeMs = Math.max(0, entity.predictionAgeMs - (lagMs >>> 0));
    }
    entity.updatedAt = this.now();
    return this.publish({ kind: 'update', entity, changedFields: [] });
  }

  applySpeed(
    guid: string,
    kind: UnitSpeedKind,
    speed: number,
    movement?: MovementInfo,
    predictionAgeMs?: number,
  ): WorldEntityChange {
    const entity = this.getOrCreate(guid);
    if (movement) applyMovement(entity, movement, predictionAgeMs, this.now());
    this.index(entity);
    applyUnitSpeedState(entity, kind, speed);
    entity.updatedAt = this.now();
    return this.publish({ kind: 'update', entity, changedFields: [] });
  }

  applyMovementMode(
    guid: string,
    patch: Partial<Pick<
      WorldEntity,
      'rooted' | 'waterWalking' | 'featherFalling' | 'hovering' | 'running'
    >>,
    movement?: MovementInfo,
    predictionAgeMs?: number,
  ): WorldEntityChange {
    const entity = this.getOrCreate(guid);
    if (movement) applyMovement(entity, movement, predictionAgeMs, this.now());
    this.index(entity);
    // Keep the public MovementInfo flags coherent with opcode-only spline changes.
    applyUnitMovementModeState(entity, patch);
    entity.updatedAt = this.now();
    return this.publish({ kind: 'update', entity, changedFields: [] });
  }

  applySpline(guid: string, spline: SplineInfo): WorldEntityChange {
    const entity = this.getOrCreate(guid);
    entity.x = spline.startX ?? entity.x;
    entity.y = spline.startY ?? entity.y;
    entity.z = spline.startZ ?? entity.z;
    entity.spline = { ...spline, startedAt: this.now() - spline.time };
    this.index(entity);
    entity.updatedAt = this.now();
    return this.publish({ kind: 'update', entity, changedFields: [] });
  }

  apply(block: UpdateBlock, movementPredictionAgeMs?: number): WorldEntityChange {
    if (block.updateType === UpdateType.OUT_OF_RANGE) {
      this.entities.delete(block.guid);
      this.spatial.remove(block.guid);
      return this.publish({ kind: 'remove', guid: block.guid });
    }
    if (block.updateType === UpdateType.NEAR_OBJECTS) return { kind: 'none' };

    const existed = this.entities.has(block.guid);
    const entity = this.getOrCreate(block.guid, block.typeId);
    setType(entity, block.typeId);
    if (block.movement) applyMovement(entity, block.movement, movementPredictionAgeMs, this.now());
    if (block.speeds) entity.speeds = block.speeds;
    applyTransportClock(entity, block.transportPathTimer, this.now());

    const changedFields: number[] = [];
    for (const field of block.values ?? []) {
      entity.fields.set(field.index, field.value);
      applyField(entity, field.index, field.value);
      changedFields.push(field.index);
    }
    entity.updatedAt = this.now();
    this.index(entity);
    return this.publish({ kind: existed ? 'update' : 'create', entity, changedFields });
  }

  private getOrCreate(guid: string, typeId = typeFromGuid(guid)) {
    let entity = this.entities.get(guid);
    if (!entity) {
      entity = { guid, typeId, typeName: typeName(typeId), fields: new Map(), updatedAt: this.now() };
      this.entities.set(guid, entity);
    }
    return entity;
  }

  private index(entity: WorldEntity) {
    if (entity.x !== undefined && entity.y !== undefined) this.spatial.update(entity.guid, entity, entity.x, entity.y);
  }
}

const TILE_ENTITY_INDEX_CELL_SIZE = 128;
