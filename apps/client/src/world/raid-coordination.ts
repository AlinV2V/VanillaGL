/** Build-5875 raid-target and ready-check wire codecs plus retained marker state. */
export const RAID_COORDINATION_OPCODES = {
  CMSG_GROUP_CHANGE_SUB_GROUP: 0x027e,
  CMSG_GROUP_SWAP_SUB_GROUP: 0x0280,
  CMSG_GROUP_RAID_CONVERT: 0x028e,
  MSG_RAID_TARGET_UPDATE: 0x0321,
  MSG_RAID_READY_CHECK: 0x0322,
} as const;

export const EMPTY_GUID = '0000000000000000';
export const emptyRaidTargets = (): Array<string | undefined> => Array(8).fill(undefined);

export type RaidCoordinationEvent =
  | { kind: 'raidTargetDelta'; icon: number; guid: string }
  | { kind: 'raidTargetList'; targets: Array<{ icon: number; guid: string }> }
  | { kind: 'readyCheckRequest' }
  | { kind: 'readyCheckResponse'; guid: string; ready: boolean };

export type RaidPacketReader = {
  readonly remaining: number;
  u8(): number;
  bytes(length: number): Uint8Array;
};

export type GroupPacketReader = RaidPacketReader & {
  u32(): number;
  cstring(): string;
};

export type RaidGroupMember = {
  guid: string;
  name: string;
  online: boolean;
  subgroup: number;
  assistant: boolean;
};

/** SMSG_GROUP_LIST retains the local subgroup/assistant byte needed by UnitPopup.lua permissions. */
export function readGroupList(reader: GroupPacketReader, readGuid: (reader: GroupPacketReader) => string) {
  const groupType = reader.u8();
  const ownFlags = reader.u8();
  const count = reader.u32();
  if (count > 40) throw new Error(`SMSG_GROUP_LIST: impossible member count ${count}`);
  const group: RaidGroupMember[] = [];
  for (let index = 0; index < count; index++) {
    const name = reader.cstring();
    const guid = readGuid(reader);
    const online = reader.u8() !== 0;
    const flags = reader.u8();
    group.push({ guid, name, online, subgroup: flags & 0x07, assistant: (flags & 0x80) !== 0 });
  }
  const expectedTail = count > 0 ? 19 : 8; // leader guid + loot method/guid/threshold/difficulty
  if (reader.remaining !== expectedTail) throw new Error(`SMSG_GROUP_LIST: expected ${expectedTail} tail bytes, got ${reader.remaining}`);
  const groupLeaderGuid = readGuid(reader);
  const lootMethod = count > 0 ? reader.u8() : undefined;
  const looterGuid = count > 0 ? readGuid(reader) : undefined;
  const lootThreshold = count > 0 ? reader.u8() : undefined;
  if (count > 0) reader.u8(); // Build 5875 dungeon difficulty (unused in vanilla)
  expectDone(reader, 'SMSG_GROUP_LIST');
  return {
    groupType, group, groupLeaderGuid, ownSubgroup: ownFlags & 0x07,
    ownAssistant: (ownFlags & 0x80) !== 0, lootMethod, looterGuid, lootThreshold,
  };
}

const expectDone = (reader: RaidPacketReader, label: string) => {
  if (reader.remaining !== 0) throw new Error(`${label}: ${reader.remaining} trailing bytes`);
};

const validIcon = (icon: number) => {
  if (icon < 0 || icon >= 8) throw new Error(`raid target icon ${icon} is outside 0..7`);
  return icon;
};

/**
 * Both opcodes are bidirectional. A target update starts with mode 0 (one delta) or mode 1
 * (the complete icon list); a ready-check server body is either empty or raw-guid + state.
 */
export function readRaidCoordination(
  opcode: number,
  reader: RaidPacketReader,
  readGuid: (reader: RaidPacketReader) => string,
): RaidCoordinationEvent | undefined {
  if (opcode === RAID_COORDINATION_OPCODES.MSG_RAID_TARGET_UPDATE) {
    const mode = reader.u8();
    if (mode === 0) {
      const icon = validIcon(reader.u8());
      const guid = readGuid(reader);
      expectDone(reader, 'MSG_RAID_TARGET_UPDATE delta');
      return { kind: 'raidTargetDelta', icon, guid };
    }
    if (mode !== 1) throw new Error(`MSG_RAID_TARGET_UPDATE: invalid mode ${mode}`);
    const targets: Array<{ icon: number; guid: string }> = [];
    const icons = new Set<number>();
    while (reader.remaining > 0) {
      if (reader.remaining < 9) throw new Error('MSG_RAID_TARGET_UPDATE: truncated list entry');
      const icon = validIcon(reader.u8());
      if (icons.has(icon)) throw new Error(`MSG_RAID_TARGET_UPDATE: duplicate icon ${icon}`);
      icons.add(icon);
      targets.push({ icon, guid: readGuid(reader) });
    }
    return { kind: 'raidTargetList', targets };
  }
  if (opcode !== RAID_COORDINATION_OPCODES.MSG_RAID_READY_CHECK) return undefined;
  if (reader.remaining === 0) return { kind: 'readyCheckRequest' };
  if (reader.remaining !== 9) throw new Error(`MSG_RAID_READY_CHECK: invalid body length ${reader.remaining}`);
  const guid = readGuid(reader);
  const state = reader.u8();
  expectDone(reader, 'MSG_RAID_READY_CHECK response');
  if (state > 1) throw new Error(`MSG_RAID_READY_CHECK: invalid state ${state}`);
  return { kind: 'readyCheckResponse', guid, ready: state === 1 };
}

