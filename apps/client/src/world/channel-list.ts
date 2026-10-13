/** Build-5875 /chatlist member packet decoding and deferred player-name resolution. */
import type { ReadGuid, Reader } from './wire';

export type ChannelListMember = { guid: string; flags: number };
export type ChannelListPacket = {
  channelName: string;
  channelFlags: number;
  members: ChannelListMember[];
};

/** SMSG_CHANNEL_LIST = cstring name + u8 channel flags + i32 count + count*(u64 guid + u8 flags). */
export function readChannelList<R extends Reader>(reader: R, readGuid: ReadGuid<R>): ChannelListPacket {
  const channelName = reader.cstring();
  const channelFlags = reader.u8();
  const count = reader.i32();
  if (count < 0 || count > Math.floor(reader.remaining / 9)) {
    throw new Error(`SMSG_CHANNEL_LIST count ${count} exceeds ${reader.remaining} remaining bytes`);
  }
  const members = Array.from({ length: count }, () => ({ guid: readGuid(reader), flags: reader.u8() }));
  if (reader.remaining !== 0) throw new Error(`SMSG_CHANNEL_LIST left ${reader.remaining} unread bytes`);
  return { channelName, channelFlags, members };
}

/** FrameXML's CHAT_CHANNEL_LIST_GET is exactly "[%s] " followed by the resolved user list. */
export function formatChannelList(channelName: string, names: readonly string[]) {
  return `[${channelName}] ${names.join(', ')}`;
}

type ChannelListResolverDeps = {
  nameFor: (guid: string) => string | undefined;
  requestName: (guid: string) => void;
  emit: (message: string) => void;
};

/**
 * The wire carries GUIDs, not names. Stock WoW waits for its name cache before raising
 * CHAT_MSG_CHANNEL_LIST; keep the packet pending until every CMSG_NAME_QUERY completes too.
 */
export class ChannelListResolver {
  private pending: ChannelListPacket[] = [];
  private readonly deps: ChannelListResolverDeps;

  constructor(deps: ChannelListResolverDeps) { this.deps = deps; }

  accept(packet: ChannelListPacket) {
    this.pending.push(packet);
    if (this.pending.length > 16) this.pending.shift();
    for (const member of packet.members) if (this.deps.nameFor(member.guid) === undefined) this.deps.requestName(member.guid);
    this.flush();
  }

  nameResolved() { this.flush(); }
  clear() { this.pending.length = 0; }

  private flush() {
    const waiting: ChannelListPacket[] = [];
    for (const packet of this.pending) {
      const names = packet.members.map((member) => this.deps.nameFor(member.guid));
      if (names.some((name) => name === undefined)) waiting.push(packet);
      else this.deps.emit(formatChannelList(packet.channelName, names as string[]));
    }
    this.pending = waiting;
  }
}
