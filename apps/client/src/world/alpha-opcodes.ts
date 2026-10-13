/** Asset conversion utility. */
/**
 * Spread into the `OPCODES` table in `world.ts`. Grouped by system, with the body layout of each
 * packet recorded where it is not obvious from the name.
 */
export const ALPHA_OPCODES = {
  // --- Login/tutorial state and small player-facing feedback packets. ---
  // SendTutorialsData writes exactly eight u32 words (WorldSession.cpp:1109-1114). Fishing
  // failures are empty packets (GameObject.cpp:428/1721); FrameXML supplies the visible strings.
  // Gossip POI is flags, x, y, icon, data, cstring name (GossipDef.cpp:286-292).
  SMSG_TUTORIAL_FLAGS: 0x00fd,
  SMSG_FISH_NOT_HOOKED: 0x01c8,
  SMSG_FISH_ESCAPED: 0x01c9,
  SMSG_GOSSIP_POI: 0x0224,

  // --- Innkeeper hearthstone binding (341/344/437/438/747) ---
  // Build 5875 takes the `> CLIENT_BUILD_1_6_1` branch in Player.cpp:12417-12423: gossip option 5
  // -> SetBindPoint -> SMSG_BINDER_CONFIRM{u64 binderGuid} -> the client confirms with
  // CMSG_BINDER_ACTIVATE{u64 npcGuid} -> SendBindPoint casts spell 3286 -> EffectBind
  // (SpellEffects.cpp:5828) sends SMSG_BINDPOINTUPDATE{f32 x,y,z, u32 mapId, u32 areaId} and
  // SMSG_PLAYERBOUND{u64 binderGuid, u32 areaId}. Older cores bind without the confirm, so
  // BINDPOINTUPDATE must be handled independently of ever having seen a BINDER_CONFIRM.
  SMSG_BINDPOINTUPDATE: 0x0155,
  SMSG_PLAYERBOUND: 0x0158,
  CMSG_BINDER_ACTIVATE: 0x01b5,
  SMSG_PLAYERBINDERROR: 0x01b6,
  SMSG_BINDER_CONFIRM: 0x02eb,

  // --- Talent reset (683). One MSG opcode both ways.
  // Server: u64 trainerGuid + u32 cost (Packets/Skill.cpp:19-23). An EMPTY trainer guid means
  // "you have not spent any talent points" (SkillHandler.cpp:52) and must never be echoed back.
  // Client: echo the u64 trainerGuid to confirm.
  MSG_TALENT_WIPE_CONFIRM: 0x02aa,

  // --- Exploration / zone (500/504/542) ---
  // SMSG_EXPLORATION_EXPERIENCE = u32 areaId + u32 experience (Packets/Misc.cpp:552).
  // CMSG_ZONEUPDATE = u32 newZone (Packets/Misc.cpp:117). SMSG_SET_REST_START = u32 restStateTime.
  CMSG_ZONEUPDATE: 0x01f4,
  SMSG_EXPLORATION_EXPERIENCE: 0x01f8,
  SMSG_SET_REST_START: 0x021e,

  // --- Group utilities ---
  // MSG_RANDOM_ROLL: client sends u32 min + u32 max; server broadcasts u32 min + u32 max +
  // u32 roll + u64 rollerGuid (GroupHandler.cpp:394-411) and rejects max > 10000.
  // MSG_MINIMAP_PING: client sends f32 x + f32 y; server relays u64 guid + f32 x + f32 y.
  MSG_RANDOM_ROLL: 0x01fb,
  MSG_MINIMAP_PING: 0x01d5,

  // --- Guild identity. CMSG carries u32 guildId; the response is u32 id + cstring name +
  // exactly 10 cstring rank names + 5 u32 emblem fields (Packets/Guild.cpp:118-131, and
  // Guild.cpp:868 "show always 10 ranks").
  CMSG_GUILD_QUERY: 0x0054,
  SMSG_GUILD_QUERY_RESPONSE: 0x0055,

  // --- Server-driven notices.
  // SMSG_NOTIFICATION        = bare cstring                   (WorldSession.cpp:911-913)
  // SMSG_SERVER_MESSAGE      = u32 messageType + cstring text (Packets/Misc.cpp:341-345)
  // SMSG_AREA_TRIGGER_MESSAGE= u32 length + cstring           (WorldSession.cpp:894-897)
  SMSG_NOTIFICATION: 0x01cb,
  SMSG_SERVER_MESSAGE: 0x0291,
  SMSG_AREA_TRIGGER_MESSAGE: 0x02b8,

  // --- /played (u32 total + u32 thisLevel seconds), /pvp toggle (empty body toggles).
  CMSG_PLAYED_TIME: 0x01cc,
  SMSG_PLAYED_TIME: 0x01cd,
  CMSG_TOGGLE_PVP: 0x0253,

  // --- Mail arrival. MSG_QUERY_NEXT_MAIL_TIME is polled by the client; SMSG_RECEIVED_MAIL is
  // pushed live and carries u32 notifyDelay (Packets/Mail.cpp:69-72).
  MSG_QUERY_NEXT_MAIL_TIME: 0x0284,
  SMSG_RECEIVED_MAIL: 0x0285,

  // --- Item name only. Request u32 entry; response u32 itemId + cstring name
  // (Packets/Item.cpp:142-146). Vanilla's response carries NO inventoryType.
  CMSG_ITEM_NAME_QUERY: 0x02c4,
  SMSG_ITEM_NAME_QUERY_RESPONSE: 0x02c5,

  // --- Auction house (597-607, 612-613, 653).
  MSG_AUCTION_HELLO: 0x0255,
  CMSG_AUCTION_SELL_ITEM: 0x0256,
  CMSG_AUCTION_REMOVE_ITEM: 0x0257,
  CMSG_AUCTION_LIST_ITEMS: 0x0258,
  CMSG_AUCTION_LIST_OWNER_ITEMS: 0x0259,
  CMSG_AUCTION_PLACE_BID: 0x025a,
  SMSG_AUCTION_COMMAND_RESULT: 0x025b,
  SMSG_AUCTION_LIST_RESULT: 0x025c,
  SMSG_AUCTION_OWNER_LIST_RESULT: 0x025d,
  SMSG_AUCTION_BIDDER_NOTIFICATION: 0x025e,
  SMSG_AUCTION_OWNER_NOTIFICATION: 0x025f,
  CMSG_AUCTION_LIST_BIDDER_ITEMS: 0x0264,
  SMSG_AUCTION_BIDDER_LIST_RESULT: 0x0265,
  SMSG_AUCTION_REMOVED_NOTIFICATION: 0x028d,

  // --- Guild charters / petitions (443-455, 705). The only way to create a guild in 1.12: buy a
  // charter from a UNIT_NPC_FLAG_PETITIONER vendor, collect 9 signatures, turn it in.
  CMSG_PETITION_SHOWLIST: 0x01bb,
  SMSG_PETITION_SHOWLIST: 0x01bc,
  CMSG_PETITION_BUY: 0x01bd,
  CMSG_PETITION_SHOW_SIGNATURES: 0x01be,
  SMSG_PETITION_SHOW_SIGNATURES: 0x01bf,
  CMSG_PETITION_SIGN: 0x01c0,
  SMSG_PETITION_SIGN_RESULTS: 0x01c1,
  MSG_PETITION_DECLINE: 0x01c2,
  CMSG_OFFER_PETITION: 0x01c3,
  CMSG_TURN_IN_PETITION: 0x01c4,
  SMSG_TURN_IN_PETITION_RESULTS: 0x01c5,
  CMSG_PETITION_QUERY: 0x01c6,
  SMSG_PETITION_QUERY_RESPONSE: 0x01c7,
  MSG_PETITION_RENAME: 0x02c1,

  // --- Hunter stable (623-629). MSG_LIST_STABLED_PETS is both the client's request (u64 npcGuid)
  // and the server's listing (NPCHandler.cpp:521-573).
  MSG_LIST_STABLED_PETS: 0x026f,
  CMSG_STABLE_PET: 0x0270,
  CMSG_UNSTABLE_PET: 0x0271,
  CMSG_BUY_STABLE_SLOT: 0x0272,
  SMSG_STABLE_RESULT: 0x0273,
  CMSG_STABLE_SWAP_PET: 0x0275,
} as const;

