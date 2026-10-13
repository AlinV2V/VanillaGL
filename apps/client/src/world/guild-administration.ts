/** Build-5875 guild roster state plus rank, note, and information mutation codecs. */
export const GUILD_ADMIN_OPCODES = {
  CMSG_GUILD_RANK: 0x0231,
  CMSG_GUILD_ADD_RANK: 0x0232,
  CMSG_GUILD_DEL_RANK: 0x0233,
  CMSG_GUILD_SET_PUBLIC_NOTE: 0x0234,
  CMSG_GUILD_SET_OFFICER_NOTE: 0x0235,
  CMSG_GUILD_INFO_TEXT: 0x02fc,
} as const;

export const GUILD_RANK_MIN_COUNT = 5;
export const GUILD_RANK_MAX_COUNT = 10;
export const GUILD_RANK_NAME_MAX = 15;
export const GUILD_NOTE_MAX = 31;
export const GUILD_INFO_MAX = 500;
export const GUILD_RIGHT_EMPTY = 0x00000040;
export const GUILD_RIGHT_ALL = 0x000ff1ff;

/** Guild.h values include the mandatory 0x40 baseline used by HasRankRight. */
export const GUILD_RIGHTS = {
  guildChatListen: 0x00000041,
  guildChatSpeak: 0x00000042,
  officerChatListen: 0x00000044,
  officerChatSpeak: 0x00000048,
  promote: 0x000000c0,
  demote: 0x00000140,
  invite: 0x00000050,
  remove: 0x00000060,
  setMotd: 0x00001040,
  editPublicNote: 0x00002040,
  viewOfficerNote: 0x00004040,
  editOfficerNote: 0x00008040,
  modifyGuildInfo: 0x00010040,
} as const;

export const GUILD_RIGHT_OPTIONS = [
  ['Guildchat Listen', GUILD_RIGHTS.guildChatListen],
  ['Guildchat Speak', GUILD_RIGHTS.guildChatSpeak],
  ['Officerchat Listen', GUILD_RIGHTS.officerChatListen],
  ['Officerchat Speak', GUILD_RIGHTS.officerChatSpeak],
  ['Promote', GUILD_RIGHTS.promote],
  ['Demote', GUILD_RIGHTS.demote],
  ['Invite Member', GUILD_RIGHTS.invite],
  ['Remove Member', GUILD_RIGHTS.remove],
  ['Set MOTD', GUILD_RIGHTS.setMotd],
  ['Edit Public Note', GUILD_RIGHTS.editPublicNote],
  ['View Officer Note', GUILD_RIGHTS.viewOfficerNote],
  ['Edit Officer Note', GUILD_RIGHTS.editOfficerNote],
  ['Modify Guild Info', GUILD_RIGHTS.modifyGuildInfo],
] as const;

export const DEFAULT_GUILD_RANK_NAMES = ['Guild Master', 'Officer', 'Veteran', 'Member', 'Initiate'] as const;

export type GuildRosterMember = {
  guid: string;
  online: boolean;
  onlineFlags: number;
  name: string;
  rankId: number;
  level: number;
  classId: number;
  zoneId: number;
  lastOnlineDays?: number;
  note: string;
  officerNote: string;
};

export type GuildRosterState = {
  guild: GuildRosterMember[];
  guildMotd: string;
  guildInfoText: string;
  guildRankRights: number[];
};

type Reader = {
  readonly remaining: number;
  u8(): number;
  u32(): number;
  f32(): number;
  cstring(): string;
  bytes(length: number): Uint8Array;
};

const wireText = new TextEncoder();
const u32 = (value: number) => new Uint8Array([value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff]);
const cstring = (value: string) => {
  const encoded = wireText.encode(value);
  const body = new Uint8Array(encoded.length + 1);
  body.set(encoded);
  return body;
};
const join = (...parts: Uint8Array[]) => {
  const body = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.length; }
  return body;
};
const validText = (value: string, max: number) => !value.includes('\0') && Array.from(value).length <= max;
const expectDone = (reader: Reader, label: string) => {
  if (reader.remaining !== 0) throw new Error(`${label} has ${reader.remaining} trailing byte(s)`);
};

