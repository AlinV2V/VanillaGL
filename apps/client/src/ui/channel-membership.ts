import { initialChannelsForZone } from '../data/chat-channels';

export type ChannelMembershipWorld = {
  joinChannel(name: string, password?: string): void;
  leaveChannel(name: string): void;
};
/** Asset conversion utility. */
export class ChannelMembership {
  private zoneAreaId = 0;
  private joined: string[] = [];

  constructor(private readonly deps: { getWorld: () => ChannelMembershipWorld | undefined }) {}

  /**
   * Call whenever the resolved zone may have changed; cheap and idempotent between changes.
   * `zoneAreaId` must be the parent-resolved ZONE id (ZoneTracker.resolveZone().areaTableId),
   * because the Trade test is against the six zone-level rows that carry AreaTable flag 0x8.
   */
  syncZone(zoneAreaId: number, zoneName: string) {
    const world = this.deps.getWorld();
    if (!world || !zoneName || zoneAreaId === this.zoneAreaId) return;
    this.zoneAreaId = zoneAreaId;

    const wanted = initialChannelsForZone(zoneAreaId, zoneName);
    // Leave first so a zone change that keeps the same channel COUNT (Zone_01 -> Zone_04) still
    // drops the old zone's General before asking for the new one.
    for (const name of this.joined) {
      if (!wanted.includes(name)) world.leaveChannel(name);
    }
    for (const name of wanted) {
      if (!this.joined.includes(name)) world.joinChannel(name);
    }
    this.joined = wanted;
  }

  /** Drop local bookkeeping — the server has already forgotten us. */
  reset() {
    this.zoneAreaId = 0;
    this.joined = [];
  }

  /** The channels this controller believes it has asked for, for QA. */
  current(): readonly string[] {
    return [...this.joined];
  }
}