const assignTarget = (targets: Array<string | undefined>, icon: number, guid: string) => {
  if (guid === EMPTY_GUID) {
    targets[icon] = undefined;
    return;
  }
  for (let slot = 0; slot < targets.length; slot++) if (targets[slot] === guid) targets[slot] = undefined;
  targets[icon] = guid;
};

/** Apply a server delta/list without exposing a half-updated marker table to renderers. */
export function applyRaidTargets(
  current: readonly (string | undefined)[],
  event: Extract<RaidCoordinationEvent, { kind: 'raidTargetDelta' | 'raidTargetList' }>,
) {
  const next = event.kind === 'raidTargetList' ? emptyRaidTargets() : Array.from(current).slice(0, 8);
  while (next.length < 8) next.push(undefined);
  if (event.kind === 'raidTargetDelta') assignTarget(next, event.icon, event.guid);
  else for (const target of event.targets) assignTarget(next, target.icon, target.guid);
  return next;
}

/** 1-based UI index; zero is the native "no marker" result. */
export function raidTargetIndex(targets: readonly (string | undefined)[], guid: string) {
  const index = targets.indexOf(guid);
  return index < 0 ? 0 : index + 1;
}

/** Build the client body `u8 icon + raw u64 guid`, including toggle-off and clear semantics. */
export function buildRaidTargetUpdate(
  targets: readonly (string | undefined)[],
  guid: string,
  uiIndex: number,
  guidBytes: (guid: string) => Uint8Array,
): Uint8Array | undefined {
  if (!Number.isInteger(uiIndex) || uiIndex < 0 || uiIndex > 8) return undefined;
  const current = raidTargetIndex(targets, guid);
  const icon = uiIndex === 0 ? current - 1 : uiIndex - 1;
  if (icon < 0) return undefined;
  const raw = uiIndex === 0 || current === uiIndex ? new Uint8Array(8) : guidBytes(guid);
  if (raw.length !== 8) throw new Error(`raid target guid must be 8 bytes, got ${raw.length}`);
  const body = new Uint8Array(9);
  body[0] = icon;
  body.set(raw, 1);
  return body;
}

export const buildRaidTargetListRequest = () => new Uint8Array([0xff]);
export const buildReadyCheckRequest = () => new Uint8Array(0);
export const buildReadyCheckResponse = (ready: boolean) => new Uint8Array([ready ? 1 : 0]);

const raidText = new TextEncoder();
const raidCString = (value: string) => {
  const encoded = raidText.encode(value);
  const out = new Uint8Array(encoded.length + 1);
  out.set(encoded);
  return out;
};

/** ConvertToRaid has no arguments; the authoritative roster change arrives in SMSG_GROUP_LIST. */
export const buildRaidConvertRequest = () => new Uint8Array(0);

/** SetRaidSubgroup's Lua group is 1..8; Build-5875 serializes the server's zero-based group byte. */
export function buildRaidSubgroupChange(name: string, subgroup: number) {
  const clean = name.trim();
  if (!clean || !Number.isInteger(subgroup) || subgroup < 0 || subgroup >= 8) return undefined;
  const encoded = raidCString(clean);
  const body = new Uint8Array(encoded.length + 1);
  body.set(encoded);
  body[encoded.length] = subgroup;
  return body;
}

/** SwapRaidSubgroup serializes two cstring member names in source/target order. */
export function buildRaidSubgroupSwap(name: string, swapWith: string) {
  const first = name.trim();
  const second = swapWith.trim();
  if (!first || !second || first === second) return undefined;
  const left = raidCString(first);
  const right = raidCString(second);
  const body = new Uint8Array(left.length + right.length);
  body.set(left);
  body.set(right, left.length);
  return body;
}

export type RaidSubgroupMember = { guid: string; name: string; subgroup: number };
export type RaidSubgroupDrop =
  | { kind: 'move'; name: string; subgroup: number }
  | { kind: 'swap'; name: string; swapWith: string };

/**
 * Resolve Blizzard_RaidUI's drop rule without optimistic state: occupied cross-group slots swap,
 * empty slots move, same-group/full/invalid drops snap back and wait for no server mutation.
 */
export function planRaidSubgroupDrop(
  members: readonly RaidSubgroupMember[],
  sourceGuid: string,
  targetSubgroup: number,
  targetSlot: number,
): RaidSubgroupDrop | undefined {
  if (!Number.isInteger(targetSubgroup) || targetSubgroup < 0 || targetSubgroup >= 8 ||
      !Number.isInteger(targetSlot) || targetSlot < 0 || targetSlot >= 5) return undefined;
  const source = members.find((member) => member.guid === sourceGuid);
  if (!source || source.subgroup === targetSubgroup) return undefined;
  const occupants = members.filter((member) => member.subgroup === targetSubgroup).slice(0, 5);
  const target = occupants[targetSlot];
  if (target) return target.guid === source.guid ? undefined : { kind: 'swap', name: source.name, swapWith: target.name };
  if (occupants.length >= 5) return undefined;
  return { kind: 'move', name: source.name, subgroup: targetSubgroup };
}