export function guildHasRight(rights: number, required: number): boolean {
  return (rights & GUILD_RIGHT_EMPTY) !== 0 && (rights & required) !== GUILD_RIGHT_EMPTY;
}

/** FriendsFrame.lua GuildFrame_GetLastOnline, using the largest non-zero unit. */
export function formatGuildLastOnline(days = 0): string {
  if (!Number.isFinite(days) || days < 1 / 24) return '< an hour';
  const value = days >= 365 ? Math.floor(days / 365) : days >= 30 ? Math.floor(days / 30) : days >= 1 ? Math.floor(days) : Math.max(1, Math.floor(days * 24));
  const unit = days >= 365 ? 'year' : days >= 30 ? 'month' : days >= 1 ? 'day' : 'hour';
  return `${value} ${unit}${value === 1 ? '' : 's'}`;
}

/** SMSG_GUILD_ROSTER as appended by Packets/Guild.cpp for clients newer than 1.8.4. */
export function readGuildRoster(reader: Reader, readGuid: (reader: Reader) => string): GuildRosterState {
  const count = reader.u32();
  const guildMotd = reader.cstring();
  const guildInfoText = reader.cstring();
  const rankCount = reader.u32();
  if (rankCount < GUILD_RANK_MIN_COUNT || rankCount > GUILD_RANK_MAX_COUNT) throw new Error(`SMSG_GUILD_ROSTER has ${rankCount} ranks`);
  const guildRankRights = Array.from({ length: rankCount }, () => reader.u32());
  // Even the shortest online member consumes 22 bytes. This makes a corrupt count fail before a
  // large loop while leaving the variable-length names and notes authoritative.
  if (count > Math.floor(reader.remaining / 22)) throw new Error(`SMSG_GUILD_ROSTER has impossible member count ${count}`);
  const guild: GuildRosterMember[] = [];
  for (let i = 0; i < count; i++) {
    const guid = readGuid(reader);
    const onlineFlags = reader.u8();
    if ((onlineFlags & ~0x07) !== 0) throw new Error(`SMSG_GUILD_ROSTER member has flags ${onlineFlags}`);
    const name = reader.cstring();
    const rankId = reader.u32();
    const level = reader.u8();
    const classId = reader.u8();
    const zoneId = reader.u32();
    const lastOnlineDays = onlineFlags ? undefined : reader.f32();
    if (lastOnlineDays !== undefined && (!Number.isFinite(lastOnlineDays) || lastOnlineDays < 0)) throw new Error(`SMSG_GUILD_ROSTER member ${name} has invalid offline days`);
    const note = reader.cstring();
    const officerNote = reader.cstring();
    if (rankId >= rankCount) throw new Error(`SMSG_GUILD_ROSTER member ${name} has rank ${rankId}/${rankCount}`);
    guild.push({ guid, online: !!onlineFlags, onlineFlags, name, rankId, level, classId, zoneId, lastOnlineDays, note, officerNote });
  }
  expectDone(reader, 'SMSG_GUILD_ROSTER');
  return { guild, guildMotd, guildInfoText, guildRankRights };
}

/** GuildControlSaveRank: u32 zero-based rank, u32 rights, cstring rank label. */
export function buildGuildRankUpdate(rankId: number, rights: number, rankName: string) {
  if (!Number.isInteger(rankId) || rankId < 0 || rankId >= GUILD_RANK_MAX_COUNT ||
      !Number.isInteger(rights) || rights < 0 || rights > 0xffffffff || !validText(rankName, GUILD_RANK_NAME_MAX)) return undefined;
  return join(u32(rankId), u32(rights | GUILD_RIGHT_EMPTY), cstring(rankName));
}

export function buildGuildAddRank(rankName: string) {
  return validText(rankName, GUILD_RANK_NAME_MAX) ? cstring(rankName) : undefined;
}

export const buildGuildDeleteRank = () => new Uint8Array(0);

export function buildGuildNote(name: string, note: string) {
  const cleanName = name.trim();
  if (!cleanName || cleanName.includes('\0') || !validText(note, GUILD_NOTE_MAX)) return undefined;
  return join(cstring(cleanName), cstring(note));
}

export function buildGuildInfoText(info: string) {
  return validText(info, GUILD_INFO_MAX) ? cstring(info) : undefined;
}
