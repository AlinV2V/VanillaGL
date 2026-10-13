import { loadRuntimeData } from '../runtime-data';
export const CHANNEL_DBC_FLAG = { INITIAL: 0x00001, ZONE_DEP: 0x00002, GLOBAL: 0x00004, TRADE: 0x00008, CITY_ONLY: 0x00010 } as const;
export type ChatChannelEntry = { readonly id: number; readonly flags: number; readonly pattern: string; readonly shortcut: string };
type Data = { version?: number; channels: ChatChannelEntry[]; tradeZoneAreaIds: number[] };
const data = await loadRuntimeData<Data>('chat-channels', { channels: [], tradeZoneAreaIds: [] });
export const CHAT_CHANNELS: readonly ChatChannelEntry[] = data.channels;
export const TRADE_ZONE_AREA_IDS: ReadonlySet<number> = new Set(data.tradeZoneAreaIds);
export const CHAT_NOTICE = { JOINED: 0x00, LEFT: 0x01, YOU_JOINED: 0x02, YOU_LEFT: 0x03, WRONG_PASSWORD: 0x04, NOT_MEMBER: 0x05, NOT_MODERATOR: 0x06, MUTED: 0x11, BANNED: 0x13, INVALID_NAME: 0x1b, NOT_MODERATED: 0x1c, THROTTLED: 0x1f } as const;
export const CHANNEL_STRINGS = { YOU_JOINED: 'Entered channel [%s].', YOU_LEFT: 'Left channel [%s].', WRONG_PASSWORD: 'Password required for %s.', NOT_MEMBER: 'You are not in channel %s.', INVALID_NAME: 'Channel name is invalid.' } as const;
const format = (template: string, value: string) => template.replace('%s', value);
export const channelNotice = (template: string, channelName: string) => format(template, channelName);
export const isInitialChannel = (entry: ChatChannelEntry) => (entry.flags & CHANNEL_DBC_FLAG.INITIAL) !== 0;
export const isZoneDependent = (entry: ChatChannelEntry) => (entry.flags & CHANNEL_DBC_FLAG.ZONE_DEP) !== 0;
export const channelWireName = (entry: ChatChannelEntry, zoneName: string): string => isZoneDependent(entry) ? format(entry.pattern, zoneName) : entry.pattern;
export const initialChannelsForZone = (zoneAreaId: number, zoneName: string): string[] => {
  if (!zoneName) return [];
  const wanted: string[] = [];
  for (const entry of CHAT_CHANNELS) {
    if (!isInitialChannel(entry)) continue;
    if ((entry.flags & CHANNEL_DBC_FLAG.CITY_ONLY) !== 0 && !TRADE_ZONE_AREA_IDS.has(zoneAreaId)) continue;
    wanted.push(channelWireName(entry, zoneName));
  }
  return wanted;
};
export class ChannelSlots {
  private readonly slots: (string | null)[] = [];
  add(name: string): number { const existing = this.indexOf(name); if (existing > 0) return existing; const free = this.slots.indexOf(null); if (free >= 0) { this.slots[free] = name; return free + 1; } this.slots.push(name); return this.slots.length; }
  remove(name: string): number { const index = this.indexOf(name); if (index > 0) this.slots[index - 1] = null; while (this.slots.length && this.slots[this.slots.length - 1] === null) this.slots.pop(); return index; }
  indexOf(name: string): number { const wanted = name.toLowerCase(); for (let i = 0; i < this.slots.length; i++) if (this.slots[i]?.toLowerCase() === wanted) return i + 1; return 0; }
  nameFor(slot: number): string | undefined { return this.slots[slot - 1] ?? undefined; }
  list(): { slot: number; name: string }[] { const out: { slot: number; name: string }[] = []; for (let i = 0; i < this.slots.length; i++) { const name = this.slots[i]; if (name) out.push({ slot: i + 1, name }); } return out; }
  clear() { this.slots.length = 0; }
}