/**
 * vMaNGOS `NPCFlags`, Objects/UnitDefines.h:654-672. The whole vanilla enum fits in bits 0-14 —
 * the highest flag is REPAIR at 0x4000 — so any constant above 0x7fff came from a later expansion
 * and can never match a bit a 1.12 server sets.
 *
 * This table is the SINGLE source for both `world.ts` and `ui/targeting.ts`. It exists because the
 * two files previously kept private copies and BANKER drifted to the WotLK value 0x00020000 in
 * both, which made the banker interact branch and the banker cursor unreachable dead code. Nothing
 * revealed it, because banker NPCs also carry GOSSIP and fell through to the gossip path.
 */
export const UNIT_NPC_FLAG = {
  GOSSIP: 0x00000001,
  QUESTGIVER: 0x00000002,
  VENDOR: 0x00000004,
  FLIGHTMASTER: 0x00000008,
  TRAINER: 0x00000010,
  SPIRITHEALER: 0x00000020,
  SPIRITGUIDE: 0x00000040,
  INNKEEPER: 0x00000080,
  BANKER: 0x00000100,
  PETITIONER: 0x00000200,
  TABARDDESIGNER: 0x00000400,
  BATTLEMASTER: 0x00000800,
  AUCTIONEER: 0x00001000,
  STABLEMASTER: 0x00002000,
  REPAIR: 0x00004000,
} as const;

/** Highest bit any 1.12 server sets. Anything above this is later-expansion data. */
export const UNIT_NPC_FLAG_CEILING = UNIT_NPC_FLAG.REPAIR;

/**
 * Service NPCs that all fall back to `UI-Cursor-Speak` — vanilla ships no dedicated banker,
 * innkeeper, auctioneer or stable-master cursor art.
 */
export const UNIT_NPC_FLAG_SPEAK = UNIT_NPC_FLAG.GOSSIP | UNIT_NPC_FLAG.QUESTGIVER
  | UNIT_NPC_FLAG.BANKER | UNIT_NPC_FLAG.INNKEEPER | UNIT_NPC_FLAG.AUCTIONEER
  | UNIT_NPC_FLAG.STABLEMASTER | UNIT_NPC_FLAG.PETITIONER | UNIT_NPC_FLAG.TABARDDESIGNER
  | UNIT_NPC_FLAG.BATTLEMASTER;
