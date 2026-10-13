import type { AuthSession, RealmInfo } from './auth';
// Level 1-40 service domains own parsers/builders; this file keeps socket calls and dispatch only.
import { ALPHA_OPCODES, UNIT_NPC_FLAG } from './world/alpha-opcodes';
import { BROWSERPORT_INSTRUMENTATION_ENABLED, emitBrowserPortTrace, observeWorldPacket } from './diagnostics/runtime';
import {
  AUCTION_ACTION_MESSAGES, AUCTION_DURATIONS_MINUTES, AUCTION_ERROR_MESSAGES,
  auctionMinimumBid, auctionTimeLeftLabel, buildAuctionListBidder, buildAuctionListItems,
  buildAuctionListOwner, buildAuctionPlaceBid, buildAuctionRemoveItem, buildAuctionSellItem,
  emptyAuctionPages, readAuctionList,
  type AuctionEntryInfo, type AuctionListPage, type AuctionSearchFilters, type AuctionState,
  type AuctionTab,
} from './world/auction';
import {
  buildPetitionBuy, buildPetitionOffer, buildPetitionQuery, buildPetitionRename, buildPetitionSign,
  PETITION_REQUIRED_SIGNATURES, PETITION_SIGN_MESSAGES, PETITION_TURN_IN_MESSAGES,
  readPetitionShowList, readPetitionSignatures,
  type PetitionCharterOffer, type PetitionState, type PetitionVendorState,
} from './world/guild-charter';
import {
  readStabledPets, STABLE_RESULT_MESSAGES, STABLE_SUCCESS_CODES,
  type StabledPet, type StableState,
} from './world/stable';
import {
  bindSuccessMessage, CONFIRM_TALENT_WIPE, explorationMessage, formatPlayedTime,
  RANDOM_ROLL_MAX, randomRollMessage, readBindPoint, readExploration, readGuildQueryResponse,
  readGossipPoi, readMinimapPing, readRandomRoll, readTutorialFlags,
  type BindPoint, type ExplorationEvent, type GossipPoi, type GuildInfo, type MinimapPingEvent,
} from './world/player-services';
import {
  QUEST_ITEM_OPCODES, QuestItemProtocol, readItemPrototypeRequirements, readItemPrototypeTail, readQuestQueryItems,
  readRewardItems, type ItemPrototypeMetadata, type QuestItemEvent, type QuestQueryItem, type QuestRewardItem,
} from './world/quest-items';
import { NAME_QUERY_OPCODES, NameQueryProtocol } from './world/name-queries';
import { GUILD_RESULT_TEXT, PARTY_RESULT_TEXT, guildEventMessage } from './world/social-feedback';
import { ChannelListResolver, readServiceFeedback, SERVICE_FEEDBACK_OPCODES } from './world/service-feedback';
import { applyRaidTargets, buildRaidConvertRequest, buildRaidSubgroupChange, buildRaidSubgroupSwap, buildRaidTargetListRequest, buildRaidTargetUpdate, buildReadyCheckRequest, buildReadyCheckResponse, emptyRaidTargets, RAID_COORDINATION_OPCODES, raidTargetIndex, readGroupList, readRaidCoordination } from './world/raid-coordination';
import { buildGuildAddRank, buildGuildDeleteRank, buildGuildInfoText, buildGuildNote, buildGuildRankUpdate, GUILD_ADMIN_OPCODES, GUILD_RANK_MAX_COUNT, GUILD_RANK_MIN_COUNT, GUILD_RIGHTS, guildHasRight, readGuildRoster, type GuildRosterMember } from './world/guild-administration';
import { SPIRIT_SERVICE_NPC_FLAGS, WORLD_NOTICE_OPCODES } from './world/world-notices';
import { UnknownOpcodeTelemetry } from './world/unknown-opcode-telemetry';
import { deferredGameObjectServiceMessage, deferredNpcServiceMessage, deferredServicePacketMessage } from './world/deferred-services';
import type { WireCodec } from './world/wire';
import { decodeCompressedMoves, inflateSizedZlib } from './combat/compressed-moves';
import {
  decodeForceSpeedBody,
  decodeObserverModeBody,
  decodeObserverSpeedBody,
  decodeSplineModeBody,
  decodeSplineSpeedBody,
  encodeForceSpeedAckBody,
} from './combat/movement-packets';
import {
  acceptsControlledMoverPacket,
  applyClientControlUpdate,
  decodeClientControlUpdateBody,
  initialControlledMoverState,
  isCurrentControlledMover,
  restorePlayerControl,
  type ControlledMoverState,
} from './combat/controlled-mover';
import { readComboPointState } from './combat/combo-points';
import { decodePeriodicAuraPayload, decodeSpellDelayedPayload } from './combat/spell-log-packets';
import {
  decodePetSpellsBody,
  repriseWithControlHint,
  type PetControlHint,
  type PetSpellLayout,
} from './combat/pet-spells';
import {
  decodeSpellModifierBody,
  SpellModifierTable,
  type SpellModifierKind,
} from './combat/spell-modifiers';
import { inventoryErrorText, showUiError } from './combat/spell-errors';
import {
  encodeDestinationSpellCast,
  encodeSpellCastRequest,
  encodeUseItemRequest,
  primarySpellObjectTarget,
  readServerSpellCastTargets,
  TARGET_FLAG_DEST_LOCATION,
  TARGET_FLAG_UNIT,
  type SpellCastTargets,
  type SpellDestination,
} from './combat/spell-targeting';
import { starterOutfitFor } from './data/char-start-outfits';
import { CHAT_NOTICE, ChannelSlots } from './data/chat-channels';
import { decodeVirtualItems, mainHandMaterial, mainHandSubclass, virtualItemsAsEquipment } from './combat/virtual-items';
import { withoutDisarmedMainHand } from './combat/disarm';
import {
  PLAYER_FIELDS,
  PLAYER_FIELD_LAYOUT_SHIFT,
  STOCK_PLAYER_FIELDS,
} from './data/player-field-layout';
import { isKeyringField, keyringFieldForProtocolSlot } from './data/keyring-layout';
import { buildKeyringBag } from './world/keyring-inventory';
import { decodePetTrainingPoints } from './world/pet-training';
import { isAuraField, parseMonsterMovePacket, parseWorldUpdatePacket, TypeID, WorldEntityStore } from './world-entities';
import { OutboundBackpressure } from './network/outbound-backpressure';
import type { MovementInfo, UnitSpeedKind, WorldEntity as ParsedWorldEntity, WorldEntityChange } from './world-entities';
import type { WorldDelta } from './protocol/world-delta';
import { Simulation } from './simulation/simulation';
import { RenderSnapshotBuffer } from './simulation/render-snapshot';
import type { TransferableRenderSnapshot } from './simulation/worker-protocol';
import { SimulationWorkerProxy } from './platform/simulation-worker-proxy';
import { emitWorldEntityChangeAsDeltas } from './migration/legacy-world-entity-adapter';
import { BoundedPacketQueue, ChunkedReceiveBuffer } from './network/world-socket-buffer';
import { sha1Digest } from './platform/sha1-digest';
const simulationWorkerRequested = () => typeof location !== 'undefined'
  && new URLSearchParams(location.search).get('simulationWorker') === '1';

type Bytes = Uint8Array<ArrayBufferLike>;

export type CharacterInfo = {
  guid: string;
  guidBytes: number[];
  name: string;
  race: number;
  classId: number;
  gender: number;
  skin: number;
  face: number;
  hairStyle: number;
  hairColor: number;
  facialHair: number;
  level: number;
  zone: number;
  map: number;
  x: number;
  y: number;
  z: number;
  guildId?: number;
equipment: {
    displayInfoId: number;
    inventoryType: number;
    sheath?: number;
    slot?: number;
    classId?: number;
    subclass?: number;
    /** ItemPrototype.Material, used by the original client's weapon-impact selector. */
    material?: number;
  }[];
};

export type WorldPosition = {
  map: number;
  x: number;
  y: number;
  z: number;
  o: number;
};

export type WorldTransferEvent =
  | { kind: 'pending'; map: number; transportEntry?: number; oldMap?: number }
  | { kind: 'newWorld'; position: WorldPosition }
  | { kind: 'aborted'; reason: number };


const TRANSFER_ABORT_SILENTLY = 0x04;
const TRANSFER_ABORT_NAMES: Record<number, string> = {
  0x01: 'TRANSFER_ABORT_MAX_PLAYERS',
  0x02: 'TRANSFER_ABORT_NOT_FOUND',
  0x03: 'TRANSFER_ABORT_TOO_MANY_INSTANCES',
  0x04: 'TRANSFER_ABORT_SILENTLY',
  0x05: 'TRANSFER_ABORT_ZONE_IN_COMBAT',
};
const TRANSFER_ABORT_TEXT: Record<number, string> = {
  0x01: 'Transfer aborted: the instance is full.',
  0x02: 'Transfer aborted: the instance was not found.',
  0x03: 'You have entered too many instances recently.',
  0x05: 'Unable to zone in while an encounter is in progress.',
};

export type MirrorTimerEvent =
  | { kind: 'start'; timerType: number; remainingMs: number; durationMs: number; scale: number; paused: boolean; spellId: number }
  | { kind: 'pause'; timerType: number; paused: boolean }
  | { kind: 'stop'; timerType: number };

export type WorldEntity = ParsedWorldEntity;

export type WorldUpdateStats = {
  updatePackets: number;
  compressedUpdatePackets: number;
  compressedMovementPackets: number;
  nestedMovementPackets: number;
  updateBlocks: number;
  movementPackets: number;
  clientMovementPackets: number;
  entities: number;
  entityCreates: number;
  postLoginEntityCreates: number;
  nearTeleportAcks: number;
  entityUpdates: number;
  entityRemoves: number;
  updateParseErrors: number;
  lastOpcode?: string;
  lastClientMove?: {
    moverGuid?: string;
    kind: MoveKind | 'heartbeat' | 'spline_done';
    x: number;
    y: number;
    z: number;
    o: number;
    flags: number;
    sentAt: number;
  };
};

export type WorldEnterResult = WorldPosition & {
  character: CharacterInfo;
  stats: WorldUpdateStats;
};

export type WorldProgress = (message: string) => void;

export type ServerClockDiagnostics = {
  localNow: number;
  serverTimeEstimate: number;
  offsetMs: number;
  rttMs: number;
  hasSync: boolean;
  lastPingId?: number;
  lastPongAt?: number;
  lastMovementStime?: number;
  lastMovementPacketAgeMs?: number;
  predictionClampMs?: number;
};

/**
 * Server time-of-day clock for the day/night cycle. Synced once from SMSG_LOGIN_SETTIMESPEED
 * (vMaNGOS Misc.cpp secsToTimeBitFields + gameSpeedMinutesPerSecond = 1/60, i.e. 1:1 real time),
 * then advanced locally. Exposes the Light.dbc half-minute step (0..2880; 1440 = noon).
 */
class GameTimeClock {
  private baseMinutes = 0; // minutes-of-day at last sync (0..1440)
  private minutesPerRealSecond = 1 / 60; // vanilla default; 60 real s = 1 game minute
  private syncedAt = 0;
  private synced = false;

  sync(packed: number, gameSpeedMinutesPerSecond: number, localNow: number) {
    // Bitfield: min(0-5), hour(6-10), wday(11-13), mday-1(14-19), mon(20-23), year-100(24-31).
    const minute = packed & 0x3f;
    const hour = (packed >>> 6) & 0x1f;
    this.baseMinutes = (hour % 24) * 60 + (minute % 60);
    this.minutesPerRealSecond = gameSpeedMinutesPerSecond > 0 ? gameSpeedMinutesPerSecond : 1 / 60;
    this.syncedAt = localNow;
    this.synced = true;
  }

  /** Live Light.dbc step (0..2880), or null until the first sync packet. */
  halfMinuteStep(localNow: number): number | null {
    if (!this.synced) return null;
    const elapsedSec = Math.max(0, (localNow - this.syncedAt) / 1000);
    const minutes = (this.baseMinutes + elapsedSec * this.minutesPerRealSecond) % 1440;
    return Math.floor((((minutes % 1440) + 1440) % 1440) * 2);
  }
}

class ServerClockSync {
  private rtt = 100;
  private clockOffset = 0;
  private hasSync = false;
  private lastPingId: number | undefined;
  private lastPongAt: number | undefined;
  private lastMovementStime: number | undefined;
  private lastMovementPacketAgeMs: number | undefined;
  private predictionClampMs: number | undefined;

  private static readonly EMA_ALPHA_OFFSET = 0.1;
  private static readonly EMA_ALPHA_RTT = 0.2;
  private static readonly INTERPOLATION_DELAY_MS = 100;
  private static readonly GROUND_PREDICTION_MAX_MS = 600;
  private static readonly AIRBORNE_PREDICTION_MAX_MS = 1500;

  now() {
    return performance.now();
  }

  createPingPayload() {
    const pingId = Math.floor(this.now()) >>> 0;
    this.lastPingId = pingId;
    return concat(u32(pingId), u32(Math.round(this.rtt)));
  }

  handlePong(pingId: number, localReceiptTime = this.now()) {
    const rttSample = localReceiptTime - pingId;
    if (rttSample > 0 && rttSample < 3000) {
      this.rtt = this.rtt * (1 - ServerClockSync.EMA_ALPHA_RTT) + rttSample * ServerClockSync.EMA_ALPHA_RTT;
      this.lastPongAt = localReceiptTime;
    }
  }

  registerServerTimestamp(stime: number, localReceiptTime = this.now()) {
    const latencyOneWay = this.rtt / 2;
    const offsetSample = stime + latencyOneWay - localReceiptTime;
    this.clockOffset = this.hasSync
      ? this.clockOffset * (1 - ServerClockSync.EMA_ALPHA_OFFSET) + offsetSample * ServerClockSync.EMA_ALPHA_OFFSET
      : offsetSample;
    this.hasSync = true;
    this.lastMovementStime = stime;
    this.lastMovementPacketAgeMs = this.estimateServerTime(localReceiptTime) - stime;
  }

  estimateServerTime(localNow = this.now()) {
    return localNow + this.clockOffset;
  }

  calculatePredictionAge(stime: number, localNow = this.now(), airborne = false) {
    if (!this.hasSync) return undefined;
    const maxAge = airborne ? ServerClockSync.AIRBORNE_PREDICTION_MAX_MS : ServerClockSync.GROUND_PREDICTION_MAX_MS;
    const age = this.estimateServerTime(localNow) - stime - ServerClockSync.INTERPOLATION_DELAY_MS;
    const clamped = Math.min(maxAge, Math.max(0, age));
    this.predictionClampMs = clamped;
    return clamped;
  }

  diagnostics(localNow = this.now(), packetStime?: number, airborne = false): ServerClockDiagnostics {
    const serverTimeEstimate = this.estimateServerTime(localNow);
    return {
      localNow,
      serverTimeEstimate,
      offsetMs: this.clockOffset,
      rttMs: this.rtt,
      hasSync: this.hasSync,
      lastPingId: this.lastPingId,
      lastPongAt: this.lastPongAt,
      lastMovementStime: this.lastMovementStime,
      lastMovementPacketAgeMs: packetStime !== undefined ? serverTimeEstimate - packetStime : this.lastMovementPacketAgeMs,
      predictionClampMs: packetStime !== undefined ? this.calculatePredictionAge(packetStime, localNow, airborne) : this.predictionClampMs,
    };
  }
}

export type CharCreateParams = {
  name: string;
  race: number;
  classId: number;
  gender: number;
  skin: number;
  face: number;
  hairStyle: number;
  hairColor: number;
  facialHair: number;
};

const OPCODES = {
  CMSG_CHAR_CREATE: 0x0036,
  CMSG_CHAR_DELETE: 0x0038,
  CMSG_AUTH_SESSION: 0x01ed,
  CMSG_CHAR_ENUM: 0x0037,
  CMSG_PING: 0x01dc,
  SMSG_PONG: 0x01dd,
  CMSG_PLAYER_LOGIN: 0x003d,
  SMSG_NEW_WORLD: 0x003e,
  SMSG_TRANSFER_PENDING: 0x003f,
  // Opcodes_1_12_1.h:67 (64). Player::SendTransferAborted (Player.cpp:19330) with reasons from
  // Player.h:560-564. Both CanPlayerEnter and Map::CanEnter run BEFORE TRANSFER_PENDING is sent
  // (Player.cpp:2000/2012 vs 2065), so an abort never leaves a half-torn-down pending state — the
  // packet was simply dropped, and clicking an instance portal did nothing visible.
  SMSG_TRANSFER_ABORTED: 0x0040,
  CMSG_SET_ACTIVE_MOVER: 0x026a,
  SMSG_CLIENT_CONTROL_UPDATE: 0x0159,
  SMSG_SET_FLAT_SPELL_MODIFIER: 0x0266,
  SMSG_SET_PCT_SPELL_MODIFIER: 0x0267,
  SMSG_PVP_CREDIT: 0x028c,
  SMSG_SET_FORCED_REACTIONS: 0x02a5,
  MSG_MOVE_START_FORWARD: 0x00b5,
  MSG_MOVE_START_BACKWARD: 0x00b6,
  MSG_MOVE_STOP: 0x00b7,
  MSG_MOVE_START_STRAFE_LEFT: 0x00b8,
  MSG_MOVE_START_STRAFE_RIGHT: 0x00b9,
  MSG_MOVE_STOP_STRAFE: 0x00ba,
  MSG_MOVE_JUMP: 0x00bb,
  MSG_MOVE_START_TURN_LEFT: 0x00bc,
  MSG_MOVE_START_TURN_RIGHT: 0x00bd,
  MSG_MOVE_STOP_TURN: 0x00be,
  MSG_MOVE_SET_RUN_MODE: 0x00c2,
  MSG_MOVE_SET_WALK_MODE: 0x00c3,
  MSG_MOVE_SET_RUN_SPEED: 0x00cd,
  MSG_MOVE_SET_RUN_BACK_SPEED: 0x00cf,
  MSG_MOVE_SET_WALK_SPEED: 0x00d1,
  MSG_MOVE_SET_SWIM_SPEED: 0x00d3,
  MSG_MOVE_SET_SWIM_BACK_SPEED: 0x00d5,
  MSG_MOVE_SET_TURN_RATE: 0x00d8,
  MSG_MOVE_FALL_LAND: 0x00c9,
  MSG_MOVE_SET_FACING: 0x00da,
  MSG_MOVE_WORLDPORT_ACK: 0x00dc,
  MSG_MOVE_TELEPORT_ACK: 0x00c7,
  // Opcodes_1_12_1.h:200 (197). The OBSERVER broadcast of a same-map teleport —
  // MovementPacketSender::SendTeleportToObservers, sent to everyone but the mover, who instead
  // gets MSG_MOVE_TELEPORT_ACK above. Fired by Unit::NearTeleportTo (Unit.cpp:10063/10065) for
  // creatures and Player::ExecuteTeleportNear (MovementHandler.cpp:252/255) for players, so
  // without it a remote Blink or a boss reposition leaves the unit standing at its old spot until
  // the next heartbeat or monster-move corrects it.
  MSG_MOVE_TELEPORT: 0x00c5,
  /** Observer lag-compensation relay: packed mover GUID + uint32 skipped milliseconds. */
  MSG_MOVE_TIME_SKIPPED: 0x0319,
  SMSG_TRIGGER_CINEMATIC: 0x00fa,
  CMSG_COMPLETE_CINEMATIC: 0x00fc,
  MSG_MOVE_HEARTBEAT: 0x00ee,
  // Server-authoritative speed changes (mounts, buffs, dazes). 1.12.1 build 5875
  // numbers verified vs vMaNGOS Opcodes_1_12_1.h; SMSG carries packed guid + u32
  // movement counter + f32 new speed, the CMSG ack echoes u64 guid + counter +
  // MovementInfo + speed (vMaNGOS MoveSpeedAck::ReadFromWorldPacket).
  SMSG_FORCE_RUN_SPEED_CHANGE: 0x00e2,
  CMSG_FORCE_RUN_SPEED_CHANGE_ACK: 0x00e3,
  SMSG_FORCE_RUN_BACK_SPEED_CHANGE: 0x00e4,
  CMSG_FORCE_RUN_BACK_SPEED_CHANGE_ACK: 0x00e5,
  SMSG_FORCE_SWIM_SPEED_CHANGE: 0x00e6,
  CMSG_FORCE_SWIM_SPEED_CHANGE_ACK: 0x00e7,
  SMSG_FORCE_WALK_SPEED_CHANGE: 0x02da,
  CMSG_FORCE_WALK_SPEED_CHANGE_ACK: 0x02db,
  SMSG_FORCE_SWIM_BACK_SPEED_CHANGE: 0x02dc,
  CMSG_FORCE_SWIM_BACK_SPEED_CHANGE_ACK: 0x02dd,
  SMSG_FORCE_TURN_RATE_CHANGE: 0x02de,
  CMSG_FORCE_TURN_RATE_CHANGE_ACK: 0x02df,
  SMSG_MONSTER_MOVE: 0x00dd,
  SMSG_MONSTER_MOVE_TRANSPORT: 0x02ae,
  // Opcodes_1_12_1.h:714 (713 / 0x02c9). The client must acknowledge the newest player-owned
  // server spline or vMaNGOS keeps HasPendingSplineDone set and discards later MSG_MOVE_* input.
  CMSG_MOVE_SPLINE_DONE: 0x02c9,
  SMSG_AUTH_CHALLENGE: 0x01ec,
  SMSG_AUTH_RESPONSE: 0x01ee,
  SMSG_CHAR_CREATE: 0x003a,
  SMSG_CHAR_DELETE: 0x003c,
  SMSG_CHAR_ENUM: 0x003b,
  SMSG_CHARACTER_LOGIN_FAILED: 0x0041,
  CMSG_PLAYER_LOGOUT: 0x004a,
  CMSG_LOGOUT_REQUEST: 0x004b,
  // Opcodes_1_12_1.h:79-82. CMSG_LOGOUT_REQUEST is answered with SMSG_LOGOUT_RESPONSE
  // (u32 reason, u8 instant); when it is not instant the server sits the player down, roots them,
  // and finalises 20s later with SMSG_LOGOUT_COMPLETE. CMSG_LOGOUT_CANCEL aborts that window and
  // is answered with SMSG_LOGOUT_CANCEL_ACK. All three server packets have empty bodies except
  // LOGOUT_RESPONSE.
  SMSG_LOGOUT_RESPONSE: 0x004c,
  SMSG_LOGOUT_COMPLETE: 0x004d,
  CMSG_LOGOUT_CANCEL: 0x004e,
  SMSG_LOGOUT_CANCEL_ACK: 0x004f,
  SMSG_LOGIN_SETTIMESPEED: 0x0042, // server time-of-day + game speed, sent on enter-world
  SMSG_START_MIRROR_TIMER: 0x01d9,
  SMSG_PAUSE_MIRROR_TIMER: 0x01da,
  SMSG_STOP_MIRROR_TIMER: 0x01db,
  // Root/unroot handshake (vMaNGOS Opcodes_1_12_1.h 232-235). The server roots a corpse and
  // un-roots a ghost via SetRooted, and DEFERS the graveyard teleport until the client acks —
  // RepopAtGraveyard only runs when !HasPendingMovementChange() (Player::Update). Without the ack
  // the pending change lingers and the release-to-graveyard teleport is delayed ~seconds.
  SMSG_FORCE_MOVE_ROOT: 0x00e8,
  CMSG_FORCE_MOVE_ROOT_ACK: 0x00e9,
  SMSG_FORCE_MOVE_UNROOT: 0x00ea,
  CMSG_FORCE_MOVE_UNROOT_ACK: 0x00eb,
  // Knockback (SPELL_EFFECT_KNOCK_BACK = 98; 133 spells in Build 5875's Spell.dbc, including
  // War Stomp, Knock Away, Wing Flap and Uppercut). Same pending-change/ack handshake as root:
  // MovementPacketSender::SendKnockBackToController pushes a PlayerMovementPendingChange and the
  // server only re-broadcasts the arc once we ack, so an un-acked knockback both freezes us in
  // place visually and blocks every later movement change. Opcodes_1_12_1.h:242-244.
  SMSG_MOVE_KNOCK_BACK: 0x00ef,
  CMSG_MOVE_KNOCK_BACK_ACK: 0x00f0,
  MSG_MOVE_KNOCK_BACK: 0x00f1,
  // Movement-flag toggles (same pending-change/ack mechanism as root). ApplyGhostForm also calls
  // SetWaterWalking(true), so an un-acked water-walk equally stalls RepopAtGraveyard. Ack opcodes:
  // vMaNGOS Opcodes_1_12_1.h 222/223/242-246, 719/720.
  SMSG_MOVE_WATER_WALK: 0x00de,
  SMSG_MOVE_LAND_WALK: 0x00df,
  CMSG_MOVE_WATER_WALK_ACK: 0x02d0,
  SMSG_MOVE_FEATHER_FALL: 0x00f2,
  SMSG_MOVE_NORMAL_FALL: 0x00f3,
  CMSG_MOVE_FEATHER_FALL_ACK: 0x02cf,
  SMSG_MOVE_SET_HOVER: 0x00f4,
  SMSG_MOVE_UNSET_HOVER: 0x00f5,
  CMSG_MOVE_HOVER_ACK: 0x00f6,
  MSG_MOVE_HOVER: 0x00f7,
  MSG_MOVE_ROOT: 0x00ec,
  MSG_MOVE_UNROOT: 0x00ed,
  MSG_MOVE_FEATHER_FALL: 0x02b0,
  MSG_MOVE_WATER_WALK: 0x02b1,
  SMSG_SPLINE_SET_RUN_SPEED: 0x02fe,
  SMSG_SPLINE_SET_RUN_BACK_SPEED: 0x02ff,
  SMSG_SPLINE_SET_SWIM_SPEED: 0x0300,
  SMSG_SPLINE_SET_WALK_SPEED: 0x0301,
  SMSG_SPLINE_SET_SWIM_BACK_SPEED: 0x0302,
  SMSG_SPLINE_SET_TURN_RATE: 0x0303,
  SMSG_SPLINE_MOVE_UNROOT: 0x0304,
  SMSG_SPLINE_MOVE_FEATHER_FALL: 0x0305,
  SMSG_SPLINE_MOVE_NORMAL_FALL: 0x0306,
  SMSG_SPLINE_MOVE_SET_HOVER: 0x0307,
  SMSG_SPLINE_MOVE_UNSET_HOVER: 0x0308,
  SMSG_SPLINE_MOVE_WATER_WALK: 0x0309,
  SMSG_SPLINE_MOVE_LAND_WALK: 0x030a,
  SMSG_SPLINE_MOVE_SET_RUN_MODE: 0x030d,
  SMSG_SPLINE_MOVE_SET_WALK_MODE: 0x030e,
  SMSG_SPLINE_MOVE_ROOT: 0x031a,
  CMSG_SPIRIT_HEALER_ACTIVATE: 0x021c,
  SMSG_SPIRIT_HEALER_CONFIRM: 0x0222,
  // Vanilla 1.12 death / corpse pipeline, verified against vMaNGOS 5875.
  CMSG_REPOP_REQUEST: 0x015a,
  SMSG_RESURRECT_REQUEST: 0x015b,
  CMSG_RESURRECT_RESPONSE: 0x015c,
  CMSG_RECLAIM_CORPSE: 0x01d2,
  SMSG_ENVIRONMENTALDAMAGELOG: 0x01fc,
  MSG_CORPSE_QUERY: 0x0216,
  SMSG_RESURRECT_FAILED: 0x0252,
  SMSG_CORPSE_RECLAIM_DELAY: 0x0269,
  CMSG_MESSAGECHAT: 0x0095,
  SMSG_MESSAGECHAT: 0x0096,
  // Chat channels. Decimal 151/152/153 in vMaNGOS Opcodes_1_12_1.h:154-156, i.e. the three
  // slots directly after CMSG/SMSG_MESSAGECHAT. Bodies from Server/Packets/Channel.cpp:3-12
  // and 94-98: join = cstring name + cstring password, leave = cstring name, notify = u8 type
  // + cstring name (plus per-notice trailers this client does not need).
  CMSG_JOIN_CHANNEL: 0x0097,
  CMSG_LEAVE_CHANNEL: 0x0098,
  SMSG_CHANNEL_NOTIFY: 0x0099,
  SMSG_EMOTE: 0x0103, // u32 Emotes.dbc id + u64 unit guid (vmangos EmoteNotify)
  SMSG_TEXT_EMOTE: 0x0105,
  CMSG_TEXT_EMOTE: 0x0104,
  SMSG_ITEM_COOLDOWN: 0x00b0,
  SMSG_GAMEOBJECT_CUSTOM_ANIM: 0x00b3,
  SMSG_SET_PROFICIENCY: 0x0127,
  SMSG_MOUNTSPECIAL_ANIM: 0x0172,
  SMSG_ENCHANTMENTLOG: 0x01d7,
  SMSG_ITEM_TIME_UPDATE: 0x01ea,
  SMSG_ITEM_ENCHANT_TIME_UPDATE: 0x01eb,
  SMSG_GAMEOBJECT_SPAWN_ANIM: 0x0214,
  SMSG_ZONE_UNDER_ATTACK: 0x0254,
  SMSG_STANDSTATE_UPDATE: 0x029d,
  SMSG_GAMEOBJECT_RESET_STATE: 0x02a7,
  SMSG_PLAYER_SKINNED: 0x02bc,
  SMSG_DURABILITY_DAMAGE_DEATH: 0x02bd,
  SMSG_AREA_SPIRIT_HEALER_TIME: 0x02e4,
  ...WORLD_NOTICE_OPCODES,
  SMSG_INVALIDATE_PLAYER: 0x031c,
  CMSG_AREATRIGGER: 0x00b4,
  CMSG_GAMEOBJ_USE: 0x00b1,
  SMSG_LOGIN_VERIFY_WORLD: 0x0236,
  SMSG_UPDATE_OBJECT: 0x00a9,
  SMSG_DESTROY_OBJECT: 0x00aa,
  SMSG_COMPRESSED_UPDATE_OBJECT: 0x01f6,
  SMSG_COMPRESSED_MOVES: 0x02fb,
  SMSG_GAMEOBJECT_DESPAWN_ANIM: 0x0215,
  CMSG_NAME_QUERY: 0x0050,
  SMSG_NAME_QUERY_RESPONSE: 0x0051,
  CMSG_WHO: 0x0062,
  SMSG_WHO: 0x0063,
  CMSG_FRIEND_LIST: 0x0066,
  SMSG_FRIEND_LIST: 0x0067,
  SMSG_FRIEND_STATUS: 0x0068,
  CMSG_ADD_FRIEND: 0x0069,
  CMSG_DEL_FRIEND: 0x006a,
  SMSG_IGNORE_LIST: 0x006b,
  CMSG_ADD_IGNORE: 0x006c,
  CMSG_DEL_IGNORE: 0x006d,
  // Party/raid. Values from vMaNGOS Opcodes_1_12_1.h:113-130 (decimal 110..127). Bodies verified
  // against WorldPackets::Group in Server/Packets/Group.h; the three NullClientPacket handlers
  // (accept/decline/disband) take an EMPTY body, not a guid.
  CMSG_GROUP_INVITE: 0x006e,
  SMSG_GROUP_INVITE: 0x006f,
  CMSG_GROUP_ACCEPT: 0x0072,
  CMSG_GROUP_DECLINE: 0x0073,
  CMSG_GROUP_UNINVITE: 0x0075,
  CMSG_GROUP_UNINVITE_GUID: 0x0076,
  CMSG_GROUP_SET_LEADER: 0x0078,
  CMSG_LOOT_METHOD: 0x007a,
  // Leaving a party and disbanding it are the SAME opcode: HandleGroupDisbandOpcode just calls
  // RemoveFromGroup() on the sender (GroupHandler.cpp:318-334).
  CMSG_GROUP_DISBAND: 0x007b,
  ...RAID_COORDINATION_OPCODES, ...SERVICE_FEEDBACK_OPCODES, ...GUILD_ADMIN_OPCODES,
  SMSG_GROUP_LIST: 0x007d,
  // Out-of-range party member vitals. vMaNGOS Group::UpdatePlayerOutOfRange pushes
  // SMSG_PARTY_MEMBER_STATS (126) automatically for members not in the viewer's visible list; the
  // _FULL variant (754) is the same body, sent on request/join. CMSG_REQUEST (639) forces a refresh.
  SMSG_PARTY_MEMBER_STATS: 0x007e,
  CMSG_REQUEST_PARTY_MEMBER_STATS: 0x027f,
  SMSG_PARTY_MEMBER_STATS_FULL: 0x02f2,
  SMSG_PARTY_COMMAND_RESULT: 0x007f,
  // Guild management. vMaNGOS Opcodes_1_12_1.h:132-150 (decimal 129..147). Invite/promote/demote/
  // remove/motd all carry a single cstring; accept/decline/leave are NullClientPacket (empty).
  CMSG_GUILD_INVITE: 0x0082,
  SMSG_GUILD_INVITE: 0x0083,
  CMSG_GUILD_ACCEPT: 0x0084,
  CMSG_GUILD_DECLINE: 0x0085,
  CMSG_GUILD_ROSTER: 0x0089,
  SMSG_GUILD_ROSTER: 0x008a,
  CMSG_GUILD_PROMOTE: 0x008b,
  CMSG_GUILD_DEMOTE: 0x008c,
  CMSG_GUILD_LEAVE: 0x008d,
  CMSG_GUILD_REMOVE: 0x008e,
  CMSG_GUILD_MOTD: 0x0091,
  SMSG_GUILD_EVENT: 0x0092,
  SMSG_GUILD_COMMAND_RESULT: 0x0093,
  CMSG_ITEM_QUERY_SINGLE: 0x0056,
  SMSG_ITEM_QUERY_SINGLE_RESPONSE: 0x0058,
  CMSG_PET_NAME_QUERY: 0x0052,
  SMSG_PET_NAME_QUERY_RESPONSE: 0x0053,
  // Combat / targeting / spells (verified vs vmangos Opcodes_1_12_1.h)
  CMSG_SET_ACTION_BUTTON: 0x0128,
  SMSG_ACTION_BUTTONS: 0x0129,
  SMSG_INITIAL_SPELLS: 0x012a,
  SMSG_LEARNED_SPELL: 0x012b,
  SMSG_SUPERCEDED_SPELL: 0x012c,
  SMSG_REMOVED_SPELL: 0x0203,
  CMSG_LEARN_TALENT: 0x0251,
  SMSG_LOG_XPGAIN: 0x01d0,
  SMSG_LEVELUP_INFO: 0x01d4,
  CMSG_CAST_SPELL: 0x012e,
  CMSG_CANCEL_CAST: 0x012f,
  SMSG_CAST_RESULT: 0x0130,
  SMSG_SPELL_START: 0x0131,
  SMSG_SPELL_GO: 0x0132,
  SMSG_SPELL_FAILURE: 0x0133,
  SMSG_PET_CAST_FAILED: 0x0138,
  SMSG_PET_TAME_FAILURE: 0x0173,
  // vMaNGOS Opcodes_1_12_1.h:500,504 — both carry { ObjectGuid, uint32 SpellVisualKit.dbc id }
  // (Server/Packets/Spell.cpp:54-65). Channelled spells pulse PLAY_SPELL_VISUAL every tick
  // (Spells/Spell.cpp:4219) and eating/drinking is delivered only this way (Objects/Player.cpp:2281).
  SMSG_PLAY_SPELL_VISUAL: 0x01f3,
  SMSG_PARTYKILLLOG: 0x01f5,
  SMSG_PLAY_SPELL_IMPACT: 0x01f7,
  SMSG_SPELL_COOLDOWN: 0x0134,
  SMSG_COOLDOWN_EVENT: 0x0135,
  CMSG_CANCEL_AURA: 0x0136,
  SMSG_UPDATE_AURA_DURATION: 0x0137,
  MSG_CHANNEL_START: 0x0139,
  MSG_CHANNEL_UPDATE: 0x013a,
  CMSG_CANCEL_CHANNELLING: 0x013b,
  SMSG_AI_REACTION: 0x013c,
  CMSG_SET_SELECTION: 0x013d,
  CMSG_ATTACKSWING: 0x0141,
  CMSG_ATTACKSTOP: 0x0142,
  CMSG_SETSHEATHED: 0x01e0,
  SMSG_ATTACKSTART: 0x0143,
  SMSG_ATTACKSTOP: 0x0144,
  SMSG_ATTACKSWING_NOTINRANGE: 0x0145,
  SMSG_ATTACKSWING_BADFACING: 0x0146,
  SMSG_ATTACKSWING_NOTSTANDING: 0x0147,
  SMSG_ATTACKSWING_DEADTARGET: 0x0148,
  SMSG_ATTACKSWING_CANT_ATTACK: 0x0149,
  SMSG_ATTACKERSTATEUPDATE: 0x014a,
  SMSG_CANCEL_COMBAT: 0x014e,
  SMSG_SPELLHEALLOG: 0x0150,
  SMSG_SPELLENERGIZELOG: 0x0151,
  CMSG_AUTOSTORE_LOOT_ITEM: 0x0108,
  CMSG_USE_ITEM: 0x00ab, // 171 — verified vs vmangos Opcodes_1_12_1.h
  CMSG_AUTOEQUIP_ITEM: 0x010a, // 266 — verified vs vmangos Opcodes_1_12_1.h
  CMSG_AUTOSTORE_BAG_ITEM: 0x010b,
  CMSG_SWAP_ITEM: 0x010c,
  CMSG_SWAP_INV_ITEM: 0x010d,
  CMSG_SPLIT_ITEM: 0x010e,
  CMSG_AUTOEQUIP_ITEM_SLOT: 0x010f,
  CMSG_DESTROYITEM: 0x0111,
  SMSG_INITIALIZE_FACTIONS: 0x0122,
  SMSG_SET_FACTION_VISIBLE: 0x0123,
  SMSG_SET_FACTION_STANDING: 0x0124,
  CMSG_SET_FACTION_ATWAR: 0x0125,
  CMSG_SET_ACTIONBAR_TOGGLES: 0x02bf,
  CMSG_SET_AMMO: 0x0268,
  CMSG_AUTOSTORE_BANK_ITEM: 0x0282,
  CMSG_AUTOBANK_ITEM: 0x0283,
  CMSG_LOOT: 0x015d,
  CMSG_LOOT_MONEY: 0x015e,
  CMSG_LOOT_RELEASE: 0x015f,
  SMSG_LOOT_RESPONSE: 0x0160,
  SMSG_LOOT_RELEASE_RESPONSE: 0x0161,
  SMSG_LOOT_REMOVED: 0x0162,
  SMSG_LOOT_MONEY_NOTIFY: 0x0163,
  SMSG_LOOT_CLEAR_MONEY: 0x0165,
  SMSG_ITEM_PUSH_RESULT: 0x0166,
  SMSG_INVENTORY_CHANGE_FAILURE: 0x0112, // 274 — server rejects an equip/move; carries InventoryResult reason
  CMSG_GOSSIP_HELLO: 0x017b,
  CMSG_GOSSIP_SELECT_OPTION: 0x017c,
  SMSG_GOSSIP_MESSAGE: 0x017d,
  SMSG_GOSSIP_COMPLETE: 0x017e,
  CMSG_NPC_TEXT_QUERY: 0x017f,
  SMSG_NPC_TEXT_UPDATE: 0x0180,
  SMSG_SHOWTAXINODES: 0x01a9,
  CMSG_TAXIQUERYAVAILABLENODES: 0x01ac,
  CMSG_ACTIVATETAXI: 0x01ad,
  SMSG_ACTIVATETAXIREPLY: 0x01ae,
  CMSG_PET_SET_ACTION: 0x0174,
  CMSG_PET_ACTION: 0x0175,
  CMSG_PET_ABANDON: 0x0176,
  CMSG_PET_RENAME: 0x0177,
  SMSG_PET_NAME_INVALID: 0x0178,
  SMSG_PET_SPELLS: 0x0179,
  SMSG_PET_MODE: 0x017a,
  CMSG_QUESTGIVER_STATUS_QUERY: 0x0182,
  SMSG_QUESTGIVER_STATUS: 0x0183,
  CMSG_QUESTGIVER_HELLO: 0x0184,
  SMSG_QUESTGIVER_QUEST_LIST: 0x0185,
  CMSG_QUESTGIVER_QUERY_QUEST: 0x0186,
  SMSG_QUESTGIVER_QUEST_DETAILS: 0x0188,
  CMSG_QUESTGIVER_ACCEPT_QUEST: 0x0189,
  CMSG_QUESTGIVER_COMPLETE_QUEST: 0x018a,
  SMSG_QUESTGIVER_REQUEST_ITEMS: 0x018b,
  CMSG_QUESTGIVER_REQUEST_REWARD: 0x018c,
  SMSG_QUESTGIVER_OFFER_REWARD: 0x018d,
  CMSG_QUESTGIVER_CHOOSE_REWARD: 0x018e,
  SMSG_QUESTGIVER_QUEST_INVALID: 0x018f,
  CMSG_QUESTGIVER_CANCEL: 0x0190,
  SMSG_QUESTGIVER_QUEST_COMPLETE: 0x0191,
  SMSG_QUESTGIVER_QUEST_FAILED: 0x0192,
  CMSG_QUEST_QUERY: 0x005c,
  SMSG_QUEST_QUERY_RESPONSE: 0x005d,
  CMSG_QUESTLOG_SWAP_QUEST: 0x0193,
  CMSG_QUESTLOG_REMOVE_QUEST: 0x0194,
  SMSG_QUESTLOG_FULL: 0x0195,
  SMSG_QUESTUPDATE_FAILED: 0x0196,
  SMSG_QUESTUPDATE_FAILEDTIMER: 0x0197,
  SMSG_QUESTUPDATE_COMPLETE: 0x0198,
  SMSG_QUESTUPDATE_ADD_KILL: 0x0199,
  SMSG_QUESTUPDATE_ADD_ITEM: 0x019a,
  CMSG_LIST_INVENTORY: 0x019e,
  SMSG_LIST_INVENTORY: 0x019f,
  CMSG_SELL_ITEM: 0x01a0,
  CMSG_BUYBACK_ITEM: 0x0290, // 656 — Opcodes_1_12_1.h:657
  CMSG_REPAIR_ITEM: 0x02a8, // 680 — Opcodes_1_12_1.h:681
  // Duels. Initiated by casting spell 7266 "Duel" on a player (SPELL_EFFECT_DUEL); there is no
  // CMSG_DUEL_REQUEST. Accept/cancel carry the duel-flag GUID. Opcodes_1_12_1.h:360-366, 696.
  SMSG_DUEL_REQUESTED: 0x0167,
  SMSG_DUEL_OUTOFBOUNDS: 0x0168,
  SMSG_DUEL_INBOUNDS: 0x0169,
  SMSG_DUEL_COMPLETE: 0x016a,
  SMSG_DUEL_WINNER: 0x016b,
  CMSG_DUEL_ACCEPTED: 0x016c,
  CMSG_DUEL_CANCELLED: 0x016d,
  SMSG_DUEL_COUNTDOWN: 0x02b7,
  // Inspect. CMSG carries the target guid; SMSG_INSPECT (277) is just a guid ACK — equipment comes
  // from the target's VISIBLE_ITEM update fields, NOT this packet, and there is NO talent data in
  // 1.12 (added later). Opcodes_1_12_1.h:279-280.
  CMSG_INSPECT: 0x0114,
  SMSG_INSPECT: 0x0115,
  SMSG_SELL_ITEM: 0x01a1,
  CMSG_BUY_ITEM: 0x01a2,
  SMSG_BUY_ITEM: 0x01a4,
  SMSG_BUY_FAILED: 0x01a5,
  CMSG_TRAINER_LIST: 0x01b0,
  SMSG_TRAINER_LIST: 0x01b1,
  CMSG_TRAINER_BUY_SPELL: 0x01b2,
  SMSG_TRAINER_BUY_SUCCEEDED: 0x01b3,
  SMSG_TRAINER_BUY_FAILED: 0x01b4,
  CMSG_BANKER_ACTIVATE: 0x01b7,
  SMSG_SHOW_BANK: 0x01b8,
  CMSG_BUY_BANK_SLOT: 0x01b9,
  SMSG_BUY_BANK_SLOT_RESULT: 0x01ba,
  CMSG_INITIATE_TRADE: 0x0116,
  CMSG_BEGIN_TRADE: 0x0117,
  CMSG_ACCEPT_TRADE: 0x011a,
  CMSG_UNACCEPT_TRADE: 0x011b,
  CMSG_CANCEL_TRADE: 0x011c,
  CMSG_SET_TRADE_ITEM: 0x011d,
  CMSG_CLEAR_TRADE_ITEM: 0x011e,
  CMSG_SET_TRADE_GOLD: 0x011f,
  SMSG_TRADE_STATUS: 0x0120,
  SMSG_TRADE_STATUS_EXTENDED: 0x0121,
  CMSG_SEND_MAIL: 0x0238,
  SMSG_SEND_MAIL_RESULT: 0x0239,
  CMSG_GET_MAIL_LIST: 0x023a,
  SMSG_MAIL_LIST_RESULT: 0x023b,
  CMSG_ITEM_TEXT_QUERY: 0x0243,
  SMSG_ITEM_TEXT_QUERY_RESPONSE: 0x0244,
  CMSG_MAIL_TAKE_MONEY: 0x0245,
  CMSG_MAIL_TAKE_ITEM: 0x0246,
  CMSG_MAIL_MARK_AS_READ: 0x0247,
  CMSG_MAIL_RETURN_TO_SENDER: 0x0248,
  CMSG_MAIL_DELETE: 0x0249,
  SMSG_SPELL_DELAYED: 0x01e2,
  SMSG_CLEAR_COOLDOWN: 0x01de,
  SMSG_SPELLLOGMISS: 0x024b,
  SMSG_SPELLLOGEXECUTE: 0x024c,
  SMSG_PERIODICAURALOG: 0x024e,
  SMSG_SPELLDAMAGESHIELD: 0x024f, // vMaNGOS Opcodes_1_12_1.h:592 (591)
  SMSG_SPELLNONMELEEDAMAGELOG: 0x0250,
  SMSG_PROCRESIST: 0x0260,
  SMSG_DISPEL_FAILED: 0x0262,
  SMSG_SPELLORDAMAGE_IMMUNE: 0x0263,
  SMSG_SPELLDISPELLOG: 0x027b,
  CMSG_PET_CANCEL_AURA: 0x026b,
  CMSG_CANCEL_AUTO_REPEAT_SPELL: 0x026d,
  SMSG_CANCEL_AUTO_REPEAT: 0x029c,
  SMSG_PET_BROKEN: 0x02af,
  SMSG_PET_ACTION_FEEDBACK: 0x02c6,
  SMSG_SPELL_FAILED_OTHER: 0x02a6,
  SMSG_FEIGN_DEATH_RESISTED: 0x02b4,
  SMSG_SPELLINSTAKILLLOG: 0x032f,
  SMSG_SPELL_UPDATE_CHAIN_TARGETS: 0x0330,
  SMSG_LOOT_ALL_PASSED: 0x029e,
  SMSG_LOOT_ROLL_WON: 0x029f,
  CMSG_LOOT_ROLL: 0x02a0,
  SMSG_LOOT_START_ROLL: 0x02a1,
  SMSG_LOOT_ROLL: 0x02a2,
  CMSG_LOOT_MASTER_GIVE: 0x02a3,
  SMSG_LOOT_MASTER_LIST: 0x02a4,
  SMSG_INIT_WORLD_STATES: 0x02c2,
  SMSG_UPDATE_WORLD_STATE: 0x02c3,
  CMSG_PET_SPELL_AUTOCAST: 0x02f3,
  SMSG_WEATHER: 0x02f4,
  SMSG_PLAY_MUSIC: 0x0277,
  SMSG_PLAY_OBJECT_SOUND: 0x0278,
  SMSG_PLAY_SOUND: 0x02d2,
  SMSG_PET_ACTION_SOUND: 0x0324,
  SMSG_SET_FACTION_ATWAR: 0x0313,
  CMSG_SET_FACTION_INACTIVE: 0x0317,
  CMSG_SET_WATCHED_FACTION: 0x0318,
  CMSG_PET_CAST_SPELL: 0x01f0,
  // Level 1-40 service systems (auction, stable, charters, bind, respec, exploration, social).
  // Kept in world/alpha-opcodes.ts so adding a service does not grow this file — AGENTS.md L1.
  ...ALPHA_OPCODES,
  ...QUEST_ITEM_OPCODES,
  ...NAME_QUERY_OPCODES,
} as const;

const AUTH_OK = 12;
const ADDON_DATA_EMPTY = new Uint8Array(4);
const text = new TextEncoder();
const latin1 = new TextDecoder('latin1');

function concat(...parts: Bytes[]): Uint8Array {
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function sha1(...parts: Bytes[]): Promise<Uint8Array> {
  return sha1Digest(...parts);
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = value & 0xff;
  out[1] = (value >>> 8) & 0xff;
  out[2] = (value >>> 16) & 0xff;
  out[3] = (value >>> 24) & 0xff;
  return out;
}

function f32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setFloat32(0, value, true);
  return out;
}

function cstring(value: string): Uint8Array {
  return concat(text.encode(value), new Uint8Array(1));
}

function randomU32(): number {
  const data = new Uint32Array(1);
  crypto.getRandomValues(data);
  return data[0] >>> 0;
}

function guidHex(bytes: Bytes): string {
  return Array.from(bytes)
    .reverse()
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Inverse of guidHex: big-endian hex string -> little-endian u64 wire bytes. */
export function guidHexToBytes(guid: string): Uint8Array {
  const out = new Uint8Array(8);
  const hex = guid.padStart(16, '0');
  for (let i = 0; i < 8; i++) out[7 - i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Packed guid (mask byte + non-zero bytes) — the client-side writer. */
function packGuid(guid: string): Uint8Array {
  const bytes = guidHexToBytes(guid);
  const out: number[] = [0];
  for (let i = 0; i < 8; i++) {
    if (bytes[i]) {
      out[0] |= 1 << i;
      out.push(bytes[i]);
    }
  }
  return new Uint8Array(out);
}

function guidFromU32Pair(low = 0, high = 0): string | undefined {
  if (!low && !high) return undefined;
  const bytes = new Uint8Array(8);
  bytes[0] = low & 0xff;
  bytes[1] = (low >>> 8) & 0xff;
  bytes[2] = (low >>> 16) & 0xff;
  bytes[3] = (low >>> 24) & 0xff;
  bytes[4] = high & 0xff;
  bytes[5] = (high >>> 8) & 0xff;
  bytes[6] = (high >>> 16) & 0xff;
  bytes[7] = (high >>> 24) & 0xff;
  return guidHex(bytes);
}

function guidField(fields: Map<number, number>, index: number): string | undefined {
  return guidFromU32Pair(fields.get(index) ?? 0, fields.get(index + 1) ?? 0);
}

function u16(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

/** One action-bar slot from SMSG_ACTION_BUTTONS (packed u32 = action | type<<24). */
export type ActionButton = { action: number; type: number } | null;

export type ItemSpellInfo = {
  spellId: number;
  trigger: number;
  charges: number;
  cooldown: number;
  category: number;
  categoryCooldown: number;
};

export type AuraSlot = {
  slot: number;
  spellId: number;
  flags: number;
  level: number;
  charges: number;
  durationMs?: number;
  timeRemainingMs?: number;
};

export type ItemInfo = ItemPrototypeMetadata & {
  entry: number;
  classId: number;
  subclass: number;
  /** ItemPrototype.Material; the client resolves its flag through Material.dbc for impact audio. */
  material: number;
  name: string;
  displayInfoId: number;
  quality: number;
  flags: number;
  buyPrice: number;
  sellPrice: number;
  inventoryType: number;
  itemLevel: number;
  requiredLevel: number;
  maxCount: number;
  stackable: number;
  containerSlots: number;
  description?: string;
  /** Root PageText.dbc id; non-zero items open the native ItemTextFrame via CMSG_READ_ITEM. */
  pageText?: number;
  languageId?: number;
  /** PageTextMaterial.dbc id (1 parchment, 2 stone, 3 marble, 4 silver, 5 bronze). */
  pageMaterial?: number;
  /** Quest id offered by this item when it is right-clicked. */
  startQuest?: number;
  lockId?: number;
  /** ItemPrototype.Sheath / Vanilla SheathTypes (0..7), used to choose the exact M2 stow attachment. */
  sheath: number;
  /** ItemPrototype.Armor (resistance index 0 on the wire). */
  armor: number;
  /** Up to 5 weapon damage entries; type is the spell school (0 = physical). Zero-max entries omitted. */
  damage: { min: number; max: number; type: number }[];
  /** Up to 10 stat entries; type is ITEM_MOD_* (0=Mana,1=Health,3=Agi,4=Str,5=Int,6=Spirit,7=Stam). Zero-value entries omitted. */
  stats: { type: number; value: number }[];
  /** Magic resistances in wire order: [Holy, Fire, Nature, Frost, Shadow, Arcane]. */
  resistances: number[];
  /** Weapon swing time in milliseconds (ItemPrototype.Delay). */
  delay: number;
  spells: ItemSpellInfo[];
  onUseSpellSlot?: number;
};

export type InventoryItem = {
  guid: string;
  typeId?: TypeID;
  entry?: number;
  count: number;
  durability?: number;
  maxDurability?: number;
  durationSeconds?: number;
  enchantments?: Array<{ enchantId: number; durationSeconds?: number }>;
  info?: ItemInfo;
};

export type InventorySlot = {
  container: 'equipment' | 'backpack' | 'bag' | 'keyring';
  index: number;
  protocolBag: number;
  protocolSlot: number;
  label: string;
  itemGuid?: string;
  item?: InventoryItem;
};

export type InventoryBag = {
  index: number;
  protocolBag: number;
  label: string;
  isBackpack: boolean; isKeyring?: boolean;
  itemGuid?: string;
  item?: InventoryItem;
  size: number;
  slots: InventorySlot[];
};

export type InventorySnapshot = {
  equipment: InventorySlot[];
  bags: InventoryBag[];
  keyring: InventoryBag; money: number;
};

export type BankItem = { entry: number; count: number; displayInfoId?: number; guid?: string };
export type BankState = {
  guid: string;
  slots: Array<BankItem | undefined>;
  bags: Array<BankItem | undefined>;
  purchasedBagSlots: number;
  nextSlotCost: number;
  playerMoney: number;
};

export type TradeItem = { entry: number; count: number; displayInfoId?: number };
export type TradeState = {
  partnerGuid?: string;
  playerMoney: number;
  targetMoney: number;
  playerItems: Array<TradeItem | undefined>;
  targetItems: Array<TradeItem | undefined>;
  playerAccepted: boolean;
  targetAccepted: boolean;
};

export type MailMessage = {
  id: number;
  messageType: number;
  senderGuid?: string;
  senderEntry?: number;
  subject: string;
  itemTextId: number;
  stationery: number;
  itemEntry: number;
  itemCount: number;
  money: number;
  cod: number;
  checked: number;
  daysLeft: number;
  body?: string;
};

export type MailState = { mailboxGuid: string; messages: MailMessage[]; result?: { action: number; error: number } };

export type InventoryDebugItem = {
  guid?: string;
  present?: boolean;
  typeId?: number;
  entry?: number;
  name?: string;
};

export type InventoryDebugBag =
  | { equippedSlot: number; protocolBag: number; equipped: false }
  | {
      equippedSlot: number;
      protocolBag: number;
      equipped: true;
      bagGuid: string;
      containerEntityPresent: boolean;
      typeId?: number;
      entry?: number;
      name?: string;
      numSlotsField?: number;
      containerSlotsFromTemplate?: number;
      contents?: (InventoryDebugItem & { slotIndex: number })[];
    };

export type InventoryDebugSnapshot = {
  playerGuid?: string;
  playerEntityPresent: boolean;
  money?: {
    field: number;
    authoritative?: number;
    fallback?: number;
    rendered: number;
  };
  equipment: (InventoryDebugItem & { slot: number })[];
  backpack: (InventoryDebugItem & { slot: number })[];
  bags: InventoryDebugBag[];
  warnings: string[];
};

export type SkillLine = {
  slot: number;
  skillId: number;
  step: number;
  value: number;
  max: number;
  tempBonus: number;
  permBonus: number;
};

export type SkillSnapshot = {
  skills: SkillLine[];
};

export type SocialFriend = { guid: string; status: number; area: number; level: number; classId: number };
export type WhoEntry = { name: string; guild: string; level: number; classId: number; race: number; zoneId: number };
export type GuildMember = GuildRosterMember;
export type GroupMember = { guid: string; name: string; online: boolean; subgroup: number; assistant: boolean };

/** Vitals for a party member who is out of visibility range (no live WorldEntity). From
 *  SMSG_PARTY_MEMBER_STATS. HP/power are u16 on the wire, which comfortably covers vanilla values. */
export type PartyVitals = {
  online: boolean;
  health: number;
  maxHealth: number;
  power: number;
  maxPower: number;
  powerType: number;
  level: number;
};

/** SMSG_GROUP_INVITE: someone asked us to join their party. Body is just their name. */
export type PartyInviteEvent = { inviterName: string };

/**
 * SMSG_PARTY_COMMAND_RESULT — the server's answer to an invite/leave attempt.
 * `operation` is PartyOperation (0 = invite, 2 = leave) and `result` is PartyResult,
 * both from vMaNGOS WorldSession.h:94-113. Result 0 is success and is not an error.
 */
export type PartyCommandResultEvent = { operation: number; memberName: string; result: number; message: string };

export const PARTY_OP = { INVITE: 0, LEAVE: 2 } as const;

/** SMSG_GUILD_INVITE: inviter + guild name, for the GUILD_INVITE popup. */
export type GuildInviteEvent = { inviterName: string; guildName: string };

/** SMSG_GUILD_COMMAND_RESULT. `result` is CommandErrors (Guild.h:93). */
export type GuildCommandResultEvent = { command: number; str: string; result: number; message: string };

/** A guild event worth showing in chat (join/leave/promote/motd). */
export type GuildEventNotice = { event: number; message: string };

/** Spell 7266 "Duel" — casting it on a player is how a duel is initiated (SPELL_EFFECT_DUEL). */
export const DUEL_SPELL_ID = 7266;

/** SMSG_DUEL_REQUESTED: someone challenged us. `challengerGuid` resolves to their name. */
export type DuelRequestEvent = { challengerGuid: string };

/** SMSG_INSPECT ack: the server allows us to inspect this player. Open the inspect frame. */
export type InspectEvent = { guid: string };

/** A duel state line for the UI: countdown tick, winner announce, bounds warning, or clear. */
export type DuelNotice =
  | { kind: 'countdown'; seconds: number }
  | { kind: 'winner'; message: string }
  | { kind: 'outOfBounds' }
  | { kind: 'inBounds' }
  | { kind: 'complete'; started: boolean };

export type SocialSnapshot = {
  friends: SocialFriend[]; ignored: string[]; who: WhoEntry[]; whoOnline: number;
  guild: GuildMember[]; guildMotd: string; guildInfoText: string; guildRankRights: number[]; guildName: string; guildRankNames: string[]; groupType: number; group: GroupMember[];
  groupLeaderGuid?: string; ownSubgroup?: number; ownAssistant?: boolean; lootMethod?: number; looterGuid?: string; lootThreshold?: number; raidTargets: Array<string | undefined>;
};

export type HonorSnapshot = {
  highestRank: number;
  rankProgress: number;
  sessionHonorableKills: number;
  sessionDishonorableKills: number;
  yesterdayHonorableKills: number;
  yesterdayDishonorableKills: number;
  lastWeekHonorableKills: number;
  lastWeekDishonorableKills: number;
  thisWeekHonorableKills: number;
  thisWeekDishonorableKills: number;
  thisWeekContribution: number;
  lifetimeHonorableKills: number;
  lifetimeDishonorableKills: number;
  yesterdayContribution: number;
  lastWeekContribution: number;
  lastWeekRank: number;
};

export type ExploredZonesSnapshot = {
  bits: number[];
};

export type ReputationState = {
  reputationListId: number;
  flags: number;
  standing: number;
  visible: boolean;
  atWar: boolean;
  hidden: boolean;
  forcedInvisible: boolean;
  peaceForced: boolean;
  inactive: boolean;
  watched: boolean;
  rank: number;
  rankName: string;
  rankMin: number;
  rankMax: number;
  valueInRank: number;
  pointsInRank: number;
};

export type ReputationSnapshot = {
  watchedFactionIndex: number;
  factions: ReputationState[];
};

export type PetActionButton = {
  slot: number;
  packed: number;
  action: number;
  activeState: number;
};

export type PetSpellCooldown = {
  spellId: number;
  category: number;
  spellCooldownMs: number;
  categoryCooldownMs: number;
  categoryCooldownRaw: number;
  permanentCategoryCooldown: boolean;
};

export type PetSpellState = {
  layout: PetSpellLayout;
  guid: string;
  durationMs: number;
  reactState?: number;
  commandState?: number;
  flag1?: number;
  enabledFlags?: number;
  possessionControlWord?: number;
  actions: PetActionButton[];
  spells: PetActionButton[];
  cooldowns: PetSpellCooldown[];
  /** Raw wire header, kept so the layout can be re-derived when late control flags arrive. */
  headerWord: number;
};

export type PetSnapshot = {
  entry?: number; petFamily?: number; trainingPoints?: number; guid?: string;
  name?: string;
  petNumber?: number;
  nameTimestamp?: number;
  ownerGuid?: string;
  level?: number;
  health?: number;
  maxHealth?: number;
  happiness?: number;
  maxHappiness?: number;
  happinessLevel?: 1 | 2 | 3;
  loyalty?: number;
  loyaltyName?: string;
  experience?: number;
  nextLevelExperience?: number;
  spellState?: PetSpellState;
};

export type LootItem = {
  slot: number;
  entry: number;
  count: number;
  displayInfoId: number;
  randomPropertyId: number;
  slotType: number;
};

export type LootState = {
  guid: string;
  lootType: number;
  money: number;
  items: LootItem[];
  error?: number;
};

export type LootRollEvent =
  | { kind: 'start'; lootGuid: string; itemSlot: number; itemEntry: number; randomSuffix: number; randomPropertyId: number; countdownMs: number }
  | { kind: 'vote'; lootGuid: string; itemSlot: number; rollerGuid: string; itemEntry: number; rollNumber: number; rollType: number }
  | { kind: 'won'; lootGuid: string; itemSlot: number; itemEntry: number; winnerGuid: string; rollNumber: number; rollType: number }
  | { kind: 'allPassed'; lootGuid: string; itemSlot: number; itemEntry: number };

export type GossipOption = {
  index: number;
  icon: number;
  coded: boolean;
  text: string;
};

export type GossipQuest = {
  questId: number;
  icon: number;
  level: number;
  title: string;
};

export type GossipState = {
  guid: string;
  textId: number;
  /** Resolved SMSG_NPC_TEXT_UPDATE body for this gossip text id. */
  text?: string;
  options: GossipOption[];
  quests: GossipQuest[];
};

export type QuestListState = {
  guid: string;
  greeting: string;
  emoteDelay: number;
  emote: number;
  quests: GossipQuest[];
};

export type QuestDetailsState = {
  guid: string;
  questId: number;
  title: string;
  details: string;
  objectives: string;
  autoFinish: boolean;
  choiceRewards: QuestRewardItem[];
  rewards: QuestRewardItem[];
  money: number;
  rewardSpell: number;
  /** Quest details pushed by another player, rather than opened from an NPC/GO/item. */
  shared?: boolean;
};

export type QuestRequestItemsState = {
  guid: string;
  questId: number;
  title: string;
  text: string;
  requiredMoney: number;
  requiredItems: QuestRewardItem[];
  complete: boolean;
};

export type QuestOfferRewardState = {
  guid: string;
  questId: number;
  title: string;
  text: string;
  choiceRewards: QuestRewardItem[];
  rewards: QuestRewardItem[];
  money: number;
  questFlags: number;
  rewardSpell: number;
};

export type QuestObjective = {
  creatureOrGoId: number;
  isGameObject: boolean;
  creatureOrGoCount: number;
  itemId: number;
  itemCount: number;
  text: string;
};

export type QuestInfo = {
  questId: number;
  method: number;
  level: number;
  zoneOrSort: number;
  type: number;
  repObjectiveFaction: number;
  repObjectiveValue: number;
  requiredOppositeRepFaction: number;
  requiredOppositeRepValue: number;
  nextQuestInChain: number;
  rewardOrRequiredMoney: number;
  rewardMoneyMaxLevel: number;
  rewardSpell: number;
  sourceItemId: number;
  questFlags: number;
  rewards: QuestQueryItem[];
  choiceRewards: QuestQueryItem[];
  pointMapId: number;
  pointX: number;
  pointY: number;
  pointOpt: number;
  title: string;
  objectives: string;
  details: string;
  endText: string;
  requiredObjectives: QuestObjective[];
};

export type QuestLogEntry = {
  slot: number;
  questId: number;
  countState: number;
  objectiveCounts: [number, number, number, number];
  state: number;
  complete: boolean;
  failed: boolean;
  timer: number;
  info?: QuestInfo;
};

export type QuestLogSnapshot = {
  capacity: number;
  entries: QuestLogEntry[];
};

export type QuestProgressEvent =
  | { kind: 'questComplete'; questId: number }
  | { kind: 'questFailed'; questId: number; timer: boolean }
  | { kind: 'questLogFull' }
  | { kind: 'questAddItem'; itemId: number; count: number }
  | { kind: 'questAddKill'; questId: number; entry: number; count: number; required: number; guid: string };

export type VendorItem = {
  vendorSlot: number;
  entry: number;
  displayInfoId: number;
  stock: number;
  price: number;
  maxDurability: number;
  buyCount: number;
};

export type VendorState = {
  guid: string;
  items: VendorItem[];
  error?: number;
  /** Whether this NPC also carries UNIT_NPC_FLAG_REPAIR (0x4000) — an armorer, not just a vendor. */
  canRepair?: boolean;
};

/** One slot of vendor buyback. `slot` is the absolute inventory slot the protocol expects. */
export type BuybackItem = {
  slot: number;
  guid: string;
  entry: number;
  count: number;
  price: number;
  soldAt: number;
};

export type TrainerSpell = {
  spellId: number;
  state: number;
  cost: number;
  primaryProfessionConfirm: boolean;
  primaryProfessionAllowed: boolean;
  requiredLevel: number;
  requiredSkill: number;
  requiredSkillValue: number;
  requiredSpell1: number;
  requiredSpell2: number;
};

export type TrainerState = {
  guid: string;
  trainerType: number;
  spells: TrainerSpell[];
  title: string;
};

export type InteractionEvent =
  | { kind: 'loot'; state: LootState }
  | { kind: 'lootClose'; guid?: string }
  | { kind: 'gossip'; state: GossipState }
  | { kind: 'gossipClose' }
  | { kind: 'questList'; state: QuestListState }
  | { kind: 'questDetails'; state: QuestDetailsState }
  | { kind: 'questRequestItems'; state: QuestRequestItemsState }
  | { kind: 'questOfferReward'; state: QuestOfferRewardState }
  | { kind: 'questMessage'; message: string; questId?: number; reason?: number }
  | QuestItemEvent
  | { kind: 'vendor'; state: VendorState }
  | { kind: 'vendorMessage'; message: string; reason?: number }
  | { kind: 'trainer'; state: TrainerState }
  | { kind: 'trainerMessage'; message: string; spellId?: number; reason?: number }
  | { kind: 'taxi'; state: TaxiState }
  | { kind: 'taxiReply'; code: number; message: string }
  | { kind: 'itemPush'; itemEntry: number; message: string }
  | { kind: 'bank'; state: BankState }
  | { kind: 'bankMessage'; message: string; reason?: number }
  | { kind: 'tradeRequest'; guid: string }
  | { kind: 'trade'; state: TradeState }
  | { kind: 'tradeClose'; message?: string }
  | { kind: 'mail'; state: MailState }
  | { kind: 'masterLootList'; eligibleGuids: string[] }
  | { kind: 'binderConfirm'; guid: string }
  | { kind: 'bindPointUpdate'; areaId: number; mapId: number }
  | { kind: 'talentWipeConfirm'; guid: string; cost: number }
  | { kind: 'petUnlearnConfirm'; petGuid: string; cost: number } | { kind: 'openContainer'; itemGuid: string }
  | { kind: 'readyCheckRequest' } | { kind: 'readyCheckResponse'; guid: string; ready: boolean }
  | { kind: 'uiError'; message: string }
  | { kind: 'gossipPoi'; poi: GossipPoi }
  | { kind: 'auction'; state: AuctionState }
  | { kind: 'auctionMessage'; message: string; action?: number; error?: number }
  | { kind: 'stable'; state: StableState }
  | { kind: 'stableMessage'; result: number; message: string }
  | { kind: 'petitionVendor'; state: PetitionVendorState }
  | { kind: 'petition'; state: PetitionState }
  | { kind: 'petitionMessage'; message: string; result?: number };

export type TaxiState = {
  guid: string;
  currentNode: number;
  /**
   * SMSG_SHOWTAXINODES known-node bitmask (8 u32 words), stored exactly as sent.
   * Bit index is `nodeId - 1`, NOT the node id: vMaNGOS PlayerTaxi.h writes node N at
   * word (N-1)/32, bit (N-1)%32. Consumers must subtract 1 before indexing.
   */
  knownMask: number[];
};

type ItemPushResult = {
  playerGuid: string;
  received: boolean;
  created: boolean;
  showInChat: boolean;
  bagSlot: number;
  itemEntry: number;
  suffixFactor: number;
  randomPropertyId: number;
};

// ActivateTaxiReplies in vMaNGOS Player.h is the Build-5875 wire order. The text is copied from
// the matching ERR_TAXI* constants in the extracted 1.12.1 GlobalStrings.lua.
const TAXI_REPLY_MESSAGES: Readonly<Record<number, string>> = {
  1: 'UNSPECIFIED TAXI SERVER ERROR',
  2: "There is no direct path to that destination!",
  3: "You don't have enough money!",
  4: 'You are too far away from the taxi stand!',
  5: 'There is no taxi vendor nearby!',
  6: "You haven't reached that taxi node on foot yet!",
  7: "You are busy and can't use the taxi service now.",
  8: 'You are already mounted! Dismount first.',
  9: "You can't take a taxi while disguised!",
  10: 'You are moving.',
  11: 'You are already there!',
  12: 'You need to be standing to go anywhere.',
};

// Re-exported so UI panels keep importing service types from '../world' and do not need to know
// which domain module each one lives in.
export {
  auctionMinimumBid, auctionTimeLeftLabel,
  type AuctionEntryInfo, type AuctionListPage, type AuctionSearchFilters, type AuctionState,
  type AuctionTab,
} from './world/auction';
export type { StabledPet, StableState } from './world/stable';
export type { PetitionCharterOffer, PetitionState, PetitionVendorState } from './world/guild-charter';
export type { ExplorationEvent, MinimapPingEvent } from './world/player-services';

export type ChatEvent = {
  type: number;
  language: number;
  senderGuid?: string;
  targetGuid?: string;
  senderName?: string;
  channelName?: string;
  message: string;
  chatTag: number;
};

/**
 * SMSG_CHANNEL_NOTIFY. `slot` is the client's own 1-based channel number after the notice was
 * applied (0 when the channel is not joined) — vanilla renders it in `"[%d. %s]: "`.
 */
export type ChannelNotifyEvent = {
  notice: number;
  channelName: string;
  slot: number;
};

export type WeatherEvent = {
  type: number;
  grade: number;
  soundId: number;
  instant: boolean;
};

export type WorldSoundEvent =
  | { kind: 'music'; soundId: number }
  | { kind: 'sound'; soundId: number; sourceGuid?: string };

/**
 * SMSG_TRIGGER_CINEMATIC. `cinematicId` indexes CinematicSequences.dbc.
 *
 * A listener returns true to claim playback; it MUST then call `complete()` when the flythrough
 * ends or the player skips it, because vMaNGOS keeps the player frozen until CMSG_COMPLETE_CINEMATIC
 * arrives. If no listener claims it the client acks immediately, preserving the old behaviour.
 */
export type CinematicEvent = {
  cinematicId: number;
  complete: () => void;
};

/**
 * SMSG_LOGOUT_RESPONSE — `u32 reason, u8 instant` (vMaNGOS Packets/Misc.cpp:272-276).
 *
 * reason 0 = accepted, 1 = in combat, 3 = jumping or falling (MiscHandler.cpp:290-296).
 * `instant` is set when the player is resting, on a taxi, or a GM with instant logout configured;
 * otherwise the server sits them down, roots them, and logs them out 20 seconds later
 * (WorldSession.h:282-285 `currTime >= m_logoutTime + 20`).
 */
export type LogoutResponseEvent = {
  reason: number;
  instant: boolean;
};

const CHAT_MSG = {
  SAY: 0x00,
  PARTY: 0x01,
  YELL: 0x05,
  WHISPER: 0x06,
  WHISPER_INFORM: 0x07,
  EMOTE: 0x08,
  TEXT_EMOTE: 0x09,
  SYSTEM: 0x0a,
  MONSTER_SAY: 0x0b,
  MONSTER_YELL: 0x0c,
  MONSTER_EMOTE: 0x0d,
  CHANNEL: 0x0e,
  AFK: 0x14,
  DND: 0x15,
  MONSTER_WHISPER: 0x1a,
  RAID_BOSS_WHISPER: 0x59,
  RAID_BOSS_EMOTE: 0x5a,
} as const;

const LANG = {
  UNIVERSAL: 0,
  ORCISH: 1,
  COMMON: 7,
} as const;

const ALLIANCE_RACES = new Set([1, 3, 4, 7]);

// InventoryResult (vMaNGOS ItemDefines.h) as seen by a 1.12.1 client: every
// SUPPORTED_CLIENT_BUILD > 1_8_4/1_5_1/1_6_1/1_10_2 entry is active for build
// 5875, so the codes are contiguous from 0. Used to decode
// SMSG_INVENTORY_CHANGE_FAILURE so a rejected equip/move is no longer silent.
const INVENTORY_RESULT_NAMES: Record<number, string> = {
  0: 'OK',
  1: 'CANT_EQUIP_LEVEL_I',
  2: 'CANT_EQUIP_SKILL',
  3: 'ITEM_DOESNT_GO_TO_SLOT',
  4: 'BAG_FULL',
  5: 'NONEMPTY_BAG_OVER_OTHER_BAG',
  6: 'CANT_TRADE_EQUIP_BAGS',
  7: 'ONLY_AMMO_CAN_GO_HERE',
  8: 'NO_REQUIRED_PROFICIENCY',
  9: 'NO_EQUIPMENT_SLOT_AVAILABLE',
  10: 'YOU_CAN_NEVER_USE_THAT_ITEM',
  11: 'YOU_CAN_NEVER_USE_THAT_ITEM2',
  12: 'NO_EQUIPMENT_SLOT_AVAILABLE2',
  13: 'CANT_EQUIP_WITH_TWOHANDED',
  14: 'CANT_DUAL_WIELD',
  15: 'ITEM_DOESNT_GO_INTO_BAG',
  16: 'ITEM_DOESNT_GO_INTO_BAG2',
  17: 'CANT_CARRY_MORE_OF_THIS',
  18: 'NO_EQUIPMENT_SLOT_AVAILABLE3',
  19: 'ITEM_CANT_STACK',
  20: 'ITEM_CANT_BE_EQUIPPED',
  21: 'ITEMS_CANT_BE_SWAPPED',
  22: 'SLOT_IS_EMPTY',
  23: 'ITEM_NOT_FOUND',
  24: 'CANT_DROP_SOULBOUND',
  25: 'OUT_OF_RANGE',
  26: 'TRIED_TO_SPLIT_MORE_THAN_COUNT',
  27: 'COULDNT_SPLIT_ITEMS',
  28: 'MISSING_REAGENT',
  29: 'NOT_ENOUGH_MONEY',
  30: 'NOT_A_BAG',
  31: 'CAN_ONLY_DO_WITH_EMPTY_BAGS',
  32: 'DONT_OWN_THAT_ITEM',
  33: 'CAN_EQUIP_ONLY1_QUIVER',
  34: 'MUST_PURCHASE_THAT_BAG_SLOT',
  35: 'TOO_FAR_AWAY_FROM_BANK',
  36: 'ITEM_LOCKED',
  37: 'YOU_ARE_STUNNED',
  38: 'YOU_ARE_DEAD',
  39: 'CANT_DO_RIGHT_NOW',
  40: 'INT_BAG_ERROR',
  41: 'CAN_EQUIP_ONLY1_BOLT',
  42: 'CAN_EQUIP_ONLY1_AMMOPOUCH',
  43: 'STACKABLE_CANT_BE_WRAPPED',
  44: 'EQUIPPED_CANT_BE_WRAPPED',
  45: 'WRAPPED_CANT_BE_WRAPPED',
  46: 'BOUND_CANT_BE_WRAPPED',
  47: 'UNIQUE_CANT_BE_WRAPPED',
  48: 'BAGS_CANT_BE_WRAPPED',
  49: 'ALREADY_LOOTED',
  50: 'INVENTORY_FULL',
  51: 'BANK_FULL',
  52: 'ITEM_IS_CURRENTLY_SOLD_OUT',
  53: 'BAG_FULL3',
  54: 'ITEM_NOT_FOUND2',
  55: 'ITEM_CANT_STACK2',
  56: 'BAG_FULL4',
  57: 'ITEM_SOLD_OUT',
  58: 'OBJECT_IS_BUSY',
  59: 'NONE',
  60: 'NOT_IN_COMBAT',
  61: 'NOT_WHILE_DISARMED',
  62: 'BAG_FULL6',
  63: 'CANT_EQUIP_RANK',
  64: 'CANT_EQUIP_REPUTATION',
  65: 'TOO_MANY_SPECIAL_BAGS',
  66: 'LOOT_CANT_LOOT_THAT_NOW',
};

function inventoryResultName(code: number): string {
  return INVENTORY_RESULT_NAMES[code] ?? `UNKNOWN_${code}`;
}

// Vanilla 1.12.1 inventory fields, verified against vMaNGOS runtime metadata
// Objects/UpdateFields_1_12_1.cpp and Bag.cpp. Note: the generated .h comments
// for CONTAINER_FIELD_* say 0x02A/0x02C, but the enum expression uses
// ITEM_END (=0x30), and the .cpp table confirms the real absolute fields below.
const OBJECT_FIELD_ENTRY = 0x03;
const ITEM_FIELD_STACK_COUNT = 0x0e;
const ITEM_FIELD_DURABILITY = 0x2e;
const ITEM_FIELD_MAXDURABILITY = 0x2f;
const CONTAINER_FIELD_NUM_SLOTS = 0x30;
const CONTAINER_FIELD_SLOT_1 = 0x32;
// Player update-field indices all resolve through data/player-field-layout.ts. The +6 there is
// OBJECT_END, which every PLAYER_* comment in UpdateFields_1_12_1.h omits — it is NOT a realm
// insertion. Nothing here may hardcode a comment literal as a field index.
const PLAYER_FIELD_INV_SLOT_HEAD = PLAYER_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD;
const PLAYER_FIELD_PACK_SLOT_1 = PLAYER_FIELDS.PLAYER_FIELD_PACK_SLOT_1;
const PLAYER_FIELD_BANK_SLOT_1 = PLAYER_FIELDS.PLAYER_FIELD_BANK_SLOT_1;
const PLAYER_FIELD_BANKBAG_SLOT_1 = PLAYER_FIELDS.PLAYER_FIELD_BANKBAG_SLOT_1;
// Buyback: 12 slots of sold-back goods the vendor holds for you until you leave or overflow it.
// Stock 1.12.1 indices are VENDORBUYBACK_SLOT_1 0x26A (24 fields = 12 GUIDs), BUYBACK_PRICE_1
// 0x4C4 and BUYBACK_TIMESTAMP_1 0x4D0 (UpdateFields_1_12_1.h:248, 286, 287).
const PLAYER_FIELD_VENDORBUYBACK_SLOT_1 = PLAYER_FIELDS.PLAYER_FIELD_VENDORBUYBACK_SLOT_1;
const PLAYER_FIELD_BUYBACK_PRICE_1 = PLAYER_FIELDS.PLAYER_FIELD_BUYBACK_PRICE_1;
const PLAYER_FIELD_BUYBACK_TIMESTAMP_1 = PLAYER_FIELDS.PLAYER_FIELD_BUYBACK_TIMESTAMP_1;
// Absolute inventory slots, not a 0-based index: vMaNGOS GetItemFromBuyBackSlot rejects anything
// outside [69, 81) and CMSG_BUYBACK_ITEM carries this raw slot number on the wire.
const BUYBACK_SLOT_START = 69;
const BUYBACK_SLOT_END = 81;
const BUYBACK_SLOT_COUNT = BUYBACK_SLOT_END - BUYBACK_SLOT_START;
const PLAYER_BYTES_2 = PLAYER_FIELDS.PLAYER_BYTES_2;
// Keep inventory server-authoritative until prediction can be matched to each
// specific vMaNGOS response. The previous optimistic descriptor writes could
// briefly or permanently show the same GUID in two slots when several bag moves
// and rejection packets arrived close together.
const ENABLE_INVENTORY_OPTIMISTIC_PREDICTION = false;
const PLAYER_QUEST_LOG_1_1 = PLAYER_FIELDS.PLAYER_QUEST_LOG_1_1;
const PLAYER_SKILL_INFO_1_1 = PLAYER_FIELDS.PLAYER_SKILL_INFO_1_1;
const PLAYER_EXPLORED_ZONES_1 = PLAYER_FIELDS.PLAYER_EXPLORED_ZONES_1;
const PLAYER_EXPLORED_ZONES_COUNT = 64;
const PLAYER_FIELD_COINAGE = PLAYER_FIELDS.PLAYER_FIELD_COINAGE;
// Tracking bitmasks. vMaNGOS SpellAuras HandleAuraTrackCreatures sets bit (1 << (creatureType-1))
// in PLAYER_TRACK_CREATURES; the real client reads this same owner-only field to decide which
// creatures get a yellow minimap dot. Stock 1.12.1 index 0x44A/0x44B (UpdateFields_1_12_1.h:257-258).
const PLAYER_TRACK_CREATURES = PLAYER_FIELDS.PLAYER_TRACK_CREATURES;
const PLAYER_TRACK_RESOURCES = PLAYER_FIELDS.PLAYER_TRACK_RESOURCES;
// Combo points ride in PLAYER_FIELD_BYTES byte 1 (vMaNGOS Player.cpp:19161
// `SetByteValue(PLAYER_FIELD_BYTES, PLAYER_FIELD_BYTES_OFFSET_COMBO_POINTS, ...)`,
// offset enum at Player.h:361; commented 0x4C0 in UpdateFields_1_12_1.h:282, compiles to 0x4C6).
// The same field's byte 3 carries the honor rank, so both readers share one resolved index; there
// is deliberately no comment-offset fallback, because the commented 0x4C0 is the compiled index of
// PLAYER_FIELD_BUYBACK_PRICE_3. `__wowComboDebug()` still dumps that alias for QA.
const PLAYER_FIELD_BYTES = PLAYER_FIELDS.PLAYER_FIELD_BYTES;
const STOCK_PLAYER_FIELD_BYTES_ALIAS = STOCK_PLAYER_FIELDS.PLAYER_FIELD_BYTES;
const PLAYER_FIELD_SESSION_KILLS = PLAYER_FIELDS.PLAYER_FIELD_SESSION_KILLS;
const PLAYER_FIELD_YESTERDAY_KILLS = PLAYER_FIELDS.PLAYER_FIELD_YESTERDAY_KILLS;
const PLAYER_FIELD_LAST_WEEK_KILLS = PLAYER_FIELDS.PLAYER_FIELD_LAST_WEEK_KILLS;
const PLAYER_FIELD_THIS_WEEK_KILLS = PLAYER_FIELDS.PLAYER_FIELD_THIS_WEEK_KILLS;
const PLAYER_FIELD_THIS_WEEK_CONTRIBUTION = PLAYER_FIELDS.PLAYER_FIELD_THIS_WEEK_CONTRIBUTION;
const PLAYER_FIELD_LIFETIME_HONORABLE_KILLS = PLAYER_FIELDS.PLAYER_FIELD_LIFETIME_HONORABLE_KILLS;
const PLAYER_FIELD_LIFETIME_DISHONORABLE_KILLS = PLAYER_FIELDS.PLAYER_FIELD_LIFETIME_DISHONORABLE_KILLS;
const PLAYER_FIELD_YESTERDAY_CONTRIBUTION = PLAYER_FIELDS.PLAYER_FIELD_YESTERDAY_CONTRIBUTION;
const PLAYER_FIELD_LAST_WEEK_CONTRIBUTION = PLAYER_FIELDS.PLAYER_FIELD_LAST_WEEK_CONTRIBUTION;
const PLAYER_FIELD_LAST_WEEK_RANK = PLAYER_FIELDS.PLAYER_FIELD_LAST_WEEK_RANK;
const PLAYER_FIELD_BYTES2 = PLAYER_FIELDS.PLAYER_FIELD_BYTES2;
const EQUIPMENT_SLOT_COUNT = 19;
const INVENTORY_BAG_SLOT_COUNT = 4;
const BACKPACK_SLOT_COUNT = 16;
const BANK_SLOT_COUNT = 24;
const MAX_QUEST_LOG_SIZE = 20;
const QUEST_LOG_SLOT_FIELD_COUNT = 3;
const PLAYER_MAX_SKILLS = 127;
const SKILL_SLOT_FIELD_COUNT = 3;
const QUEST_STATE_COMPLETE = 0x01;
const QUEST_STATE_FAIL = 0x02;
const PLAYER_FIELD_WATCHED_FACTION_INDEX = PLAYER_FIELDS.PLAYER_FIELD_WATCHED_FACTION_INDEX;
const UNIT_FIELD_SUMMON = 0x008;
const UNIT_FIELD_CHARMEDBY = 0x00a; // UpdateFields_1_12_1.h:43, size 2 (GUID)
const UNIT_FIELD_SUMMONEDBY = 0x00c;
const UNIT_FIELD_FLAGS = 0x02e; // UpdateFields_1_12_1.h:66
const UNIT_FIELD_POWER5 = 0x01b;
const UNIT_FIELD_MAXPOWER5 = 0x021;
const UNIT_FIELD_LEVEL = 0x022;
const UNIT_FIELD_BYTES_1 = 0x08a;
const UNIT_FIELD_PETNUMBER = 0x08b;
const UNIT_FIELD_PET_NAME_TIMESTAMP = 0x08c;
const UNIT_FIELD_PETEXPERIENCE = 0x08d;
const UNIT_FIELD_PETNEXTLEVELEXP = 0x08e, UNIT_TRAINING_POINTS = 0x095;
const UNIT_BYTES_1_OFFSET_PET_LOYALTY = 1;
const INVENTORY_SLOT_BAG_0 = 255;
const INVENTORY_SLOT_BAG_START = 19;
const INVENTORY_SLOT_ITEM_START = 23;
const INVENTORY_SLOT_ITEM_END = INVENTORY_SLOT_ITEM_START + BACKPACK_SLOT_COUNT;
const INVENTORY_SLOT_BANK_START = 39;
const INVENTORY_SLOT_BANK_END = INVENTORY_SLOT_BANK_START + BANK_SLOT_COUNT;
const INVENTORY_SLOT_BANK_BAG_START = 63;
const INVENTORY_SLOT_BANK_BAG_END = INVENTORY_SLOT_BANK_BAG_START + 6;
const INVTYPE_BAG = 18;
const ITEM_CLASS_CONTAINER = 1;
const ITEM_CLASS_QUIVER = 11;
const UNIT_DYNFLAG_LOOTABLE = 0x0001;
// NPC flags now come from world/alpha-opcodes.ts, which is the single source shared with
// 1.12 specification handling.
// value 0x00020000 in both copies — a bit no 1.12 server ever sets.
const UNIT_NPC_FLAG_REPAIR = UNIT_NPC_FLAG.REPAIR;
const BANK_BAG_SLOT_PRICES = [1_000, 10_000, 100_000, 250_000, 500_000, 1_000_000] as const;
const MAX_FACTION_COUNT = 64;
const FACTION_FLAG_VISIBLE = 0x01;
const FACTION_FLAG_AT_WAR = 0x02;
const FACTION_FLAG_HIDDEN = 0x04;
const FACTION_FLAG_INVISIBLE_FORCED = 0x08;
const FACTION_FLAG_PEACE_FORCED = 0x10;
const FACTION_FLAG_INACTIVE = 0x20;
const REPUTATION_RANK_NAMES = ['Hated', 'Hostile', 'Unfriendly', 'Neutral', 'Friendly', 'Honored', 'Revered', 'Exalted'];
const REPUTATION_POINTS_IN_RANK = [36000, 3000, 3000, 3000, 6000, 12000, 21000, 1000];
const REPUTATION_BOTTOM = -42000;
const REPUTATION_CAP = 42999;
const PET_HAPPINESS_LEVEL_SIZE = 333000;
const PET_HAPPINESS_MAX = 1000000;
const PET_LOYALTY_NAMES = ['Rebellious', 'Unruly', 'Submissive', 'Dependable', 'Faithful', 'Best Friend'];

const EQUIPMENT_SLOT_LABELS = [
  'Head',
  'Neck',
  'Shoulders',
  'Shirt',
  'Chest',
  'Waist',
  'Legs',
  'Feet',
  'Wrists',
  'Hands',
  'Finger 1',
  'Finger 2',
  'Trinket 1',
  'Trinket 2',
  'Back',
  'Main Hand',
  'Off Hand',
  'Ranged',
  'Tabard',
];

/**
 * Combat events surfaced to the UI. Wire formats verified against vmangos
 * (Server/Packets/Combat.cpp + Unit::SendAttackStateUpdate, 1.12 branch).
 */
export type CombatEvent =
  | { kind: 'attackStart'; attackerGuid: string; victimGuid: string }
  | { kind: 'attackStop'; attackerGuid: string; victimGuid: string; attackerDead: boolean }
  | { kind: 'combatCancelled' }
  | { kind: 'aiReaction'; guid: string; reaction: number }
  | { kind: 'swingError'; reason: 'notInRange' | 'badFacing' | 'notStanding' | 'deadTarget' | 'cantAttack' }
  | {
      kind: 'meleeDamage';
      attackerGuid: string;
      victimGuid: string;
      hitInfo: number;
      totalDamage: number;
      school: number;
      absorb: number;
      resist: number;
      targetState: number;
      blocked: number;
      spellId: number;
    }
  | {
      kind: 'castResult';
      spellId: number;
      success: boolean;
      reason?: number;
      failureArg1?: number;
      failureArg2?: number;
    }
  | { kind: 'creatureQueryResponse'; entry: number; name: string; subname: string; displayId: number; rank: number }
  | { kind: 'playerNameResponse'; guid: string; name: string; race: number; classId: number; gender: number }
  | { kind: 'itemQueryResponse'; entry: number; displayInfoId: number; inventoryType: number; name: string; quality: number }
  | {
      kind: 'castSent';
      spellId: number;
      targetGuid?: string;
      destination?: SpellDestination;
      targets: SpellCastTargets;
    } // local echo of CMSG_CAST_SPELL for QA tracing
  | { kind: 'emote'; guid: string; emoteId: number } // SMSG_EMOTE: unit plays an Emotes.dbc animation
  | { kind: 'xpGain'; victimGuid: string; totalXp: number; xpType: number; baseXp?: number; groupBonus?: number }
  | { kind: 'levelUp'; level: number; healthGain: number; powerGains: number[]; statGains: number[] }
  | {
      kind: 'spellStart';
      casterGuid: string;
      castSourceGuid: string;
      castItemGuid?: string;
      spellId: number;
      castTimeMs: number;
      castFlags: number;
      targetGuid?: string;
      destination?: SpellDestination;
      targets: SpellCastTargets;
      ammoDisplayId?: number;
      ammoInventoryType?: number;
    }
  | {
      kind: 'spellGo';
      casterGuid: string;
      castSourceGuid: string;
      castItemGuid?: string;
      spellId: number;
      targetGuid?: string;
      /** Every GUID in the SMSG_SPELL_GO hit list, in wire order. Chain Lightning, Multi-Shot
      *  and cleaves land on all of them; only the first used to survive parsing. */
      hitGuids: string[];
      misses: Array<{ guid: string; reason: number; reflectResult?: number }>;
      destination?: SpellDestination;
      targets: SpellCastTargets;
      /** CAST_FLAG_AMMO payload written by vMaNGOS Spell::WriteAmmoToPacket. */
      ammoDisplayId?: number;
      ammoInventoryType?: number;
    }
  | { kind: 'playSpellVisualKit'; guid: string; kitId: number; onTarget: boolean }
  | { kind: 'spellFailure'; casterGuid: string; spellId: number; reason: number }
  | { kind: 'spellDelayed'; casterGuid: string; delayMs: number }
  | { kind: 'spellCooldown'; spellId: number; cooldownMs: number }
  | { kind: 'cooldownEvent'; spellId: number }
  | { kind: 'clearCooldown'; spellId: number }
  | { kind: 'channelStart'; casterGuid: string; spellId: number; durationMs: number }
  | { kind: 'channelUpdate'; casterGuid: string; timeRemainingMs: number }
  | {
      kind: 'spellDamage';
      attackerGuid: string;
      targetGuid: string;
      spellId: number;
      damage: number;
      school: number;
      absorb: number;
      resist: number;
      blocked: number;
      hitInfo: number;
      periodic: boolean;
    }
  /**
   * SMSG_SPELLDAMAGESHIELD (Thorns, Fire Shield, Retribution Aura...). The wire names are the
   * shield bearer's point of view: `shieldGuid` is who wears the aura, `victimGuid` is the attacker
   * that gets burned — vmangos deals the damage to the attacker (Unit.cpp:1754-1761).
   */
  | { kind: 'damageShield'; shieldGuid: string; victimGuid: string; damage: number; school: number }
  | { kind: 'spellHeal'; healerGuid: string; targetGuid: string; spellId: number; amount: number; critical: boolean }
  | { kind: 'spellEnergize'; casterGuid: string; targetGuid: string; spellId: number; powerType: number; amount: number }
  | { kind: 'environmentalDamage'; victimGuid: string; damageType: number; damage: number; absorb: number; resist: number }
  | { kind: 'spellMiss'; casterGuid: string; targetGuid: string; spellId: number; missInfo: number; reflectResult?: number }
  | { kind: 'petCastFailed'; spellId: number; status: number; reason: number }
  | { kind: 'autoRepeatCancelled' }
  | { kind: 'petActionFeedback'; message: number }
  | { kind: 'petTameFailure'; reason: number }
  | { kind: 'petBroken' }
  | { kind: 'partyKill'; killerGuid: string; victimGuid: string }
  | { kind: 'feignDeathResisted' }
  | { kind: 'spellDispel'; casterGuid: string; targetGuid: string; spellIds: number[]; success: boolean }
  | { kind: 'spellInstaKill'; victimGuid: string; spellId: number }
  | { kind: 'spellChainTargets'; casterGuid: string; spellId: number; targetGuids: string[] }
  | { kind: 'gameObjectAnimation'; guid: string; phase: 'spawn' | 'custom' | 'reset' | 'despawn'; animationId?: number }
  | { kind: 'itemCooldown'; itemGuid: string; spellId: number; durationMs: number }
  | { kind: 'itemEnchantTime'; itemGuid: string; slot: number; durationSeconds: number; playerGuid: string }
  | { kind: 'enchantmentLog'; casterGuid: string; ownerGuid: string; itemEntry: number; spellId: number; showAffiliation: boolean }
  | { kind: 'itemTime'; itemGuid: string; durationSeconds: number }
  | { kind: 'standState'; standState: number }
  | { kind: 'proficiency'; itemClass: number; subclassMask: number }
  | { kind: 'spellModifier'; modifierType: SpellModifierKind; effectIndex: number; modOp: number; value: number }
  | { kind: 'forcedReactions'; reactions: Array<{ factionId: number; reputationRank: number }> }
  | { kind: 'pvpCredit'; honor: number; victimGuid: string; victimRank: number }
  | { kind: 'playerSkinned'; freeRepop: boolean }
  | { kind: 'durabilityDamageDeath' }
  | { kind: 'mountSpecial'; guid: string }
  | { kind: 'textEmote'; sourceGuid: string; textEmoteId: number; emoteNumber: number; targetName: string }
  | { kind: 'areaSpiritHealerTime'; healerGuid: string; timeRemainingMs: number }
  | { kind: 'zoneUnderAttack'; areaId: number }
  | { kind: 'summonRequest'; summonerGuid: string; areaId: number; autoDeclineDelayMs: number }
  | { kind: 'raidGroupOnly'; timerMs: number; errorCode: number; bindAreaId?: number }
  | { kind: 'invalidatePlayer'; playerGuid: string }
  | {
      kind: 'spellExecute';
      casterGuid: string;
      spellId: number;
      effects: Array<{
        effectId: number;
        count: number;
        targetGuids: string[];
        records: SpellExecuteRecord[];
      }>;
    }
  | {
      kind: 'periodicAura';
      casterGuid: string;
      targetGuid: string;
      spellId: number;
      auraType: number;
      amount: number;
      school?: number;
      absorb?: number;
      resist?: number;
      powerType?: number;
    };

export type DeathEvent =
  | { kind: 'corpseReclaimDelay'; delayMs: number; availableAt: number }
  | { kind: 'corpseLocation'; found: false }
  | { kind: 'corpseLocation'; found: true; mapId: number; x: number; y: number; z: number; corpseMapId: number }
  | { kind: 'resurrectRequest'; resurrectorGuid: string; resurrectorName: string; sickness: boolean; useTimer: boolean }
  | { kind: 'resurrectFailed' }
  | { kind: 'spiritHealerConfirm'; healerGuid: string };

/**
 * Destination of a same-map ("near") teleport carried by SMSG MSG_MOVE_TELEPORT_ACK.
 * vMaNGOS packs a full MovementInfo after the counter (MovementPacketSender::SendTeleportToController),
 * so this is the authoritative new world position — used for graveyard release, in-world ports, etc.
 */
export type NearTeleport = { x: number; y: number; z: number; o: number };
export type RootStateEvent = { guid: string; rooted: boolean };
export type ControlledMoverEvent = ControlledMoverState & {
  previousMoverGuid: string;
  reason: 'server' | 'transfer' | 'despawn' | 'disconnect';
};
/**
 * Knockback arc from SMSG_MOVE_KNOCK_BACK / MSG_MOVE_KNOCK_BACK. The server sends the same four
 * floats vanilla's jump block carries — a horizontal direction as (cos, sin), a horizontal speed
 * and a vertical speed (MovementPacketSender::SendKnockBackToController) — because a knockback IS
 * a server-authored jump. `self` marks the packet addressed to our own mover, which is the only
 * one that needs a CMSG_MOVE_KNOCK_BACK_ACK.
 */
export type KnockbackEvent = {
  guid: string;
  cosAngle: number;
  sinAngle: number;
  speedXY: number;
  speedZ: number;
  self: boolean;
};

const SWING_ERROR_REASONS: Record<number, 'notInRange' | 'badFacing' | 'notStanding' | 'deadTarget' | 'cantAttack'> = {
  [OPCODES.SMSG_ATTACKSWING_NOTINRANGE]: 'notInRange',
  [OPCODES.SMSG_ATTACKSWING_BADFACING]: 'badFacing',
  [OPCODES.SMSG_ATTACKSWING_NOTSTANDING]: 'notStanding',
  [OPCODES.SMSG_ATTACKSWING_DEADTARGET]: 'deadTarget',
  [OPCODES.SMSG_ATTACKSWING_CANT_ATTACK]: 'cantAttack',
};

const OPCODE_NAMES = new Map<number, string>(
  Object.entries(OPCODES).map(([name, value]) => [value, name]),
);

export function packetName(opcode: number) {
  return OPCODE_NAMES.get(opcode) ?? `0x${opcode.toString(16)}`;
}

/**
 * Vanilla 1.12 world header cipher. NOT RC4; vanilla uses a byte add/xor stream
 * keyed directly by the 40-byte SRP session key.
 */
class HeaderCrypt {
  private key?: Uint8Array;
  private sendI = 0;
  private sendJ = 0;
  private recvI = 0;
  private recvJ = 0;

  // eslint-disable-next-line @typescript-eslint/require-await
  async init(sessionKey: Bytes) {
    this.key = sessionKey;
  }

  encrypt(header: Uint8Array) {
    const k = this.key;
    if (!k) return;
    for (let t = 0; t < header.length; t++) {
      this.sendI %= k.length;
      const x = ((header[t] ^ k[this.sendI]) + this.sendJ) & 0xff;
      this.sendI++;
      header[t] = this.sendJ = x;
    }
  }

  decrypt(header: Uint8Array) {
    const k = this.key;
    if (!k) return;
    for (let t = 0; t < header.length; t++) {
      this.recvI %= k.length;
      const x = ((header[t] - this.recvJ) ^ k[this.recvI]) & 0xff;
      this.recvI++;
      this.recvJ = header[t];
      header[t] = x;
    }
  }
}

export type WorldPacket = {
  opcode: number;
  body: Uint8Array;
};

type PacketDispatchContext = {
  compressedDepth: number;
  parentOpcode?: number;
  recordIndex?: number;
};

let nextWorldSessionGeneration = 1;

const WORLD_PING_INTERVAL_MS = 30000;
const WORLD_PING_MIN_SAFE_INTERVAL_MS = 27000;
const WORLD_CONNECT_TIMEOUT_MS = 10000;
const WORLD_PACKET_TIMEOUT_MS = 15000;
const WORLD_ENTER_VERIFY_TIMEOUT_MS = 20000;

/**
 * Turn a WebSocket close frame into a line that says who hung up.
 *
 * RFC 6455 codes, with what each one means for this stack specifically:
 *   1000/1001  orderly close — we or the page asked for it.
 *   1006       NO close frame arrived. The browser synthesises this when the TCP connection
 *              drops, so it means the proxy process died or the realm dropped the session
 *              without a WebSocket-level goodbye. Look in the proxy console next.
 *   1011       the proxy closed us deliberately and put its reason in the frame — that reason
 *              string is `why` from `close()` in server/proxy/proxy.mjs (backpressure timeout,
 *              upstream queue overflow, TCP error).
 *   1009       a frame exceeded the socket's size limit.
 */
export const describeSocketClose = (code: number | undefined, reason: string): string => {
  const detail = reason?.trim();
  const known: Record<number, string> = {
    1000: 'closed normally',
    1001: 'endpoint going away',
    1006: 'connection lost with no close frame (proxy or realm dropped the TCP)',
    1009: 'message too large',
    1011: 'proxy closed the connection',
  };
  const base = code === undefined ? 'world WebSocket closed' : known[code] ?? `world WebSocket closed (code ${code})`;
  const withCode = code === undefined || known[code] === undefined ? base : `${base} [code ${code}]`;
  return detail ? `${withCode}: ${detail}` : withCode;
};
export class WorldSocket {
  private readonly ws: WebSocket;
  private readonly buffer = new ChunkedReceiveBuffer();
  private readonly packets = new BoundedPacketQueue<WorldPacket>();
  private readonly waiters: Array<{
    resolve: (packet: WorldPacket) => void;
    reject: (error: Error) => void;
  }> = [];
  private readonly crypt = new HeaderCrypt();
  private readonly outboundBackpressure = new OutboundBackpressure();
  private pendingHeader?: { opcode: number; bodySize: number };
  private encrypted = false;
  private closed = false;
  private lastReceivedAt = performance.now(); private lastSentAt = performance.now();
  private closedAt: number | undefined;
  private closeCode: number | undefined;
  private closeReason = '';

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('message', (event: MessageEvent<ArrayBuffer | Blob>) => {
      this.lastReceivedAt = performance.now();
      if (event.data instanceof ArrayBuffer) {
        this.pushSafely(new Uint8Array(event.data));
      } else {
        void event.data.arrayBuffer()
          .then((data) => {
            this.lastReceivedAt = performance.now();
            this.pushSafely(new Uint8Array(data));
          })
          .catch((error) => this.fail(error instanceof Error ? error : new Error(String(error))));
      }
    });
    ws.addEventListener('close', (event) => {
      this.closed = true; this.buffer.clear(); this.packets.clear();
      this.closedAt = performance.now();
      this.closeCode = event.code;
      this.closeReason = event.reason;
      // Carry the close frame into the error. The proxy already puts its reason on the wire
      // (`ws.close(code, why)` in server/proxy/proxy.mjs), and the code alone separates the three
      // cases that look identical to a player: 1006 = the TCP to vMaNGOS dropped with no close
      // frame (server-side kick/crash/idle), 1011 = the proxy gave up and says why, 1000/1001 =
      // an orderly close. Throwing a bare "world WebSocket closed" discarded all of it and made
      // an intermittent mid-session disconnect impossible to attribute.
      this.rejectWaiters(new Error(describeSocketClose(event.code, event.reason)));
    });
  }

  static open(url: string, timeoutMs = WORLD_CONNECT_TIMEOUT_MS): Promise<WorldSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        ws.removeEventListener('close', onClose);
        if (timeout) clearTimeout(timeout);
      };
      const onOpen = () => {
        cleanup();
        resolve(new WorldSocket(ws));
      };
      const onError = () => {
        cleanup();
        reject(new Error('world WebSocket error'));
      };
      const onClose = () => {
        cleanup();
        reject(new Error('world WebSocket closed before connecting'));
      };
      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('error', onError, { once: true });
      ws.addEventListener('close', onClose, { once: true });
      timeout = setTimeout(() => {
        cleanup();
        ws.close();
        reject(new Error('world WebSocket connection timed out'));
      }, timeoutMs);
    });
  }

  async enableEncryption(sessionKey: Bytes) {
    await this.crypt.init(sessionKey);
    this.encrypted = true;
  }
  send(opcode: number, body: Bytes = new Uint8Array()) {
    if (this.closed) throw new Error('world WebSocket closed');
    if (this.ws.readyState !== WebSocket.OPEN) {
      this.closed = true;
      const error = new Error(`world WebSocket not open (state ${this.ws.readyState})`);
      this.rejectWaiters(error);
      throw error;
    }
    const admission = this.outboundBackpressure.admit(this.ws.bufferedAmount, opcode === OPCODES.MSG_MOVE_HEARTBEAT || opcode === OPCODES.MSG_MOVE_SET_FACING);
    if (admission === 'drop-replaceable') return;
    if (admission === 'disconnect') { this.close(); throw new Error('world WebSocket outbound buffer remained above high-water mark'); }
    const size = body.length + 4, packet = new Uint8Array(6 + body.length);
    packet[0] = (size >>> 8) & 0xff; packet[1] = size & 0xff;
    packet[2] = opcode & 0xff; packet[3] = (opcode >>> 8) & 0xff;
    packet[4] = (opcode >>> 16) & 0xff; packet[5] = (opcode >>> 24) & 0xff;
    packet.set(body, 6);
    if (BROWSERPORT_INSTRUMENTATION_ENABLED) observeWorldPacket('outbound', opcode, body);
    if (this.encrypted) this.crypt.encrypt(packet.subarray(0, 6));
    this.ws.send(packet);
    this.lastSentAt = performance.now();
  }
  readPacket(timeoutMs?: number): Promise<WorldPacket> {
    const packet = this.packets.shift();
    if (packet) return Promise.resolve(packet);
    if (this.closed || this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED) {
      return Promise.reject(new Error('world WebSocket closed'));
    }
    return new Promise((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let waiter: { resolve: (packet: WorldPacket) => void; reject: (error: Error) => void } | undefined;
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        if (waiter) {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
        }
      };
      waiter = {
        resolve: (p) => {
          cleanup();
          resolve(p);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      this.waiters.push(waiter);
      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          cleanup();
          reject(new Error('world packet read timed out'));
        }, timeoutMs);
      }
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true; this.buffer.clear(); this.packets.clear();
    this.rejectWaiters(new Error('world WebSocket closed'));
    this.ws.close();
  }

  diagnostics() {
    const now = performance.now();
    return {
      readyState: this.ws.readyState,
      closed: this.closed,
      lastReceivedAgoMs: Math.round(now - this.lastReceivedAt),
      lastSentAgoMs: Math.round(now - this.lastSentAt),
      closedAgoMs: this.closedAt === undefined ? undefined : Math.round(now - this.closedAt),
      closeCode: this.closeCode,
      closeReason: this.closeReason,
      bufferedAmount: this.ws.bufferedAmount,
      outboundBackpressure: this.outboundBackpressure.diagnostics(this.ws.bufferedAmount, now),
      queuedPackets: this.packets.length,
      queuedPacketBytes: this.packets.byteLength,
      bufferedBytes: this.buffer.length,
    };
  }

  private push(chunk: Uint8Array) {
    this.buffer.append(chunk);
    this.pump();
  }

  private pushSafely(chunk: Uint8Array) {
    if (this.closed) return;
    try {
      this.push(chunk);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Header decryption is stateful, so a malformed encrypted header cannot be skipped or resynced.
   * Fail the transport, reject the pending read, and let RealmWorldClient's pump surface the normal
   * disconnect path instead of re-parsing the same poisoned bytes forever.
   */
  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    this.buffer.clear();
    this.packets.clear();
    this.pendingHeader = undefined;
    this.rejectWaiters(error);
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      const overflow = /exceeded|overflow/.test(error.message);
      this.ws.close(overflow ? 1009 : 1002, overflow ? 'world packet backpressure limit' : 'invalid world packet');
    }
  }

  private pump() {
    for (;;) {
      if (!this.pendingHeader) {
        if (this.buffer.length < 4) return;
        const header = this.buffer.read(4)!;
        if (this.encrypted) this.crypt.decrypt(header);
        const size = (header[0] << 8) | header[1];
        const bodySize = size - 2;
        if (bodySize < 0) throw new Error(`invalid world packet size ${size}`);
        this.pendingHeader = { opcode: header[2] | (header[3] << 8), bodySize };
      }

      if (this.buffer.length < this.pendingHeader.bodySize) return;
      const body = this.buffer.read(this.pendingHeader.bodySize)!;
      const packet = { opcode: this.pendingHeader.opcode, body };
      if (BROWSERPORT_INSTRUMENTATION_ENABLED) observeWorldPacket('inbound', packet.opcode, packet.body);
      this.pendingHeader = undefined;
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(packet);
      else this.packets.push(packet, packet.body.byteLength + 4);
    }
  }

  private rejectWaiters(error: Error) {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }
}

class Reader {
  offset = 0;
  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  get remaining() {
    return this.data.length - this.offset;
  }

  ensure(length: number) {
    if (this.offset + length > this.data.length) {
      throw new Error(`world packet truncated at ${this.offset}, need ${length}, have ${this.data.length - this.offset}`);
    }
  }

  u8() {
    this.ensure(1);
    return this.data[this.offset++];
  }

  u16() {
    this.ensure(2);
    const v = this.data[this.offset] | (this.data[this.offset + 1] << 8);
    this.offset += 2;
    return v;
  }

  u32() {
    this.ensure(4);
    const v =
      this.data[this.offset] |
      (this.data[this.offset + 1] << 8) |
      (this.data[this.offset + 2] << 16) |
      (this.data[this.offset + 3] << 24);
    this.offset += 4;
    return v >>> 0;
  }

  i32() {
    const value = this.u32();
    return value > 0x7fffffff ? value - 0x100000000 : value;
  }

  f32() {
    this.ensure(4);
    const dv = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 4);
    this.offset += 4;
    return dv.getFloat32(0, true);
  }

  bytes(length: number) {
    this.ensure(length);
    const out = this.data.slice(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  cstring() {
    const start = this.offset;
    while (this.offset < this.data.length && this.data[this.offset] !== 0) this.offset++;
    if (this.offset >= this.data.length) throw new Error(`world packet unterminated string at ${start}`);
    const s = latin1.decode(this.data.slice(start, this.offset));
    this.offset++;
    return s;
  }

  stringBytes(length: number) {
    if (length <= 0) return '';
    const raw = this.bytes(length);
    const end = raw.indexOf(0);
    return latin1.decode(end >= 0 ? raw.slice(0, end) : raw);
  }
}

function readGuid64(r: Reader) {
  return guidHex(r.bytes(8));
}

export type SpellExecuteRecord = {
  targetGuid?: string;
  amount?: number;
  powerType?: number;
  multiplier?: number;
  criticalHeal?: boolean;
  extraAttacks?: number;
  itemEntry?: number;
  interruptedSpellId?: number;
  durabilityItemEntry?: number;
  durabilityCategory?: number;
};

const SPELL_MISS_REFLECT = 11;
const SPELL_CAST_FLAG_AMMO = 0x0020;

// Every GUID-only effect serialized by vMaNGOS Spell::SendLogExecute. The sender returns without
// transmitting for any unhandled effect, so these layouts cover every valid 1.12 packet body.
const SPELL_EXECUTE_GUID_EFFECTS = new Set([
  1, 18, 28, 33, 38, 41, 42, 50, 56, 59, 63, 69, 73, 74, 76, 79,
  87, 88, 89, 90, 91, 97, 102, 104, 105, 106, 107, 108, 112, 113,
  114, 116, 125, 126,
]);

function readSpellExecuteRecord(r: Reader, effectId: number): SpellExecuteRecord {
  if (SPELL_EXECUTE_GUID_EFFECTS.has(effectId)) return { targetGuid: readGuid64(r) };
  switch (effectId) {
    case 8: { // POWER_DRAIN: guid, amount, power, multiplier
      return {
        targetGuid: readGuid64(r),
        amount: r.u32(),
        powerType: r.u32(),
        multiplier: r.f32(),
      };
    }
    case 10:
    case 67: { // HEAL / HEAL_MAX_HEALTH: guid, amount, critical
      return { targetGuid: readGuid64(r), amount: r.u32(), criticalHeal: r.u8() !== 0 };
    }
    case 30: { // ENERGIZE: guid, amount, power type
      return { targetGuid: readGuid64(r), amount: r.u32(), powerType: r.u32() };
    }
    case 19: { // ADD_EXTRA_ATTACKS: guid, count
      return { targetGuid: readGuid64(r), extraAttacks: r.u32() };
    }
    case 24: // CREATE_ITEM: item entry
    case 101: // FEED_PET: item entry
      return { itemEntry: r.u32() };
    case 68: { // INTERRUPT_CAST: guid, interrupted spell id
      return { targetGuid: readGuid64(r), interruptedSpellId: r.u32() };
    }
    case 111: { // DURABILITY_DAMAGE: guid, item entry, unknown
      return {
        targetGuid: readGuid64(r),
        durabilityItemEntry: signedU32(r.u32()),
        durabilityCategory: signedU32(r.u32()),
      };
    }
    default:
      throw new Error(`unsupported SMSG_SPELLLOGEXECUTE effect ${effectId}`);
  }
}

function signedU32(value: number) {
  return value > 0x7fffffff ? value - 0x100000000 : value;
}

function signed16(value: number) {
  const clean = value & 0xffff;
  return clean > 0x7fff ? clean - 0x10000 : clean;
}

function byteAt(value: number, index: number) {
  return (value >>> (index * 8)) & 0xff;
}

function reputationRankFor(standing: number) {
  let limit = REPUTATION_CAP + 1;
  for (let rank = REPUTATION_POINTS_IN_RANK.length - 1; rank >= 0; rank--) {
    limit -= REPUTATION_POINTS_IN_RANK[rank];
    if (standing >= limit) return rank;
  }
  return 0;
}

function reputationRankMin(rank: number) {
  let value = REPUTATION_BOTTOM;
  for (let i = 0; i < rank; i++) value += REPUTATION_POINTS_IN_RANK[i] ?? 0;
  return value;
}

function makeReputationState(reputationListId: number, flags: number, standing: number, watchedFactionIndex: number): ReputationState {
  const rank = reputationRankFor(standing);
  const pointsInRank = REPUTATION_POINTS_IN_RANK[rank] ?? 1;
  const rankMin = reputationRankMin(rank);
  const rankMax = rank === REPUTATION_POINTS_IN_RANK.length - 1 ? REPUTATION_CAP : rankMin + pointsInRank - 1;
  return {
    reputationListId,
    flags,
    standing,
    visible: (flags & FACTION_FLAG_VISIBLE) !== 0,
    atWar: (flags & FACTION_FLAG_AT_WAR) !== 0,
    hidden: (flags & FACTION_FLAG_HIDDEN) !== 0,
    forcedInvisible: (flags & FACTION_FLAG_INVISIBLE_FORCED) !== 0,
    peaceForced: (flags & FACTION_FLAG_PEACE_FORCED) !== 0,
    inactive: (flags & FACTION_FLAG_INACTIVE) !== 0,
    watched: reputationListId === watchedFactionIndex,
    rank,
    rankName: REPUTATION_RANK_NAMES[rank] ?? `Rank ${rank}`,
    rankMin,
    rankMax,
    valueInRank: Math.max(0, Math.min(pointsInRank, standing - rankMin)),
    pointsInRank,
  };
}

function parseMessageChat(packet: WorldPacket): ChatEvent {
  const r = new Reader(packet.body);
  const type = r.u8();
  const language = r.u32();
  const event: ChatEvent = { type, language, message: '', chatTag: 0 };

  switch (type) {
    case CHAT_MSG.MONSTER_WHISPER:
    case CHAT_MSG.RAID_BOSS_WHISPER:
    case CHAT_MSG.RAID_BOSS_EMOTE:
    case CHAT_MSG.MONSTER_EMOTE:
      event.senderName = r.stringBytes(r.u32());
      event.targetGuid = readGuid64(r);
      break;
    case CHAT_MSG.SAY:
    case CHAT_MSG.PARTY:
    case CHAT_MSG.YELL:
      event.senderGuid = readGuid64(r);
      event.targetGuid = readGuid64(r); // vMaNGOS repeats sender for normal player speech.
      break;
    case CHAT_MSG.MONSTER_SAY:
    case CHAT_MSG.MONSTER_YELL:
      event.senderGuid = readGuid64(r);
      event.senderName = r.stringBytes(r.u32());
      event.targetGuid = readGuid64(r);
      break;
    case CHAT_MSG.CHANNEL:
      event.channelName = r.cstring();
      if (r.remaining >= 4) r.u32(); // player rank, present in 1.12.1 builds newer than 1.5.1.
      event.senderGuid = readGuid64(r);
      break;
    default:
      event.senderGuid = readGuid64(r);
      break;
  }

  event.message = r.stringBytes(r.u32());
  event.chatTag = r.remaining > 0 ? r.u8() : 0;
  return event;
}

async function waitFor(
  socket: WorldSocket,
  opcode: number,
  progress: WorldProgress,
  timeoutMs = WORLD_PACKET_TIMEOUT_MS,
): Promise<WorldPacket> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) throw new Error(`world timed out waiting for ${packetName(opcode)}`);
    let packet: WorldPacket;
    try {
      packet = await socket.readPacket(remainingMs);
    } catch (error) {
      if ((error as Error).message.includes('timed out')) {
        throw new Error(`world timed out waiting for ${packetName(opcode)}`);
      }
      throw error;
    }
    progress(`world: received ${packetName(packet.opcode)}`);
    if (packet.opcode === opcode) return packet;
  }
}

async function sendAuthSession(socket: WorldSocket, session: AuthSession, realm: RealmInfo, serverSeed: number) {
  const clientSeed = randomU32();
  const digest = await sha1(
    text.encode(session.account),
    u32(0),
    u32(clientSeed),
    u32(serverSeed),
    session.sessionKey,
  );
  const realmId = realm.id || 1;
  const body = concat(
    u32(5875),
    u32(realmId),
    cstring(session.account),
    u32(clientSeed),
    digest,
    ADDON_DATA_EMPTY,
  );
  socket.send(OPCODES.CMSG_AUTH_SESSION, body);
  await socket.enableEncryption(session.sessionKey);
}

function parseCharacters(packet: WorldPacket): CharacterInfo[] {
  const r = new Reader(packet.body);
  const count = r.u8();
  const characters: CharacterInfo[] = [];
  for (let i = 0; i < count; i++) {
    const guidBytes = Array.from(r.bytes(8));
    const guid = guidHex(new Uint8Array(guidBytes));
    const name = r.cstring();
    const race = r.u8();
    const classId = r.u8();
    const gender = r.u8();
    const skin = r.u8();
    const face = r.u8();
    const hairStyle = r.u8();
    const hairColor = r.u8();
    const facialHair = r.u8();
    const level = r.u8();
    const zone = r.u32();
    const map = r.u32();
    const x = r.f32();
    const y = r.f32();
    const z = r.f32();
    const guildId = r.u32();
    r.u32(); // character flags
    r.u8(); // first-login flag (server writes uint8, not uint32)
    r.u32(); // pet display id
    r.u32(); // pet level
    r.u32(); // pet family
    // Equipment: server loops slot < INVENTORY_SLOT_BAG_START + 1 (= 20), writing
    // { displayInfoId: u32, inventoryType: u8 } per slot. No trailing enchant field in vanilla.
    const equipment: CharacterInfo['equipment'] = [];
    for (let j = 0; j < 20; j++) {
      equipment.push({ displayInfoId: r.u32(), inventoryType: r.u8(), slot: j });
    }
    characters.push({
      guid,
      guidBytes,
      name,
      race,
      classId,
      gender,
      skin,
      face,
      hairStyle,
      hairColor,
      facialHair,
      level,
      zone,
      map,
      x,
      y,
      z,
      guildId,
      equipment,
    });
  }
  return characters;
}

function parseLoginVerifyWorld(packet: WorldPacket): WorldPosition {
  const r = new Reader(packet.body);
  return { map: r.u32(), x: r.f32(), y: r.f32(), z: r.f32(), o: r.f32() };
}

function parseUpdateHeader(data: Uint8Array) {
  const r = new Reader(data);
  const blocks = r.u32();
  const hasTransport = r.remaining > 0 ? r.u8() !== 0 : false;
  return { blocks, hasTransport };
}

function readPackedGuid(r: Reader): string {
  const mask = r.u8();
  const bytes = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    if (mask & (1 << i)) bytes[i] = r.u8();
  }
  return guidHex(bytes);
}

function parseMovementInfo(r: Reader): MovementInfo {
  const flags = r.u32();
  const time = r.u32();
  const x = r.f32();
  const y = r.f32();
  const z = r.f32();
  const o = r.f32();
  const onTransport = (flags & 0x02000000) !== 0;
  const swimming = (flags & 0x00200000) !== 0;
  const falling = (flags & 0x00002000) !== 0;
  const splineElevation = (flags & 0x04000000) !== 0;
  const movement: MovementInfo = { x, y, z, o, flags, time, fallTime: 0 };

  if (onTransport) {
    movement.transportGuid = guidHex(r.bytes(8));
    movement.transportX = r.f32();
    movement.transportY = r.f32();
    movement.transportZ = r.f32();
    movement.transportO = r.f32();
  }
  if (swimming) movement.swimPitch = r.f32();
  const fallTime = r.u32();
  movement.fallTime = fallTime;
  if (falling) {
    movement.jumpVelocity = r.f32();
    movement.jumpCosAngle = r.f32();
    movement.jumpSinAngle = r.f32();
    movement.jumpXYSpeed = r.f32();
  }
  if (splineElevation) movement.splineElevation = r.f32();
  return movement;
}

export type JumpInfo = { velocity: number; sinAngle: number; cosAngle: number; xySpeed: number };

export type ClientTransportMovement = {
  guid: string;
  x: number;
  y: number;
  z: number;
  o: number;
};

export type ClientMovementExtras = {
  swimPitch?: number;
  transport?: ClientTransportMovement;
};

const MOVEMENTFLAG_JUMPING = 0x00002000; // a.k.a. falling; triggers the jump float block
const MOVEMENTFLAG_SWIMMING = 0x00200000;
const MOVEMENTFLAG_XY = 0x0000000f;
// MOVEFLAG_ROOT (vMaNGOS MovementInfo.h). A root-apply ack MUST carry this flag or the server kicks
// the player (HandleMoveRootAck); it must not coexist with the moving flags.
const MOVEMENTFLAG_ROOT = 0x00001000;
const MOVEMENTFLAG_WATERWALKING = 0x10000000;
const MOVEMENTFLAG_SAFE_FALL = 0x20000000;
const MOVEMENTFLAG_HOVER = 0x40000000;
const DEFAULT_JUMP_VELOCITY = 7.95797334;
const DEFAULT_JUMP_XY_SPEED = 7.0;

function resolveJumpInfo(o: number, flags: number, jump?: JumpInfo): JumpInfo | undefined {
  if ((flags & MOVEMENTFLAG_JUMPING) === 0) return undefined;
  if (jump) return jump;
  return {
    velocity: DEFAULT_JUMP_VELOCITY,
    cosAngle: Math.cos(o),
    sinAngle: Math.sin(o),
    xySpeed: (flags & MOVEMENTFLAG_XY) !== 0 ? DEFAULT_JUMP_XY_SPEED : 0,
  };
}

function movementBody(
  x: number,
  y: number,
  z: number,
  o: number,
  flags = 0,
  jump?: JumpInfo,
  fallTime = 0,
  extras: ClientMovementExtras = {},
): Uint8Array {
  const parts: Bytes[] = [
    u32(flags),
    u32(Date.now() & 0xffffffff),
    f32(x),
    f32(y),
    f32(z),
    f32(o),
  ];
  if ((flags & 0x02000000) !== 0) {
    const transport = extras.transport;
    if (!transport) throw new Error('MOVEMENTFLAG_ONTRANSPORT requires transport coordinates');
    parts.push(
      guidHexToBytes(transport.guid),
      f32(transport.x),
      f32(transport.y),
      f32(transport.z),
      f32(transport.o),
    );
  }
  if ((flags & MOVEMENTFLAG_SWIMMING) !== 0) parts.push(f32(extras.swimPitch ?? 0)); // vanilla s_pitch, before fallTime
  parts.push(u32(fallTime));
  // When airborne the vanilla MovementInfo carries the jump arc: vertical velocity,
  // cos/sin of the 2D facing, and horizontal speed.
  const jumpInfo = resolveJumpInfo(o, flags, jump);
  if (jumpInfo) {
    parts.push(f32(jumpInfo.velocity), f32(jumpInfo.cosAngle), f32(jumpInfo.sinAngle), f32(jumpInfo.xySpeed));
  }
  return concat(...parts);
}

const MOVE_OPCODES: Record<string, number> = {
  start_forward: OPCODES.MSG_MOVE_START_FORWARD,
  start_backward: OPCODES.MSG_MOVE_START_BACKWARD,
  stop: OPCODES.MSG_MOVE_STOP,
  start_strafe_left: OPCODES.MSG_MOVE_START_STRAFE_LEFT,
  start_strafe_right: OPCODES.MSG_MOVE_START_STRAFE_RIGHT,
  stop_strafe: OPCODES.MSG_MOVE_STOP_STRAFE,
  jump: OPCODES.MSG_MOVE_JUMP,
  start_turn_left: OPCODES.MSG_MOVE_START_TURN_LEFT,
  start_turn_right: OPCODES.MSG_MOVE_START_TURN_RIGHT,
  stop_turn: OPCODES.MSG_MOVE_STOP_TURN,
  fall_land: OPCODES.MSG_MOVE_FALL_LAND,
  facing: OPCODES.MSG_MOVE_SET_FACING,
  heartbeat: OPCODES.MSG_MOVE_HEARTBEAT,
  set_run: OPCODES.MSG_MOVE_SET_RUN_MODE,
  set_walk: OPCODES.MSG_MOVE_SET_WALK_MODE,
};

// vMaNGOS rebroadcasts player movement with the original MSG_MOVE_* opcode and a
// packed mover GUID prepended before MovementInfo. Accept the vanilla movement
// family here, not just heartbeat, or nearby players appear frozen.
const SERVER_MOVEMENT_OPCODES = new Set<number>([
  ...Object.values(MOVE_OPCODES),
  0x00bf, // MSG_MOVE_START_PITCH_UP
  0x00c0, // MSG_MOVE_START_PITCH_DOWN
  0x00c1, // MSG_MOVE_STOP_PITCH
  0x00ca, // MSG_MOVE_START_SWIM
  0x00cb, // MSG_MOVE_STOP_SWIM
  0x00db, // MSG_MOVE_SET_PITCH
]);

const SPLINE_SPEED_OPCODES = new Map<number, UnitSpeedKind>([
  [OPCODES.SMSG_SPLINE_SET_WALK_SPEED, 'walk'],
  [OPCODES.SMSG_SPLINE_SET_RUN_SPEED, 'run'],
  [OPCODES.SMSG_SPLINE_SET_RUN_BACK_SPEED, 'runBack'],
  [OPCODES.SMSG_SPLINE_SET_SWIM_SPEED, 'swim'],
  [OPCODES.SMSG_SPLINE_SET_SWIM_BACK_SPEED, 'swimBack'],
  [OPCODES.SMSG_SPLINE_SET_TURN_RATE, 'turnRate'],
]);

const OBSERVER_SPEED_OPCODES = new Map<number, UnitSpeedKind>([
  [OPCODES.MSG_MOVE_SET_WALK_SPEED, 'walk'],
  [OPCODES.MSG_MOVE_SET_RUN_SPEED, 'run'],
  [OPCODES.MSG_MOVE_SET_RUN_BACK_SPEED, 'runBack'],
  [OPCODES.MSG_MOVE_SET_SWIM_SPEED, 'swim'],
  [OPCODES.MSG_MOVE_SET_SWIM_BACK_SPEED, 'swimBack'],
  [OPCODES.MSG_MOVE_SET_TURN_RATE, 'turnRate'],
]);

const SPLINE_MODE_OPCODES = new Map<number, Partial<Pick<
  WorldEntity,
  'rooted' | 'waterWalking' | 'featherFalling' | 'hovering' | 'running'
>>>([
  [OPCODES.SMSG_SPLINE_MOVE_ROOT, { rooted: true }],
  [OPCODES.SMSG_SPLINE_MOVE_UNROOT, { rooted: false }],
  [OPCODES.SMSG_SPLINE_MOVE_WATER_WALK, { waterWalking: true }],
  [OPCODES.SMSG_SPLINE_MOVE_LAND_WALK, { waterWalking: false }],
  [OPCODES.SMSG_SPLINE_MOVE_FEATHER_FALL, { featherFalling: true }],
  [OPCODES.SMSG_SPLINE_MOVE_NORMAL_FALL, { featherFalling: false }],
  [OPCODES.SMSG_SPLINE_MOVE_SET_HOVER, { hovering: true }],
  [OPCODES.SMSG_SPLINE_MOVE_UNSET_HOVER, { hovering: false }],
  [OPCODES.SMSG_SPLINE_MOVE_SET_RUN_MODE, { running: true }],
  [OPCODES.SMSG_SPLINE_MOVE_SET_WALK_MODE, { running: false }],
]);

export type MoveKind =
  | 'start_forward' | 'start_backward' | 'stop'
  | 'start_strafe_left' | 'start_strafe_right' | 'stop_strafe'
  | 'jump' | 'start_turn_left' | 'start_turn_right' | 'stop_turn'
  | 'fall_land' | 'facing' | 'heartbeat' | 'set_run' | 'set_walk';

export class RealmWorldClient {
  readonly stats: WorldUpdateStats = {
    updatePackets: 0,
    compressedUpdatePackets: 0,
    compressedMovementPackets: 0,
    nestedMovementPackets: 0,
    updateBlocks: 0,
    movementPackets: 0,
    clientMovementPackets: 0,
    entities: 0,
    entityCreates: 0,
    postLoginEntityCreates: 0,
    nearTeleportAcks: 0,
    entityUpdates: 0,
    entityRemoves: 0,
    updateParseErrors: 0,
  };

  private readonly statsListeners = new Set<(stats: WorldUpdateStats) => void>();
  private readonly entityListeners = new Set<(entity: WorldEntity, change?: WorldEntityChange) => void>();
  private readonly entityRemoveListeners = new Set<(guid: string) => void>();
  private readonly combatListeners = new Set<(event: CombatEvent) => void>();
  private readonly deathListeners = new Set<(event: DeathEvent) => void>();
  private readonly nearTeleportListeners = new Set<(dest: NearTeleport) => void>();
  private readonly rootStateListeners = new Set<(event: RootStateEvent) => void>();
  private readonly controlledMoverListeners = new Set<(event: ControlledMoverEvent) => void>();
  private readonly knockbackListeners = new Set<(event: KnockbackEvent) => void>();
  private readonly chatListeners = new Set<(event: ChatEvent) => void>();
  private readonly channelNotifyListeners = new Set<(event: ChannelNotifyEvent) => void>();
  /** Ordered channel slots; `/1` resolves through this, and so does the `[1. General]` prefix. */
  private readonly channelSlots = new ChannelSlots();
  private readonly channelLists = new ChannelListResolver({ nameFor: (guid) => this.playerNames.get(guid)?.name, requestName: (guid) => this.queryPlayerName(guid), emit: (message) => this.emitChat({ type: CHAT_MSG.SYSTEM, language: 0, chatTag: 0, message }) });
  private readonly cinematicListeners = new Set<(event: CinematicEvent) => boolean | void>();
  private readonly logoutResponseListeners = new Set<(event: LogoutResponseEvent) => void>();
  private readonly logoutCancelListeners = new Set<() => void>();
  private readonly logoutCompleteListeners = new Set<() => void>();
  private readonly weatherListeners = new Set<(event: WeatherEvent) => void>();
  private readonly soundListeners = new Set<(event: WorldSoundEvent) => void>();
  private readonly worldTransferListeners = new Set<(event: WorldTransferEvent) => void | Promise<void>>();
  private readonly mirrorTimerListeners = new Set<(event: MirrorTimerEvent) => void>();
  private readonly disconnectListeners = new Set<(reason: string) => void>();
  private readonly actionDataListeners = new Set<() => void>();
  private readonly auraListeners = new Set<(unitGuid: string, auras: readonly AuraSlot[]) => void>();
  private readonly worldStateListeners = new Set<(states: Readonly<Record<number, number>>) => void>();
  private readonly inventoryListeners = new Set<(snapshot: InventorySnapshot) => void>();
  private readonly skillListeners = new Set<(snapshot: SkillSnapshot) => void>();
  private readonly honorListeners = new Set<(snapshot: HonorSnapshot) => void>();
  private readonly reputationListeners = new Set<(snapshot: ReputationSnapshot) => void>();
  private readonly petListeners = new Set<(snapshot: PetSnapshot) => void>();
  private readonly questLogListeners = new Set<(snapshot: QuestLogSnapshot) => void>();
  private readonly questProgressListeners = new Set<(event: QuestProgressEvent) => void>();
  private readonly interactionListeners = new Set<(event: InteractionEvent) => void>();
  private readonly lootRollListeners = new Set<(event: LootRollEvent) => void>();
  private readonly socialListeners = new Set<(snapshot: SocialSnapshot) => void>();
  private readonly partyInviteListeners = new Set<(event: PartyInviteEvent) => void>();
  private readonly partyResultListeners = new Set<(event: PartyCommandResultEvent) => void>();
  private readonly guildInviteListeners = new Set<(event: GuildInviteEvent) => void>();
  private readonly guildResultListeners = new Set<(event: GuildCommandResultEvent) => void>();
  private readonly guildEventListeners = new Set<(event: GuildEventNotice) => void>();
  private readonly duelRequestListeners = new Set<(event: DuelRequestEvent) => void>();
  private readonly duelNoticeListeners = new Set<(event: DuelNotice) => void>();
  // Build 5875 DuelInfo.cpp retains the first GUID in SMSG_DUEL_REQUESTED (the duel flag) and
  // writes that same u64 in both CMSG_DUEL_ACCEPTED and CMSG_DUEL_CANCELLED.
  private duelFlagGuid = '';
  private readonly inspectListeners = new Set<(event: InspectEvent) => void>();
  private statsLastEmittedAt = 0;
  private statsEmitTimer: ReturnType<typeof setTimeout> | undefined;
  private knownSpells: number[] = [];
  private actionButtons: ActionButton[] = [];
  private currentLoot: LootState | undefined;
  // Authoritative field when present; loot notifications are a fallback for custom cores.
  private lastKnownMoney: number | undefined;
  private lastCreditedLootMoneyGuid: string | undefined;
  private currentGossipGuid: string | undefined;
  private currentGossipState: GossipState | undefined;
  private readonly npcTexts = new Map<number, string>();
  private currentVendorGuid: string | undefined;
  private currentTrainerGuid: string | undefined;
  private currentBankGuid: string | undefined;
  private tradeState: TradeState | undefined;
  private currentMailboxGuid: string | undefined;
  private mailMessages: MailMessage[] = [];
  private masterLootEligible: string[] = [];
  // --- level 1-40 service state (protocol lives under world/) ---
  private bindPoint: BindPoint | undefined;
  private tutorialFlags = Array<number>(8).fill(0);
  /** Suppresses duplicate CMSG_ZONEUPDATE; the server only cares about transitions. */
  private lastSentZoneId = 0;
  private readonly guildNames = new Map<number, GuildInfo>();
  private readonly pendingGuildQueries = new Set<number>();
  private readonly itemNames = new Map<number, string>();
  private readonly pendingItemNameQueries = new Set<number>();
  private currentAuctioneerGuid: string | undefined;
  private auctionHouseId = 0;
  private auctionPages = emptyAuctionPages();
  private auctionPending: AuctionTab | undefined;
  private lastAuctionFilters: AuctionSearchFilters = {};
  private currentStableGuid: string | undefined;
  private stablePets: StabledPet[] = [];
  private stableSlots = 0;
  private currentPetitionVendorGuid: string | undefined;
  private currentPetition: PetitionState | undefined;
  private unreadMail = false;
  private readonly explorationListeners = new Set<(event: ExplorationEvent) => void>();
  private readonly minimapPingListeners = new Set<(event: MinimapPingEvent) => void>();
  /** Byte encoders handed to the domain body-builders so encoding has one implementation. */
  private readonly codec: WireCodec = {
    u32, cstring, guid: guidHexToBytes, concat,
  };
  private readonly questItems: QuestItemProtocol<Reader>;
  private readonly names: NameQueryProtocol<Reader>;
  private activeJumpInfo: JumpInfo | undefined;
  private activeJumpStartedAt: number | undefined;
  private readonly clockSync = new ServerClockSync();
  private readonly gameClock = new GameTimeClock();
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private lastPingSentAt = 0;
  private readonly playerNames = new Map<string, { name: string; race: number; classId: number; gender: number }>();
  /** Lowercased player name → guild name, accumulated from every SMSG_WHO response. */
  private readonly playerGuildNames = new Map<string, string>();
  private readonly itemInfo = new Map<number, ItemInfo>();
  private readonly questInfo = new Map<number, QuestInfo>();
  private readonly factionStates = new Map<number, { flags: number; standing: number }>();
  private readonly petNames = new Map<number, { name: string; timestamp: number }>();
  private readonly pendingPlayerNameQueries = new Set<string>();
  private readonly pendingItemQueries = new Set<number>();
  private readonly pendingItemPushes: ItemPushResult[] = [];
  private readonly pendingQuestQueries = new Set<number>();
  // Overhead quest ! / ? markers: guid -> DIALOG_STATUS_* (QuestDef.h). Populated by
  // SMSG_QUESTGIVER_STATUS after we query a nearby questgiver, and refreshed whenever the server
  // pushes a new status (quest accepted/completed/turned in).
  private readonly questGiverStatus = new Map<string, number>();
  private readonly pendingQuestStatusQueries = new Set<string>();
  private readonly pendingPetNameQueries = new Set<number>();
  private petSpellState: PetSpellState | undefined;
  private worldStates: Record<number, number> = {};
  private social: SocialSnapshot = { friends: [], ignored: [], who: [], whoOnline: 0, guild: [], guildMotd: '', guildInfoText: '', guildRankRights: [], guildName: '', guildRankNames: [], groupType: 0, group: [], raidTargets: emptyRaidTargets() };
  private readonly simulation = new Simulation();
  private readonly simulationSnapshot = new RenderSnapshotBuffer();
  private readonly workerSimulationSnapshot = new RenderSnapshotBuffer();
  private readonly simulationWorker = SimulationWorkerProxy.tryCreate(simulationWorkerRequested());
  private simulationWorkerActive = this.simulationWorker !== null;
  private simulationWorkerParityErrors: string[] = [];
  private simulationAccumulatorMs = 0;
  private readonly enqueueSimulationDelta = (delta: WorldDelta) => {
    this.simulation.enqueueDelta(delta);
    if (this.simulationWorkerActive) this.simulationWorker?.enqueueDelta(delta);
  };
  private readonly mirrorEntityChange = (change: WorldEntityChange) =>
    emitWorldEntityChangeAsDeltas(change, this.enqueueSimulationDelta);
  private readonly entities = new WorldEntityStore(() => performance.now(), this.mirrorEntityChange);
  private readonly partyVitals = new Map<string, PartyVitals>();
  private readonly playerAuraDurations = new Map<number, { durationMs: number; expiresAt: number }>();
  private readonly spellModifiers = new SpellModifierTable();
  private readonly proficiencyMasks = new Map<number, number>();
  private readonly forcedReactions = new Map<number, number>();
  private pumpStarted = false; private enterWorldStarted = false;
  private closed = false;
  private activeCharacter?: CharacterInfo;
  private controlledMover?: ControlledMoverState;
  private readonly sessionGeneration = nextWorldSessionGeneration++;
  private worldGeneration = 0;
  private readonly unknownOpcodeTelemetry = new UnknownOpcodeTelemetry();

  /** Advance the non-render-owning migration shadow at a deterministic fixed cadence. */
  advanceSimulation(elapsedMs: number): number {
    const fixed = this.simulation.clock.fixedDeltaMs;
    this.simulationAccumulatorMs += Math.max(0, Math.min(250, elapsedMs));
    let steps = 0;
    while (this.simulationAccumulatorMs >= fixed && steps < 8) {
      this.simulation.step();
      this.simulationAccumulatorMs -= fixed;
      steps++;
    }
    if (steps === 8 && this.simulationAccumulatorMs >= fixed) this.simulationAccumulatorMs %= fixed;
    this.simulation.world.events.clear(); // Legacy rendering consumes snapshots; only the Worker consumes edge events.
    if (steps > 0 && this.simulationWorkerActive) this.simulationWorker?.step(steps);
    return steps;
  }

  simulationDiagnostics() {
    this.simulation.writeRenderSnapshot(this.simulationSnapshot);
    return {
      tick: this.simulation.clock.tick,
      timeMs: this.simulation.clock.timeMs,
      entities: this.simulationSnapshot.count,
      legacyEntities: this.entities.size,
      pending: this.simulation.pendingDiagnostics(),
      hash: this.simulation.deterministicHash(),
      worker: {
        requested: simulationWorkerRequested(),
        active: this.simulationWorkerActive,
        tick: this.workerSimulationSnapshot.tick,
        parityErrors: this.simulationWorkerParityErrors.slice(),
        role: 'experimental-render-shadow',
      },
    };
  }

  /** Current fixed-step numeric state consumed by the world renderer. The buffer is reused. */
  getRenderSnapshot(): RenderSnapshotBuffer {
    const synchronous = this.simulation.writeRenderSnapshot(this.simulationSnapshot);
    return this.simulationWorkerActive && this.workerSimulationSnapshot.tick > 0
      ? this.workerSimulationSnapshot
      : synchronous;
  }

  /** Resolve cold/lifecycle metadata for a dense render id. Hot numeric state stays in the snapshot. */
  getEntityByRenderId(renderId: number): WorldEntity | undefined {
    const state = this.simulation.world.getByRenderId(renderId);
    return state ? this.entities.get(state.guid) : undefined;
  }

  /** Compare the legacy packet store against the protocol-neutral simulation projection. */
  simulationParityErrors(): string[] {
    const errors: string[] = [];
    const legacy = this.entities.snapshot();
    if (legacy.length !== this.simulation.world.size) {
      errors.push(`entity count legacy=${legacy.length} simulation=${this.simulation.world.size}`);
    }
    const same = (a: number | undefined, b: number, fallback = 0) =>
      Math.abs((Number.isFinite(a) ? a! : fallback) - b) <= 0.0001;
    for (const entity of legacy) {
      const shadow = this.simulation.world.get(entity.guid);
      if (!shadow) { errors.push(`missing simulation entity ${entity.guid}`); continue; }
      if (!same(entity.x, shadow.position.x) || !same(entity.y, shadow.position.y) || !same(entity.z, shadow.position.z))
        errors.push(`position mismatch ${entity.guid}`);
      if (!same(entity.o, shadow.orientation)) errors.push(`orientation mismatch ${entity.guid}`);
      if ((entity.displayId ?? 0) !== shadow.displayId) errors.push(`display mismatch ${entity.guid}`);
      if (!same(entity.scale, shadow.scale, 1)) errors.push(`scale mismatch ${entity.guid}`);
      if ((entity.health ?? 0) !== shadow.health || (entity.maxHealth ?? 0) !== shadow.maxHealth) errors.push(`health mismatch ${entity.guid}`);
      if ((entity.level ?? 0) !== shadow.level || (entity.faction ?? 0) !== shadow.faction) errors.push(`metadata mismatch ${entity.guid}`);
      if ((entity.unitFlags ?? 0) !== shadow.unitFlags || (entity.dynamicFlags ?? 0) !== shadow.dynamicFlags) errors.push(`flags mismatch ${entity.guid}`);
      if ((entity.auraState ?? 0) !== shadow.auraState) errors.push(`aura state mismatch ${entity.guid}`);
      if ((entity.teleportSeq ?? 0) !== shadow.teleportSeq) errors.push(`teleport sequence mismatch ${entity.guid}`);
      if ((entity.auraSpellIds ?? []).join(',') !== shadow.auraSpellIds.join(',')) errors.push(`aura list mismatch ${entity.guid}`);
    }
    return errors;
  }

  private acceptSimulationWorkerSnapshot(source: TransferableRenderSnapshot): void {
    if (!this.simulationWorkerActive) return;
    const target = this.workerSimulationSnapshot;
    target.ensureCapacity(source.count);
    target.revision = source.tick;
    target.tick = source.tick;
    target.timeMs = source.timeMs;
    target.count = source.count;
    target.renderIds.set(source.renderIds, 0);
    target.positions.set(source.positions, 0);
    target.orientations.set(source.orientations, 0);
    target.displayIds.set(source.displayIds, 0);
    target.scales.set(source.scales, 0);
    target.health.set(source.health, 0);
    target.maxHealth.set(source.maxHealth, 0);
    target.unitFlags.set(source.unitFlags, 0);
    target.dynamicFlags.set(source.dynamicFlags, 0);
    target.teleportSequences.set(source.teleportSequences, 0);
    target.transformVersions.set(source.transformVersions, 0);
    target.appearanceVersions.set(source.appearanceVersions, 0);
    target.combatVersions.set(source.combatVersions, 0);

    const canonical = this.simulation.writeRenderSnapshot(this.simulationSnapshot);
    if (canonical.tick !== source.tick) return;
    const errors: string[] = [];
    if (canonical.count !== source.count) errors.push(`count ${source.count} != ${canonical.count}`);
    const compare = (name: string, worker: ArrayLike<number>, sync: ArrayLike<number>, length: number) => {
      for (let index = 0; index < length && errors.length < 8; index++) {
        if (worker[index] !== sync[index]) errors.push(`${name}[${index}] ${worker[index]} != ${sync[index]}`);
      }
    };
    const count = Math.min(source.count, canonical.count);
    compare('renderIds', source.renderIds, canonical.renderIds, count);
    compare('positions', source.positions, canonical.positions, count * 3);
    compare('orientations', source.orientations, canonical.orientations, count);
    compare('displayIds', source.displayIds, canonical.displayIds, count);
    compare('scales', source.scales, canonical.scales, count);
    compare('health', source.health, canonical.health, count);
    compare('maxHealth', source.maxHealth, canonical.maxHealth, count);
    compare('unitFlags', source.unitFlags, canonical.unitFlags, count);
    compare('dynamicFlags', source.dynamicFlags, canonical.dynamicFlags, count);
    compare('teleportSequences', source.teleportSequences, canonical.teleportSequences, count);
    compare('transformVersions', source.transformVersions, canonical.transformVersions, count);
    compare('appearanceVersions', source.appearanceVersions, canonical.appearanceVersions, count);
    compare('combatVersions', source.combatVersions, canonical.combatVersions, count);
    this.simulationWorkerParityErrors = errors;
    if (errors.length) {
      this.simulationWorkerActive = false;
      this.simulationWorker?.dispose();
      this.progress(`simulation worker diverged (${errors[0]}); using synchronous fallback`);
    }
  }

  private constructor(
    private readonly socket: WorldSocket,
    readonly characters: CharacterInfo[],
    private readonly progress: WorldProgress,
  ) {
    this.simulationWorker?.subscribe((snapshot) => this.acceptSimulationWorkerSnapshot(snapshot));
    this.simulationWorker?.onError((message) => {
      this.simulationWorkerActive = false;
      this.simulationWorkerParityErrors = [`worker error: ${message}`];
      this.progress(`simulation worker disabled (${message}); using synchronous fallback`);
    });
    this.questItems = new QuestItemProtocol({
      reader: (body) => new Reader(body), readGuid: readGuid64, codec: this.codec,
      send: (opcode, body) => this.socket.send(opcode, body),
      itemEntry: (guid) => this.entities.get(guid)?.entry,
      itemInfo: (entry) => this.itemInfo.get(entry),
      gameObjectEntry: (guid) => this.entities.get(guid)?.entry,
      gameObjectInfo: (entry) => this.names?.getGameObject(entry),
      queryGameObject: (entry, guid) => this.names?.queryGameObject(entry, guid),
      playerName: (guid) => this.playerNames.get(guid)?.name,
      queryPlayerName: (guid) => this.queryPlayerName(guid),
      emit: (event) => this.emitInteraction(event), progress: (message) => this.progress(message),
    });
    this.names = new NameQueryProtocol({
      reader: (body) => new Reader(body), codec: this.codec,
      send: (opcode, body) => this.socket.send(opcode, body), progress: (message) => this.progress(message),
      onCreature: (info) => {
        this.emitCombat({ kind: 'creatureQueryResponse', ...info });
        this.emitQuestLog(); this.emitPetData();
      },
      onGameObject: (info) => {
        this.questItems.gameObjectMetadataArrived(info.entry);
        for (const entity of this.entities.snapshot()) {
          if (entity.typeId === TypeID.GAMEOBJECT && entity.entry === info.entry) this.emitEntity(entity);
        }
        this.emitQuestLog();
      },
    });
  }

  static async connect(
    worldProxyUrl: string,
    session: AuthSession,
    realm: RealmInfo,
    progress: WorldProgress = () => {},
  ): Promise<RealmWorldClient> {
    progress('world: connecting');
    const socket = await WorldSocket.open(worldProxyUrl, WORLD_CONNECT_TIMEOUT_MS);
    const challenge = await waitFor(socket, OPCODES.SMSG_AUTH_CHALLENGE, progress);
    const r = new Reader(challenge.body);
    if (challenge.body.length >= 8) r.u32();
    const serverSeed = r.u32();

    progress('world: authenticating');
    await sendAuthSession(socket, session, realm, serverSeed);

    const response = await waitFor(socket, OPCODES.SMSG_AUTH_RESPONSE, progress);
    const result = response.body[0];
    if (result !== AUTH_OK) {
      socket.close();
      throw new Error(`world auth rejected: 0x${result.toString(16)}`);
    }

    progress('world: requesting characters');
    socket.send(OPCODES.CMSG_CHAR_ENUM);
    const characters = parseCharacters(await waitFor(socket, OPCODES.SMSG_CHAR_ENUM, progress));
    progress(`world: ${characters.length} character${characters.length === 1 ? '' : 's'}`);
    return new RealmWorldClient(socket, characters, progress);
  }

  onStats(listener: (stats: WorldUpdateStats) => void) {
    this.statsListeners.add(listener);
    return () => this.statsListeners.delete(listener);
  }

  onEntity(listener: (entity: WorldEntity, change?: WorldEntityChange) => void) {
    this.entityListeners.add(listener);
    return () => this.entityListeners.delete(listener);
  }

  onEntityRemove(listener: (guid: string) => void) {
    this.entityRemoveListeners.add(listener);
    return () => this.entityRemoveListeners.delete(listener);
  }

  onCombat(listener: (event: CombatEvent) => void) {
    this.combatListeners.add(listener);
    return () => this.combatListeners.delete(listener);
  }

  onDeath(listener: (event: DeathEvent) => void) {
    this.deathListeners.add(listener);
    return () => this.deathListeners.delete(listener);
  }

  onNearTeleport(listener: (dest: NearTeleport) => void) {
    this.nearTeleportListeners.add(listener);
    return () => this.nearTeleportListeners.delete(listener);
  }

  onRootState(listener: (event: RootStateEvent) => void) {
    this.rootStateListeners.add(listener);
    return () => this.rootStateListeners.delete(listener);
  }

  onKnockback(listener: (event: KnockbackEvent) => void) {
    this.knockbackListeners.add(listener);
    return () => this.knockbackListeners.delete(listener);
  }

  onSocial(listener: (snapshot: SocialSnapshot) => void) {
    this.socialListeners.add(listener);
    return () => this.socialListeners.delete(listener);
  }

  getSocial() { return this.social; }

  getRaidTargetIndex(guid: string) { return raidTargetIndex(this.social.raidTargets, guid); } canSetRaidTarget() { return this.social.group.length > 0 && (this.social.groupLeaderGuid === this.activeCharacter?.guid || !!this.social.ownAssistant); } canStartReadyCheck() { return this.social.groupType === 1 && this.social.groupLeaderGuid === this.activeCharacter?.guid; } canConvertToRaid() { return this.social.groupType === 0 && this.social.group.length > 0 && this.social.groupLeaderGuid === this.activeCharacter?.guid; } canManageRaidSubgroups() { return this.social.groupType === 1 && this.social.groupLeaderGuid === this.activeCharacter?.guid; }
  setRaidTarget(guid: string, uiIndex: number) { const body = buildRaidTargetUpdate(this.social.raidTargets, guid, uiIndex, guidHexToBytes); if (!this.closed && this.canSetRaidTarget() && body) this.socket.send(OPCODES.MSG_RAID_TARGET_UPDATE, body); } startReadyCheck() { if (!this.closed && this.canStartReadyCheck()) this.socket.send(OPCODES.MSG_RAID_READY_CHECK, buildReadyCheckRequest()); } confirmReadyCheck(ready: boolean) { if (!this.closed && this.social.groupType === 1) this.socket.send(OPCODES.MSG_RAID_READY_CHECK, buildReadyCheckResponse(ready)); } convertToRaid() { if (!this.closed && this.canConvertToRaid()) this.socket.send(OPCODES.CMSG_GROUP_RAID_CONVERT, buildRaidConvertRequest()); } changeRaidSubgroup(name: string, subgroup: number) { const body = buildRaidSubgroupChange(name, subgroup); if (!this.closed && this.canManageRaidSubgroups() && body) this.socket.send(OPCODES.CMSG_GROUP_CHANGE_SUB_GROUP, body); } swapRaidSubgroups(name: string, swapWith: string) { const body = buildRaidSubgroupSwap(name, swapWith); if (!this.closed && this.canManageRaidSubgroups() && body) this.socket.send(OPCODES.CMSG_GROUP_SWAP_SUB_GROUP, body); }

  /** Last-known vitals for an out-of-range party member (SMSG_PARTY_MEMBER_STATS), or undefined. */
  getPartyVitals(guid: string): PartyVitals | undefined { return this.partyVitals.get(guid); }
  private emitSocial() { this.dispatch(this.socialListeners, (listener) => listener(this.social), 'social'); }

  onPartyInvite(listener: (event: PartyInviteEvent) => void) {
    this.partyInviteListeners.add(listener);
    return () => this.partyInviteListeners.delete(listener);
  }

  onPartyCommandResult(listener: (event: PartyCommandResultEvent) => void) {
    this.partyResultListeners.add(listener);
    return () => this.partyResultListeners.delete(listener);
  }

  /** CMSG_GROUP_INVITE: cstring memberName. The server resolves the name and answers with
   *  SMSG_PARTY_COMMAND_RESULT, so never assume the invite succeeded. */
  inviteToParty(name: string) {
    const clean = name.trim();
    if (this.closed || !clean) return;
    this.socket.send(OPCODES.CMSG_GROUP_INVITE, cstring(clean));
  }

  /** CMSG_GROUP_ACCEPT / CMSG_GROUP_DECLINE — both NullClientPacket, empty body. */
  acceptPartyInvite() {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_GROUP_ACCEPT, new Uint8Array(0));
  }

  declinePartyInvite() {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_GROUP_DECLINE, new Uint8Array(0));
  }

  /** CMSG_GROUP_UNINVITE_GUID: u64. Preferred over the by-name form when we hold the guid. */
  uninviteFromParty(guid: string) {
    if (this.closed || !guid) return;
    this.socket.send(OPCODES.CMSG_GROUP_UNINVITE_GUID, guidHexToBytes(guid));
  }

  /** CMSG_GROUP_UNINVITE: cstring memberName — for offline members we only know by name. */
  uninviteFromPartyByName(name: string) {
    const clean = name.trim();
    if (this.closed || !clean) return;
    this.socket.send(OPCODES.CMSG_GROUP_UNINVITE, cstring(clean));
  }

  /**
   * CMSG_GROUP_SET_LEADER. Guarded in vMaNGOS by
   * `#if SUPPORTED_CLIENT_BUILD > CLIENT_BUILD_1_11_2` — Build 5875 qualifies, so this carries
   * an ObjectGuid. Older builds send a name; do not "simplify" this to cstring.
   */
  setPartyLeader(guid: string) {
    if (this.closed || !guid) return;
    this.socket.send(OPCODES.CMSG_GROUP_SET_LEADER, guidHexToBytes(guid));
  }

  /**
   * `/promote <name>` resolves through the group roster because Build 5875 sends a guid, not a
   * name. Returns false when the name is not in our party so the caller can print vanilla's
   * "%s is not in your party."
   */
  setPartyLeaderByName(name: string): boolean {
    const clean = name.trim().toLowerCase();
    const member = this.social.group.find((entry) => entry.name.toLowerCase() === clean);
    if (!member) return false;
    this.setPartyLeader(member.guid);
    return true;
  }

  /** CMSG_LOOT_METHOD: u32 method, u64 masterGuid, u32 threshold. Server rejects method > 4. */
  setLootMethod(method: number, masterGuid: string, threshold: number) {
    if (this.closed || method > 4) return;
    this.socket.send(OPCODES.CMSG_LOOT_METHOD, concat(u32(method), guidHexToBytes(masterGuid), u32(threshold)));
  }

  /** CMSG_GROUP_DISBAND: empty body. Removes US from the group — this is also "leave party". */
  leaveParty() {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_GROUP_DISBAND, new Uint8Array(0));
  }

  // ---- Guild management. Invite/promote/demote/remove carry a cstring name; accept/decline/leave
  // are empty. All command errors return via SMSG_GUILD_COMMAND_RESULT.
  onGuildInvite(listener: (event: GuildInviteEvent) => void) {
    this.guildInviteListeners.add(listener);
    return () => this.guildInviteListeners.delete(listener);
  }

  onGuildCommandResult(listener: (event: GuildCommandResultEvent) => void) {
    this.guildResultListeners.add(listener);
    return () => this.guildResultListeners.delete(listener);
  }

  onGuildEvent(listener: (event: GuildEventNotice) => void) {
    this.guildEventListeners.add(listener);
    return () => this.guildEventListeners.delete(listener);
  }

  private ownGuildRankId() { return this.social.guild.find((member) => member.guid === this.activeCharacter?.guid)?.rankId; }
  canManageGuildRanks() { return this.ownGuildRankId() === 0; }
  canUseGuildRight(right: number) { const rank = this.ownGuildRankId(); return rank !== undefined && guildHasRight(this.social.guildRankRights[rank] ?? 0, right); }

  guildInvite(name: string) {
    const clean = name.trim();
    if (this.closed || !clean) return;
    this.socket.send(OPCODES.CMSG_GUILD_INVITE, cstring(clean));
  }

  acceptGuildInvite() {
    if (!this.closed) this.socket.send(OPCODES.CMSG_GUILD_ACCEPT, new Uint8Array(0));
  }

  declineGuildInvite() {
    if (!this.closed) this.socket.send(OPCODES.CMSG_GUILD_DECLINE, new Uint8Array(0));
  }

  guildInfo() { if (!this.closed) this.socket.send(OPCODES.CMSG_GUILD_INFO, new Uint8Array(0)); }
  guildPromote(name: string) {
    const clean = name.trim();
    if (this.closed || !clean) return;
    this.socket.send(OPCODES.CMSG_GUILD_PROMOTE, cstring(clean));
  }

  guildDemote(name: string) {
    const clean = name.trim();
    if (this.closed || !clean) return;
    this.socket.send(OPCODES.CMSG_GUILD_DEMOTE, cstring(clean));
  }

  guildRemove(name: string) {
    const clean = name.trim();
    if (this.closed || !clean) return;
    this.socket.send(OPCODES.CMSG_GUILD_REMOVE, cstring(clean));
  }

  /** CMSG_GUILD_LEAVE: empty body. The guild master must promote a successor first (server rule). */
  guildLeave() {
    if (!this.closed) this.socket.send(OPCODES.CMSG_GUILD_LEAVE, new Uint8Array(0));
  }

  /** CMSG_GUILD_MOTD: cstring (may be empty to clear). Server caps at GUILD_MOTD_MAX_LENGTH. */
  guildSetMotd(motd: string) {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_GUILD_MOTD, cstring(motd));
  }

  guildSaveRank(rankId: number, rights: number, rankName: string) { const body = buildGuildRankUpdate(rankId, rights, rankName); if (!this.closed && this.canManageGuildRanks() && rankId < this.social.guildRankRights.length && body) this.socket.send(OPCODES.CMSG_GUILD_RANK, body); }
  guildAddRank(rankName: string) { const body = buildGuildAddRank(rankName); if (!this.closed && this.canManageGuildRanks() && this.social.guildRankRights.length < GUILD_RANK_MAX_COUNT && body) this.socket.send(OPCODES.CMSG_GUILD_ADD_RANK, body); }
  guildDeleteLowestRank() { const rankId = this.social.guildRankRights.length - 1; if (!this.closed && this.canManageGuildRanks() && rankId >= GUILD_RANK_MIN_COUNT && !this.social.guild.some((member) => member.rankId === rankId)) this.socket.send(OPCODES.CMSG_GUILD_DEL_RANK, buildGuildDeleteRank()); }
  guildSetPublicNote(name: string, note: string) { const body = buildGuildNote(name, note); if (!this.closed && this.canUseGuildRight(GUILD_RIGHTS.editPublicNote) && body) this.socket.send(OPCODES.CMSG_GUILD_SET_PUBLIC_NOTE, body); }
  guildSetOfficerNote(name: string, note: string) { const body = buildGuildNote(name, note); if (!this.closed && this.canUseGuildRight(GUILD_RIGHTS.editOfficerNote) && body) this.socket.send(OPCODES.CMSG_GUILD_SET_OFFICER_NOTE, body); }
  guildSetInfoText(info: string) { const body = buildGuildInfoText(info); if (!this.closed && this.canUseGuildRight(GUILD_RIGHTS.modifyGuildInfo) && body) this.socket.send(OPCODES.CMSG_GUILD_INFO_TEXT, body); }

  // ---- Duels. A challenge is a cast of spell 7266 on the target player; accept/cancel are empty.
  onDuelRequest(listener: (event: DuelRequestEvent) => void) {
    this.duelRequestListeners.add(listener);
    return () => this.duelRequestListeners.delete(listener);
  }

  onDuelNotice(listener: (event: DuelNotice) => void) {
    this.duelNoticeListeners.add(listener);
    return () => this.duelNoticeListeners.delete(listener);
  }

  /** Challenge a player to a duel — casts spell 7266 on them. */
  challengeDuel(targetGuid: string) {
    if (this.closed || !targetGuid) return;
    this.castSpell(DUEL_SPELL_ID, targetGuid);
  }

  /** CMSG_DUEL_ACCEPTED — raw u64 duel-flag GUID (reversed Build 5875 DuelInfo.cpp: FUN_004d4830). */
  acceptDuel() {
    if (!this.closed) this.socket.send(OPCODES.CMSG_DUEL_ACCEPTED, guidHexToBytes(this.duelFlagGuid));
  }

  /** CMSG_DUEL_CANCELLED — the same u64 duel-flag GUID; also /forfeit after combat begins. */
  cancelDuel() {
    if (!this.closed) this.socket.send(OPCODES.CMSG_DUEL_CANCELLED, guidHexToBytes(this.duelFlagGuid));
  }

  // ---- Inspect. CMSG_INSPECT asks the server; it replies with SMSG_INSPECT (a guid ack) once the
  // target is in range (10 yd) and non-hostile. The gear is read from update fields we already hold.
  onInspect(listener: (event: InspectEvent) => void) {
    this.inspectListeners.add(listener);
    return () => this.inspectListeners.delete(listener);
  }

  /** CMSG_INSPECT: u64 targetGuid. */
  inspect(targetGuid: string) {
    if (this.closed || !targetGuid) return;
    this.socket.send(OPCODES.CMSG_INSPECT, guidHexToBytes(targetGuid));
  }

  /** The item entries the target has equipped (19 slots), read from their VISIBLE_ITEM fields. */
  visibleItemEntries(guid: string): number[] {
    return this.entities.get(guid)?.visibleItemEntries ?? [];
  }

  /** Ensure name/icon/quality is queried for every item the inspected player has equipped. */
  private requestItemInfoForVisibleItems(guid: string) {
    for (const entry of this.entities.get(guid)?.visibleItemEntries ?? []) {
      if (entry > 0) this.requestItemInfo(entry);
    }
  }

  onChat(listener: (event: ChatEvent) => void) {
    this.chatListeners.add(listener);
    return () => this.chatListeners.delete(listener);
  }

  onChannelNotify(listener: (event: ChannelNotifyEvent) => void) {
    this.channelNotifyListeners.add(listener);
    return () => this.channelNotifyListeners.delete(listener);
  }

  /**
   * CMSG_JOIN_CHANNEL — cstring channelName, cstring channelPassword
   * (vMaNGOS Server/Packets/Channel.cpp:3-7).
   *
   * The server refuses any name whose first byte is ASCII and not alphabetic
   * (Handlers/ChannelHandler.cpp:29-36) and answers CHAT_INVALID_NAME_NOTICE, so the same test
   * runs here rather than spending a round trip on a name that cannot work. The slot is not
   * assigned here — it is assigned when the server confirms with CHAT_YOU_JOINED_NOTICE.
   */
  joinChannel(name: string, password = '') {
    const clean = name.trim();
    if (this.closed || !clean) return;
    this.socket.send(OPCODES.CMSG_JOIN_CHANNEL, concat(cstring(clean), cstring(password)));
  }

  /** CMSG_LEAVE_CHANNEL — cstring channelName (Server/Packets/Channel.cpp:9-12). */
  leaveChannel(name: string) {
    const clean = name.trim();
    if (this.closed || !clean) return;
    this.socket.send(OPCODES.CMSG_LEAVE_CHANNEL, cstring(clean));
  }

  /** 1-based slot for a channel name, or 0 when not joined. */
  channelSlotFor(name: string) {
    return this.channelSlots.indexOf(name);
  }

  /** The channel occupying a 1-based slot — what `/1` resolves through. */
  channelNameForSlot(slot: number) {
    return this.channelSlots.nameFor(slot);
  }

  getJoinedChannels() { return this.channelSlots.list(); } listChannel(name: string) { if (!this.closed && name.trim()) this.socket.send(OPCODES.CMSG_CHANNEL_LIST, cstring(name.trim())); }

  /** Return true from the listener to claim playback and take responsibility for `complete()`. */
  onCinematic(listener: (event: CinematicEvent) => boolean | void) {
    this.cinematicListeners.add(listener);
    return () => this.cinematicListeners.delete(listener);
  }

  onLogoutResponse(listener: (event: LogoutResponseEvent) => void) {
    this.logoutResponseListeners.add(listener);
    return () => this.logoutResponseListeners.delete(listener);
  }

  /** SMSG_LOGOUT_CANCEL_ACK — the server accepted CMSG_LOGOUT_CANCEL and un-rooted the player. */
  onLogoutCancelled(listener: () => void) {
    this.logoutCancelListeners.add(listener);
    return () => this.logoutCancelListeners.delete(listener);
  }

  /** SMSG_LOGOUT_COMPLETE — the 20s window elapsed (or the logout was instant) and we are out. */
  onLogoutComplete(listener: () => void) {
    this.logoutCompleteListeners.add(listener);
    return () => this.logoutCompleteListeners.delete(listener);
  }

  onWeather(listener: (event: WeatherEvent) => void) {
    this.weatherListeners.add(listener);
    return () => this.weatherListeners.delete(listener);
  }

  onSound(listener: (event: WorldSoundEvent) => void) {
    this.soundListeners.add(listener);
    return () => this.soundListeners.delete(listener);
  }

  onWorldTransfer(listener: (event: WorldTransferEvent) => void | Promise<void>) {
    this.worldTransferListeners.add(listener);
    return () => this.worldTransferListeners.delete(listener);
  }

  onMirrorTimer(listener: (event: MirrorTimerEvent) => void) {
    this.mirrorTimerListeners.add(listener);
    return () => this.mirrorTimerListeners.delete(listener);
  }

  /**
   * Fires when the connection drops unexpectedly (socket error, failed ping, packet-loop abort).
   * Not fired for a deliberate `close()`. Without this the world simply froze in place with no
   * feedback, because the read loop stops silently and never reconnects.
   */
  onDisconnect(listener: (reason: string) => void) {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  /** Live server time-of-day as a Light.dbc half-minute step (0..2880), or null until synced. */
  gameTimeHalfMinutes(): number | null {
    return this.gameClock.halfMinuteStep(performance.now());
  }

  /** Fires whenever SMSG_INITIAL_SPELLS or SMSG_ACTION_BUTTONS (re)arrive. */
  onActionData(listener: () => void) {
    this.actionDataListeners.add(listener);
    return () => this.actionDataListeners.delete(listener);
  }

  onAura(listener: (unitGuid: string, auras: readonly AuraSlot[]) => void) {
    this.auraListeners.add(listener);
    return () => this.auraListeners.delete(listener);
  }

  onWorldState(listener: (states: Readonly<Record<number, number>>) => void) {
    this.worldStateListeners.add(listener);
    return () => this.worldStateListeners.delete(listener);
  }

  onInventoryData(listener: (snapshot: InventorySnapshot) => void) {
    this.inventoryListeners.add(listener);
    return () => this.inventoryListeners.delete(listener);
  }

  onSkillData(listener: (snapshot: SkillSnapshot) => void) {
    this.skillListeners.add(listener);
    return () => this.skillListeners.delete(listener);
  }

  onHonorData(listener: (snapshot: HonorSnapshot) => void) {
    this.honorListeners.add(listener);
    return () => this.honorListeners.delete(listener);
  }

  onReputationData(listener: (snapshot: ReputationSnapshot) => void) {
    this.reputationListeners.add(listener);
    return () => this.reputationListeners.delete(listener);
  }

  onPetData(listener: (snapshot: PetSnapshot) => void) {
    this.petListeners.add(listener);
    return () => this.petListeners.delete(listener);
  }

  onQuestLog(listener: (snapshot: QuestLogSnapshot) => void) {
    this.questLogListeners.add(listener);
    return () => this.questLogListeners.delete(listener);
  }

  onQuestProgress(listener: (event: QuestProgressEvent) => void) {
    this.questProgressListeners.add(listener);
    return () => this.questProgressListeners.delete(listener);
  }

  onInteraction(listener: (event: InteractionEvent) => void) {
    this.interactionListeners.add(listener);
    return () => this.interactionListeners.delete(listener);
  }

  onLootRoll(listener: (event: LootRollEvent) => void) {
    this.lootRollListeners.add(listener);
    return () => this.lootRollListeners.delete(listener);
  }

  /** SMSG_EXPLORATION_EXPERIENCE — a newly discovered area, with the XP it granted. */
  onExploration(listener: (event: ExplorationEvent) => void) {
    this.explorationListeners.add(listener);
    return () => this.explorationListeners.delete(listener);
  }

  /** MSG_MINIMAP_PING relayed from another group member. */
  onMinimapPing(listener: (event: MinimapPingEvent) => void) {
    this.minimapPingListeners.add(listener);
    return () => this.minimapPingListeners.delete(listener);
  }

  getKnownSpells(): readonly number[] {
    return this.knownSpells;
  }

  getSpellModifierValues(
    kind: SpellModifierKind,
    modOp: number,
    familyFlagsLow: number,
    familyFlagsHigh: number,
  ) {
    return this.spellModifiers.valuesForMask(
      kind,
      modOp,
      familyFlagsLow,
      familyFlagsHigh,
    );
  }

  getProficiencyMask(itemClass: number) {
    return this.proficiencyMasks.get(itemClass) ?? 0;
  }

  getForcedReaction(factionId: number) {
    return this.forcedReactions.get(factionId);
  }

  getActionButtons(): readonly ActionButton[] {
    return this.actionButtons;
  }

  learnTalent(talentId: number, requestedRank: number) {
    if (this.closed || talentId <= 0 || requestedRank < 0) return;
    this.socket.send(OPCODES.CMSG_LEARN_TALENT, concat(u32(talentId >>> 0), u32(requestedRank >>> 0)));
  }

  getEntities(bounds?: { minX: number; minY: number; maxX: number; maxY: number }) {
    return bounds ? this.entities.queryBounds(bounds) : this.entities.snapshot();
  }

  /** Vanilla RepopMe(): release the dead player's spirit. Body is empty. */
  releaseSpirit() {
    if (!this.closed) this.socket.send(OPCODES.CMSG_REPOP_REQUEST);
  }

  /** Request the corpse coordinates used by Vanilla's map marker. */
  queryCorpse() {
    if (!this.closed) this.socket.send(OPCODES.MSG_CORPSE_QUERY);
  }

  /** Vanilla RetrieveCorpse(): body is the raw corpse u64 GUID. */
  reclaimCorpse(corpseGuid: string) {
    if (!this.closed && corpseGuid) this.socket.send(OPCODES.CMSG_RECLAIM_CORPSE, guidHexToBytes(corpseGuid));
  }

  respondResurrect(resurrectorGuid: string, accept: boolean) {
    if (this.closed || !resurrectorGuid) return;
    this.socket.send(OPCODES.CMSG_RESURRECT_RESPONSE, concat(
      guidHexToBytes(resurrectorGuid),
      new Uint8Array([accept ? 1 : 0]),
    ));
  }

  /** Confirm a spirit-healer resurrect (AcceptXPLoss in Vanilla FrameXML). Body is the healer GUID. */
  spiritHealerActivate(healerGuid: string) {
    if (!this.closed && healerGuid) this.socket.send(OPCODES.CMSG_SPIRIT_HEALER_ACTIVATE, guidHexToBytes(healerGuid));
  }

  getEntity(guid: string) {
    return this.entities.get(guid);
  }

  getItemInfo(entry: number): ItemInfo | undefined {
    return this.itemInfo.get(entry);
  }

  requestItemInfo(entry: number) {
    if (entry > 0 && !this.itemInfo.has(entry)) this.queryItem(entry);
  }

  getQuestInfo(questId: number): QuestInfo | undefined {
    return this.questInfo.get(questId);
  }

  getReputation(): ReputationSnapshot {
    const player = this.activeCharacter ? this.entities.get(this.activeCharacter.guid) : undefined;
    const watchedRaw = signedU32(player?.fields.get(PLAYER_FIELD_WATCHED_FACTION_INDEX) ?? 0xffffffff);
    const watchedFactionIndex = watchedRaw >= 0 ? watchedRaw : -1;
    const factions = Array.from(this.factionStates.entries())
      .map(([reputationListId, state]) => makeReputationState(reputationListId, state.flags, state.standing, watchedFactionIndex))
      .filter((state) => state.visible && !state.hidden && !state.forcedInvisible)
      .sort((a, b) => a.reputationListId - b.reputationListId);
    return { watchedFactionIndex, factions };
  }

  getPet(): PetSnapshot {
    const player = this.activeCharacter ? this.entities.get(this.activeCharacter.guid) : undefined, playerGuid = this.activeCharacter?.guid;
    let petGuid = player ? guidField(player.fields, UNIT_FIELD_SUMMON) : undefined;
    let pet = petGuid ? this.entities.get(petGuid) : undefined;
    if (!pet && playerGuid) {
      pet = this.entities
        .snapshot()
        .find((entity) => entity.typeId === TypeID.UNIT && guidField(entity.fields, UNIT_FIELD_SUMMONEDBY) === playerGuid);
      petGuid = pet?.guid;
    }
    if (!pet || !petGuid) return {};
    const petNumber = pet.fields.get(UNIT_FIELD_PETNUMBER);
    const nameTimestamp = pet.fields.get(UNIT_FIELD_PET_NAME_TIMESTAMP);
    if (petNumber && (!this.petNames.has(petNumber) || this.petNames.get(petNumber)!.timestamp !== nameTimestamp)) {
      this.queryPetName(petNumber, petGuid);
    }
    const happiness = pet.fields.get(UNIT_FIELD_POWER5) ?? pet.powers?.[4];
    const maxHappiness = pet.fields.get(UNIT_FIELD_MAXPOWER5) ?? pet.maxPowers?.[4] ?? PET_HAPPINESS_MAX;
    const happinessLevel =
      happiness === undefined
        ? undefined
        : happiness < PET_HAPPINESS_LEVEL_SIZE
          ? 1
          : happiness >= PET_HAPPINESS_LEVEL_SIZE * 2
            ? 3
            : 2;
    const loyalty = byteAt(pet.fields.get(UNIT_FIELD_BYTES_1) ?? 0, UNIT_BYTES_1_OFFSET_PET_LOYALTY);
    const cachedName = petNumber ? this.petNames.get(petNumber) : undefined;
    const creature = pet.entry ? this.names.getCreature(pet.entry) : undefined;
    if (pet.entry && !creature) this.names.queryCreature(pet.entry, petGuid);
    return {
      entry: pet.entry, petFamily: creature?.petFamily, trainingPoints: decodePetTrainingPoints(pet.fields.get(UNIT_TRAINING_POINTS)),
      guid: petGuid,
      name: cachedName?.name,
      petNumber,
      nameTimestamp,
      ownerGuid: guidField(pet.fields, UNIT_FIELD_SUMMONEDBY),
      level: pet.fields.get(UNIT_FIELD_LEVEL) ?? pet.level,
      health: pet.health,
      maxHealth: pet.maxHealth,
      happiness,
      maxHappiness,
      happinessLevel,
      loyalty: loyalty || undefined,
      loyaltyName: loyalty >= 1 && loyalty <= PET_LOYALTY_NAMES.length ? PET_LOYALTY_NAMES[loyalty - 1] : undefined,
      experience: pet.fields.get(UNIT_FIELD_PETEXPERIENCE),
      nextLevelExperience: pet.fields.get(UNIT_FIELD_PETNEXTLEVELEXP),
      spellState: this.petSpellState?.guid === petGuid ? this.petSpellState : undefined,
    };
  }

  getBankState(): BankState | undefined {
    if (!this.currentBankGuid || !this.activeCharacter) return undefined;
    const player = this.entities.get(this.activeCharacter.guid);
    if (!player) return undefined;
    const describe = (guid: string | undefined): BankItem | undefined => {
      const item = this.inventoryItem(guid);
      if (!item?.entry) return undefined;
      return {
        guid: item.guid,
        entry: item.entry,
        count: item.count,
        displayInfoId: item.info?.displayInfoId,
      };
    };
    const purchasedBagSlots = Math.min(6, byteAt(player.fields.get(PLAYER_BYTES_2) ?? 0, 2));
    return {
      guid: this.currentBankGuid,
      slots: Array.from({ length: BANK_SLOT_COUNT }, (_, index) =>
        describe(guidField(player.fields, PLAYER_FIELD_BANK_SLOT_1 + index * 2))),
      bags: Array.from({ length: 6 }, (_, index) =>
        describe(guidField(player.fields, PLAYER_FIELD_BANKBAG_SLOT_1 + index * 2))),
      purchasedBagSlots,
      nextSlotCost: BANK_BAG_SLOT_PRICES[purchasedBagSlots] ?? 0,
      playerMoney: this.playerMoney(player),
    };
  }

  private playerMoney(player?: WorldEntity): number {
    const authoritative = player?.fields.get(PLAYER_FIELD_COINAGE);
    if (authoritative !== undefined) {
      this.lastKnownMoney = authoritative;
      return authoritative;
    }
    return this.lastKnownMoney ?? 0;
  }

  private creditLootMoneyFallback(amount: number, lootGuid?: string) {
    if (amount <= 0 || (lootGuid !== undefined && lootGuid === this.lastCreditedLootMoneyGuid)) return;
    const player = this.activeCharacter ? this.entities.get(this.activeCharacter.guid) : undefined;
    if (player?.fields.get(PLAYER_FIELD_COINAGE) !== undefined) return;
    this.lastKnownMoney = (this.lastKnownMoney ?? 0) + amount;
    this.lastCreditedLootMoneyGuid = lootGuid;
  }

  getTradeState(): TradeState | undefined {
    return this.tradeState ? {
      ...this.tradeState,
      playerItems: [...this.tradeState.playerItems],
      targetItems: [...this.tradeState.targetItems],
    } : undefined;
  }

  getInventory(): InventorySnapshot {
    const player = this.activeCharacter ? this.entities.get(this.activeCharacter.guid) : undefined;
    const equipment: InventorySlot[] = [];
    const bags: InventoryBag[] = [];
    if (!player) {
      return {
        equipment: EQUIPMENT_SLOT_LABELS.map((label, index) => ({
          container: 'equipment',
          index,
          protocolBag: INVENTORY_SLOT_BAG_0,
          protocolSlot: index,
          label,
        })),
        bags: [
          {
            index: 0,
            protocolBag: INVENTORY_SLOT_BAG_0,
            label: 'Backpack',
            isBackpack: true,
            size: BACKPACK_SLOT_COUNT,
            slots: Array.from({ length: BACKPACK_SLOT_COUNT }, (_, index) => ({
              container: 'backpack' as const,
              index,
              protocolBag: INVENTORY_SLOT_BAG_0,
              protocolSlot: INVENTORY_SLOT_ITEM_START + index,
              label: `Backpack ${index + 1}`,
            })),
          },
        ],
        keyring: buildKeyringBag(0),
        money: 0,
      };
    }

    const money = this.playerMoney(player);

    for (let index = 0; index < EQUIPMENT_SLOT_COUNT; index++) {
      equipment.push(
        this.inventorySlot(
          'equipment',
          index,
          INVENTORY_SLOT_BAG_0,
          index,
          EQUIPMENT_SLOT_LABELS[index] ?? `Equip ${index + 1}`,
          guidField(player.fields, PLAYER_FIELD_INV_SLOT_HEAD + index * 2),
        ),
      );
    }

    const backpackSlots = Array.from({ length: BACKPACK_SLOT_COUNT }, (_, index) =>
      this.inventorySlot(
        'backpack',
        index,
        INVENTORY_SLOT_BAG_0,
        INVENTORY_SLOT_ITEM_START + index,
        `Backpack ${index + 1}`,
        guidField(player.fields, PLAYER_FIELD_PACK_SLOT_1 + index * 2),
      ),
    );
    bags.push({
      index: 0,
      protocolBag: INVENTORY_SLOT_BAG_0,
      label: 'Backpack',
      isBackpack: true,
      size: BACKPACK_SLOT_COUNT,
      slots: backpackSlots,
    });

    for (let bagIndex = 0; bagIndex < INVENTORY_BAG_SLOT_COUNT; bagIndex++) {
      const bagGuid = guidField(player.fields, PLAYER_FIELD_INV_SLOT_HEAD + (EQUIPMENT_SLOT_COUNT + bagIndex) * 2);
      const bagItem = this.inventoryItem(bagGuid);
      const bagEntity = bagGuid ? this.entities.get(bagGuid) : undefined;
      const size = Math.max(0, Math.min(36, bagEntity?.fields.get(CONTAINER_FIELD_NUM_SLOTS) ?? bagItem?.info?.containerSlots ?? 0));
      const protocolBag = INVENTORY_SLOT_BAG_START + bagIndex;
      const slots = Array.from({ length: size }, (_, slotIndex) =>
        this.inventorySlot(
          'bag',
          slotIndex,
          protocolBag,
          slotIndex,
          `Bag ${bagIndex + 1} Slot ${slotIndex + 1}`,
          bagEntity ? guidField(bagEntity.fields, CONTAINER_FIELD_SLOT_1 + slotIndex * 2) : undefined,
        ),
      );
      bags.push({
        index: bagIndex + 1,
        protocolBag,
        label: `Bag ${bagIndex + 1}`,
        isBackpack: false,
        itemGuid: bagGuid,
        item: bagItem,
        size,
        slots,
      });
    }

    const keyring = buildKeyringBag(player.level ?? this.activeCharacter?.level ?? 0, (slot) => this.inventorySlot('keyring', slot.index, slot.protocolBag, slot.protocolSlot, slot.label, guidField(player.fields, slot.field)));
    return { equipment, bags, keyring, money };
  }
  /**
   * Dumps the raw inventory data-layer state for QA. Exposed on the client as
   * `__wowInventoryDebug()`. Lets the user paste exact browser state (player
   * fields, equipped-bag GUIDs, container objects, contents) so we can compare
   * against the real 1.12.1 client without guessing from screenshots.
   *
   * Slot layout (all under INVENTORY_SLOT_BAG_0 = 255):
   *   equipment   slots 0-18   -> PLAYER_FIELD_INV_SLOT_HEAD + slot*2
   *   equipped bags slots 19-22 -> PLAYER_FIELD_INV_SLOT_HEAD + slot*2
   *   backpack    slots 23-38  -> PLAYER_FIELD_PACK_SLOT_1 + (slot-23)*2
   * Equipped-bag contents come from the CONTAINER object's
   *   CONTAINER_FIELD_SLOT_1 + slotIndex*2.
   */
  inventoryDebug(): InventoryDebugSnapshot {
    const player = this.activeCharacter ? this.entities.get(this.activeCharacter.guid) : undefined;
    if (!player) {
      const empty: InventoryDebugSnapshot = {
        playerGuid: this.activeCharacter?.guid,
        playerEntityPresent: false,
        equipment: [],
        backpack: [],
        bags: [],
        warnings: ['no active player entity present'],
      };
      // eslint-disable-next-line no-console
      console.warn('[inventoryDebug] no active player entity present');
      return empty;
    }

    const warnings: string[] = [];
    const describeItem = (guid: string | undefined) => {
      if (!guid || guid === '0000000000000000') return { guid: undefined };
      const entity = this.entities.get(guid);
      const entry = entity?.entry ?? entity?.fields.get(OBJECT_FIELD_ENTRY);
      return {
        guid,
        present: !!entity,
        typeId: entity?.typeId,
        entry,
        name: entry ? this.itemInfo.get(entry)?.name : undefined,
      };
    };

    const equipment = Array.from({ length: EQUIPMENT_SLOT_COUNT }, (_, slot) => ({
      slot,
      ...describeItem(guidField(player.fields, PLAYER_FIELD_INV_SLOT_HEAD + slot * 2)),
    }));

    const backpack = Array.from({ length: BACKPACK_SLOT_COUNT }, (_, index) => ({
      slot: INVENTORY_SLOT_ITEM_START + index,
      ...describeItem(guidField(player.fields, PLAYER_FIELD_PACK_SLOT_1 + index * 2)),
    }));

    const bags = Array.from({ length: INVENTORY_BAG_SLOT_COUNT }, (_, bagIndex) => {
      const equippedSlot = EQUIPMENT_SLOT_COUNT + bagIndex; // 19..22
      const bagGuid = guidField(player.fields, PLAYER_FIELD_INV_SLOT_HEAD + equippedSlot * 2);
      const protocolBag = INVENTORY_SLOT_BAG_START + bagIndex; // 19..22
      if (!bagGuid || bagGuid === '0000000000000000') {
        return { equippedSlot, protocolBag, equipped: false as const };
      }
      const bagEntity = this.entities.get(bagGuid);
      const bagItem = this.inventoryItem(bagGuid);
      if (!bagEntity) {
        warnings.push(
          `equipped bag in slot ${equippedSlot} (guid ${bagGuid}) has NO container entity — contents unknown until the CONTAINER object arrives`,
        );
      } else if (bagEntity.typeId !== TypeID.CONTAINER) {
        warnings.push(
          `equipped bag in slot ${equippedSlot} (guid ${bagGuid}) entity typeId=${bagEntity.typeId}, expected CONTAINER(${TypeID.CONTAINER})`,
        );
      }
      const numSlots = bagEntity?.fields.get(CONTAINER_FIELD_NUM_SLOTS);
      const fallbackSlots = bagItem?.info?.containerSlots;
      const size = numSlots ?? fallbackSlots;
      const contents = bagEntity
        ? Array.from({ length: Math.max(0, Math.min(36, size ?? 0)) }, (_, slotIndex) => ({
            slotIndex,
            ...describeItem(guidField(bagEntity.fields, CONTAINER_FIELD_SLOT_1 + slotIndex * 2)),
          }))
        : undefined;
      return {
        equippedSlot,
        protocolBag,
        equipped: true as const,
        bagGuid,
        containerEntityPresent: !!bagEntity,
        typeId: bagEntity?.typeId,
        entry: bagEntity?.entry ?? bagItem?.entry,
        name: bagItem?.info?.name,
        numSlotsField: numSlots,
        containerSlotsFromTemplate: fallbackSlots,
        contents,
      };
    });

    const snapshot: InventoryDebugSnapshot = {
      playerGuid: this.activeCharacter?.guid,
      playerEntityPresent: true,
      money: {
        field: PLAYER_FIELD_COINAGE,
        authoritative: player.fields.get(PLAYER_FIELD_COINAGE),
        fallback: this.lastKnownMoney,
        rendered: this.playerMoney(player),
      },
      equipment,
      backpack,
      bags,
      warnings,
    };
    // eslint-disable-next-line no-console
    console.log('[inventoryDebug]', JSON.stringify(snapshot, null, 2));
    return snapshot;
  }

  getSkills(): SkillSnapshot {
    const player = this.activeCharacter ? this.entities.get(this.activeCharacter.guid) : undefined;
    const skills: SkillLine[] = [];
    if (!player) return { skills };

    for (let slot = 0; slot < PLAYER_MAX_SKILLS; slot++) {
      const base = PLAYER_SKILL_INFO_1_1 + slot * SKILL_SLOT_FIELD_COUNT;
      const idStep = player.fields.get(base) ?? 0;
      const skillId = idStep & 0xffff;
      if (!skillId) continue;
      const valueMax = player.fields.get(base + 1) ?? 0;
      const bonus = player.fields.get(base + 2) ?? 0;
      skills.push({
        slot,
        skillId,
        step: (idStep >>> 16) & 0xffff,
        value: valueMax & 0xffff,
        max: (valueMax >>> 16) & 0xffff,
        tempBonus: signed16(bonus),
        permBonus: signed16(bonus >>> 16),
      });
    }

    return { skills };
  }

  /**
   * Current combo points on the player's target (0..5). Vanilla clamps to 5 server-side
   * (Player.cpp:19194) and clears them when the combo target changes, so the client only mirrors
   * the byte — it never accumulates or decays points locally.
   */
  getComboPoints(): number {
    const player = this.activeCharacter ? this.entities.get(this.activeCharacter.guid) : undefined;
    const fields = player?.fields;
    if (!fields) return 0;
    return readComboPointState(fields, PLAYER_FIELD_LAYOUT_SHIFT).points;
  }

  getComboTargetGuid(): string | undefined {
    const player = this.activeCharacter ? this.entities.get(this.activeCharacter.guid) : undefined;
    return player ? readComboPointState(player.fields, PLAYER_FIELD_LAYOUT_SHIFT).targetGuid : undefined;
  }

  /** Live capture to settle which PLAYER_FIELD_BYTES index this realm actually uses. */
  comboPointDebug() {
    const player = this.activeCharacter ? this.entities.get(this.activeCharacter.guid) : undefined;
    const fields = player?.fields;
    const dump = (field: number) => {
      const raw = fields?.get(field);
      return { field: `0x${field.toString(16)}`, raw, bytes: raw === undefined ? undefined : [0, 1, 2, 3].map((b) => (raw >>> (b * 8)) & 0xff) };
    };
    return {
      resolved: this.getComboPoints(),
      comboTargetGuid: this.getComboTargetGuid(),
      shifted: dump(PLAYER_FIELD_BYTES),
      stockAliasOnly: dump(STOCK_PLAYER_FIELD_BYTES_ALIAS),
    };
  }

  getHonor(): HonorSnapshot {
    const player = this.activeCharacter ? this.entities.get(this.activeCharacter.guid) : undefined;
    const fields = player?.fields;
    const pair = (field: number) => {
      const value = fields?.get(field) ?? 0;
      return { low: value & 0xffff, high: (value >>> 16) & 0xffff };
    };
    const playerBytes = fields?.get(PLAYER_FIELD_BYTES) ?? 0;
    const playerBytes2 = fields?.get(PLAYER_FIELD_BYTES2) ?? 0;
    const session = pair(PLAYER_FIELD_SESSION_KILLS);
    return {
      highestRank: (playerBytes >>> 24) & 0xff,
      rankProgress: playerBytes2 & 0xff,
      sessionHonorableKills: session.low,
      sessionDishonorableKills: session.high,
      yesterdayHonorableKills: fields?.get(PLAYER_FIELD_YESTERDAY_KILLS) ?? 0,
      yesterdayDishonorableKills: 0,
      lastWeekHonorableKills: fields?.get(PLAYER_FIELD_LAST_WEEK_KILLS) ?? 0,
      lastWeekDishonorableKills: 0,
      thisWeekHonorableKills: fields?.get(PLAYER_FIELD_THIS_WEEK_KILLS) ?? 0,
      thisWeekDishonorableKills: 0,
      thisWeekContribution: fields?.get(PLAYER_FIELD_THIS_WEEK_CONTRIBUTION) ?? 0,
      lifetimeHonorableKills: fields?.get(PLAYER_FIELD_LIFETIME_HONORABLE_KILLS) ?? 0,
      lifetimeDishonorableKills: fields?.get(PLAYER_FIELD_LIFETIME_DISHONORABLE_KILLS) ?? 0,
      yesterdayContribution: fields?.get(PLAYER_FIELD_YESTERDAY_CONTRIBUTION) ?? 0,
      lastWeekContribution: fields?.get(PLAYER_FIELD_LAST_WEEK_CONTRIBUTION) ?? 0,
      lastWeekRank: fields?.get(PLAYER_FIELD_LAST_WEEK_RANK) ?? 0,
    };
  }

  getExploredZones(): ExploredZonesSnapshot {
    const player = this.activeCharacter ? this.entities.get(this.activeCharacter.guid) : undefined;
    const bits: number[] = [];
    for (let i = 0; i < PLAYER_EXPLORED_ZONES_COUNT; i++) {
      bits.push(player?.fields.get(PLAYER_EXPLORED_ZONES_1 + i) ?? 0);
    }
    return { bits };
  }

  getQuestLog(): QuestLogSnapshot {
    const player = this.activeCharacter ? this.entities.get(this.activeCharacter.guid) : undefined;
    const entries: QuestLogEntry[] = [];
    if (!player) return { capacity: MAX_QUEST_LOG_SIZE, entries };

    for (let slot = 0; slot < MAX_QUEST_LOG_SIZE; slot++) {
      const base = PLAYER_QUEST_LOG_1_1 + slot * QUEST_LOG_SLOT_FIELD_COUNT;
      const questId = player.fields.get(base) ?? 0;
      if (!questId) continue;
      const countState = player.fields.get(base + 1) ?? 0;
      const timer = player.fields.get(base + 2) ?? 0;
      const state = (countState >>> 24) & 0xff;
      entries.push({
        slot,
        questId,
        countState,
        objectiveCounts: [
          countState & 0x3f,
          (countState >>> 6) & 0x3f,
          (countState >>> 12) & 0x3f,
          (countState >>> 18) & 0x3f,
        ],
        state,
        complete: (state & QUEST_STATE_COMPLETE) !== 0,
        failed: (state & QUEST_STATE_FAIL) !== 0,
        timer,
        info: this.questInfo.get(questId),
      });
    }

    return { capacity: MAX_QUEST_LOG_SIZE, entries };
  }

  getStats(): WorldUpdateStats {
    return { ...this.stats, lastClientMove: this.stats.lastClientMove ? { ...this.stats.lastClientMove } : undefined };
  }

  private inventorySlot(
    container: InventorySlot['container'],
    index: number,
    protocolBag: number,
    protocolSlot: number,
    label: string,
    itemGuid?: string,
  ): InventorySlot {
    const item = this.inventoryItem(itemGuid);
    return {
      container,
      index,
      protocolBag,
      protocolSlot,
      label,
      itemGuid,
      item,
    };
  }

  private inventoryItem(guid: string | undefined): InventoryItem | undefined {
    if (!guid) return undefined;
    const entity = this.entities.get(guid);
    const entry = entity?.entry ?? entity?.fields.get(OBJECT_FIELD_ENTRY);
    if (entry) this.queryItem(entry);
    return {
      guid,
      typeId: entity?.typeId,
      entry,
      count: Math.max(1, entity?.fields.get(ITEM_FIELD_STACK_COUNT) ?? 1),
      durability: entity?.fields.get(ITEM_FIELD_DURABILITY),
      maxDurability: entity?.fields.get(ITEM_FIELD_MAXDURABILITY),
      durationSeconds: entity?.itemExpiresAt
        ? Math.max(0, Math.ceil((entity.itemExpiresAt - Date.now()) / 1000))
        : entity?.itemDurationSeconds,
      enchantments: entity?.itemEnchantments
        ?.filter((enchantment) => enchantment.enchantId > 0)
        .map((enchantment) => ({
          enchantId: enchantment.enchantId,
          durationSeconds: enchantment.expiresAt
            ? Math.max(0, Math.ceil((enchantment.expiresAt - Date.now()) / 1000))
            : enchantment.durationMs > 0
              ? Math.ceil(enchantment.durationMs / 1000)
              : undefined,
        })),
      info: entry ? this.itemInfo.get(entry) : undefined,
    };
  }

  private isInventoryRelevantEntity(entity: WorldEntity) {
    return (
      entity.guid === this.activeCharacter?.guid ||
      entity.typeId === TypeID.ITEM ||
      entity.typeId === TypeID.CONTAINER
    );
  }

  private isQuestLogField(field: number) {
    const first = PLAYER_QUEST_LOG_1_1;
    const last = PLAYER_QUEST_LOG_1_1 + MAX_QUEST_LOG_SIZE * QUEST_LOG_SLOT_FIELD_COUNT;
    return field >= first && field < last;
  }

  private isSkillField(field: number) {
    const first = PLAYER_SKILL_INFO_1_1;
    const last = PLAYER_SKILL_INFO_1_1 + PLAYER_MAX_SKILLS * SKILL_SLOT_FIELD_COUNT;
    return field >= first && field < last;
  }

  private isHonorField(field: number) {
    return (
      field === PLAYER_FIELD_BYTES ||
      field === PLAYER_FIELD_SESSION_KILLS ||
      field === PLAYER_FIELD_YESTERDAY_KILLS ||
      field === PLAYER_FIELD_LAST_WEEK_KILLS ||
      field === PLAYER_FIELD_THIS_WEEK_KILLS ||
      field === PLAYER_FIELD_THIS_WEEK_CONTRIBUTION ||
      field === PLAYER_FIELD_LIFETIME_HONORABLE_KILLS ||
      field === PLAYER_FIELD_LIFETIME_DISHONORABLE_KILLS ||
      field === PLAYER_FIELD_YESTERDAY_CONTRIBUTION ||
      field === PLAYER_FIELD_LAST_WEEK_CONTRIBUTION ||
      field === PLAYER_FIELD_LAST_WEEK_RANK ||
      field === PLAYER_FIELD_BYTES2
    );
  }

  private petControlHint(guid: string): PetControlHint {
    if (!guid) return undefined;
    const entity = this.entities.get(guid);
    if (entity?.possessed) return 'possession';
    if (entity?.charmedByGuid) return 'charm';
    return 'pet';
  }

  /**
   * Re-derive the pet-spell layout after the control flags that describe it arrive. SMSG_PET_SPELLS
   * is a direct send; UNIT_FLAG_POSSESSED and UNIT_FIELD_CHARMEDBY ride the batched update stream,
   * so the packet is always decoded before the flags exist.
   */
  private repriseControlLayout() {
    const state = this.petSpellState;
    if (!state) return false;
    const next = repriseWithControlHint(state, this.petControlHint(state.guid));
    if (next === state) return false;
    this.petSpellState = next;
    return true;
  }

  private isPetField(field: number) {
    return (
      field === UNIT_FIELD_SUMMON ||
      field === UNIT_FIELD_SUMMON + 1 ||
      field === UNIT_FIELD_SUMMONEDBY ||
      field === UNIT_FIELD_SUMMONEDBY + 1 ||
      field === UNIT_FIELD_POWER5 ||
      field === UNIT_FIELD_MAXPOWER5 ||
      field === UNIT_FIELD_LEVEL ||
      field === UNIT_FIELD_BYTES_1 ||
      field === UNIT_FIELD_PETNUMBER ||
      field === UNIT_FIELD_PET_NAME_TIMESTAMP ||
      field === UNIT_FIELD_PETEXPERIENCE || field === UNIT_FIELD_PETNEXTLEVELEXP ||
      field === UNIT_TRAINING_POINTS
    );
  }

  private isPetRelevantEntity(entity: WorldEntity) {
    if (entity.guid === this.activeCharacter?.guid) return true;
    const ownerGuid = guidField(entity.fields, UNIT_FIELD_SUMMONEDBY);
    if (ownerGuid && ownerGuid === this.activeCharacter?.guid) return true;
    const player = this.activeCharacter ? this.entities.get(this.activeCharacter.guid) : undefined;
    const summonGuid = player ? guidField(player.fields, UNIT_FIELD_SUMMON) : undefined;
    return !!summonGuid && entity.guid === summonGuid;
  }

  private hasInitialWorldVisibility(activeGuid: string, position?: Pick<WorldPosition, 'x' | 'y'>) {
    return this.entities
      .snapshot()
      .some((entity) => {
        if (entity.guid === activeGuid) return false;
        if (
          entity.typeId !== 3 /* UNIT */ &&
          entity.typeId !== 5 /* GAMEOBJECT */ &&
          entity.typeId !== 6 /* DYNAMICOBJECT */ &&
          entity.typeId !== 7 /* CORPSE */
        ) {
          return false;
        }
        if (!position) return true;
        if (entity.x === undefined || entity.y === undefined) return false;
        return Math.hypot(entity.x - position.x, entity.y - position.y) <= 220;
      });
  }

  getClockDiagnostics() {
    return this.clockSync.diagnostics();
  }

  getConnectionDiagnostics() {
    const lastMove = this.stats.lastClientMove;
    return {
      closed: this.closed,
      pumpStarted: this.pumpStarted,
      lastPingSentAgoMs: this.lastPingSentAt ? Math.round(performance.now() - this.lastPingSentAt) : undefined,
      // Movement-visibility triage: does the client emit moves, and does the server stream new
      // entities in response? clientMovementPackets climbing + postLoginEntityCreates flat while
      // walking into mobs => server isn't relocating us (H1). Both climbing => streaming works.
      movement: {
        clientMovementPacketsSent: this.stats.clientMovementPackets,
        lastClientMove: lastMove
          ? { kind: lastMove.kind, x: Math.round(lastMove.x), y: Math.round(lastMove.y), z: Math.round(lastMove.z), agoMs: Date.now() - lastMove.sentAt }
          : undefined,
      },
      visibility: {
        entitiesTracked: this.entities.snapshot().length,
        entityCreatesTotal: this.stats.entityCreates,
        postLoginEntityCreates: this.stats.postLoginEntityCreates,
        serverUpdatePackets: this.stats.updatePackets + this.stats.compressedUpdatePackets,
      },
      socket: this.socket.diagnostics(),
      clock: this.clockSync.diagnostics(),
      tutorialFlags: this.tutorialFlags.slice(),
      unknownOpcodes: this.unknownOpcodeTelemetry.snapshot(),
    };
  }

  resumeNetwork() {
    if (this.closed) return false;
    return this.sendPingIfDue('resume');
  }


  getCreatureName(entry: number) {
    return this.names.getCreature(entry);
  }

  getGameObjectName(entry: number) {
    return this.names.getGameObject(entry);
  }

  /**
   * Bitmask of creature types the player is currently tracking (Track Humanoids/Beasts/Undead/etc.),
   * as `1 << (CreatureType-1)` per vMaNGOS HandleAuraTrackCreatures. 0 when no tracking is active.
   * The minimap uses this to reproduce vanilla's tracking dots: a creature of type T shows a yellow
   * blip only while bit (T-1) is set. Mirrors the exact field the real 1.12 client reads.
   */
  getTrackedCreatureMask(): number {
    const player = this.activeCharacter ? this.entities.get(this.activeCharacter.guid) : undefined;
    return player?.fields?.get(PLAYER_TRACK_CREATURES) ?? 0;
  }

  /** Bitmask of tracked resource nodes (Find Herbs/Minerals), `1 << (lockType-1)`; 0 when inactive. */
  getTrackedResourceMask(): number {
    const player = this.activeCharacter ? this.entities.get(this.activeCharacter.guid) : undefined;
    return player?.fields?.get(PLAYER_TRACK_RESOURCES) ?? 0;
  }

  getPlayerName(guid: string) {
    return this.playerNames.get(guid);
  }

  /**
   * Guild name for a visible player, or undefined when we have never seen them in a /who
   * result. Vanilla has no per-unit guild field on the wire, so this is genuinely
   * best-effort: the name resolves once a who query has covered that player.
   */
  getPlayerGuildName(guid: string): string | undefined {
    const name = this.playerNames.get(guid)?.name;
    return name ? this.playerGuildNames.get(name.toLowerCase()) : undefined;
  }

  getAuras(guid: string): readonly AuraSlot[] {
    const entity = this.entities.get(guid);
    if (!entity?.auraSpellIds) return [];
    const auras: AuraSlot[] = [];
    for (let slot = 0; slot < 48; slot++) {
      const spellId = entity.auraSpellIds[slot] ?? 0;
      if (!spellId) continue;
      auras.push({
        slot,
        spellId,
        flags: entity.auraFlags?.[slot] ?? 0,
        level: entity.auraLevels?.[slot] ?? 0,
        // UNIT_FIELD_AURAAPPLICATIONS is transmitted as (realStackCount - 1); vMaNGOS
        // SpellAuras.cpp:7507 encodes it "count-1 for proper amount show". A present aura is
        // therefore at least 1 application, so add the byte back here (guarded by the spellId
        // check above, so empty slots stay absent rather than becoming a phantom 1-stack).
        charges: (entity.auraApplications?.[slot] ?? 0) + 1,
        ...(guid === this.activeCharacter?.guid && this.playerAuraDurations.has(slot)
          ? {
              durationMs: this.playerAuraDurations.get(slot)!.durationMs,
              timeRemainingMs: Math.max(0, Math.round(this.playerAuraDurations.get(slot)!.expiresAt - Date.now())),
            }
          : {}),
      });
    }
    return auras;
  }

  getWorldStates() {
    return { ...this.worldStates };
  }

  queryCreature(entry: number, guid?: string) {
    if (!this.closed) this.names.queryCreature(entry, guid);
  }

  queryGameObject(entry: number, guid?: string) {
    if (!this.closed) this.names.queryGameObject(entry, guid);
  }

  queryPlayerName(guid: string) {
    if (this.closed || !guid || this.playerNames.has(guid) || this.pendingPlayerNameQueries.has(guid)) return;
    this.pendingPlayerNameQueries.add(guid);
    this.socket.send(OPCODES.CMSG_NAME_QUERY, guidHexToBytes(guid));
  }

  requestSocialLists() {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_FRIEND_LIST);
  }

  /**
   * Ask the server for a questgiver's dialog status so we can draw its overhead ! / ? marker.
   * `force` re-queries even if a status is already cached (used when the quest log changes and the
   * marker may have flipped from ! to ? or cleared). CMSG_QUESTGIVER_STATUS_QUERY body is the raw
   * 8-byte guid (vMaNGOS HandleQuestgiverStatusQueryOpcode reads a plain ObjectGuid).
   */
  queryQuestGiverStatus(guid: string, force = false) {
    if (this.closed || !guid) return;
    if (!force && (this.questGiverStatus.has(guid) || this.pendingQuestStatusQueries.has(guid))) return;
    this.pendingQuestStatusQueries.add(guid);
    this.socket.send(OPCODES.CMSG_QUESTGIVER_STATUS_QUERY, guidHexToBytes(guid));
  }

  /** DIALOG_STATUS_* for a questgiver (QuestDef.h), or undefined until the server has answered. */
  getQuestGiverStatus(guid: string): number | undefined {
    return this.questGiverStatus.get(guid);
  }

  /** Quest state changed — allow every cached questgiver marker to refresh on its next query. */
  invalidateQuestGiverStatuses() {
    this.questGiverStatus.clear();
    this.pendingQuestStatusQueries.clear();
  }

  addFriend(name: string) {
    const clean = name.trim();
    if (!this.closed && clean) this.socket.send(OPCODES.CMSG_ADD_FRIEND, cstring(clean));
  }

  removeFriend(guid: string) {
    if (!this.closed && guid) this.socket.send(OPCODES.CMSG_DEL_FRIEND, guidHexToBytes(guid));
  }

  addIgnore(name: string) {
    const clean = name.trim();
    if (!this.closed && clean) this.socket.send(OPCODES.CMSG_ADD_IGNORE, cstring(clean));
  }

  removeIgnore(guid: string) {
    if (!this.closed && guid) this.socket.send(OPCODES.CMSG_DEL_IGNORE, guidHexToBytes(guid));
  }

  requestWho() {
    if (this.closed) return;
    // Who::ReadFromWorldPacket: level range, player/guild, masks, zone and term lists.
    this.socket.send(OPCODES.CMSG_WHO, concat(
      u32(0), u32(100), cstring(''), cstring(''), u32(0xffffffff), u32(0xffffffff), u32(0), u32(0),
    ));
  }

  private ownGuildId() { return this.activeCharacter ? this.entities.get(this.activeCharacter.guid)?.fields.get(PLAYER_FIELDS.PLAYER_GUILDID) ?? this.activeCharacter.guildId ?? 0 : 0; } private reconcileGuildMembership(previousGuildId: number) { const guildId = this.ownGuildId(); if (guildId === previousGuildId) return; if (this.activeCharacter) this.activeCharacter.guildId = guildId; this.social = { ...this.social, guild: [], guildMotd: '', guildInfoText: '', guildRankRights: [], guildName: '', guildRankNames: [] }; this.emitSocial(); if (guildId) this.requestGuildRoster(); }
  requestGuildRoster() { const guildId = this.ownGuildId(); if (guildId) this.queryGuild(guildId); if (!this.closed) this.socket.send(OPCODES.CMSG_GUILD_ROSTER); }

  queryPetName(petNumber: number, petGuid?: string) {
    const cleanPetNumber = petNumber >>> 0;
    if (this.closed || !cleanPetNumber || this.pendingPetNameQueries.has(cleanPetNumber)) return;
    this.pendingPetNameQueries.add(cleanPetNumber);
    this.socket.send(OPCODES.CMSG_PET_NAME_QUERY, concat(u32(cleanPetNumber), petGuid ? guidHexToBytes(petGuid) : new Uint8Array(8)));
  }

  setFactionAtWar(reputationListId: number, atWar: boolean) {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_SET_FACTION_ATWAR, concat(u32(reputationListId >>> 0), new Uint8Array([atWar ? 1 : 0])));
  }

  setFactionInactive(reputationListId: number, inactive: boolean) {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_SET_FACTION_INACTIVE, concat(u32(reputationListId >>> 0), new Uint8Array([inactive ? 1 : 0])));
  }

  setWatchedFaction(reputationListId: number | null) {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_SET_WATCHED_FACTION, u32(reputationListId === null ? 0xffffffff : reputationListId >>> 0));
  }

  petAction(petGuid: string, action: number, activeState: number, targetGuid?: string) {
    if (this.closed || !petGuid) return;
    const packed = (action & 0x00ffffff) | ((activeState & 0xff) << 24);
    this.socket.send(
      OPCODES.CMSG_PET_ACTION,
      concat(guidHexToBytes(petGuid), u32(packed), targetGuid ? guidHexToBytes(targetGuid) : new Uint8Array(8)),
    );
  }

  petSetAction(
    petGuid: string,
    position: number,
    data: number,
    second?: { position: number; data: number },
  ) {
    if (this.closed || !petGuid) return;
    const body = second
      ? concat(guidHexToBytes(petGuid), u32(position >>> 0), u32(data >>> 0), u32(second.position >>> 0), u32(second.data >>> 0))
      : concat(guidHexToBytes(petGuid), u32(position >>> 0), u32(data >>> 0));
    this.socket.send(OPCODES.CMSG_PET_SET_ACTION, body);
  }

  petCastSpell(petGuid: string, spellId: number, targetGuid?: string) {
    if (this.closed || !petGuid || !spellId) return;
    const targets = targetGuid ? concat(u16(0x0002), packGuid(targetGuid)) : u16(0x0000);
    this.socket.send(OPCODES.CMSG_PET_CAST_SPELL, concat(guidHexToBytes(petGuid), u32(spellId >>> 0), targets));
  }

  petCancelAura(petGuid: string, spellId: number) {
    if (this.closed || !petGuid || !spellId) return;
    this.socket.send(OPCODES.CMSG_PET_CANCEL_AURA, concat(guidHexToBytes(petGuid), u32(spellId >>> 0)));
  }

  petSpellAutocast(petGuid: string, spellId: number, enabled: boolean) {
    if (this.closed || !petGuid || !spellId) return;
    this.socket.send(OPCODES.CMSG_PET_SPELL_AUTOCAST, concat(guidHexToBytes(petGuid), u32(spellId >>> 0), new Uint8Array([enabled ? 1 : 0])));
  }

  petAbandon(petGuid: string) {
    if (this.closed || !petGuid) return;
    this.socket.send(OPCODES.CMSG_PET_ABANDON, guidHexToBytes(petGuid));
  }

  petRename(petGuid: string, name: string) {
    const clean = name.trim();
    if (this.closed || !petGuid || !clean) return;
    this.socket.send(OPCODES.CMSG_PET_RENAME, concat(guidHexToBytes(petGuid), cstring(clean)));
  }

  private queryItem(entry: number) {
    if (this.closed || !entry || this.itemInfo.has(entry) || this.pendingItemQueries.has(entry)) return;
    this.pendingItemQueries.add(entry);
    this.socket.send(OPCODES.CMSG_ITEM_QUERY_SINGLE, concat(u32(entry), new Uint8Array(8)));
  }

  private defaultChatLanguage() {
    const race = this.activeCharacter?.race ?? 1;
    return ALLIANCE_RACES.has(race) ? LANG.COMMON : LANG.ORCISH;
  }

  sendChat(message: string, type: number = CHAT_MSG.SAY, targetOrChannel = '') {
    const clean = message.trim();
    if (this.closed || !clean) return;
    const language = type === CHAT_MSG.AFK || type === CHAT_MSG.DND ? LANG.UNIVERSAL : this.defaultChatLanguage();
    const target =
      type === CHAT_MSG.WHISPER || type === CHAT_MSG.CHANNEL ? cstring(targetOrChannel.trim()) : new Uint8Array(0);
    this.socket.send(OPCODES.CMSG_MESSAGECHAT, concat(u32(type), u32(language), target, cstring(clean)));
  }

  /**
   * CMSG_TEXT_EMOTE (vmangos WorldPackets::Misc::TextEmote): u32 EmotesText.dbc id,
   * u32 emoteNum, u64 raw target guid. The server resolves the Emotes.dbc anim and
   * mirrors it to everyone (including us) via SMSG_EMOTE, plus the chat line.
   */
  textEmote(textEmoteId: number, targetGuid?: string) {
    if (this.closed) return;
    this.socket.send(
      OPCODES.CMSG_TEXT_EMOTE,
      concat(u32(textEmoteId), u32(0), targetGuid ? guidHexToBytes(targetGuid) : new Uint8Array(8)),
    );
  }

  private resolveVisibleEquipment(entity: WorldEntity) {
    // Creatures do not use PLAYER_VISIBLE_ITEM at all — their weapons ride in UNIT_VIRTUAL_ITEM_*,
    // which carries the ItemDisplayInfo id plus class/subclass/inventoryType/sheath directly, so no
    // item query is needed. Without this the fields were decoded and dropped, and every armed mob
    // in the game swung empty hands.
    if (entity.typeId === TypeID.UNIT) {
      const virtualItems = decodeVirtualItems(entity.virtualItemDisplayIds, entity.virtualItemInfo);
      entity.virtualItems = virtualItems;
      entity.weaponSubclass = mainHandSubclass(virtualItems);
      entity.weaponMaterial = mainHandMaterial(virtualItems);
      if (virtualItems.length) {
        entity.visibleEquipment = withoutDisarmedMainHand(virtualItemsAsEquipment(virtualItems), entity.disarmed);
      }
      return;
    }
    const entries = entity.visibleItemEntries;
    if (!entries?.length) {
      if (entity.typeId === 4 /* PLAYER */ && !entity.visibleEquipment?.length) {
        const fallback =
          entity.guid === this.activeCharacter?.guid && this.activeCharacter.equipment.some((item) => item.displayInfoId)
            ? this.activeCharacter.equipment.filter((item) => item.displayInfoId)
            : starterOutfitFor(entity.race, entity.classId, entity.gender);
        if (fallback.length) entity.visibleEquipment = fallback;
      }
      return;
    }
    const equipment: CharacterInfo['equipment'] = [];
    const activeCharacterEquipment =
      entity.guid === this.activeCharacter?.guid ? this.activeCharacter.equipment : undefined;
    for (let slot = 0; slot < Math.max(entries.length, activeCharacterEquipment?.length ?? 0); slot++) {
      const entry = entries[slot] ?? 0;
      if (!entry) {
        const fallback = activeCharacterEquipment?.[slot];
        if (fallback?.displayInfoId) equipment.push({ ...fallback, slot });
        continue;
      }
      const info = this.itemInfo.get(entry);
      // Stamp the equipment slot on every resolved item. The array is compacted (empty slots are
      // skipped), so the array index is NOT the slot — main hand vs off hand can only be told apart
      // by this field, and INVTYPE_WEAPON (13) is legal in both.
      if (info) equipment.push({ ...info, slot });
      else this.queryItem(entry);
    }
    // A disarmed unit visibly loses its main hand — the appearance key downstream is built from
    // this list, so dropping the item here is what makes the weapon disappear and come back.
    entity.visibleEquipment = withoutDisarmedMainHand(equipment, entity.disarmed);
    const mainHand = entity.visibleEquipment.find((item) => item.slot === 15)
      ?? entity.visibleEquipment.find((item) => item.slot === 17);
    entity.weaponSubclass = mainHand?.subclass;
    entity.weaponMaterial = mainHand?.material;
  }

  private emitEntity(entity: WorldEntity, change?: WorldEntityChange) {
    if (entity.typeId === TypeID.GAMEOBJECT && entity.entry) this.names.queryGameObject(entity.entry, entity.guid);
    if (entity.typeId === 4 /* PLAYER */ && entity.guid !== this.activeCharacter?.guid) {
      const known = this.playerNames.get(entity.guid);
      if (known) {
        entity.race ??= known.race;
        entity.classId ??= known.classId;
        entity.gender ??= known.gender;
      } else if (entity.race === undefined || entity.classId === undefined || entity.gender === undefined) {
        this.queryPlayerName(entity.guid);
      }
    }
    this.resolveVisibleEquipment(entity);
    this.dispatch(this.entityListeners, (listener) => listener(entity, change), 'entity');
  }

  private emitControlledMover(
    previousMoverGuid: string,
    reason: ControlledMoverEvent['reason'],
  ) {
    if (!this.controlledMover) return;
    this.dispatch(
      this.controlledMoverListeners,
      (listener) => listener({
        ...this.controlledMover!,
        previousMoverGuid,
        reason,
      }),
      'controlledMover',
    );
  }

  private restoreControlledMover(
    reason: ControlledMoverEvent['reason'],
    confirmWithServer = true,
  ) {
    if (!this.controlledMover) return;
    const previousMoverGuid = this.controlledMover.moverGuid;
    this.controlledMover = restorePlayerControl(this.controlledMover, this.worldGeneration);
    if (confirmWithServer && !this.closed && this.activeCharacter) {
      this.socket.send(
        OPCODES.CMSG_SET_ACTIVE_MOVER,
        new Uint8Array(this.activeCharacter.guidBytes),
      );
    }
    this.emitControlledMover(previousMoverGuid, reason);
  }

  private controlledMovementBody(
    moverGuid: string,
    flags?: number,
    jump?: JumpInfo,
  ) {
    const last = this.stats.lastClientMove;
    const entity = this.entities.get(moverGuid);
    const useLast = last?.moverGuid === moverGuid;
    return movementBody(
      useLast ? last.x : entity?.x ?? 0,
      useLast ? last.y : entity?.y ?? 0,
      useLast ? last.z : entity?.z ?? 0,
      useLast ? last.o : entity?.o ?? 0,
      flags ?? (useLast ? last.flags : entity?.flags ?? 0),
      jump,
    );
  }

  private sendBootstrapHeartbeat(position: WorldPosition) {
    const flags = 0;
    this.socket.send(OPCODES.MSG_MOVE_HEARTBEAT, movementBody(position.x, position.y, position.z, position.o, flags));
    this.recordClientMove('heartbeat', position.x, position.y, position.z, position.o, flags);
    this.progress('world: sent bootstrap MSG_MOVE_HEARTBEAT');
  }

  async enterWorld(character: CharacterInfo): Promise<WorldEnterResult> {
    if (this.enterWorldStarted || this.pumpStarted) throw new Error('already entering or in world on this socket');
    this.enterWorldStarted = true;
    this.worldGeneration++;
    this.entities.clear();
    this.playerAuraDurations.clear();
    this.spellModifiers.clear();
    this.proficiencyMasks.clear();
    this.forcedReactions.clear();
    this.factionStates.clear();
    this.petSpellState = undefined;
    this.pendingPetNameQueries.clear();
    this.lastKnownMoney = undefined;
    this.lastCreditedLootMoneyGuid = undefined;
    this.tutorialFlags.fill(0);
    this.activeCharacter = character;
    this.controlledMover = initialControlledMoverState(character.guid, this.worldGeneration);
    this.progress(`world: entering ${character.name}`);
    this.socket.send(OPCODES.CMSG_PLAYER_LOGIN, new Uint8Array(character.guidBytes));

    let verified: WorldPosition | undefined;
    let worldportAcked = false;
    let activeMoverSent = false;
    let verifiedAt = 0;
    let lastBootstrapHeartbeatAt = 0;
    const verifyDeadline = performance.now() + WORLD_ENTER_VERIFY_TIMEOUT_MS;
    const updateStart = this.stats.updatePackets + this.stats.compressedUpdatePackets;
    for (let i = 0; i < 220; i++) {
      let packet: WorldPacket;
      try {
        packet = await this.socket.readPacket(verified ? 250 : undefined);
      } catch (e) {
        if (verified && (e as Error).message.includes('timed out')) {
          const waitedMs = performance.now() - verifiedAt;
          const updatesSeen = this.stats.updatePackets + this.stats.compressedUpdatePackets - updateStart;
          if (performance.now() - lastBootstrapHeartbeatAt >= 500) {
            this.sendBootstrapHeartbeat(verified);
            lastBootstrapHeartbeatAt = performance.now();
          }
          if (updatesSeen > 0 && (this.hasInitialWorldVisibility(character.guid, verified) || waitedMs > 5000)) break;
          continue;
        }
        throw e;
      }
      if (packet.opcode === OPCODES.SMSG_CHARACTER_LOGIN_FAILED) {
        throw new Error(`character login failed: 0x${packet.body[0]?.toString(16) ?? '??'}`);
      }
      if (packet.opcode === OPCODES.SMSG_LOGIN_VERIFY_WORLD) {
        verified = parseLoginVerifyWorld(packet);
        this.progress(
          `world: verified map ${verified.map} (${verified.x.toFixed(1)}, ${verified.y.toFixed(1)}, ${verified.z.toFixed(1)})`,
        );
        verifiedAt = performance.now();
        if (!worldportAcked) {
          // vMaNGOS handles MSG_MOVE_WORLDPORT_ACK as a NullClientPacket in 1.12.1.
          this.socket.send(OPCODES.MSG_MOVE_WORLDPORT_ACK);
          worldportAcked = true;
          this.progress('world: sent MSG_MOVE_WORLDPORT_ACK');
        }
        if (!activeMoverSent) {
          // vMaNGOS explicitly preserves movement packets during login so this client
          // confirmation is not discarded while AddToMap/visibility bootstrap finishes.
          this.socket.send(OPCODES.CMSG_SET_ACTIVE_MOVER, new Uint8Array(character.guidBytes));
          activeMoverSent = true;
          this.progress('world: sent CMSG_SET_ACTIVE_MOVER');
        }
        this.sendBootstrapHeartbeat(verified);
        lastBootstrapHeartbeatAt = performance.now();
      } else {
        await this.handlePacket(packet);
      }

      const updatesSeen = this.stats.updatePackets + this.stats.compressedUpdatePackets - updateStart;
      if (
        verified &&
        activeMoverSent &&
        updatesSeen > 0 &&
        (this.hasInitialWorldVisibility(character.guid, verified) || performance.now() - verifiedAt > 5000)
      ) {
        break;
      }
    }

    if (!verified) throw new Error('world login did not receive SMSG_LOGIN_VERIFY_WORLD');
    if (!activeMoverSent) {
      // Fallback for odd login streams that produce updates before LOGIN_VERIFY_WORLD.
      this.socket.send(OPCODES.CMSG_SET_ACTIVE_MOVER, new Uint8Array(character.guidBytes));
      this.progress('world: sent CMSG_SET_ACTIVE_MOVER');
    }
    this.startPingLoop();
    this.beginPump();
    return { character, ...verified, stats: { ...this.stats } };
  }

  sendHeartbeat(x: number, y: number, z: number, o: number, flags = 0, extras: ClientMovementExtras = {}) {
    if (
      this.closed
      || (this.controlledMover && !acceptsControlledMoverPacket(
        this.controlledMover,
        this.controlledMover.moverGuid,
      ))
    ) return;
    const jump = (flags & MOVEMENTFLAG_JUMPING) !== 0 ? this.activeJumpInfo : undefined;
    try {
      this.socket.send(OPCODES.MSG_MOVE_HEARTBEAT, movementBody(x, y, z, o, flags, jump, this.activeJumpFallTime(flags), extras));
      this.recordClientMove('heartbeat', x, y, z, o, flags);
    } catch (e) {
      this.handleSocketFailure(e as Error);
    }
  }

  setActiveJump(jump: JumpInfo | undefined) {
    this.activeJumpInfo = jump;
    this.activeJumpStartedAt = jump ? performance.now() : undefined;
  }

  private activeJumpFallTime(flags: number, explicit?: number) {
    if (explicit !== undefined) return explicit;
    if ((flags & MOVEMENTFLAG_JUMPING) === 0 || this.activeJumpStartedAt === undefined) return 0;
    return Math.max(0, Math.floor(performance.now() - this.activeJumpStartedAt));
  }

  /** Send a movement transition packet (start/stop/jump/fall/facing), matching the WoW client. */
  sendMove(kind: MoveKind, m: { x: number; y: number; z: number; o: number; flags?: number; jump?: JumpInfo; fallTime?: number; swimPitch?: number; transport?: ClientTransportMovement }) {
    const op = MOVE_OPCODES[kind];
    if (
      op === undefined
      || this.closed
      || (this.controlledMover && !acceptsControlledMoverPacket(
        this.controlledMover,
        this.controlledMover.moverGuid,
      ))
    ) return;
    const flags = m.flags ?? 0;
    const jump = (flags & MOVEMENTFLAG_JUMPING) !== 0 ? (m.jump ?? this.activeJumpInfo) : undefined;
    try {
      this.socket.send(op, movementBody(
        m.x, m.y, m.z, m.o, flags, jump, this.activeJumpFallTime(flags, m.fallTime),
        { swimPitch: m.swimPitch, transport: m.transport },
      ));
      this.recordClientMove(kind, m.x, m.y, m.z, m.o, flags);
    } catch (e) {
      this.handleSocketFailure(e as Error);
    }
  }

  /**
   * Complete a player-owned SMSG_MONSTER_MOVE spline.
   *
   * Build 5875 sends MovementInfo + spline id + one trailing float. vMaNGOS reads that exact shape
   * in MoveSplineDone::ReadFromWorldPacket and rejects an id other than the mover's newest spline.
   */
  sendMoveSplineDone(m: { x: number; y: number; z: number; o: number; splineId: number }) {
    if (
      this.closed
      || (this.controlledMover && !acceptsControlledMoverPacket(
        this.controlledMover,
        this.controlledMover.moverGuid,
      ))
    ) return;
    try {
      const flags = 0;
      this.socket.send(
        OPCODES.CMSG_MOVE_SPLINE_DONE,
        concat(
          movementBody(m.x, m.y, m.z, m.o, flags),
          u32(m.splineId >>> 0),
          f32(0),
        ),
      );
      this.recordClientMove('spline_done', m.x, m.y, m.z, m.o, flags);
    } catch (e) {
      this.handleSocketFailure(e as Error);
    }
  }

  /** CMSG_SET_SELECTION: raw u64 guid; null/empty clears the target (all-zero guid). */
  setSelection(guid: string | null) {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_SET_SELECTION, guid ? guidHexToBytes(guid) : new Uint8Array(8));
  }

  /** CMSG_ATTACKSWING: raw u64 victim guid — starts server-side auto-attack. */
  attackSwing(guid: string) {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_ATTACKSWING, guidHexToBytes(guid));
  }

  /** CMSG_ATTACKSTOP: empty body (vmangos HandleAttackStopOpcode takes no payload). */
  attackStop() {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_ATTACKSTOP);
  }

  /**
   * CMSG_SETSHEATHED (0x1E0): u32 sheath state (vmangos HandleSetSheathedOpcode).
   * 0 = weapons stowed, 1 = melee drawn, 2 = ranged drawn. The server mirrors it to
   * everyone via UNIT_FIELD_BYTES_2 byte 0.
   */
  setSheathed(state: 0 | 1 | 2) {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_SETSHEATHED, u32(state));
  }

  /**
   * CMSG_CAST_SPELL: u32 spellId + SpellCastTargets (vmangos SpellCastTargetsInfo.cpp):
   * u16 targetMask, then packed guid when TARGET_FLAG_UNIT (0x0002). Mask 0 = self —
   * the server's PrepareForSpellSystem fills in implicit targets.
   */
  castSpell(spellId: number, targetGuid?: string) {
    const targets: SpellCastTargets = targetGuid
      ? { targetMask: TARGET_FLAG_UNIT, unitGuid: targetGuid }
      : { targetMask: 0 };
    this.castSpellTargets(spellId, targets);
  }

  castSpellTargets(spellId: number, targets: SpellCastTargets) {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_CAST_SPELL, encodeSpellCastRequest(spellId, targets));
    this.emitCombat({
      kind: 'castSent',
      spellId,
      targetGuid: primarySpellObjectTarget(targets),
      destination: targets.destination,
      targets,
    });
  }

  /**
   * Build 5875 ground-target cast. vMaNGOS SpellCastTargets::read consumes
   * uint16 TARGET_FLAG_DEST_LOCATION followed by three little-endian floats.
   */
  castSpellAtLocation(spellId: number, destination: SpellDestination) {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_CAST_SPELL, encodeDestinationSpellCast(spellId, destination));
    this.emitCombat({
      kind: 'castSent',
      spellId,
      destination,
      targets: { targetMask: TARGET_FLAG_DEST_LOCATION, destination },
    });
  }

  cancelCast() {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_CANCEL_CAST, u32(0));
  }

  cancelAura(auraSlot: number) {
    if (this.closed) return;
    const spellId = this.activeCharacter ? this.entities.get(this.activeCharacter.guid)?.auraSpellIds?.[auraSlot] ?? 0 : 0;
    if (!spellId) {
      this.progress(`world: CMSG_CANCEL_AURA skipped for empty slot ${auraSlot}`);
      return;
    }
    this.socket.send(OPCODES.CMSG_CANCEL_AURA, u32(spellId));
  }

  /** CMSG_CANCEL_AURA carries the spell id, which some native UI functions know directly. */
  cancelAuraSpell(spellId: number) {
    if (!this.closed && spellId > 0) this.socket.send(OPCODES.CMSG_CANCEL_AURA, u32(spellId));
  }

  /** AcceptAreaSpiritHeal(): u64 spirit-service guid in CMSG_AREA_SPIRIT_HEALER_QUEUE. */
  queueAreaSpiritHeal(healerGuid: string) {
    if (!this.closed && healerGuid) {
      this.socket.send(OPCODES.CMSG_AREA_SPIRIT_HEALER_QUEUE, guidHexToBytes(healerGuid));
    }
  }

  /** ConfirmSummon(): Build 5875 sends only the stored summoner's u64 guid. */
  acceptSummon(summonerGuid: string) {
    if (!this.closed && summonerGuid) {
      this.socket.send(OPCODES.CMSG_SUMMON_RESPONSE, guidHexToBytes(summonerGuid));
    }
  }

  cancelChanneling(spellId = 0) {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_CANCEL_CHANNELLING, u32(spellId));
  }

  onControlledMover(listener: (event: ControlledMoverEvent) => void) {
    this.controlledMoverListeners.add(listener);
    if (this.controlledMover) {
      listener({
        ...this.controlledMover,
        previousMoverGuid: this.controlledMover.moverGuid,
        reason: 'server',
      });
    }
    return () => this.controlledMoverListeners.delete(listener);
  }

  getControlledMover(): Readonly<ControlledMoverState> | undefined {
    return this.controlledMover;
  }

  /** CMSG_CANCEL_AUTO_REPEAT_SPELL: empty body; stops Auto Shot/Shoot on the authoritative mover. */
  cancelAutoRepeatSpell() {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_CANCEL_AUTO_REPEAT_SPELL);
  }

  /** CMSG_AREATRIGGER: uint32 trigger id. Server validates exact position/range before acting. */
  areaTrigger(triggerId: number) {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_AREATRIGGER, u32(triggerId >>> 0));
    this.progress(`world: sent CMSG_AREATRIGGER ${triggerId >>> 0}`);
  }

  interact(guid: string) {
    if (this.closed || !guid) return;
    const entity = this.entities.get(guid);
    if (!entity) return;
    const lootable = (entity.dynamicFlags ?? 0) & UNIT_DYNFLAG_LOOTABLE;
    if (
      lootable &&
      (entity.typeId === TypeID.UNIT || entity.typeId === TypeID.GAMEOBJECT || entity.typeId === TypeID.CORPSE) &&
      (entity.typeId !== TypeID.UNIT || (entity.health ?? 0) <= 0)
    ) {
      this.openLoot(guid);
      return;
    }
    const npcFlags = entity.typeId === TypeID.UNIT ? (entity.npcFlags ?? 0) : 0;
    // Gossip wins because its server-built menu may contain dialogue, quests and service options.
    if (npcFlags & (UNIT_NPC_FLAG.GOSSIP | UNIT_NPC_FLAG.QUESTGIVER)) {
      this.gossipHello(guid);
      return;
    }
    if (npcFlags & SPIRIT_SERVICE_NPC_FLAGS) {
      this.socket.send(OPCODES.CMSG_AREA_SPIRIT_HEALER_QUERY, guidHexToBytes(guid));
      return;
    }
    if (npcFlags & UNIT_NPC_FLAG.BANKER) { this.bankerActivate(guid); return; }
    if (npcFlags & UNIT_NPC_FLAG.AUCTIONEER) { this.auctionHello(guid); return; }
    if (npcFlags & UNIT_NPC_FLAG.STABLEMASTER) { this.listStabledPets(guid); return; }
    if (npcFlags & UNIT_NPC_FLAG.INNKEEPER) { this.binderActivate(guid); return; }
    if (npcFlags & UNIT_NPC_FLAG.PETITIONER) { this.petitionShowList(guid); return; }
    const deferredNpc = deferredNpcServiceMessage(npcFlags);
    if (deferredNpc) { showUiError(deferredNpc); return; }
    if (npcFlags & (UNIT_NPC_FLAG.VENDOR | UNIT_NPC_FLAG.TRAINER | UNIT_NPC_FLAG.FLIGHTMASTER)) {
      this.gossipHello(guid);
      return;
    }
    if (entity.typeId === TypeID.GAMEOBJECT && entity.gameObjectType === 19) {
      this.openMailbox(guid);
      return;
    }
    if (entity.typeId === TypeID.GAMEOBJECT && entity.gameObjectType === 9 && this.questItems.openGameObject(guid)) return;
    if (entity.typeId === TypeID.GAMEOBJECT) {
      const deferredObject = deferredGameObjectServiceMessage(entity.gameObjectType);
      if (deferredObject) { showUiError(deferredObject); return; }
      this.socket.send(OPCODES.CMSG_GAMEOBJ_USE, guidHexToBytes(guid));
      return;
    }
  }

  openLoot(guid: string) {
    if (this.closed || !guid) return;
    this.socket.send(OPCODES.CMSG_LOOT, guidHexToBytes(guid));
  }

  lootItem(slot: number) {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_AUTOSTORE_LOOT_ITEM, new Uint8Array([slot & 0xff]));
  }

  lootMoney() {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_LOOT_MONEY);
  }

  lootRoll(lootGuid: string, itemSlot: number, rollType: 0 | 1 | 2) {
    if (this.closed || !lootGuid) return;
    this.socket.send(OPCODES.CMSG_LOOT_ROLL, concat(guidHexToBytes(lootGuid), u32(itemSlot >>> 0), new Uint8Array([rollType])));
  }

  getMasterLootEligible() {
    return [...this.masterLootEligible];
  }

  masterLootGive(lootGuid: string, itemSlot: number, playerGuid: string) {
    if (this.closed || !lootGuid || !playerGuid) return;
    this.socket.send(
      OPCODES.CMSG_LOOT_MASTER_GIVE,
      concat(guidHexToBytes(lootGuid), new Uint8Array([itemSlot & 0xff]), guidHexToBytes(playerGuid)),
    );
  }

  /** CMSG_READ_ITEM (vmangos WorldPackets::Item::ReadItem): u8 bag, u8 slot. */
  readItem(bag: number, slot: number) { if (!this.closed) this.socket.send(OPCODES.CMSG_READ_ITEM, new Uint8Array([bag & 0xff, slot & 0xff])); }

  /**
   * CMSG_USE_ITEM (vmangos WorldPackets::Spell::UseItem): u8 bagIndex, u8 slot,
   * u8 spellSlot, then SpellCastTargets. spellSlot 0 = first on-use spell;
   * targetMask 0 = self/implicit target (server fills it in). bag/slot are the
   * protocol container+slot from InventorySnapshot.
   */
  useItem(
    bag: number,
    slot: number,
    spellSlot = 0,
    targets: SpellCastTargets = { targetMask: 0 },
  ) {
    if (this.closed) return;
    this.socket.send(
      OPCODES.CMSG_USE_ITEM,
      encodeUseItemRequest(bag, slot, spellSlot, targets),
    );
  }

  // --- Optimistic inventory prediction ---------------------------------------
  // The server does not reliably push the owner's INV/PACK slot-pointer changes
  // after an item move, so the client predicts the move locally (exactly as the
  // real 1.12 client does), then reconciles: any later authoritative field
  // update overwrites the prediction, and a rejection reverts it.
  private inventoryPredictionQueue: { revert?: () => void; fields: string[]; expiresAt: number }[] = [];

  private enqueueInventoryPrediction(prediction?: { revert: () => void; fields: string[] }) {
    if (!ENABLE_INVENTORY_OPTIMISTIC_PREDICTION) return;
    const entry = { revert: prediction?.revert, fields: prediction?.fields ?? [], expiresAt: Date.now() + 5000 };
    this.inventoryPredictionQueue.push(entry);
    if (this.inventoryPredictionQueue.length > 16) this.inventoryPredictionQueue.shift();
    globalThis.setTimeout?.(() => {
      const index = this.inventoryPredictionQueue.indexOf(entry);
      if (index >= 0) this.inventoryPredictionQueue.splice(index, 1);
    }, 5000);
  }

  private confirmInventoryPredictionsFor(changedFields: Iterable<string>) {
    const changed = new Set(changedFields);
    if (!changed.size) return;
    this.inventoryPredictionQueue = this.inventoryPredictionQueue.filter(
      (entry) => !entry.fields.some((field) => changed.has(field)),
    );
  }

  /** Resolve the GUID-pair field for an inventory position in the local store. */
  private inventorySlotField(bag: number, slot: number): { fields: Map<number, number>; field: number; key: string } | undefined {
    const player = this.activeCharacter ? this.entities.get(this.activeCharacter.guid) : undefined;
    if (!player) return undefined;
    if (bag === INVENTORY_SLOT_BAG_0) {
      if (slot >= 0 && slot < INVENTORY_SLOT_ITEM_START) {
        const field = PLAYER_FIELD_INV_SLOT_HEAD + slot * 2;
        return { fields: player.fields, field, key: `${player.guid}:${field}` };
      }
      if (slot >= INVENTORY_SLOT_ITEM_START && slot < INVENTORY_SLOT_ITEM_END) {
        const field = PLAYER_FIELD_PACK_SLOT_1 + (slot - INVENTORY_SLOT_ITEM_START) * 2;
        return { fields: player.fields, field, key: `${player.guid}:${field}` };
      }
      const keyringField = keyringFieldForProtocolSlot(slot);
      if (keyringField !== undefined) return { fields: player.fields, field: keyringField, key: `${player.guid}:${keyringField}` };
      // Bank predictions need their own opened-bank state; do not write guessed fields.
      if (
        (slot >= INVENTORY_SLOT_BANK_START && slot < INVENTORY_SLOT_BANK_END) ||
        (slot >= INVENTORY_SLOT_BANK_BAG_START && slot < INVENTORY_SLOT_BANK_BAG_END)
      ) {
        return undefined;
      }
      return undefined;
    }
    const bagGuid = guidField(player.fields, PLAYER_FIELD_INV_SLOT_HEAD + bag * 2);
    const container = bagGuid ? this.entities.get(bagGuid) : undefined;
    if (!container) return undefined;
    const field = CONTAINER_FIELD_SLOT_1 + slot * 2;
    return { fields: container.fields, field, key: `${container.guid}:${field}` };
  }

  private itemInfoLooksLikeBag(info?: ItemInfo) {
    return (
      (info?.containerSlots ?? 0) > 0 ||
      info?.inventoryType === INVTYPE_BAG ||
      info?.classId === ITEM_CLASS_CONTAINER ||
      info?.classId === ITEM_CLASS_QUIVER
    );
  }

  private entityLooksLikeBagContainer(entity: WorldEntity | undefined) {
    if (!entity) return false;
    if (entity.typeId === TypeID.CONTAINER) return true;
    if (entity.fields.has(CONTAINER_FIELD_NUM_SLOTS)) return true;
    const entry = entity.entry ?? entity.fields.get(OBJECT_FIELD_ENTRY);
    return this.itemInfoLooksLikeBag(entry ? this.itemInfo.get(entry) : undefined);
  }

  private itemIsStackable(entity: WorldEntity | undefined) {
    const entry = entity?.entry ?? entity?.fields.get(OBJECT_FIELD_ENTRY);
    const info = entry ? this.itemInfo.get(entry) : undefined;
    return (info?.stackable ?? 1) > 1;
  }

  private bagContainerIsEmpty(entity: WorldEntity | undefined) {
    if (!this.entityLooksLikeBagContainer(entity)) return true;
    const size = Math.max(0, Math.min(36, entity?.fields.get(CONTAINER_FIELD_NUM_SLOTS) ?? 0));
    for (let slot = 0; slot < size; slot++) {
      if (entity && guidField(entity.fields, CONTAINER_FIELD_SLOT_1 + slot * 2)) return false;
    }
    return true;
  }

  /** Optimistically swap two inventory positions' GUID pointers, then re-render. */
  private predictSwap(srcBag: number, srcSlot: number, dstBag: number, dstSlot: number): { revert: () => void; fields: string[] } | undefined {
    const a = this.inventorySlotField(srcBag, srcSlot);
    const b = this.inventorySlotField(dstBag, dstSlot);
    if (!a || !b) return undefined;
    const aGuid = guidField(a.fields, a.field);
    const bGuid = guidField(b.fields, b.field);
    if (!aGuid) return undefined;
    const aEntity = this.entities.get(aGuid);
    const bEntity = bGuid ? this.entities.get(bGuid) : undefined;
    if (!bGuid) return this.predictMoveToEmpty(srcBag, srcSlot, dstBag, dstSlot);
    // The server may merge stackable items or transfer contents between bags.
    // Predict only the plain non-stack/non-bag occupied swap case.
    if (
      this.itemIsStackable(aEntity) ||
      this.itemIsStackable(bEntity) ||
      this.entityLooksLikeBagContainer(aEntity) ||
      this.entityLooksLikeBagContainer(bEntity)
    ) {
      return undefined;
    }
    const swap = () => {
      const aLow = a.fields.get(a.field) ?? 0;
      const aHigh = a.fields.get(a.field + 1) ?? 0;
      const bLow = b.fields.get(b.field) ?? 0;
      const bHigh = b.fields.get(b.field + 1) ?? 0;
      a.fields.set(a.field, bLow);
      a.fields.set(a.field + 1, bHigh);
      b.fields.set(b.field, aLow);
      b.fields.set(b.field + 1, aHigh);
      this.emitInventoryData();
    };
    swap();
    return { revert: swap, fields: [a.key, b.key] }; // a GUID swap is its own inverse
  }

  private predictMoveToEmpty(srcBag: number, srcSlot: number, dstBag: number, dstSlot: number): { revert: () => void; fields: string[] } | undefined {
    const src = this.inventorySlotField(srcBag, srcSlot);
    const dst = this.inventorySlotField(dstBag, dstSlot);
    if (!src || !dst) return undefined;
    const srcLow = src.fields.get(src.field) ?? 0;
    const srcHigh = src.fields.get(src.field + 1) ?? 0;
    const dstLow = dst.fields.get(dst.field) ?? 0;
    const dstHigh = dst.fields.get(dst.field + 1) ?? 0;
    if (!srcLow && !srcHigh) return undefined;
    if (dstLow || dstHigh) return undefined;

    const apply = () => {
      src.fields.set(src.field, 0);
      src.fields.set(src.field + 1, 0);
      dst.fields.set(dst.field, srcLow);
      dst.fields.set(dst.field + 1, srcHigh);
      this.emitInventoryData();
    };
    const revert = () => {
      dst.fields.set(dst.field, dstLow);
      dst.fields.set(dst.field + 1, dstHigh);
      src.fields.set(src.field, srcLow);
      src.fields.set(src.field + 1, srcHigh);
      this.emitInventoryData();
    };
    apply();
    return { revert, fields: [src.key, dst.key] };
  }

  private predictAutoStoreBagItem(srcBag: number, srcSlot: number, dstBag: number): { revert: () => void; fields: string[] } | undefined {
    const player = this.activeCharacter ? this.entities.get(this.activeCharacter.guid) : undefined;
    if (!player || dstBag === INVENTORY_SLOT_BAG_0) return undefined;
    const bagGuid = guidField(player.fields, PLAYER_FIELD_INV_SLOT_HEAD + dstBag * 2);
    const container = bagGuid ? this.entities.get(bagGuid) : undefined;
    if (!container) return undefined;
    const size = Math.max(0, Math.min(36, container.fields.get(CONTAINER_FIELD_NUM_SLOTS) ?? 0));
    for (let slot = 0; slot < size; slot++) {
      if (!guidField(container.fields, CONTAINER_FIELD_SLOT_1 + slot * 2)) {
        return this.predictMoveToEmpty(srcBag, srcSlot, dstBag, slot);
      }
    }
    return undefined;
  }

  /** Predict the server's bag auto-equip: bags land in the first free slot 19-22. */
  private predictAutoEquipBag(srcBag: number, srcSlot: number): { revert: () => void; fields: string[] } | undefined {
    const player = this.activeCharacter ? this.entities.get(this.activeCharacter.guid) : undefined;
    const src = this.inventorySlotField(srcBag, srcSlot);
    if (!player || !src) return undefined;
    const itemGuid = guidField(src.fields, src.field);
    const item = itemGuid ? this.entities.get(itemGuid) : undefined;
    if (!this.entityLooksLikeBagContainer(item)) return undefined; // only bags are predictable here
    if (!this.bagContainerIsEmpty(item)) return undefined;
    for (let i = 0; i < INVENTORY_BAG_SLOT_COUNT; i++) {
      const equipSlot = INVENTORY_SLOT_BAG_START + i; // 19..22
      if (!guidField(player.fields, PLAYER_FIELD_INV_SLOT_HEAD + equipSlot * 2)) {
        return this.predictSwap(srcBag, srcSlot, INVENTORY_SLOT_BAG_0, equipSlot);
      }
    }
    return undefined;
  }

  /** Undo the most recent optimistic prediction (called when the server rejects it). */
  private revertLastOptimistic() {
    const now = Date.now();
    while (this.inventoryPredictionQueue.length && this.inventoryPredictionQueue[this.inventoryPredictionQueue.length - 1].expiresAt < now) {
      this.inventoryPredictionQueue.pop();
    }
    const entry = this.inventoryPredictionQueue.pop();
    entry?.revert?.();
  }

  /**
   * CMSG_AUTOEQUIP_ITEM (vmangos WorldPackets::Item::AutoEquipItem): u8 srcbag,
   * u8 srcslot. Server's CanEquipItem picks the destination equipment slot.
   */
  autoEquipItem(bag: number, slot: number) {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_AUTOEQUIP_ITEM, new Uint8Array([bag & 0xff, slot & 0xff]));
    if (ENABLE_INVENTORY_OPTIMISTIC_PREDICTION) this.enqueueInventoryPrediction(this.predictAutoEquipBag(bag, slot));
  }

  /** CMSG_AUTOSTORE_BAG_ITEM: u8 srcbag, u8 srcslot, u8 dstbag. */
  autoStoreBagItem(srcBag: number, srcSlot: number, dstBag: number) {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_AUTOSTORE_BAG_ITEM, new Uint8Array([srcBag & 0xff, srcSlot & 0xff, dstBag & 0xff]));
    if (ENABLE_INVENTORY_OPTIMISTIC_PREDICTION) this.enqueueInventoryPrediction(this.predictAutoStoreBagItem(srcBag, srcSlot, dstBag));
  }

  /** CMSG_SWAP_ITEM: u8 dstbag, u8 dstslot, u8 srcbag, u8 srcslot. */
  swapItem(srcBag: number, srcSlot: number, dstBag: number, dstSlot: number) {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_SWAP_ITEM, new Uint8Array([dstBag & 0xff, dstSlot & 0xff, srcBag & 0xff, srcSlot & 0xff]));
    if (ENABLE_INVENTORY_OPTIMISTIC_PREDICTION) this.enqueueInventoryPrediction(this.predictSwap(srcBag, srcSlot, dstBag, dstSlot));
  }

  /** CMSG_SWAP_INV_ITEM: u8 srcslot, u8 dstslot for equipment/backpack inventory slots. */
  swapInventoryItem(srcSlot: number, dstSlot: number) {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_SWAP_INV_ITEM, new Uint8Array([srcSlot & 0xff, dstSlot & 0xff]));
    if (ENABLE_INVENTORY_OPTIMISTIC_PREDICTION) {
      this.enqueueInventoryPrediction(this.predictSwap(INVENTORY_SLOT_BAG_0, srcSlot, INVENTORY_SLOT_BAG_0, dstSlot));
    }
  }

  /** CMSG_SPLIT_ITEM: u8 srcbag, u8 srcslot, u8 dstbag, u8 dstslot, u8 count. */
  splitItem(srcBag: number, srcSlot: number, dstBag: number, dstSlot: number, count: number) {
    if (this.closed || count <= 0) return;
    this.socket.send(
      OPCODES.CMSG_SPLIT_ITEM,
      new Uint8Array([srcBag & 0xff, srcSlot & 0xff, dstBag & 0xff, dstSlot & 0xff, count & 0xff]),
    );
    this.enqueueInventoryPrediction();
  }

  /** CMSG_AUTOEQUIP_ITEM_SLOT: ObjectGuid itemGuid, u8 dstslot. */
  autoEquipItemSlot(itemGuid: string, dstSlot: number) {
    if (this.closed || !itemGuid) return;
    this.socket.send(OPCODES.CMSG_AUTOEQUIP_ITEM_SLOT, concat(guidHexToBytes(itemGuid), new Uint8Array([dstSlot & 0xff])));
    this.enqueueInventoryPrediction();
  }

  /** CMSG_DESTROYITEM: u8 bag, u8 slot, u8 count, then three zero bytes consumed by vMaNGOS. */
  destroyItem(bag: number, slot: number, count = 0) {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_DESTROYITEM, new Uint8Array([bag & 0xff, slot & 0xff, count & 0xff, 0, 0, 0]));
    this.enqueueInventoryPrediction();
  }

  /** CMSG_AUTOBANK_ITEM / CMSG_AUTOSTORE_BANK_ITEM: u8 srcbag, u8 srcslot. */
  autoBankItem(srcBag: number, srcSlot: number) {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_AUTOBANK_ITEM, new Uint8Array([srcBag & 0xff, srcSlot & 0xff]));
    this.enqueueInventoryPrediction();
  }

  autoStoreBankItem(srcBag: number, srcSlot: number) {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_AUTOSTORE_BANK_ITEM, new Uint8Array([srcBag & 0xff, srcSlot & 0xff]));
    this.enqueueInventoryPrediction();
  }

  /** CMSG_SET_AMMO: uint32 item entry. */
  setAmmo(itemEntry: number) {
    if (this.closed || !itemEntry) return;
    this.socket.send(OPCODES.CMSG_SET_AMMO, u32(itemEntry >>> 0));
  }

  /**
   * CMSG_SET_ACTION_BUTTON (vmangos WorldPackets::Misc::SetActionButton):
   * u8 button, u32 packedData where packed = action | (type << 24).
   */
  setActionButton(button: number, action = 0, type = 0) {
    if (this.closed || button < 0 || button >= 120) return;
    const packed = action ? ((action & 0x00ffffff) | ((type & 0xff) << 24)) >>> 0 : 0;
    this.socket.send(OPCODES.CMSG_SET_ACTION_BUTTON, concat(new Uint8Array([button & 0xff]), u32(packed)));
    // The server does not echo SMSG_ACTION_BUTTONS after a set, so reflect it locally.
    while (this.actionButtons.length <= button) this.actionButtons.push(null);
    this.actionButtons[button] = action ? { action: action & 0x00ffffff, type: type & 0xff } : null;
  }

  /** CMSG_SET_ACTIONBAR_TOGGLES: u8 visible-multibar bitmask. */
  setActionBarToggles(actionBar: number) {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_SET_ACTIONBAR_TOGGLES, new Uint8Array([actionBar & 0xff]));
  }

  releaseLoot(guid = this.currentLoot?.guid) {
    if (this.closed || !guid) return;
    this.socket.send(OPCODES.CMSG_LOOT_RELEASE, guidHexToBytes(guid));
  }

  gossipHello(guid: string) {
    if (this.closed || !guid) return;
    this.currentGossipGuid = guid;
    this.socket.send(OPCODES.CMSG_GOSSIP_HELLO, guidHexToBytes(guid));
  }

  bankerActivate(guid: string) {
    if (this.closed || !guid) return;
    this.currentBankGuid = guid;
    this.socket.send(OPCODES.CMSG_BANKER_ACTIVATE, guidHexToBytes(guid));
  }

  buyBankSlot() {
    if (this.closed || !this.currentBankGuid) return;
    this.socket.send(OPCODES.CMSG_BUY_BANK_SLOT, guidHexToBytes(this.currentBankGuid));
  }

  closeBank() {
    this.currentBankGuid = undefined;
  }

  // --- Level 1-40 services. Bodies are built in world/<domain>.ts; this layer is the socket. ---

  /** Confirm an innkeeper bind by echoing the guid from SMSG_BINDER_CONFIRM. */
  binderActivate(guid: string) {
    if (this.closed || !guid) return;
    this.socket.send(OPCODES.CMSG_BINDER_ACTIVATE, guidHexToBytes(guid));
  }

  /** Home location from the last SMSG_BINDPOINTUPDATE, for the hearthstone tooltip. */
  getBindPoint(): BindPoint | undefined { return this.bindPoint; }

  /** An all-zero trainer guid means "no talent points spent" and must never be echoed. */
  confirmTalentWipe(trainerGuid: string) {
    if (this.closed || !trainerGuid || /^0+$/.test(trainerGuid)) return;
    this.socket.send(OPCODES.MSG_TALENT_WIPE_CONFIRM, guidHexToBytes(trainerGuid));
  }

  confirmPetUnlearn(petGuid: string) { if (!this.closed && petGuid && !/^0+$/.test(petGuid)) this.socket.send(OPCODES.CMSG_PET_UNLEARN, guidHexToBytes(petGuid)); }

  /** CMSG_ZONEUPDATE: u32 zone id. Called from the render loop, so it dedupes by zone. */
  sendZoneUpdate(zoneId: number) {
    if (this.closed || !zoneId || zoneId === this.lastSentZoneId) return;
    this.lastSentZoneId = zoneId;
    this.socket.send(OPCODES.CMSG_ZONEUPDATE, u32(zoneId >>> 0));
  }

  /** MSG_RANDOM_ROLL: u32 min + u32 max. vMaNGOS rejects min>max or max>10000. */
  randomRoll(minimum = 1, maximum = 100) {
    if (this.closed) return;
    const lo = Math.max(0, Math.floor(minimum));
    const hi = Math.min(RANDOM_ROLL_MAX, Math.floor(maximum));
    if (lo > hi) return;
    this.socket.send(OPCODES.MSG_RANDOM_ROLL, concat(u32(lo), u32(hi)));
  }

  /** MSG_MINIMAP_PING: f32 x + f32 y, relayed to the rest of the group. */
  minimapPing(x: number, y: number) {
    if (this.closed) return;
    this.socket.send(OPCODES.MSG_MINIMAP_PING, concat(f32(x), f32(y)));
  }

  /** CMSG_GUILD_QUERY: u32 guild id. Answered once and cached — guild data rarely changes. */
  queryGuild(guildId: number) {
    if (this.closed || !guildId || this.guildNames.has(guildId) || this.pendingGuildQueries.has(guildId)) return;
    this.pendingGuildQueries.add(guildId);
    this.socket.send(OPCODES.CMSG_GUILD_QUERY, u32(guildId >>> 0));
  }

  getGuildInfo(guildId: number): GuildInfo | undefined { return this.guildNames.get(guildId); }

  /** CMSG_PLAYED_TIME (empty) -> SMSG_PLAYED_TIME { u32 total, u32 thisLevel } seconds. */
  requestPlayedTime() {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_PLAYED_TIME, new Uint8Array(0));
  }

  /** CMSG_TOGGLE_PVP: empty body toggles; one u8 sets explicitly. */
  togglePvp(enable?: boolean) {
    if (this.closed) return;
    this.socket.send(
      OPCODES.CMSG_TOGGLE_PVP,
      enable === undefined ? new Uint8Array(0) : new Uint8Array([enable ? 1 : 0]),
    );
  }

  /** CMSG_ITEM_NAME_QUERY: cheaper than a full item query when only the name is shown. */
  requestItemName(entry: number) {
    if (this.closed || !entry || this.itemNames.has(entry) || this.pendingItemNameQueries.has(entry)) return;
    this.pendingItemNameQueries.add(entry);
    this.socket.send(OPCODES.CMSG_ITEM_NAME_QUERY, u32(entry >>> 0));
  }

  getItemNameOnly(entry: number): string | undefined { return this.itemNames.get(entry); }

  /** True once SMSG_RECEIVED_MAIL has arrived; cleared when the mailbox is opened. */
  hasUnreadMail() { return this.unreadMail; }

  // --- Auction house ---------------------------------------------------------------------------

  auctionHello(guid: string) {
    if (this.closed || !guid) return;
    this.currentAuctioneerGuid = guid;
    this.socket.send(OPCODES.MSG_AUCTION_HELLO, guidHexToBytes(guid));
  }

  closeAuctionHouse() {
    this.currentAuctioneerGuid = undefined;
    this.auctionPages = emptyAuctionPages();
    this.auctionHouseId = 0;
    this.auctionPending = undefined;
    this.lastAuctionFilters = {};
  }

  getAuctionState(): AuctionState | undefined {
    if (!this.currentAuctioneerGuid) return undefined;
    const clone = (page: AuctionListPage): AuctionListPage =>
      ({ ...page, entries: page.entries.map((entry) => ({ ...entry })) });
    return {
      auctioneerGuid: this.currentAuctioneerGuid,
      houseId: this.auctionHouseId,
      browse: clone(this.auctionPages.browse),
      bids: clone(this.auctionPages.bids),
      auctions: clone(this.auctionPages.auctions),
      pending: this.auctionPending,
    };
  }

  auctionListItems(filters: AuctionSearchFilters = {}) {
    if (this.closed || !this.currentAuctioneerGuid) return;
    this.lastAuctionFilters = { ...filters };
    this.auctionPages.browse = { ...this.auctionPages.browse, page: Math.max(0, Math.floor(filters.page ?? 0)) };
    this.auctionPending = 'browse';
    this.socket.send(
      OPCODES.CMSG_AUCTION_LIST_ITEMS,
      buildAuctionListItems(this.codec, this.currentAuctioneerGuid, filters),
    );
    this.emitAuction();
  }

  auctionListOwnerItems(page = 0) {
    if (this.closed || !this.currentAuctioneerGuid) return;
    this.auctionPages.auctions = { ...this.auctionPages.auctions, page: Math.max(0, page) };
    this.auctionPending = 'auctions';
    this.socket.send(
      OPCODES.CMSG_AUCTION_LIST_OWNER_ITEMS,
      buildAuctionListOwner(this.codec, this.currentAuctioneerGuid, page),
    );
    this.emitAuction();
  }

  auctionListBidderItems(page = 0, refreshIds: number[] = []) {
    if (this.closed || !this.currentAuctioneerGuid) return;
    this.auctionPages.bids = { ...this.auctionPages.bids, page: Math.max(0, page) };
    this.auctionPending = 'bids';
    this.socket.send(
      OPCODES.CMSG_AUCTION_LIST_BIDDER_ITEMS,
      buildAuctionListBidder(this.codec, this.currentAuctioneerGuid, page, refreshIds),
    );
    this.emitAuction();
  }

  auctionSellItem(itemGuid: string, bid: number, buyout: number, durationMinutes: number) {
    if (this.closed || !this.currentAuctioneerGuid || !itemGuid) return;
    const body = buildAuctionSellItem(this.codec, this.currentAuctioneerGuid, itemGuid, bid, buyout, durationMinutes);
    if (body) this.socket.send(OPCODES.CMSG_AUCTION_SELL_ITEM, body);
  }

  auctionPlaceBid(auctionId: number, price: number) {
    if (this.closed || !this.currentAuctioneerGuid || !auctionId || price <= 0) return;
    this.socket.send(
      OPCODES.CMSG_AUCTION_PLACE_BID,
      buildAuctionPlaceBid(this.codec, this.currentAuctioneerGuid, auctionId, price),
    );
  }

  auctionRemoveItem(auctionId: number) {
    if (this.closed || !this.currentAuctioneerGuid || !auctionId) return;
    this.socket.send(
      OPCODES.CMSG_AUCTION_REMOVE_ITEM,
      buildAuctionRemoveItem(this.codec, this.currentAuctioneerGuid, auctionId),
    );
  }

  // --- Guild charters --------------------------------------------------------------------------

  petitionShowList(guid: string) {
    if (this.closed || !guid) return;
    this.currentPetitionVendorGuid = guid;
    this.socket.send(OPCODES.CMSG_PETITION_SHOWLIST, guidHexToBytes(guid));
  }

  petitionBuy(guid: string, name: string, index = 0) {
    if (this.closed || !guid || !name.trim()) return;
    this.socket.send(OPCODES.CMSG_PETITION_BUY, buildPetitionBuy(this.codec, guid, name, index));
  }

  petitionShowSignatures(itemGuid: string) {
    if (this.closed || !itemGuid) return;
    this.socket.send(OPCODES.CMSG_PETITION_SHOW_SIGNATURES, guidHexToBytes(itemGuid));
  }

  petitionQuery(petitionGuid: number, itemGuid: string) {
    if (this.closed || !petitionGuid) return;
    this.socket.send(OPCODES.CMSG_PETITION_QUERY, buildPetitionQuery(this.codec, petitionGuid, itemGuid));
  }

  petitionSign(itemGuid: string) {
    if (this.closed || !itemGuid) return;
    this.socket.send(OPCODES.CMSG_PETITION_SIGN, buildPetitionSign(this.codec, itemGuid));
  }

  petitionDecline(itemGuid: string) {
    if (this.closed || !itemGuid) return;
    this.socket.send(OPCODES.MSG_PETITION_DECLINE, guidHexToBytes(itemGuid));
  }

  petitionOffer(itemGuid: string, playerGuid: string) {
    if (this.closed || !itemGuid || !playerGuid) return;
    this.socket.send(OPCODES.CMSG_OFFER_PETITION, buildPetitionOffer(this.codec, itemGuid, playerGuid));
  }

  petitionTurnIn(itemGuid: string) {
    if (this.closed || !itemGuid) return;
    this.socket.send(OPCODES.CMSG_TURN_IN_PETITION, guidHexToBytes(itemGuid));
  }

  petitionRename(itemGuid: string, newName: string) {
    if (this.closed || !itemGuid || !newName.trim()) return;
    this.socket.send(OPCODES.MSG_PETITION_RENAME, buildPetitionRename(this.codec, itemGuid, newName));
  }

  getPetitionState(): PetitionState | undefined {
    return this.currentPetition
      ? { ...this.currentPetition, signatures: [...this.currentPetition.signatures] }
      : undefined;
  }

  closePetition() {
    this.currentPetition = undefined;
    this.currentPetitionVendorGuid = undefined;
  }

  // --- Hunter stable ---------------------------------------------------------------------------

  listStabledPets(guid: string) {
    if (this.closed || !guid) return;
    this.currentStableGuid = guid;
    this.socket.send(OPCODES.MSG_LIST_STABLED_PETS, guidHexToBytes(guid));
  }

  closeStable() {
    this.currentStableGuid = undefined;
    this.stablePets = [];
    this.stableSlots = 0;
  }

  getStableState(): StableState | undefined {
    return this.currentStableGuid
      ? { guid: this.currentStableGuid, stableSlots: this.stableSlots, pets: this.stablePets.map((p) => ({ ...p })) }
      : undefined;
  }

  stableCurrentPet() { this.sendStableAction(OPCODES.CMSG_STABLE_PET); }
  buyStableSlot() { this.sendStableAction(OPCODES.CMSG_BUY_STABLE_SLOT); }

  /** CMSG_UNSTABLE_PET: u64 npcGuid + u32 petNumber. Rejected while a pet is already summoned. */
  unstablePet(petNumber: number) { this.sendStablePetAction(OPCODES.CMSG_UNSTABLE_PET, petNumber); }
  /** CMSG_STABLE_SWAP_PET: swaps the active pet with a stabled one. */
  stableSwapPet(petNumber: number) { this.sendStablePetAction(OPCODES.CMSG_STABLE_SWAP_PET, petNumber); }

  private sendStableAction(opcode: number) {
    if (this.closed || !this.currentStableGuid) return;
    this.socket.send(opcode, guidHexToBytes(this.currentStableGuid));
  }

  private sendStablePetAction(opcode: number, petNumber: number) {
    if (this.closed || !this.currentStableGuid || !petNumber) return;
    this.socket.send(opcode, concat(guidHexToBytes(this.currentStableGuid), u32(petNumber >>> 0)));
  }

  openMailbox(guid: string) {
    if (this.closed || !guid) return;
    this.currentMailboxGuid = guid;
    this.unreadMail = false;
    this.socket.send(OPCODES.CMSG_GET_MAIL_LIST, guidHexToBytes(guid));
  }

  closeMailbox() {
    this.currentMailboxGuid = undefined;
    this.mailMessages = [];
  }

  getMailState(): MailState | undefined {
    return this.currentMailboxGuid ? { mailboxGuid: this.currentMailboxGuid, messages: this.mailMessages.map((mail) => ({ ...mail })) } : undefined;
  }

  sendMail(params: { receiver: string; subject: string; body: string; itemGuid?: string; money?: number; cod?: number }) {
    if (this.closed || !this.currentMailboxGuid || !params.receiver.trim()) return;
    this.socket.send(OPCODES.CMSG_SEND_MAIL, concat(
      guidHexToBytes(this.currentMailboxGuid),
      cstring(params.receiver.trim()),
      cstring(params.subject.slice(0, 64)),
      cstring(params.body.slice(0, 8000)),
      u32(41),
      u32(0),
      params.itemGuid ? guidHexToBytes(params.itemGuid) : new Uint8Array(8),
      u32(Math.max(0, params.money ?? 0)),
      u32(Math.max(0, params.cod ?? 0)),
      new Uint8Array(9),
    ));
  }

  mailTakeMoney(mailId: number) { this.sendMailboxAction(OPCODES.CMSG_MAIL_TAKE_MONEY, mailId); }
  mailTakeItem(mailId: number) { this.sendMailboxAction(OPCODES.CMSG_MAIL_TAKE_ITEM, mailId); }
  mailMarkRead(mailId: number) { this.sendMailboxAction(OPCODES.CMSG_MAIL_MARK_AS_READ, mailId); }
  mailReturn(mailId: number) { this.sendMailboxAction(OPCODES.CMSG_MAIL_RETURN_TO_SENDER, mailId); }
  mailDelete(mailId: number) { this.sendMailboxAction(OPCODES.CMSG_MAIL_DELETE, mailId); }
  queryMailBody(mailId: number, itemTextId: number) {
    if (this.closed || !itemTextId) return;
    this.socket.send(OPCODES.CMSG_ITEM_TEXT_QUERY, concat(u32(itemTextId), u32(mailId), u32(0)));
  }

  private sendMailboxAction(opcode: number, mailId: number) {
    if (this.closed || !this.currentMailboxGuid) return;
    this.socket.send(opcode, concat(guidHexToBytes(this.currentMailboxGuid), u32(mailId)));
  }

  initiateTrade(guid: string) {
    if (this.closed || !guid) return;
    this.tradeState = {
      partnerGuid: guid,
      playerMoney: 0,
      targetMoney: 0,
      playerItems: Array(7),
      targetItems: Array(7),
      playerAccepted: false,
      targetAccepted: false,
    };
    this.socket.send(OPCODES.CMSG_INITIATE_TRADE, guidHexToBytes(guid));
  }

  beginTrade() {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_BEGIN_TRADE);
  }

  acceptTrade() {
    if (this.closed || !this.tradeState) return;
    this.tradeState.playerAccepted = true;
    this.socket.send(OPCODES.CMSG_ACCEPT_TRADE, u32(1));
    this.emitInteraction({ kind: 'trade', state: this.getTradeState()! });
  }

  unacceptTrade() {
    if (this.closed || !this.tradeState) return;
    this.tradeState.playerAccepted = false;
    this.socket.send(OPCODES.CMSG_UNACCEPT_TRADE);
    this.emitInteraction({ kind: 'trade', state: this.getTradeState()! });
  }

  cancelTrade() {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_CANCEL_TRADE);
    this.tradeState = undefined;
    this.masterLootEligible = [];
  }

  setTradeItem(tradeSlot: number, bag: number, slot: number) {
    if (this.closed || tradeSlot < 0 || tradeSlot >= 7) return;
    this.socket.send(OPCODES.CMSG_SET_TRADE_ITEM, new Uint8Array([tradeSlot & 0xff, bag & 0xff, slot & 0xff]));
  }

  clearTradeItem(tradeSlot: number) {
    if (this.closed || tradeSlot < 0 || tradeSlot >= 7) return;
    this.socket.send(OPCODES.CMSG_CLEAR_TRADE_ITEM, new Uint8Array([tradeSlot & 0xff]));
  }

  setTradeGold(copper: number) {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_SET_TRADE_GOLD, u32(Math.max(0, copper) >>> 0));
  }

  gossipSelect(guid: string, optionIndex: number, code = '') {
    if (this.closed || !guid) return;
    const base = concat(guidHexToBytes(guid), u32(optionIndex >>> 0));
    this.socket.send(OPCODES.CMSG_GOSSIP_SELECT_OPTION, code ? concat(base, cstring(code)) : base);
  }

  questHello(guid: string) {
    if (this.closed || !guid) return;
    this.socket.send(OPCODES.CMSG_QUESTGIVER_HELLO, guidHexToBytes(guid));
  }

  questQuery(guid: string, questId: number) {
    if (this.closed || !guid || !questId) return;
    this.socket.send(OPCODES.CMSG_QUESTGIVER_QUERY_QUEST, concat(guidHexToBytes(guid), u32(questId >>> 0)));
  }

  questAccept(guid: string, questId: number) {
    if (this.closed || !guid || !questId) return;
    this.invalidateQuestGiverStatuses(); // taking this quest clears the giver's ! (or flips it to ?)
    this.socket.send(OPCODES.CMSG_QUESTGIVER_ACCEPT_QUEST, concat(guidHexToBytes(guid), u32(questId >>> 0)));
  }

  questComplete(guid: string, questId: number) {
    if (this.closed || !guid || !questId) return;
    this.socket.send(OPCODES.CMSG_QUESTGIVER_COMPLETE_QUEST, concat(guidHexToBytes(guid), u32(questId >>> 0)));
  }

  questRequestReward(guid: string, questId: number) {
    if (this.closed || !guid || !questId) return;
    this.socket.send(OPCODES.CMSG_QUESTGIVER_REQUEST_REWARD, concat(guidHexToBytes(guid), u32(questId >>> 0)));
  }

  questChooseReward(guid: string, questId: number, rewardIndex = 0) {
    if (this.closed || !guid || !questId) return;
    this.socket.send(OPCODES.CMSG_QUESTGIVER_CHOOSE_REWARD, concat(guidHexToBytes(guid), u32(questId >>> 0), u32(rewardIndex >>> 0)));
  }

  questCancel(sharedByGuid?: string) {
    if (this.closed) return;
    if (sharedByGuid) {
      this.questItems.declineQuest(sharedByGuid);
    } else this.socket.send(OPCODES.CMSG_QUESTGIVER_CANCEL);
  }

  openItem(bag: number, slot: number) { if (!this.closed) this.socket.send(OPCODES.CMSG_OPEN_ITEM, new Uint8Array([bag & 0xff, slot & 0xff])); }

  confirmSharedQuest(questId: number) {
    const cleanQuestId = questId >>> 0;
    if (this.closed || !cleanQuestId) return;
    this.questItems.confirmQuest(cleanQuestId);
  }

  queryQuestInfo(questId: number) {
    const cleanQuestId = questId >>> 0;
    if (this.closed || !cleanQuestId || this.questInfo.has(cleanQuestId) || this.pendingQuestQueries.has(cleanQuestId)) return;
    this.pendingQuestQueries.add(cleanQuestId);
    this.socket.send(OPCODES.CMSG_QUEST_QUERY, u32(cleanQuestId));
  }

  swapQuestLogSlots(slot1: number, slot2: number) {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_QUESTLOG_SWAP_QUEST, new Uint8Array([slot1 & 0xff, slot2 & 0xff]));
  }

  removeQuestLogSlot(slot: number) {
    if (this.closed) return;
    this.invalidateQuestGiverStatuses(); // abandoning frees a giver to offer that quest again (! returns)
    this.socket.send(OPCODES.CMSG_QUESTLOG_REMOVE_QUEST, new Uint8Array([slot & 0xff]));
  }

  pushQuestToParty(questId: number) {
    const cleanQuestId = questId >>> 0;
    if (this.closed || !cleanQuestId) return;
    this.socket.send(OPCODES.CMSG_PUSHQUESTTOPARTY, u32(cleanQuestId));
  }

  listVendor(guid: string) {
    if (this.closed || !guid) return;
    this.currentVendorGuid = guid;
    this.socket.send(OPCODES.CMSG_LIST_INVENTORY, guidHexToBytes(guid));
  }

  /** True when the entity behind this guid is a repairer (UNIT_NPC_FLAG_REPAIR). */
  private npcHasRepairFlag(guid: string): boolean {
    const entity = this.entities.get(guid);
    return ((entity?.npcFlags ?? 0) & UNIT_NPC_FLAG_REPAIR) !== 0;
  }

  /**
   * CMSG_REPAIR_ITEM (680): u64 npcGuid, u64 itemGuid. A ZERO itemGuid means "repair everything" —
   * HandleRepairItemOpcode branches on `if (packet.itemGuid)` between DurabilityRepair and
   * DurabilityRepairAll (NPCHandler.cpp:806-816). Cost, reputation discount and gold deduction are
   * entirely server-side; the client only asks.
   */
  repairAllItems(vendorGuid: string) {
    if (this.closed || !vendorGuid) return;
    this.socket.send(OPCODES.CMSG_REPAIR_ITEM, concat(guidHexToBytes(vendorGuid), guidHexToBytes('0000000000000000')));
  }

  /** CMSG_REPAIR_ITEM for a single item by its guid. */
  repairItem(vendorGuid: string, itemGuid: string) {
    if (this.closed || !vendorGuid || !itemGuid) return;
    this.socket.send(OPCODES.CMSG_REPAIR_ITEM, concat(guidHexToBytes(vendorGuid), guidHexToBytes(itemGuid)));
  }

  buyVendorItem(guid: string, itemEntry: number, count = 1) {
    if (this.closed || !guid || !itemEntry) return;
    this.socket.send(OPCODES.CMSG_BUY_ITEM, concat(guidHexToBytes(guid), u32(itemEntry >>> 0), new Uint8Array([Math.max(1, count) & 0xff, 0])));
  }

  sellItem(vendorGuid: string, itemGuid: string, count = 0) {
    if (this.closed || !vendorGuid || !itemGuid) return;
    this.socket.send(OPCODES.CMSG_SELL_ITEM, concat(guidHexToBytes(vendorGuid), guidHexToBytes(itemGuid), new Uint8Array([count & 0xff])));
  }

  /**
   * Items the vendor is holding back for you, newest first (vanilla lists the most recent sale in
   * the first buyback slot). Empty slots are skipped, so the UI never renders holes.
   */
  getBuybackItems(): BuybackItem[] {
    const player = this.activeCharacter ? this.entities.get(this.activeCharacter.guid) : undefined;
    if (!player) return [];
    const results: BuybackItem[] = [];
    for (let index = 0; index < BUYBACK_SLOT_COUNT; index++) {
      const guid = guidField(player.fields, PLAYER_FIELD_VENDORBUYBACK_SLOT_1 + index * 2);
      if (!guid || guid === '0000000000000000') continue;
      const entity = this.entities.get(guid);
      const entry = entity?.entry ?? entity?.fields.get(OBJECT_FIELD_ENTRY) ?? 0;
      if (!entry) continue;
      results.push({
        // The wire wants the absolute inventory slot, not this loop index.
        slot: BUYBACK_SLOT_START + index,
        guid,
        entry,
        count: entity?.fields.get(ITEM_FIELD_STACK_COUNT) ?? 1,
        price: player.fields.get(PLAYER_FIELD_BUYBACK_PRICE_1 + index) ?? 0,
        soldAt: player.fields.get(PLAYER_FIELD_BUYBACK_TIMESTAMP_1 + index) ?? 0,
      });
    }
    return results;
  }

  /** CMSG_BUYBACK_ITEM: u64 vendorGuid, u32 slot (absolute, 69..80). */
  buybackItem(vendorGuid: string, slot: number) {
    if (this.closed || !vendorGuid) return;
    if (slot < BUYBACK_SLOT_START || slot >= BUYBACK_SLOT_END) return;
    this.socket.send(OPCODES.CMSG_BUYBACK_ITEM, concat(guidHexToBytes(vendorGuid), u32(slot >>> 0)));
  }

  listTrainer(guid: string) {
    if (this.closed || !guid) return;
    this.currentTrainerGuid = guid;
    this.socket.send(OPCODES.CMSG_TRAINER_LIST, guidHexToBytes(guid));
  }

  buyTrainerSpell(guid: string, spellId: number) {
    if (this.closed || !guid || !spellId) return;
    this.socket.send(OPCODES.CMSG_TRAINER_BUY_SPELL, concat(guidHexToBytes(guid), u32(spellId >>> 0)));
  }

  /** Re-request the flight map from a flight master (vanilla re-opens via gossip). */
  queryTaxiNodes(guid: string) {
    if (this.closed || !guid) return;
    this.socket.send(OPCODES.CMSG_TAXIQUERYAVAILABLENODES, guidHexToBytes(guid));
  }

  /** CMSG_ACTIVATETAXI: flight master guid + source/destination TaxiNodes ids. */
  activateTaxi(guid: string, sourceNode: number, destinationNode: number) {
    if (this.closed || !guid || !sourceNode || !destinationNode) return;
    this.socket.send(OPCODES.CMSG_ACTIVATETAXI, concat(guidHexToBytes(guid), u32(sourceNode >>> 0), u32(destinationNode >>> 0)));
  }

  async createCharacter(params: CharCreateParams): Promise<{ success: boolean; error?: string }> {
    const name = cstring(params.name);
    const body = concat(
      name,
      new Uint8Array([
        params.race,
        params.classId,
        params.gender,
        params.skin,
        params.face,
        params.hairStyle,
        params.hairColor,
        params.facialHair,
        0, // OutfitID (always 0)
      ])
    );
    this.socket.send(OPCODES.CMSG_CHAR_CREATE, body);

    for (let i = 0; i < 40; i++) {
      const packet = await this.socket.readPacket();
      if (packet.opcode === OPCODES.SMSG_CHAR_CREATE) {
        const result = packet.body[0];
        // Vanilla 1.12 ResponseCodes (vMaNGOS SharedDefines.h): 0x2D = CHAR_CREATE_IN_PROGRESS,
        // 0x2E = CHAR_CREATE_SUCCESS. Do not treat IN_PROGRESS as playable yet; entering that
        // freshly-created character before vMaNGOS finishes SaveNewPlayer can miss initial grids.
        if (result === 0x2d) {
          this.progress('world: character creation still in progress');
          continue;
        }
        if (result === 0x2e) {
          return { success: true };
        }
        const CHAR_CREATE_ERRORS: Record<number, string> = {
          0x2f: 'Creation failed (server error)',          // CHAR_CREATE_ERROR
          0x30: 'Creation failed (server error)',          // CHAR_CREATE_FAILED
          0x31: 'Name already exists',                     // CHAR_CREATE_NAME_IN_USE
          0x32: 'Character creation is disabled',          // CHAR_CREATE_DISABLED
          0x33: 'Both factions are not allowed on a PvP realm', // CHAR_CREATE_PVP_TEAMS_VIOLATION
          0x34: 'Realm character limit reached',           // CHAR_CREATE_SERVER_LIMIT
          0x35: 'Cannot create more characters',           // CHAR_CREATE_ACCOUNT_LIMIT
        };
        return { success: false, error: CHAR_CREATE_ERRORS[result] ?? `Unknown error (0x${result.toString(16)})` };
      }
      await this.handlePacket(packet);
    }
    return { success: false, error: 'Timeout waiting for character creation response' };
  }

  async deleteCharacter(guidBytes: number[]): Promise<{ success: boolean; error?: string }> {
    this.socket.send(OPCODES.CMSG_CHAR_DELETE, new Uint8Array(guidBytes));

    for (let i = 0; i < 40; i++) {
      const packet = await this.socket.readPacket();
      if (packet.opcode === OPCODES.SMSG_CHAR_DELETE) {
        const result = packet.body[0];
        // Vanilla 1.12: 0x38 = CHAR_DELETE_IN_PROGRESS, 0x39 = CHAR_DELETE_SUCCESS, 0x3A = FAILED.
        if (result === 0x38 || result === 0x39) {
          return { success: true };
        }
        return { success: false, error: `Deletion failed (0x${result.toString(16)})` };
      }
      await this.handlePacket(packet);
    }
    return { success: false, error: 'Timeout waiting for character deletion response' };
  }

  async reloadCharacters(): Promise<CharacterInfo[]> {
    this.socket.send(OPCODES.CMSG_CHAR_ENUM);
    for (let i = 0; i < 40; i++) {
      const packet = await this.socket.readPacket();
      if (packet.opcode === OPCODES.SMSG_CHAR_ENUM) {
        const list = parseCharacters(packet);
        (this.characters as any).length = 0;
        (this.characters as any).push(...list);
        return list;
      }
      await this.handlePacket(packet);
    }
    throw new Error('Timeout waiting for character list reload');
  }

  requestLogout() {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_LOGOUT_REQUEST);
  }

  /** Abort a pending 20-second logout. vMaNGOS answers with SMSG_LOGOUT_CANCEL_ACK and un-roots. */
  cancelLogout() {
    if (this.closed) return;
    this.socket.send(OPCODES.CMSG_LOGOUT_CANCEL);
  }

  close(options: { logout?: boolean } = {}) {
    if (options.logout) {
      try {
        this.requestLogout();
      } catch {
        // The page may be tearing down; closing the socket still lets vMaNGOS finalize the session.
      }
    }
    this.restoreControlledMover('disconnect', false);
    this.closed = true;
    // Server-side channel membership ends with the session.
    this.channelSlots.clear(); this.channelLists.clear();
    if (this.pingTimer !== undefined) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    if (this.statsEmitTimer !== undefined) {
      clearTimeout(this.statsEmitTimer);
      this.statsEmitTimer = undefined;
    }
    this.simulationWorker?.dispose();
    this.simulationWorkerActive = false;
    this.socket.close();
  }

  private startPingLoop() {
    if (this.pingTimer !== undefined) return;
    this.sendPingIfDue('start');
    // vMaNGOS treats CMSG_PING faster than 27 seconds as "overspeed pings" and may kick after a
    // few strikes. Vanilla clients sit around a 30s cadence, so keep this safely above the limit.
    this.pingTimer = setInterval(() => this.sendPingIfDue('timer'), WORLD_PING_INTERVAL_MS);
  }

  private sendPingIfDue(source: 'start' | 'timer' | 'resume') {
    if (this.closed) return false;
    const now = performance.now();
    if (this.lastPingSentAt && now - this.lastPingSentAt < WORLD_PING_MIN_SAFE_INTERVAL_MS) return false;
    try {
      this.socket.send(OPCODES.CMSG_PING, this.clockSync.createPingPayload());
      this.lastPingSentAt = now;
      return true;
    } catch (e) {
      this.progress(`world: ${source} ping failed (${(e as Error).message})`);
      this.handleSocketFailure(e as Error);
      return false;
    }
  }

  private handleSocketFailure(error: Error) {
    if (this.closed) return;
    this.restoreControlledMover('disconnect', false);
    this.closed = true;
    // Server-side channel membership ends with the session.
    this.channelSlots.clear(); this.channelLists.clear();
    if (this.pingTimer !== undefined) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    if (this.statsEmitTimer !== undefined) {
      clearTimeout(this.statsEmitTimer);
      this.statsEmitTimer = undefined;
    }
    this.progress(`world: connection stopped (${error.message})`);
    this.dispatch(this.disconnectListeners, (listener) => listener(error.message), 'disconnect');
  }

  private beginPump() {
    if (this.pumpStarted) return;
    this.pumpStarted = true;
    void this.pump();
  }

  private async pump() {
    while (!this.closed) {
      try {
        const packet = await this.socket.readPacket();
        await this.handlePacket(packet);
      } catch (e) {
        if (!this.closed) this.handleSocketFailure(e as Error);
        return;
      }
    }
  }

  private async handlePacket(
    packet: WorldPacket,
    context: PacketDispatchContext = { compressedDepth: 0 },
  ) {
    this.stats.lastOpcode = packetName(packet.opcode);
    if (packet.opcode === OPCODES.SMSG_COMPRESSED_MOVES) {
      this.stats.compressedMovementPackets++;
      try {
        if (context.compressedDepth !== 0) {
          throw new Error(
            `nested SMSG_COMPRESSED_MOVES at depth ${context.compressedDepth} is not allowed`,
          );
        }
        const nestedPackets = await decodeCompressedMoves(packet.body, {
          maxInflatedBytes: 900_000,
        });
        for (const nested of nestedPackets) {
          this.stats.nestedMovementPackets++;
          await this.handlePacket(
            { opcode: nested.opcode, body: nested.body },
            {
              compressedDepth: context.compressedDepth + 1,
              parentOpcode: packet.opcode,
              recordIndex: nested.recordIndex,
            },
          );
        }
      } catch (e) {
        this.progress(`world: compressed movement batch rejected (${(e as Error).message})`);
      }
      this.emitStats();
      return;
    }

    if (this.questItems.handle(packet.opcode, packet.body)) return;
    const deferredService = deferredServicePacketMessage(packet.opcode);
    if (deferredService) { showUiError(deferredService); return; }

    if (packet.opcode === OPCODES.SMSG_CLIENT_CONTROL_UPDATE) {
      // Build 5875: packed mover GUID + allowMove; enabled movers are confirmed with a raw GUID.
      try {
        const { moverGuid, allowMove } = decodeClientControlUpdateBody(packet.body);
        if (!this.controlledMover) {
          const playerGuid = this.activeCharacter?.guid;
          if (!playerGuid) throw new Error('CLIENT_CONTROL_UPDATE arrived without an active player');
          this.controlledMover = initialControlledMoverState(playerGuid, this.worldGeneration);
        }
        const previousMoverGuid = this.controlledMover.moverGuid;
        this.controlledMover = applyClientControlUpdate(
          this.controlledMover,
          { moverGuid, allowMove },
        );
        if (allowMove) {
          this.socket.send(OPCODES.CMSG_SET_ACTIVE_MOVER, guidHexToBytes(moverGuid));
          this.progress(`world: active mover -> ${moverGuid} (confirmed)`);
        } else {
          this.progress(`world: movement control revoked for ${moverGuid}`);
        }
        this.emitControlledMover(previousMoverGuid, 'server');
      } catch (e) {
        this.progress(`world: client-control update skipped (${(e as Error).message})`);
      }
      return;
    }
    if (packet.opcode === OPCODES.SMSG_CORPSE_RECLAIM_DELAY) {
      try {
        const delayMs = new Reader(packet.body).u32();
        this.emitDeath({ kind: 'corpseReclaimDelay', delayMs, availableAt: Date.now() + delayMs });
      } catch (e) {
        this.progress(`world: corpse reclaim delay parse skipped (${(e as Error).message})`);
      }
      return;
    }
    if (packet.opcode === OPCODES.MSG_CORPSE_QUERY) {
      try {
        const r = new Reader(packet.body);
        if (r.u8() === 0) {
          this.emitDeath({ kind: 'corpseLocation', found: false });
        } else {
          this.emitDeath({
            kind: 'corpseLocation',
            found: true,
            mapId: r.i32(),
            x: r.f32(),
            y: r.f32(),
            z: r.f32(),
            corpseMapId: r.u32(),
          });
        }
      } catch (e) {
        this.progress(`world: corpse query parse skipped (${(e as Error).message})`);
      }
      return;
    }
    if (packet.opcode === OPCODES.SMSG_RESURRECT_REQUEST) {
      try {
        const r = new Reader(packet.body);
        const resurrectorGuid = readGuid64(r);
        const nameLength = r.u32();
        const resurrectorName = nameLength > 0 ? r.cstring() : '';
        const sickness = r.u8() !== 0;
        const useTimer = r.u8() !== 0;
        if (!resurrectorName) this.queryPlayerName(resurrectorGuid);
        this.emitDeath({ kind: 'resurrectRequest', resurrectorGuid, resurrectorName, sickness, useTimer });
      } catch (e) {
        this.progress(`world: resurrect request parse skipped (${(e as Error).message})`);
      }
      return;
    }
    if (packet.opcode === OPCODES.SMSG_RESURRECT_FAILED) {
      this.emitDeath({ kind: 'resurrectFailed' });
      return;
    }
    if (packet.opcode === OPCODES.SMSG_SPIRIT_HEALER_CONFIRM) {
      // Spirit-healer resurrect is a 3-step handshake: gossip select -> server casts 17251 ->
      // SMSG_SPIRIT_HEALER_CONFIRM (this) -> the client shows the XP-loss confirm and replies
      // CMSG_SPIRIT_HEALER_ACTIVATE. Without this the "Return me to life" option silently did nothing.
      try {
        const healerGuid = readGuid64(new Reader(packet.body));
        this.emitDeath({ kind: 'spiritHealerConfirm', healerGuid });
      } catch (e) {
        this.progress(`world: spirit healer confirm parse skipped (${(e as Error).message})`);
      }
      return;
    }
    if (packet.opcode === OPCODES.SMSG_ENVIRONMENTALDAMAGELOG) {
      try {
        const r = new Reader(packet.body);
        this.emitCombat({
          kind: 'environmentalDamage',
          victimGuid: readGuid64(r),
          damageType: r.u8(),
          damage: r.u32(),
          absorb: r.u32(),
          resist: r.i32(),
        });
      } catch (e) {
        this.progress(`world: environmental damage log parse skipped (${(e as Error).message})`);
      }
      return;
    }
    if (packet.opcode === OPCODES.SMSG_FRIEND_LIST) {
      try {
        const r = new Reader(packet.body);
        const friends: SocialFriend[] = [];
        const count = r.u8();
        for (let i = 0; i < count && r.remaining >= 9; i++) {
          const guid = guidHex(r.bytes(8));
          const status = r.u8();
          const area = status && r.remaining >= 12 ? r.u32() : 0;
          const level = status && r.remaining >= 8 ? r.u32() : 0;
          const classId = status && r.remaining >= 4 ? r.u32() : 0;
          friends.push({ guid, status, area, level, classId });
          this.queryPlayerName(guid);
        }
        this.social = { ...this.social, friends };
        this.emitSocial();
      } catch (e) { this.progress(`world: friend list parse skipped (${(e as Error).message})`); }
      return;
    }
    if (packet.opcode === OPCODES.SMSG_IGNORE_LIST) {
      try {
        const r = new Reader(packet.body);
        const ignored: string[] = [];
        const count = r.u8();
        for (let i = 0; i < count && r.remaining >= 8; i++) {
          const guid = guidHex(r.bytes(8));
          ignored.push(guid);
          this.queryPlayerName(guid);
        }
        this.social = { ...this.social, ignored };
        this.emitSocial();
      } catch (e) { this.progress(`world: ignore list parse skipped (${(e as Error).message})`); }
      return;
    }
    if (packet.opcode === OPCODES.SMSG_FRIEND_STATUS) {
      // Results have several conditional layouts. The authoritative full lists are
      // tiny, so refresh them instead of maintaining a second fragile result parser.
      this.requestSocialLists();
      return;
    }
    if (packet.opcode === OPCODES.SMSG_WHO) {
      try {
        const r = new Reader(packet.body);
        const listed = r.u32();
        const whoOnline = r.u32();
        const who: WhoEntry[] = [];
        for (let i = 0; i < listed && r.remaining > 0; i++) {
          const entry: WhoEntry = { name: r.cstring(), guild: r.cstring(), level: r.u32(), classId: r.u32(), race: r.u32(), zoneId: r.u32() };
          who.push(entry);
          // SMSG_WHO is the only vanilla packet that pairs a player with their guild name
          // (SMSG_NAME_QUERY_RESPONSE carries realm, not guild). The who list itself is
          // replaced per query, so keep the name→guild pairs in a cache that survives it —
          // that is what feeds the UnitNamePlayerGuild overhead tag.
          if (entry.guild) this.playerGuildNames.set(entry.name.toLowerCase(), entry.guild);
        }
        this.social = { ...this.social, who, whoOnline };
        this.emitSocial();
      } catch (e) { this.progress(`world: who list parse skipped (${(e as Error).message})`); }
      return;
    }
    if (packet.opcode === OPCODES.SMSG_GUILD_ROSTER) {
      try {
        const state = readGuildRoster(new Reader(packet.body), (reader) => guidHex(reader.bytes(8)));
        const guildId = this.ownGuildId();
        if (guildId) this.queryGuild(guildId);
        const identity = guildId ? this.guildNames.get(guildId) : undefined;
        this.social = { ...this.social, ...state, guildName: identity?.name ?? this.social.guildName, guildRankNames: identity?.rankNames.slice(0, state.guildRankRights.length) ?? this.social.guildRankNames };
        this.emitSocial();
      } catch (e) { this.progress(`world: guild roster parse skipped (${(e as Error).message})`); }
      return;
    }
    if (packet.opcode === OPCODES.SMSG_GROUP_INVITE) {
      try {
        const inviterName = new Reader(packet.body).cstring();
        this.dispatch(this.partyInviteListeners, (listener) => listener({ inviterName }), 'partyInvite');
      } catch (e) { this.progress(`world: group invite parse skipped (${(e as Error).message})`); }
      return;
    }
    if (packet.opcode === OPCODES.SMSG_PARTY_COMMAND_RESULT) {
      try {
        const r = new Reader(packet.body);
        const operation = r.u32();
        const memberName = r.cstring();
        const result = r.u32();
        // Result 0 is ERR_PARTY_RESULT_OK — the server sends it on success too (e.g. after a
        // successful leave), so it must not surface as an error.
        const message = (PARTY_RESULT_TEXT[result] ?? '').replace('%s', memberName);
        this.dispatch(
          this.partyResultListeners,
          (listener) => listener({ operation, memberName, result, message }),
          'partyResult',
        );
      } catch (e) { this.progress(`world: party result parse skipped (${(e as Error).message})`); }
      return;
    }
    if (packet.opcode === OPCODES.SMSG_INSPECT) {
      try {
        const guid = readGuid64(new Reader(packet.body));
        // Body is only the guid — an ack that we may inspect. Equipment already lives on the
        // entity's VISIBLE_ITEM fields; the UI reads it from there.
        if (guid) {
          this.requestItemInfoForVisibleItems(guid);
          this.dispatch(this.inspectListeners, (listener) => listener({ guid }), 'inspect');
        }
      } catch (e) { this.progress(`world: inspect parse skipped (${(e as Error).message})`); }
      return;
    }
    if (packet.opcode === OPCODES.SMSG_DUEL_REQUESTED) {
      try {
        const r = new Reader(packet.body);
        this.duelFlagGuid = readGuid64(r);
        const challengerGuid = readGuid64(r);
        // The server sends this to BOTH players; the initiator must not get an accept popup.
        if (challengerGuid && challengerGuid !== this.activeCharacter?.guid) {
          this.dispatch(this.duelRequestListeners, (listener) => listener({ challengerGuid }), 'duelRequest');
        } else if (challengerGuid === this.activeCharacter?.guid) {
          // The original client acknowledges its own echoed request with the flag GUID. vMaNGOS
          // deliberately ignores this initiator-side accept; the challenged player still decides.
          this.acceptDuel();
        }
      } catch (e) { this.progress(`world: duel request parse skipped (${(e as Error).message})`); }
      return;
    }
    if (packet.opcode === OPCODES.SMSG_DUEL_COUNTDOWN) {
      try {
        // Reversed Build 5875 FUN_004d4ae0 divides this wire value by 1000; vMaNGOS sends 3000.
        const durationMs = new Reader(packet.body).u32();
        const seconds = Math.ceil(durationMs / 1000);
        this.dispatch(this.duelNoticeListeners, (listener) => listener({ kind: 'countdown', seconds }), 'duelNotice');
      } catch (e) { this.progress(`world: duel countdown parse skipped (${(e as Error).message})`); }
      return;
    }
    if (packet.opcode === OPCODES.SMSG_DUEL_WINNER) {
      try {
        const r = new Reader(packet.body);
        const fled = r.u8() !== 0;
        const winnerName = r.cstring();
        const loserName = r.cstring();
        // DUEL_WINNER_KNOCKOUT / _RETREAT (GlobalStrings.lua:736-737).
        const message = fled
          ? `${loserName} has fled from ${winnerName} in a duel`
          : `${winnerName} has defeated ${loserName} in a duel`;
        this.dispatch(this.duelNoticeListeners, (listener) => listener({ kind: 'winner', message }), 'duelNotice');
      } catch (e) { this.progress(`world: duel winner parse skipped (${(e as Error).message})`); }
      return;
    }
    if (packet.opcode === OPCODES.SMSG_DUEL_COMPLETE) {
      this.duelFlagGuid = '';
      // vMaNGOS serializes one bool: false for a challenge/countdown interruption, true after an
      // actually-started duel. Preserve that distinction so cancelling an invite cannot tear down
      // unrelated PvE combat on the recipient.
      const started = packet.body.length > 0 && new Reader(packet.body).u8() !== 0;
      this.dispatch(this.duelNoticeListeners, (listener) => listener({ kind: 'complete', started }), 'duelNotice');
      return;
    }
    // Empty-body notifications (vMaNGOS Duel.h). OUTOFBOUNDS starts the server's 10s forfeit timer
    // (Player::CheckDuelDistance); INBOUNDS clears it. The client is otherwise given no warning.
    if (packet.opcode === OPCODES.SMSG_DUEL_OUTOFBOUNDS) {
      this.dispatch(this.duelNoticeListeners, (listener) => listener({ kind: 'outOfBounds' }), 'duelNotice');
      return;
    }
    if (packet.opcode === OPCODES.SMSG_DUEL_INBOUNDS) {
      this.dispatch(this.duelNoticeListeners, (listener) => listener({ kind: 'inBounds' }), 'duelNotice');
      return;
    }
    if (packet.opcode === OPCODES.SMSG_GUILD_INVITE) {
      try {
        const r = new Reader(packet.body);
        const inviterName = r.cstring();
        const guildName = r.cstring();
        this.dispatch(this.guildInviteListeners, (listener) => listener({ inviterName, guildName }), 'guildInvite');
      } catch (e) { this.progress(`world: guild invite parse skipped (${(e as Error).message})`); }
      return;
    }
    if (packet.opcode === OPCODES.SMSG_GUILD_COMMAND_RESULT) {
      try {
        const r = new Reader(packet.body);
        const command = r.u32();
        const str = r.cstring();
        const result = r.u32();
        const message = (GUILD_RESULT_TEXT[result] ?? '').replace('%s', str);
        this.dispatch(this.guildResultListeners, (listener) => listener({ command, str, result, message }), 'guildResult');
      } catch (e) { this.progress(`world: guild result parse skipped (${(e as Error).message})`); }
      return;
    }
    if (packet.opcode === OPCODES.SMSG_GUILD_EVENT) {
      try {
        const r = new Reader(packet.body);
        const event = r.u8();
        const count = r.u8();
        const params: string[] = [];
        for (let i = 0; i < count && r.remaining > 0; i++) params.push(r.cstring());
        // The packet may append an ObjectGuid after the strings; we never read it, so a short
        // or long tail cannot desync anything.
        const message = guildEventMessage(event, params);
        if (message) this.dispatch(this.guildEventListeners, (listener) => listener({ event, message }), 'guildEvent');
        // Any membership/rank/motd change makes the cached roster stale — refresh it.
        this.requestGuildRoster();
      } catch (e) { this.progress(`world: guild event parse skipped (${(e as Error).message})`); }
      return;
    }
    if (packet.opcode === OPCODES.MSG_RAID_TARGET_UPDATE || packet.opcode === OPCODES.MSG_RAID_READY_CHECK) {
      try {
        const event = readRaidCoordination(packet.opcode, new Reader(packet.body), (reader) => guidHex(reader.bytes(8)));
        if (event?.kind === 'raidTargetDelta' || event?.kind === 'raidTargetList') { this.social = { ...this.social, raidTargets: applyRaidTargets(this.social.raidTargets, event) }; this.emitSocial(); }
        else if (event) { if (event.kind === 'readyCheckResponse') this.queryPlayerName(event.guid); this.emitInteraction(event); }
      } catch (e) { this.progress(`world: raid coordination parse skipped (${(e as Error).message})`); }
      return;
    }
    if (packet.opcode === OPCODES.SMSG_GROUP_LIST) {
      try {
        const state = readGroupList(new Reader(packet.body), (reader) => guidHex(reader.bytes(8)));
        const group: GroupMember[] = state.group;
        this.social = { ...this.social, ...state, raidTargets: group.length ? this.social.raidTargets : emptyRaidTargets() };
        // Drop cached vitals for anyone no longer in the party.
        const memberGuids = new Set(group.map((m) => m.guid));
        for (const guid of [...this.partyVitals.keys()]) if (!memberGuids.has(guid)) this.partyVitals.delete(guid);
        this.emitSocial();
        if (group.length) { for (const member of group) this.queryPlayerName(member.guid); this.socket.send(OPCODES.MSG_RAID_TARGET_UPDATE, buildRaidTargetListRequest()); }
      } catch (e) { this.progress(`world: group list parse skipped (${(e as Error).message})`); }
      return;
    }
    if (packet.opcode === OPCODES.SMSG_PARTY_MEMBER_STATS || packet.opcode === OPCODES.SMSG_PARTY_MEMBER_STATS_FULL) {
      try {
        const r = new Reader(packet.body);
        const guid = readPackedGuid(r);
        const mask = r.u32();
        const prev = this.partyVitals.get(guid);
        const vitals: PartyVitals = prev
          ? { ...prev }
          : { online: true, health: 0, maxHealth: 0, power: 0, maxPower: 0, powerType: 0, level: 0 };
        // GROUP_UPDATE_FLAG bit order (vMaNGOS Group.h). Fields are serialized ascending by bit, so the
        // vitals we render always precede zone/aura/pet payloads — parse them in order and stop.
        if ((mask & 0x0001) && r.remaining >= 1) vitals.online = (r.u8() & 0x01 /* MEMBER_STATUS_ONLINE */) !== 0;
        if ((mask & 0x0002) && r.remaining >= 2) vitals.health = r.u16();
        if ((mask & 0x0004) && r.remaining >= 2) vitals.maxHealth = r.u16();
        if ((mask & 0x0008) && r.remaining >= 1) vitals.powerType = r.u8();
        if ((mask & 0x0010) && r.remaining >= 2) vitals.power = r.u16();
        if ((mask & 0x0020) && r.remaining >= 2) vitals.maxPower = r.u16();
        if ((mask & 0x0040) && r.remaining >= 2) vitals.level = r.u16();
        this.partyVitals.set(guid, vitals);
        this.emitSocial();
      } catch (e) { this.progress(`world: party member stats parse skipped (${(e as Error).message})`); }
      return;
    }
    if (packet.opcode === OPCODES.SMSG_LOGIN_SETTIMESPEED) {
      try {
        const r = new Reader(packet.body);
        this.gameClock.sync(r.u32(), r.f32(), performance.now());
      } catch (e) {
        this.progress(`world: settimespeed parse skipped (${(e as Error).message})`);
      }
      return;
    }

    // Server-authoritative movement speed (mounting, speed auras, dazes). Wire format
    // verified vs vMaNGOS MovementPacketSender::SendSpeedChangeToController (build
    // 5875 branch): packed guid + u32 movementCounter + f32 speed. The client MUST
    // echo an ack (u64 guid + counter + MovementInfo + speed) or the server keeps the
    // change pending and rejects our subsequent moves at the new rate.
    {
      const forceSpeed: Record<number, { ack: number; kind: UnitSpeedKind }> = {
        [OPCODES.SMSG_FORCE_RUN_SPEED_CHANGE]: { ack: OPCODES.CMSG_FORCE_RUN_SPEED_CHANGE_ACK, kind: 'run' },
        [OPCODES.SMSG_FORCE_RUN_BACK_SPEED_CHANGE]: { ack: OPCODES.CMSG_FORCE_RUN_BACK_SPEED_CHANGE_ACK, kind: 'runBack' },
        [OPCODES.SMSG_FORCE_SWIM_SPEED_CHANGE]: { ack: OPCODES.CMSG_FORCE_SWIM_SPEED_CHANGE_ACK, kind: 'swim' },
        [OPCODES.SMSG_FORCE_WALK_SPEED_CHANGE]: { ack: OPCODES.CMSG_FORCE_WALK_SPEED_CHANGE_ACK, kind: 'walk' },
        [OPCODES.SMSG_FORCE_SWIM_BACK_SPEED_CHANGE]: { ack: OPCODES.CMSG_FORCE_SWIM_BACK_SPEED_CHANGE_ACK, kind: 'swimBack' },
        [OPCODES.SMSG_FORCE_TURN_RATE_CHANGE]: { ack: OPCODES.CMSG_FORCE_TURN_RATE_CHANGE_ACK, kind: 'turnRate' },
      };
      const entry = forceSpeed[packet.opcode];
      if (entry) {
        try {
          const { guid, movementCounter: counter, speed } = decodeForceSpeedBody(packet.body);
          const change = this.entities.applySpeed(guid, entry.kind, speed);
          if (change.kind === 'update') this.emitEntity(change.entity, change);
          if (!isCurrentControlledMover(this.controlledMover, guid)) {
            this.progress(
              `world: ignored late ${entry.kind} controller packet for inactive mover ${guid}`,
            );
            return;
          }
          this.socket.send(
            entry.ack,
            encodeForceSpeedAckBody(
              guid,
              counter,
              this.controlledMovementBody(guid),
              speed,
            ),
          );
          this.progress(`world: ${entry.kind} speed -> ${speed.toFixed(2)} yd/s (acked #${counter})`);
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent(
              'wow-force-speed',
              { detail: { guid, kind: entry.kind, speed } },
            ));
          }
        } catch (e) {
          this.progress(`world: force speed parse skipped (${(e as Error).message})`);
        }
        return;
      }
    }

    if (packet.opcode === OPCODES.SMSG_PONG) {
      try {
        const r = new Reader(packet.body);
        this.clockSync.handlePong(r.u32());
      } catch (e) {
        this.progress(`world: pong parse skipped (${(e as Error).message})`);
      }
      this.emitStats();
      return;
    }

    if (packet.opcode === OPCODES.SMSG_START_MIRROR_TIMER) {
      try {
        const r = new Reader(packet.body);
        this.emitMirrorTimer({
          kind: 'start',
          timerType: r.u32(),
          remainingMs: r.u32(),
          durationMs: r.u32(),
          scale: r.i32(),
          paused: r.u8() !== 0,
          spellId: r.u32(),
        });
      } catch (e) {
        this.progress(`world: mirror timer start parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_PAUSE_MIRROR_TIMER) {
      try {
        const r = new Reader(packet.body);
        this.emitMirrorTimer({ kind: 'pause', timerType: r.u32(), paused: r.u8() !== 0 });
      } catch (e) {
        this.progress(`world: mirror timer pause parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_STOP_MIRROR_TIMER) {
      try {
        const r = new Reader(packet.body);
        this.emitMirrorTimer({ kind: 'stop', timerType: r.u32() });
      } catch (e) {
        this.progress(`world: mirror timer stop parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_TRANSFER_PENDING) {
      try {
        const r = new Reader(packet.body);
        const map = r.u32();
        const transportEntry = r.remaining >= 4 ? r.u32() : undefined;
        const oldMap = r.remaining >= 4 ? r.u32() : undefined;
        await this.emitWorldTransfer({ kind: 'pending', map, transportEntry, oldMap });
      } catch (e) {
        this.progress(`world: transfer pending parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_TRANSFER_ABORTED) {
      try {
        const r = new Reader(packet.body);
        const reason = r.u8();
        // TRANSFER_ABORT_SILENTLY (4) and anything above the known range are deliberately silent
        // per the enum's own comment (Player.h:563).
        if (reason !== TRANSFER_ABORT_SILENTLY && TRANSFER_ABORT_TEXT[reason]) {
          showUiError(TRANSFER_ABORT_TEXT[reason]);
        }
        this.progress(`world: transfer aborted (${TRANSFER_ABORT_NAMES[reason] ?? `reason ${reason}`})`);
        await this.emitWorldTransfer({ kind: 'aborted', reason });
      } catch (e) {
        this.progress(`world: transfer abort parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_NEW_WORLD) {
      let position: WorldPosition | undefined;
      try {
        const r = new Reader(packet.body);
        position = { map: r.u32(), x: r.f32(), y: r.f32(), z: r.f32(), o: r.f32() };
        if (r.remaining !== 0) throw new Error(`NEW_WORLD left ${r.remaining} unread bytes`);
        this.resetForWorldTransfer();
        // Presentation starts synchronously, but cannot hold the protocol ACK behind terrain/WMO,
        // texture, shader, or entity hydration. The UI owns an input lock until visual readiness.
        void this.emitWorldTransfer({ kind: 'newWorld', position }).catch((error) =>
          this.progress(`world: transfer presentation failed (${(error as Error).message})`));
        this.socket.send(OPCODES.MSG_MOVE_WORLDPORT_ACK);
        if (this.activeCharacter) {
          this.socket.send(OPCODES.CMSG_SET_ACTIVE_MOVER, new Uint8Array(this.activeCharacter.guidBytes));
        }
        this.sendBootstrapHeartbeat(position);
        this.progress(`world: acknowledged transfer to map ${position.map}`);
      } catch (e) {
        this.progress(`world: new world parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_MESSAGECHAT) {
      try {
        const event = parseMessageChat(packet);
        if (event.senderGuid && !event.senderName) this.queryPlayerName(event.senderGuid);
        this.emitChat(event);
      } catch (e) {
        this.progress(`world: chat parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_CHANNEL_NOTIFY) {
      try {
        const r = new Reader(packet.body);
        const notice = r.u8();
        const channelName = r.cstring();
        // Slot bookkeeping is driven by the server's confirmation, never by our own request:
        // a join can be refused for a wrong password or a ban, and those arrive as their own
        // notices with the channel name attached. Trailing payloads (flags for YOU_JOINED, a
        // guid for JOINED/LEFT) are deliberately not read — nothing here consumes them.
        if (notice === CHAT_NOTICE.YOU_JOINED) this.channelSlots.add(channelName);
        else if (notice === CHAT_NOTICE.YOU_LEFT) this.channelSlots.remove(channelName);
        this.emitChannelNotify({ notice, channelName, slot: this.channelSlots.indexOf(channelName) });
      } catch (e) {
        this.progress(`world: channel notify parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_WEATHER) {
      try {
        const r = new Reader(packet.body);
        this.emitWeather({
          type: r.u32(),
          grade: r.f32(),
          soundId: r.remaining >= 4 ? r.u32() : 0,
          instant: r.remaining >= 1 ? r.u8() !== 0 : false,
        });
      } catch (e) {
        this.progress(`world: weather parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_PLAY_MUSIC || packet.opcode === OPCODES.SMSG_PLAY_SOUND || packet.opcode === OPCODES.SMSG_PLAY_OBJECT_SOUND || packet.opcode === OPCODES.SMSG_PET_ACTION_SOUND) {
      try {
        const r = new Reader(packet.body);
        if (packet.opcode === OPCODES.SMSG_PLAY_MUSIC) this.emitSound({ kind: 'music', soundId: r.u32() });
        else if (packet.opcode === OPCODES.SMSG_PLAY_SOUND) this.emitSound({ kind: 'sound', soundId: r.u32() });
        else if (packet.opcode === OPCODES.SMSG_PLAY_OBJECT_SOUND) {
          const soundId = r.u32();
          this.emitSound({ kind: 'sound', soundId, sourceGuid: readGuid64(r) });
        } else {
          const sourceGuid = readGuid64(r);
          this.emitSound({ kind: 'sound', soundId: r.u32(), sourceGuid });
        }
      } catch (e) {
        this.progress(`world: sound parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_INITIALIZE_FACTIONS) {
      try {
        const r = new Reader(packet.body);
        const count = Math.min(r.u32(), MAX_FACTION_COUNT);
        this.factionStates.clear();
        for (let i = 0; i < count && r.remaining >= 5; i++) {
          this.factionStates.set(i, { flags: r.u8(), standing: r.i32() });
        }
        this.emitReputationData();
      } catch (e) {
        this.progress(`world: initialize factions parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_SET_FACTION_VISIBLE) {
      try {
        const reputationListId = new Reader(packet.body).u32();
        const previous = this.factionStates.get(reputationListId) ?? { flags: 0, standing: 0 };
        this.factionStates.set(reputationListId, { ...previous, flags: previous.flags | FACTION_FLAG_VISIBLE });
        this.emitReputationData();
      } catch (e) {
        this.progress(`world: faction visible parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_SET_FACTION_STANDING) {
      try {
        const r = new Reader(packet.body);
        const count = r.u32();
        for (let i = 0; i < count && r.remaining >= 8; i++) {
          const reputationListId = r.u32();
          const standing = r.i32();
          const previous = this.factionStates.get(reputationListId) ?? { flags: FACTION_FLAG_VISIBLE, standing: 0 };
          this.factionStates.set(reputationListId, { ...previous, standing });
        }
        this.emitReputationData();
      } catch (e) {
        this.progress(`world: faction standing parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_SET_FACTION_ATWAR) {
      try {
        const r = new Reader(packet.body);
        const reputationListId = r.u32();
        const flags = r.u8();
        const previous = this.factionStates.get(reputationListId) ?? { flags: FACTION_FLAG_VISIBLE, standing: 0 };
        this.factionStates.set(reputationListId, {
          ...previous,
          flags: (previous.flags & ~FACTION_FLAG_AT_WAR) | (flags & FACTION_FLAG_AT_WAR),
        });
        this.emitReputationData();
      } catch (e) {
        this.progress(`world: faction at-war parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_PET_NAME_QUERY_RESPONSE) {
      try {
        const r = new Reader(packet.body);
        const petNumber = r.u32();
        const name = r.cstring();
        const timestamp = r.u32();
        this.pendingPetNameQueries.delete(petNumber);
        this.petNames.set(petNumber, { name, timestamp });
        this.emitPetData();
      } catch (e) {
        this.progress(`world: pet name query parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_PET_NAME_INVALID) {
      this.progress('world: pet name invalid');
      return;
    }

    if (packet.opcode === OPCODES.SMSG_PET_MODE) {
      try {
        const r = new Reader(packet.body);
        const guid = readGuid64(r);
        const previous = this.petSpellState?.guid === guid ? this.petSpellState : undefined;
        this.petSpellState = {
          layout: previous?.layout ?? 'ambiguousControl',
          guid,
          durationMs: previous?.durationMs ?? 0,
          headerWord: previous?.headerWord ?? 0,
          reactState: r.u8(),
          commandState: r.u8(),
          flag1: r.u8(),
          enabledFlags: r.u8(),
          actions: previous?.actions ?? [],
          spells: previous?.spells ?? [],
          cooldowns: previous?.cooldowns ?? [],
        };
        this.emitPetData();
      } catch (e) {
        this.progress(`world: pet mode parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_PET_SPELLS) {
      try {
        const guid = packet.body.length >= 8 ? guidHex(packet.body.slice(0, 8)) : '';
        // The hint is only a tiebreaker for genuinely ambiguous bytes now; the layout is derived
        // from the wire first. It has to be, because UNIT_FLAG_POSSESSED is an update field that
        // reaches us AFTER this direct send, and SummonPossessedMinion creates the creature in the
        // same call — so `entity` is frequently undefined and `possessed` frequently still false.
        // petControlHint() is re-run on the retained header when those flags land.
        this.petSpellState = decodePetSpellsBody(packet.body, this.petControlHint(guid));
        this.emitPetData();
      } catch (e) {
        this.progress(`world: pet spells parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_INVENTORY_CHANGE_FAILURE) {
      try {
        const r = new Reader(packet.body);
        const reason = r.u8();
        if (reason !== 0) {
          const requiredLevel = reason === 1 && r.remaining >= 4 ? r.u32() : undefined; // EQUIP_ERR_CANT_EQUIP_LEVEL_I
          const item1 = r.remaining >= 8 ? readGuid64(r) : undefined;
          const item2 = r.remaining >= 8 ? readGuid64(r) : undefined;
          const bagSlot = r.remaining >= 1 ? r.u8() : undefined;
          // eslint-disable-next-line no-console
          console.warn(
            `[inv] REJECTED: INVENTORY_CHANGE_FAILURE reason=${reason} (${inventoryResultName(reason)})` +
              `${requiredLevel !== undefined ? ` reqLevel=${requiredLevel}` : ''}` +
              `${item1 && item1 !== '0000000000000000' ? ` item1=${item1}` : ''}` +
              `${item2 && item2 !== '0000000000000000' ? ` item2=${item2}` : ''}` +
              `${bagSlot !== undefined ? ` bagSlot=${bagSlot}` : ''}`,
          );
          // Vanilla shows these as red UIErrorsFrame text ("That bag is full." etc.) — a
          // rejected drag that only logged to the console read as inventory desync (UI-17).
          showUiError(inventoryErrorText(reason, inventoryResultName(reason), requiredLevel));
          // The server refused the move; undo the optimistic prediction so the UI
          // snaps back to the authoritative state.
          this.revertLastOptimistic();
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[inv] inventory change failure parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_COMPRESSED_UPDATE_OBJECT) {
      this.stats.compressedUpdatePackets++;
      try {
        // vMaNGOS UpdateData logs packets at or above 900,000 bytes as client-crashing. Reject the
        // declared size before starting the stream, then enforce the same cap while inflating so a
        // forged prefix cannot make the browser allocate an unbounded Response.arrayBuffer().
        this.recordUpdate(await inflateSizedZlib(packet.body, {
          maxInflatedBytes: 900_000,
          label: 'SMSG_COMPRESSED_UPDATE_OBJECT',
        }));
      } catch (e) {
        this.progress(`world: compressed update skipped (${(e as Error).message})`);
      }
      this.emitStats();
      return;
    }

    if (packet.opcode === OPCODES.SMSG_UPDATE_OBJECT) {
      this.stats.updatePackets++;
      // Guarded exactly like SMSG_COMPRESSED_UPDATE_OBJECT above: this is the highest-frequency
      // opcode in the protocol, and an escaping parse error here would end the read loop for good.
      try {
        this.recordUpdate(packet.body);
      } catch (e) {
        this.progress(`world: update skipped (${(e as Error).message})`);
      }
      this.emitStats();
      return;
    }

    if (
      packet.opcode === OPCODES.SMSG_DESTROY_OBJECT
      || packet.opcode === OPCODES.SMSG_GAMEOBJECT_DESPAWN_ANIM
    ) {
      // vMaNGOS Misc::DestroyObject and GameObjectDespawnAnim both serialize one plain
      // ObjectGuid (u64). DynamicObject::Delete sends the despawn animation when an area aura
      // expires, so ignoring this left Flamestrike and every similar persistent area in the world.
      try {
        const guid = guidHex(new Reader(packet.body).bytes(8));
        if (packet.opcode === OPCODES.SMSG_GAMEOBJECT_DESPAWN_ANIM) {
          this.emitCombat({ kind: 'gameObjectAnimation', guid, phase: 'despawn' });
          // The authored despawn animation precedes the later destroy/out-of-range update. Keep
          // the object authoritative and renderable until that separate removal arrives.
          return;
        }
        if (
          this.controlledMover
          && guid === this.controlledMover.moverGuid
          && guid !== this.controlledMover.playerGuid
        ) {
          this.restoreControlledMover('despawn');
        }
        if (this.entities.remove(guid)) this.stats.entityRemoves++;
        this.stats.entities = this.entities.size;
        this.dispatch(this.entityRemoveListeners, (listener) => listener(guid), 'entityRemove');
      } catch (e) {
        this.progress(`world: object despawn parse skipped (${(e as Error).message})`);
      }
      this.emitStats();
      return;
    }

    if (packet.opcode === OPCODES.MSG_MOVE_TELEPORT_ACK) {
      // vMaNGOS same-map ("near") teleport: the server sets SemaphoreTeleportNear and DROPS every
      // movement packet until the client acks this. A freshly-created character's first login
      // triggers one (a position settle when the player is added to the map), so without the ack
      // the server keeps the player frozen at spawn while the client walks client-side into empty
      // grid — no NPCs/mobs stream in until a relog. Ack it (guid + counter + time) to clear the
      // semaphore and unblock movement. Also covers in-game near teleports. Verified against
      // vMaNGOS HandleMoveTeleportAck + MovementPacketSender::SendTeleportToController (1.12.1).
      let dest: NearTeleport | undefined;
      try {
        const r = new Reader(packet.body);
        const moverGuid = readPackedGuid(r);
        const counter = r.u32(); // movement counter, echoed back verbatim (build > 1.9.4)
        if (!isCurrentControlledMover(this.controlledMover, moverGuid)) {
          this.progress(`world: ignored late near-teleport for inactive mover ${moverGuid}`);
          return;
        }
        // The server appends a full MovementInfo whose position IS the teleport destination
        // (BuildTeleportAckMsg -> mi.ChangePosition). Graveyard spirit-release routes through here,
        // so without applying this the ghost stays on top of its own corpse instead of the graveyard.
        try {
          const mi = parseMovementInfo(r);
          if ([mi.x, mi.y, mi.z, mi.o].every((n) => Number.isFinite(n))) {
            dest = { x: mi.x, y: mi.y, z: mi.z, o: mi.o };
          }
        } catch {
          // Position block is optional/legacy for some near-teleports; ack still unblocks movement.
        }
        this.stats.nearTeleportAcks++;
        this.socket.send(
          OPCODES.MSG_MOVE_TELEPORT_ACK,
          concat(guidHexToBytes(moverGuid), u32(counter), u32(Date.now() & 0xffffffff)),
        );
        this.progress(
          `world: acked near-teleport for ${moverGuid} (counter ${counter})`
          + (dest ? ` -> (${dest.x.toFixed(1)}, ${dest.y.toFixed(1)}, ${dest.z.toFixed(1)})` : ''),
        );
      } catch (e) {
        this.progress(`world: near-teleport ack parse skipped (${(e as Error).message})`);
      }
      if (dest) this.emitNearTeleport(dest);
      return;
    }

    if (packet.opcode === OPCODES.SMSG_FORCE_MOVE_ROOT || packet.opcode === OPCODES.SMSG_FORCE_MOVE_UNROOT) {
      // Root handshake. The server sends packGuid + counter and holds a pending movement change
      // until we ack. Death roots (SMSG_FORCE_MOVE_ROOT), spirit-release un-roots
      // (SMSG_FORCE_MOVE_UNROOT), and RepopAtGraveyard is gated on !HasPendingMovementChange() — so
      // an un-acked unroot is exactly the ~5s stall before the graveyard teleport. Ack format mirrors
      // the verified force-speed ack: u64 guid + counter + MovementInfo. A root-apply ack MUST set
      // MOVEFLAG_ROOT (and clear moving flags) or HandleMoveRootAck kicks the player.
      const applyRoot = packet.opcode === OPCODES.SMSG_FORCE_MOVE_ROOT;
      try {
        const r = new Reader(packet.body);
        const guid = readPackedGuid(r);
        const counter = r.u32();
        if (!isCurrentControlledMover(this.controlledMover, guid)) {
          this.progress(`world: ignored late root packet for inactive mover ${guid}`);
          return;
        }
        // A rooted corpse/ghost is idle: root ack carries only MOVEFLAG_ROOT, unroot carries none.
        // Deliberately dropping any stale JUMPING/SWIMMING/ONTRANSPORT flags keeps movementBody from
        // demanding jump/transport extras we don't have for a stationary dead body.
        const flags = applyRoot ? MOVEMENTFLAG_ROOT : 0;
        this.socket.send(
          applyRoot ? OPCODES.CMSG_FORCE_MOVE_ROOT_ACK : OPCODES.CMSG_FORCE_MOVE_UNROOT_ACK,
          concat(
            guidHexToBytes(guid),
            u32(counter),
            this.controlledMovementBody(guid, flags),
          ),
        );
        this.dispatch(this.rootStateListeners, (listener) => listener({ guid, rooted: applyRoot }), 'rootState');
        this.progress(`world: acked ${applyRoot ? 'root' : 'unroot'} (counter ${counter})`);
      } catch (e) {
        this.progress(`world: root ack parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_MOVE_KNOCK_BACK) {
      // packGuid, u32 counter, f32 vcos, f32 vsin, f32 speedXY, f32 speedZ
      // (MovementPacketSender::SendKnockBackToController, Movement/MovementPacketSender.cpp:261-277).
      //
      // The ack is a MoveKnockBackAck — u64 guid, u32 counter, MovementInfo — and
      // Unit::FindPendingMovementKnockbackChange (Unit.cpp:7087-7108) matches the pending change by
      // comparing the four jump floats to within 0.01, so the MovementInfo MUST carry
      // MOVEFLAG_JUMPING and echo the server's arc verbatim. A mismatch (or a missing ack) leaves
      // the pending change queued, which the anticheat then counts against every later ack.
      try {
        const r = new Reader(packet.body);
        const guid = readPackedGuid(r);
        const counter = r.u32();
        const cosAngle = r.f32();
        const sinAngle = r.f32();
        const speedXY = r.f32();
        const speedZ = r.f32();
        if (!isCurrentControlledMover(this.controlledMover, guid)) {
          this.progress(`world: ignored late knockback packet for inactive mover ${guid}`);
          return;
        }
        this.socket.send(
          OPCODES.CMSG_MOVE_KNOCK_BACK_ACK,
          concat(
            guidHexToBytes(guid),
            u32(counter),
            this.controlledMovementBody(
              guid,
              MOVEMENTFLAG_JUMPING,
              { velocity: speedZ, cosAngle, sinAngle, xySpeed: speedXY },
            ),
          ),
        );
        this.dispatch(
          this.knockbackListeners,
          (listener) => listener({ guid, cosAngle, sinAngle, speedXY, speedZ, self: true }),
          'knockback',
        );
        this.progress(`world: acked knockback (counter ${counter}, xy ${speedXY.toFixed(2)}, z ${speedZ.toFixed(2)})`);
      } catch (e) {
        this.progress(`world: knockback ack parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.MSG_MOVE_KNOCK_BACK) {
      // Observer copy: packGuid, MovementInfo, f32 vcos, f32 vsin, f32 speedXY, f32 speedZ
      // (MovementPacketSender::SendKnockBackToObservers). We only need the arc — the MovementInfo
      // is the same one the normal movement path already consumes, so it is skipped here.
      try {
        const r = new Reader(packet.body);
        const guid = readPackedGuid(r);
        parseMovementInfo(r); // position/flags; the regular movement path already applies these
        const cosAngle = r.f32();
        const sinAngle = r.f32();
        const speedXY = r.f32();
        const speedZ = r.f32();
        this.dispatch(
          this.knockbackListeners,
          (listener) => listener({ guid, cosAngle, sinAngle, speedXY, speedZ, self: false }),
          'knockback',
        );
      } catch (e) {
        this.progress(`world: observed knockback parse skipped (${(e as Error).message})`);
      }
      return;
    }

    {
      // Movement-flag toggles that share the AddMovementFlagChangeToController pending-change path.
      // ApplyGhostForm's SetWaterWalking(true) lands here; leaving it un-acked stalls the graveyard
      // teleport just like an un-acked unroot. Ack format (MoveFlagChangeAck): guid + counter +
      // MovementInfo + u32(apply). The server does not kick on flag mismatch here (only ROOT does),
      // so a stationary MovementInfo carrying just the toggled flag is safe.
      const flagChange: Record<number, { ack: number; apply: boolean; flag: number; name: string }> = {
        [OPCODES.SMSG_MOVE_WATER_WALK]: { ack: OPCODES.CMSG_MOVE_WATER_WALK_ACK, apply: true, flag: MOVEMENTFLAG_WATERWALKING, name: 'water-walk' },
        [OPCODES.SMSG_MOVE_LAND_WALK]: { ack: OPCODES.CMSG_MOVE_WATER_WALK_ACK, apply: false, flag: MOVEMENTFLAG_WATERWALKING, name: 'land-walk' },
        [OPCODES.SMSG_MOVE_FEATHER_FALL]: { ack: OPCODES.CMSG_MOVE_FEATHER_FALL_ACK, apply: true, flag: MOVEMENTFLAG_SAFE_FALL, name: 'feather-fall' },
        [OPCODES.SMSG_MOVE_NORMAL_FALL]: { ack: OPCODES.CMSG_MOVE_FEATHER_FALL_ACK, apply: false, flag: MOVEMENTFLAG_SAFE_FALL, name: 'normal-fall' },
        [OPCODES.SMSG_MOVE_SET_HOVER]: { ack: OPCODES.CMSG_MOVE_HOVER_ACK, apply: true, flag: MOVEMENTFLAG_HOVER, name: 'hover' },
        [OPCODES.SMSG_MOVE_UNSET_HOVER]: { ack: OPCODES.CMSG_MOVE_HOVER_ACK, apply: false, flag: MOVEMENTFLAG_HOVER, name: 'unhover' },
      };
      const change = flagChange[packet.opcode];
      if (change) {
        try {
          const r = new Reader(packet.body);
          const guid = readPackedGuid(r);
          const counter = r.u32();
          if (!isCurrentControlledMover(this.controlledMover, guid)) {
            this.progress(`world: ignored late ${change.name} packet for inactive mover ${guid}`);
            return;
          }
          this.socket.send(change.ack, concat(
            guidHexToBytes(guid),
            u32(counter),
            this.controlledMovementBody(guid, change.apply ? change.flag : 0),
            u32(change.apply ? 1 : 0),
          ));
          this.progress(`world: acked ${change.name} (counter ${counter})`);
        } catch (e) {
          this.progress(`world: ${change.name} ack parse skipped (${(e as Error).message})`);
        }
        return;
      }
    }

    if (packet.opcode === OPCODES.SMSG_LOGOUT_RESPONSE) {
      // vMaNGOS Packets/Misc.cpp:272-276 — `buffer << reason; buffer << instant;` i.e. u32 then u8.
      if (packet.body.length < 5) {
        this.progress(`world: SMSG_LOGOUT_RESPONSE parse skipped (expected 5 bytes, got ${packet.body.length})`);
        return;
      }
      const r = new Reader(packet.body);
      const reason = r.u32();
      const instant = r.u8() !== 0;
      this.progress(`world: SMSG_LOGOUT_RESPONSE reason=${reason} instant=${instant ? 1 : 0}`);
      this.dispatch(this.logoutResponseListeners, (listener) => listener({ reason, instant }), 'logoutResponse');
      return;
    }

    if (packet.opcode === OPCODES.SMSG_LOGOUT_CANCEL_ACK) {
      this.progress('world: SMSG_LOGOUT_CANCEL_ACK — logout aborted');
      this.dispatch(this.logoutCancelListeners, (listener) => listener(), 'logoutCancel');
      return;
    }

    if (packet.opcode === OPCODES.SMSG_LOGOUT_COMPLETE) {
      // The session is finished server-side. Treat it exactly like a clean disconnect so the UI
      // returns to character select instead of waiting for the socket to time out.
      this.progress('world: SMSG_LOGOUT_COMPLETE');
      this.dispatch(this.logoutCompleteListeners, (listener) => listener(), 'logoutComplete');
      return;
    }

    if (packet.opcode === OPCODES.SMSG_TRIGGER_CINEMATIC) {
      // A brand-new character's FIRST login triggers the race intro cinematic (vMaNGOS
      // CharacterHandler: "Show cinematic at the first time that player login"). CinematicStart sets
      // m_currentCinematicEntry and repositions the player onto the cinematic path; the server only
      // releases them on CMSG_COMPLETE_CINEMATIC -> CinematicEnd(). Without that ack the player is
      // pinned server-side at spawn (all movement ignored, no mobs stream in) until a relog — which
      // never re-triggers a first-login-only cinematic, hence "F5 fixes it forever".
      //
      // The body is a single u32 CinematicSequences.dbc id. Hand it to the renderer; the ack is
      // deferred to whoever plays it (or fires immediately below if nobody can).
      let cinematicId = 0;
      try {
        cinematicId = new Reader(packet.body).u32();
      } catch {
        cinematicId = 0;
      }
      const acked = { done: false };
      const ack = () => {
        if (acked.done || this.closed) return;
        acked.done = true;
        this.socket.send(OPCODES.CMSG_COMPLETE_CINEMATIC);
        this.progress(`world: sent CMSG_COMPLETE_CINEMATIC for sequence ${cinematicId}`);
      };
      let handled = false;
      this.dispatch(
        this.cinematicListeners,
        (listener) => {
          if (listener({ cinematicId, complete: ack })) handled = true;
        },
        'cinematic',
      );
      if (!handled) {
        // Nothing rendered it. Ack straight away so movement is never left blocked.
        ack();
        this.progress(`world: acked SMSG_TRIGGER_CINEMATIC ${cinematicId} unplayed — movement unblocked`);
      }
      return;
    }

    const splineSpeedKind = SPLINE_SPEED_OPCODES.get(packet.opcode);
    if (splineSpeedKind) {
      this.stats.movementPackets++;
      try {
        const { guid, speed } = decodeSplineSpeedBody(packet.body);
        if (!Number.isFinite(speed) || speed < 0 || speed > 100) {
          throw new Error(`${packetName(packet.opcode)} invalid absolute speed ${speed}`);
        }
        const change = this.entities.applySpeed(guid, splineSpeedKind, speed);
        if (change.kind === 'update') this.emitEntity(change.entity, change);
      } catch (e) {
        this.progress(`world: spline speed parse skipped (${(e as Error).message})`);
      }
      this.emitStats();
      return;
    }

    if (
      packet.opcode === OPCODES.SMSG_GAMEOBJECT_SPAWN_ANIM
      || packet.opcode === OPCODES.SMSG_GAMEOBJECT_CUSTOM_ANIM
      || packet.opcode === OPCODES.SMSG_GAMEOBJECT_RESET_STATE
    ) {
      try {
        const r = new Reader(packet.body);
        const guid = readGuid64(r);
        const phase = packet.opcode === OPCODES.SMSG_GAMEOBJECT_SPAWN_ANIM
          ? 'spawn'
          : packet.opcode === OPCODES.SMSG_GAMEOBJECT_RESET_STATE
            ? 'reset'
            : 'custom';
        const animationId = phase === 'custom' ? r.u32() : undefined;
        if (r.remaining !== 0) throw new Error(`${phase} animation left ${r.remaining} unread bytes`);
        this.emitCombat({ kind: 'gameObjectAnimation', guid, phase, animationId });
      } catch (e) {
        this.progress(`world: game-object animation parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_ITEM_COOLDOWN) {
      try {
        const r = new Reader(packet.body);
        const itemGuid = readGuid64(r);
        const spellId = r.u32();
        if (r.remaining !== 0) throw new Error(`item cooldown left ${r.remaining} unread bytes`);
        // This packet is the fixed post-equip on-use lockout. Ordinary use cooldowns continue to
        // arrive through SMSG_SPELL_COOLDOWN/SMSG_COOLDOWN_EVENT.
        const durationMs = 30_000;
        this.emitCombat({ kind: 'itemCooldown', itemGuid, spellId, durationMs });
        this.emitCombat({ kind: 'spellCooldown', spellId, cooldownMs: durationMs });
      } catch (e) {
        this.progress(`world: item cooldown parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_ITEM_ENCHANT_TIME_UPDATE) {
      try {
        const r = new Reader(packet.body);
        const itemGuid = readGuid64(r);
        const slot = r.u32();
        const durationSeconds = r.u32();
        const playerGuid = readGuid64(r);
        if (r.remaining !== 0) throw new Error(`enchant time left ${r.remaining} unread bytes`);
        const item = this.entities.get(itemGuid);
        if (item) {
          item.itemEnchantments ??= [];
          item.itemEnchantments[slot] ??= { enchantId: 0, durationMs: 0, charges: 0 };
          item.itemEnchantments[slot].durationMs = durationSeconds * 1000;
          item.itemEnchantments[slot].expiresAt = durationSeconds > 0
            ? Date.now() + durationSeconds * 1000
            : undefined;
          this.emitInventoryData();
        }
        this.emitCombat({ kind: 'itemEnchantTime', itemGuid, slot, durationSeconds, playerGuid });
      } catch (e) {
        this.progress(`world: enchant time parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_ENCHANTMENTLOG) {
      try {
        const r = new Reader(packet.body);
        const casterGuid = readGuid64(r);
        const ownerGuid = readGuid64(r);
        const itemEntry = r.u32();
        const spellId = r.u32();
        const showAffiliation = r.u8() !== 0;
        if (r.remaining !== 0) throw new Error(`enchantment log left ${r.remaining} unread bytes`);
        this.emitCombat({ kind: 'enchantmentLog', casterGuid, ownerGuid, itemEntry, spellId, showAffiliation });
      } catch (e) {
        this.progress(`world: enchantment log parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_ITEM_TIME_UPDATE) {
      try {
        const r = new Reader(packet.body);
        const itemGuid = readGuid64(r);
        const durationSeconds = r.u32();
        if (r.remaining !== 0) throw new Error(`item time left ${r.remaining} unread bytes`);
        const item = this.entities.get(itemGuid);
        if (item) {
          item.itemDurationSeconds = durationSeconds;
          item.itemExpiresAt = durationSeconds > 0 ? Date.now() + durationSeconds * 1000 : undefined;
          this.emitInventoryData();
        }
        this.emitCombat({ kind: 'itemTime', itemGuid, durationSeconds });
      } catch (e) {
        this.progress(`world: item time parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_STANDSTATE_UPDATE) {
      try {
        const r = new Reader(packet.body);
        const standState = r.u8();
        if (r.remaining !== 0) throw new Error(`stand state left ${r.remaining} unread bytes`);
        const guid = this.activeCharacter?.guid;
        const entity = guid ? this.entities.get(guid) : undefined;
        if (entity) {
          entity.standState = standState;
          this.dispatch(this.entityListeners, (listener) => listener(entity), 'entity');
        }
        this.emitCombat({ kind: 'standState', standState });
      } catch (e) {
        this.progress(`world: stand state parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_SET_PROFICIENCY) {
      try {
        const r = new Reader(packet.body);
        const itemClass = r.u8();
        const subclassMask = r.u32();
        if (r.remaining !== 0) throw new Error(`proficiency left ${r.remaining} unread bytes`);
        this.proficiencyMasks.set(itemClass, subclassMask);
        this.emitCombat({ kind: 'proficiency', itemClass, subclassMask });
      } catch (e) {
        this.progress(`world: proficiency parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (
      packet.opcode === OPCODES.SMSG_SET_FLAT_SPELL_MODIFIER
      || packet.opcode === OPCODES.SMSG_SET_PCT_SPELL_MODIFIER
    ) {
      try {
        const modifierType: SpellModifierKind = packet.opcode === OPCODES.SMSG_SET_FLAT_SPELL_MODIFIER
          ? 'flat'
          : 'pct';
        const update = decodeSpellModifierBody(packet.body, modifierType);
        this.spellModifiers.apply(update);
        this.emitCombat({
          kind: 'spellModifier',
          modifierType,
          effectIndex: update.effectIndex,
          modOp: update.modOp,
          value: update.value,
        });
      } catch (e) {
        this.progress(`world: spell modifier parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_SET_FORCED_REACTIONS) {
      try {
        const r = new Reader(packet.body);
        const count = r.u32();
        if (count > 4096 || r.remaining !== count * 8) {
          throw new Error(`forced-reaction count ${count} does not match ${r.remaining} bytes`);
        }
        const reactions: Array<{ factionId: number; reputationRank: number }> = [];
        for (let index = 0; index < count; index++) {
          const factionId = r.u32();
          const reputationRank = r.u32();
          if (reputationRank > 7) throw new Error(`forced reaction rank ${reputationRank} is outside 0..7`);
          reactions.push({ factionId, reputationRank });
        }
        this.forcedReactions.clear();
        for (const reaction of reactions) {
          this.forcedReactions.set(reaction.factionId, reaction.reputationRank);
        }
        this.emitCombat({ kind: 'forcedReactions', reactions });
      } catch (e) {
        this.progress(`world: forced reactions parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_PVP_CREDIT) {
      try {
        const r = new Reader(packet.body);
        const honor = signedU32(r.u32());
        const victimGuid = guidHex(r.bytes(8));
        const victimRank = signedU32(r.u32());
        if (r.remaining !== 0) throw new Error(`pvp credit left ${r.remaining} unread bytes`);
        this.emitCombat({ kind: 'pvpCredit', honor, victimGuid, victimRank });
      } catch (e) {
        this.progress(`world: pvp credit parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_PLAYER_SKINNED) {
      if (packet.body.length !== 1) {
        this.progress(`world: player-skinned expected 1 byte, got ${packet.body.length}`);
        return;
      }
      const freeRepop = packet.body.length > 0 && packet.body[0] !== 0;
      this.emitCombat({ kind: 'playerSkinned', freeRepop });
      return;
    }

    if (packet.opcode === OPCODES.SMSG_DURABILITY_DAMAGE_DEATH) {
      if (packet.body.length !== 0) this.progress(`world: durability death had ${packet.body.length} unexpected bytes`);
      this.emitCombat({ kind: 'durabilityDamageDeath' });
      return;
    }

    if (packet.opcode === OPCODES.SMSG_MOUNTSPECIAL_ANIM) {
      try {
        const r = new Reader(packet.body);
        const guid = readGuid64(r);
        if (r.remaining !== 0) throw new Error(`mount special left ${r.remaining} unread bytes`);
        this.emitCombat({ kind: 'mountSpecial', guid });
      } catch (e) {
        this.progress(`world: mount special parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_TEXT_EMOTE) {
      try {
        const r = new Reader(packet.body);
        const sourceGuid = readGuid64(r);
        const textEmoteId = r.u32();
        const emoteNumber = r.u32();
        const nameLength = r.u32();
        const targetName = r.stringBytes(nameLength);
        if (r.remaining !== 0) throw new Error(`text emote left ${r.remaining} unread bytes`);
        this.emitCombat({ kind: 'textEmote', sourceGuid, textEmoteId, emoteNumber, targetName });
      } catch (e) {
        this.progress(`world: text emote parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_SUMMON_REQUEST) {
      try {
        const r = new Reader(packet.body);
        const summonerGuid = readGuid64(r);
        const areaId = r.u32();
        const autoDeclineDelayMs = r.u32();
        if (r.remaining !== 0) throw new Error(`summon request left ${r.remaining} unread bytes`);
        this.queryPlayerName(summonerGuid);
        this.emitCombat({ kind: 'summonRequest', summonerGuid, areaId, autoDeclineDelayMs });
      } catch (e) {
        this.progress(`world: summon request parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_AREA_SPIRIT_HEALER_TIME) {
      try {
        const r = new Reader(packet.body);
        const healerGuid = readGuid64(r);
        const timeRemainingMs = r.u32();
        if (r.remaining !== 0) throw new Error(`spirit healer time left ${r.remaining} unread bytes`);
        this.emitCombat({ kind: 'areaSpiritHealerTime', healerGuid, timeRemainingMs });
      } catch (e) {
        this.progress(`world: spirit healer time parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_ZONE_UNDER_ATTACK) {
      try {
        const r = new Reader(packet.body);
        const areaId = r.u32();
        if (r.remaining !== 0) throw new Error(`zone-under-attack left ${r.remaining} unread bytes`);
        this.emitCombat({ kind: 'zoneUnderAttack', areaId });
      } catch (e) {
        this.progress(`world: zone-under-attack parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_INVALIDATE_PLAYER) {
      try {
        const r = new Reader(packet.body);
        const playerGuid = readGuid64(r);
        if (r.remaining !== 0) throw new Error(`invalidate-player left ${r.remaining} unread bytes`);
        this.playerNames.delete(playerGuid);
        this.emitCombat({ kind: 'invalidatePlayer', playerGuid });
      } catch (e) {
        this.progress(`world: invalidate-player parse skipped (${(e as Error).message})`);
      }
      return;
    }

    const observerSpeedKind = OBSERVER_SPEED_OPCODES.get(packet.opcode);
    if (observerSpeedKind) {
      this.stats.movementPackets++;
      try {
        const { guid, movement, speed } = decodeObserverSpeedBody(packet.body);
        if (!Number.isFinite(speed) || speed < 0 || speed > 100) {
          throw new Error(`${packetName(packet.opcode)} invalid absolute speed ${speed}`);
        }
        const receiptTime = this.clockSync.now();
        this.clockSync.registerServerTimestamp(movement.time, receiptTime);
        const predictionAgeMs = this.clockSync.calculatePredictionAge(
          movement.time,
          receiptTime,
          (movement.flags & MOVEMENTFLAG_JUMPING) !== 0,
        );
        const change = this.entities.applySpeed(
          guid,
          observerSpeedKind,
          speed,
          movement,
          predictionAgeMs,
        );
        if (change.kind === 'update') {
          change.entity.movementOpcode = packet.opcode;
          this.emitEntity(change.entity, change);
        }
      } catch (e) {
        this.progress(`world: observer speed parse skipped (${(e as Error).message})`);
      }
      this.emitStats();
      return;
    }

    const splineMode = SPLINE_MODE_OPCODES.get(packet.opcode);
    if (splineMode) {
      this.stats.movementPackets++;
      try {
        const { guid } = decodeSplineModeBody(packet.body);
        const change = this.entities.applyMovementMode(guid, splineMode);
        if (change.kind === 'update') this.emitEntity(change.entity, change);
      } catch (e) {
        this.progress(`world: spline movement-mode parse skipped (${(e as Error).message})`);
      }
      this.emitStats();
      return;
    }

    if (
      packet.opcode === OPCODES.MSG_MOVE_ROOT
      || packet.opcode === OPCODES.MSG_MOVE_UNROOT
      || packet.opcode === OPCODES.MSG_MOVE_WATER_WALK
      || packet.opcode === OPCODES.MSG_MOVE_FEATHER_FALL
      || packet.opcode === OPCODES.MSG_MOVE_HOVER
    ) {
      this.stats.movementPackets++;
      try {
        const { guid, movement } = decodeObserverModeBody(packet.body);
        const receiptTime = this.clockSync.now();
        this.clockSync.registerServerTimestamp(movement.time, receiptTime);
        const predictionAgeMs = this.clockSync.calculatePredictionAge(
          movement.time,
          receiptTime,
          (movement.flags & MOVEMENTFLAG_JUMPING) !== 0,
        );
        const patch = packet.opcode === OPCODES.MSG_MOVE_ROOT
          ? { rooted: true }
          : packet.opcode === OPCODES.MSG_MOVE_UNROOT
            ? { rooted: false }
            : {};
        const change = this.entities.applyMovementMode(
          guid,
          patch,
          movement,
          predictionAgeMs,
        );
        if (change.kind === 'update') {
          change.entity.movementOpcode = packet.opcode;
          this.emitEntity(change.entity, change);
        }
      } catch (e) {
        this.progress(`world: observer movement-mode parse skipped (${(e as Error).message})`);
      }
      this.emitStats();
      return;
    }

    if (SERVER_MOVEMENT_OPCODES.has(packet.opcode)) {
      this.stats.movementPackets++;
      try {
        const r = new Reader(packet.body);
        const guid = readPackedGuid(r);
        const movement = parseMovementInfo(r);
        const receiptTime = this.clockSync.now();
        this.clockSync.registerServerTimestamp(movement.time, receiptTime);
        const predictionAgeMs = this.clockSync.calculatePredictionAge(
          movement.time,
          receiptTime,
          (movement.flags & MOVEMENTFLAG_JUMPING) !== 0,
        );
        const change = this.entities.applyMovement(guid, movement, predictionAgeMs);
        if (change.kind === 'update') change.entity.movementOpcode = packet.opcode;
        this.stats.entities = this.entities.size;
        if (change.kind === 'update') {
          this.emitEntity(change.entity, change);
        }
      } catch (e) {
        this.progress(`world: movement parse skipped (${(e as Error).message})`);
      }
      this.emitStats();
      return;
    }

    if (packet.opcode === OPCODES.MSG_MOVE_TELEPORT) {
      // Observer broadcast of a same-map teleport: packed mover GUID + MovementInfo whose position
      // has already been rewritten to the destination (MovementPacketSender.cpp:225-236). Shares
      // the movement wire shape but not its semantics — see WorldEntityStore.applyTeleport.
      this.stats.movementPackets++;
      try {
        const r = new Reader(packet.body);
        const guid = readPackedGuid(r);
        const movement = parseMovementInfo(r);
        // The mover gets MSG_MOVE_TELEPORT_ACK instead and drives its own position from the ack;
        // applying the observer copy on top would fight the local prediction.
        if (isCurrentControlledMover(this.controlledMover, guid)) return;
        const change = this.entities.applyTeleport(guid, movement);
        this.stats.entities = this.entities.size;
        if (change.kind === 'update') {
          change.entity.movementOpcode = packet.opcode;
          this.emitEntity(change.entity, change);
        }
      } catch (e) {
        this.progress(`world: observer teleport parse skipped (${(e as Error).message})`);
      }
      this.emitStats();
      return;
    }

    if (packet.opcode === OPCODES.MSG_MOVE_TIME_SKIPPED) {
      // MovementHandler.cpp:982-1010 advances the mover's stored client/server movement clocks by
      // `lag`, then relays exactly packed GUID + lag to observers. Mirror that clock correction;
      // there is intentionally no position change and no local-mover application.
      try {
        const r = new Reader(packet.body);
        const guid = readPackedGuid(r);
        const lag = r.u32();
        if (r.remaining !== 0) throw new Error(`${r.remaining} unread bytes`);
        if (isCurrentControlledMover(this.controlledMover, guid)) return;
        const change = this.entities.applyTimeSkipped(guid, lag);
        if (change.kind === 'update') this.emitEntity(change.entity, change);
      } catch (e) {
        this.progress(`world: movement time-skip parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_MONSTER_MOVE || packet.opcode === OPCODES.SMSG_MONSTER_MOVE_TRANSPORT) {
      this.stats.movementPackets++;
      try {
        const { guid, spline } = parseMonsterMovePacket(packet.body, packet.opcode === OPCODES.SMSG_MONSTER_MOVE_TRANSPORT);
        const change = this.entities.applySpline(guid, spline);
        if (change.kind === 'update') {
          this.emitEntity(change.entity, change);
        }
      } catch (e) {
        this.progress(`world: monster movement parse skipped (${(e as Error).message})`);
      }
      this.emitStats();
      return;
    }

    // --- Query responses / UI name data ---
    if (this.names.handle(packet.opcode, packet.body)) return;

    if (packet.opcode === OPCODES.SMSG_NAME_QUERY_RESPONSE) {
      try {
        const r = new Reader(packet.body);
        // Vanilla writes a FULL uint64 here and no status byte: vmangos
        // NameQueryResponse::AppendBodyTo (Packets/Query.cpp:46-56) is
        //   `buffer << playerGuid; buffer << name; buffer << realmName; << race << gender << class_`
        // and `operator<<(ByteBuffer&, ObjectGuid const&)` (ObjectGuid.cpp:174-178) writes
        // `uint64(guid.GetRawValue())` — packing requires an explicit WriteAsPacked(), which this
        // 1.12 specification handling.
        // wrong bytes entirely: replayed against the server's own layout for guid 0x457/"Henard",
        // that path yielded guid=4 and an EMPTY name. It also deleted the wrong key from
        // pendingPlayerNameQueries, so the real guid stayed pending forever and was never re-queried
        // — remote players never resolved a name, race, class or gender for the rest of the session.
        const guid = readGuid64(r);
        const name = r.cstring();
        r.cstring(); // realm name, usually empty
        const race = r.u32();
        const gender = r.u32();
        const classId = r.u32();
        for (let i = 0; i < 5 && r.remaining > 0; i++) r.cstring();
        this.playerNames.set(guid, { name, race, classId, gender }); this.channelLists.nameResolved();
        if (this.tradeState?.partnerGuid === guid) this.emitInteraction({ kind: 'trade', state: this.getTradeState()! });
        if (this.mailMessages.some((mail) => mail.senderGuid === guid)) {
          const state = this.getMailState();
          if (state) this.emitInteraction({ kind: 'mail', state });
        }
        if (this.social.friends.some((friend) => friend.guid === guid) || this.social.ignored.includes(guid)) this.emitSocial();
        this.pendingPlayerNameQueries.delete(guid);
        const entity = this.entities.get(guid);
        if (entity?.typeId === 4 /* PLAYER */) {
          entity.race = race;
          entity.classId = classId;
          entity.gender = gender;
          this.emitEntity(entity);
        }
        this.emitCombat({ kind: 'playerNameResponse', guid, name, race, classId, gender }); if (this.social.group.some((member) => member.guid === guid)) this.emitSocial();
      } catch (e) {
        this.progress(`world: name query parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_ITEM_QUERY_SINGLE_RESPONSE) {
      try {
        const r = new Reader(packet.body);
        const entry = r.u32();
        const cleanEntry = entry & 0x7fffffff;
        this.pendingItemQueries.delete(cleanEntry);
        if ((entry & 0x80000000) !== 0) {
          this.flushItemPushes(cleanEntry);
          return;
        }
        const classId = r.u32();
        const subclass = r.u32();
        const name = r.cstring();
        r.cstring(); // name2
        r.cstring(); // name3
        r.cstring(); // name4
        const displayInfoId = r.u32();
        const quality = r.u32();
        const flags = r.u32();
        const buyPrice = r.u32();
        const sellPrice = r.u32();
        const inventoryType = r.u32();
        r.u32(); // allowable class
        r.u32(); // allowable race
        const itemLevel = r.u32();
        const requiredLevel = r.u32();
        const itemPrototypeRequirements = readItemPrototypeRequirements(r), maxCount = r.remaining >= 4 ? r.u32() : 0;
        const stackable = r.remaining >= 4 ? r.u32() : 0;
        const containerSlots = r.remaining >= 4 ? r.u32() : 0;
        // MAX_ITEM_PROTO_STATS=10 pairs; omit empty slots (value 0). Field order byte-verified vs
        // vMaNGOS ItemHandler.cpp:327-348 for build 1.12.1.
        const stats: { type: number; value: number }[] = [];
        for (let i = 0; i < 10 && r.remaining >= 8; i++) {
          const statType = r.u32();
          const statValue = signedU32(r.u32());
          if (statValue !== 0) stats.push({ type: statType, value: statValue });
        }
        // MAX_ITEM_PROTO_DAMAGES=5; omit empty slots (max 0).
        const damage: { min: number; max: number; type: number }[] = [];
        for (let i = 0; i < 5 && r.remaining >= 12; i++) {
          const dmgMin = r.f32();
          const dmgMax = r.f32();
          const dmgType = r.u32();
          if (dmgMax > 0) damage.push({ min: dmgMin, max: dmgMax, type: dmgType });
        }
        // 7 resistances in order: Armor, Holy, Fire, Nature, Frost, Shadow, Arcane.
        const armor = r.remaining >= 4 ? r.u32() : 0;
        const resistances: number[] = [];
        for (let i = 0; i < 6 && r.remaining >= 4; i++) resistances.push(r.u32());
        const delay = r.remaining >= 4 ? r.u32() : 0; // weapon swing time (ms)
        if (r.remaining >= 4) r.u32(); // ammo type
        if (r.remaining >= 4) r.f32(); // ranged mod range (1.12.1)
        const spells: ItemSpellInfo[] = [];
        for (let i = 0; i < 5 && r.remaining >= 24; i++) {
          spells.push({
            spellId: r.u32(),
            trigger: r.u32(),
            charges: r.i32(),
            cooldown: r.i32(),
            category: r.u32(),
            categoryCooldown: r.i32(),
          });
        }
        const onUseIndex = spells.findIndex((spell) => spell.spellId !== 0 && spell.trigger === 0);
        const itemPrototypeTail = readItemPrototypeTail(r);
        this.itemInfo.set(cleanEntry, {
          entry: cleanEntry,
          classId,
          subclass,
          name,
          displayInfoId,
          quality,
          flags,
          buyPrice,
          sellPrice,
          inventoryType,
          itemLevel,
          requiredLevel,
          ...itemPrototypeRequirements,
          maxCount,
          stackable,
          containerSlots,
          ...itemPrototypeTail,
          armor,
          damage,
          stats,
          resistances,
          delay,
          spells,
          onUseSpellSlot: onUseIndex >= 0 ? onUseIndex : undefined,
        });
        this.flushItemPushes(cleanEntry);
        this.emitCombat({ kind: 'itemQueryResponse', entry: cleanEntry, displayInfoId, inventoryType, name, quality });
        this.emitInventoryData();
        this.emitQuestLog();
        const mailState = this.getMailState();
        if (mailState) this.emitInteraction({ kind: 'mail', state: mailState });
        for (const entity of this.entities.snapshot()) {
          if (entity.visibleItemEntries?.includes(cleanEntry)) this.emitEntity(entity);
        }
      } catch (e) {
        this.progress(`world: item query parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_QUEST_QUERY_RESPONSE) {
      try {
        const r = new Reader(packet.body);
        const questId = r.u32();
        this.pendingQuestQueries.delete(questId);
        const method = r.u32();
        const level = r.u32();
        const zoneOrSort = r.u32();
        const type = r.u32();
        const repObjectiveFaction = r.u32();
        const repObjectiveValue = signedU32(r.u32());
        const requiredOppositeRepFaction = r.u32();
        const requiredOppositeRepValue = signedU32(r.u32());
        const nextQuestInChain = r.u32();
        const rewardOrRequiredMoney = signedU32(r.u32());
        const rewardMoneyMaxLevel = r.u32();
        const rewardSpell = r.u32();
        const sourceItemId = r.u32();
        const questFlags = r.u32();
        const rewards = readQuestQueryItems(r, 4);
        const choiceRewards = readQuestQueryItems(r, 6);
        const pointMapId = r.u32();
        const pointX = r.f32();
        const pointY = r.f32();
        const pointOpt = r.u32();
        const title = r.cstring();
        const objectives = r.cstring();
        const details = r.cstring();
        const endText = r.cstring();
        const requiredObjectives: QuestObjective[] = [];
        for (let i = 0; i < 4 && r.remaining >= 16; i++) {
          const rawCreatureOrGoId = r.u32();
          const isGameObject = (rawCreatureOrGoId & 0x80000000) !== 0;
          requiredObjectives.push({
            creatureOrGoId: isGameObject ? rawCreatureOrGoId & 0x7fffffff : rawCreatureOrGoId,
            isGameObject,
            creatureOrGoCount: r.u32(),
            itemId: r.u32(),
            itemCount: r.u32(),
            text: '',
          });
        }
        for (let i = 0; i < requiredObjectives.length && r.remaining > 0; i++) {
          requiredObjectives[i].text = r.cstring();
        }
        const info: QuestInfo = {
          questId,
          method,
          level,
          zoneOrSort,
          type,
          repObjectiveFaction,
          repObjectiveValue,
          requiredOppositeRepFaction,
          requiredOppositeRepValue,
          nextQuestInChain,
          rewardOrRequiredMoney,
          rewardMoneyMaxLevel,
          rewardSpell,
          sourceItemId,
          questFlags,
          rewards,
          choiceRewards,
          pointMapId,
          pointX,
          pointY,
          pointOpt,
          title,
          objectives,
          details,
          endText,
          requiredObjectives,
        };
        this.questInfo.set(questId, info);
        for (const item of [...rewards, ...choiceRewards]) this.queryItem(item.itemId);
        for (const objective of requiredObjectives) {
          if (objective.itemId) this.queryItem(objective.itemId);
          else if (objective.creatureOrGoId) {
            (objective.isGameObject ? this.queryGameObject : this.queryCreature).call(this, Math.abs(objective.creatureOrGoId));
          }
        }
        if (sourceItemId) this.queryItem(sourceItemId);
        this.emitQuestLog();
      } catch (e) {
        this.progress(`world: quest query response parse skipped (${(e as Error).message})`);
      }
      return;
    }

    // --- Loot / NPC interaction layers (vanilla 1.12.1, verified against vMaNGOS packet appenders) ---
    if (packet.opcode === OPCODES.SMSG_LOOT_START_ROLL) {
      try {
        const r = new Reader(packet.body);
        const event: LootRollEvent = {
          kind: 'start', lootGuid: readGuid64(r), itemSlot: r.u32(), itemEntry: r.u32(),
          randomSuffix: r.u32(), randomPropertyId: r.u32(), countdownMs: r.u32(),
        };
        this.queryItem(event.itemEntry);
        this.emitLootRoll(event);
      } catch (e) { this.progress(`world: loot roll start parse skipped (${(e as Error).message})`); }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_LOOT_ROLL) {
      try {
        const r = new Reader(packet.body);
        const lootGuid = readGuid64(r);
        const itemSlot = r.u32();
        const rollerGuid = readGuid64(r);
        const itemEntry = r.u32();
        r.u32(); r.u32();
        this.emitLootRoll({ kind: 'vote', lootGuid, itemSlot, rollerGuid, itemEntry, rollNumber: r.u8(), rollType: r.u8() });
      } catch (e) { this.progress(`world: loot roll vote parse skipped (${(e as Error).message})`); }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_LOOT_ROLL_WON) {
      try {
        const r = new Reader(packet.body);
        const lootGuid = readGuid64(r);
        const itemSlot = r.u32();
        const itemEntry = r.u32();
        r.u32(); r.u32();
        this.emitLootRoll({ kind: 'won', lootGuid, itemSlot, itemEntry, winnerGuid: readGuid64(r), rollNumber: r.u8(), rollType: r.u8() });
      } catch (e) { this.progress(`world: loot roll won parse skipped (${(e as Error).message})`); }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_LOOT_ALL_PASSED) {
      try {
        const r = new Reader(packet.body);
        const lootGuid = readGuid64(r);
        const itemSlot = r.u32();
        const itemEntry = r.u32();
        this.emitLootRoll({ kind: 'allPassed', lootGuid, itemSlot, itemEntry });
      } catch (e) { this.progress(`world: loot all-passed parse skipped (${(e as Error).message})`); }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_LOOT_MASTER_LIST) {
      try {
        const r = new Reader(packet.body);
        const count = r.u8();
        this.masterLootEligible = [];
        for (let index = 0; index < count && r.remaining >= 8; index++) {
          const guid = readGuid64(r);
          this.masterLootEligible.push(guid);
          this.queryPlayerName(guid);
        }
        this.emitInteraction({ kind: 'masterLootList', eligibleGuids: [...this.masterLootEligible] });
      } catch (e) { this.progress(`world: master loot list parse skipped (${(e as Error).message})`); }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_LOOT_RESPONSE) {
      try {
        const r = new Reader(packet.body);
        const guid = readGuid64(r);
        const lootType = r.u8();
        if (r.remaining === 1) {
          const state: LootState = { guid, lootType, money: 0, items: [], error: r.u8() };
          this.currentLoot = state;
          this.emitInteraction({ kind: 'loot', state });
          return;
        }
        const money = r.u32();
        const itemCount = r.u8();
        const items: LootItem[] = [];
        for (let i = 0; i < itemCount && r.remaining >= 22; i++) {
          const slot = r.u8();
          const entry = r.u32();
          const count = r.u32();
          const displayInfoId = r.u32();
          r.u32(); // always 0 in vMaNGOS 1.12.1
          const randomPropertyId = r.u32();
          const slotType = r.u8();
          if (entry) {
            this.queryItem(entry);
            items.push({ slot, entry, count, displayInfoId, randomPropertyId, slotType });
          }
        }
        const state: LootState = { guid, lootType, money, items };
        this.currentLoot = state;
        this.emitInteraction({ kind: 'loot', state });
      } catch (e) {
        this.progress(`world: loot response parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_ITEM_PUSH_RESULT) {
      try {
        const r = new Reader(packet.body);
        // vMaNGOS Server/Packets/Item.cpp ItemPushResult::AppendBodyTo. Build 5875 predates the
        // later itemSlot/count additions, so its body is exactly 33 bytes with a one-byte bag slot.
        const result: ItemPushResult = {
          playerGuid: readGuid64(r),
          received: r.u32() !== 0,
          created: r.u32() !== 0,
          showInChat: r.u32() !== 0,
          bagSlot: r.u8(),
          itemEntry: r.u32(),
          suffixFactor: r.u32(),
          randomPropertyId: r.u32(),
        };
        if (result.showInChat) {
          this.pendingItemPushes.push(result);
          if (this.pendingItemPushes.length > 64) this.pendingItemPushes.shift();
          if (this.itemInfo.has(result.itemEntry)) this.flushItemPushes(result.itemEntry);
          else this.queryItem(result.itemEntry);
        }
      } catch (e) {
        this.progress(`world: item push parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_LOOT_REMOVED) {
      if (this.currentLoot && packet.body.length >= 1) {
        const slot = packet.body[0];
        this.currentLoot = { ...this.currentLoot, items: this.currentLoot.items.filter((item) => item.slot !== slot) };
        this.emitInteraction({ kind: 'loot', state: this.currentLoot });
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_LOOT_CLEAR_MONEY) {
      if (this.currentLoot) {
        // Vanilla solo looting sends CLEAR_MONEY but (unlike group loot) does not
        // necessarily send SMSG_LOOT_MONEY_NOTIFY. The loot response already gave us
        // the exact copper amount, so retain it if this custom core omits coinage.
        this.creditLootMoneyFallback(this.currentLoot.money, this.currentLoot.guid);
        this.currentLoot = { ...this.currentLoot, money: 0 };
        this.emitInteraction({ kind: 'loot', state: this.currentLoot });
        this.emitInventoryData();
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_LOOT_MONEY_NOTIFY) {
      try {
        const amount = new Reader(packet.body).u32();
        // Normal owner value updates remain authoritative. Some custom 1.12 cores send
        // only the loot-money notification, so accumulate its explicit copper amount
        // when no coinage field exists and publish the bag snapshot immediately.
        this.creditLootMoneyFallback(amount, this.currentLoot?.guid);
        if (this.currentLoot) {
          this.currentLoot = { ...this.currentLoot, money: 0 };
          this.emitInteraction({ kind: 'loot', state: this.currentLoot });
        }
        this.emitInventoryData();
      } catch (e) {
        this.progress(`world: loot money notify parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_LOOT_RELEASE_RESPONSE) {
      try {
        const r = new Reader(packet.body);
        const guid = readGuid64(r);
        this.currentLoot = undefined;
        this.emitInteraction({ kind: 'lootClose', guid });
      } catch (e) {
        this.currentLoot = undefined;
        this.emitInteraction({ kind: 'lootClose' });
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_SHOWTAXINODES) {
      // u32 showUi(1) + u64 flight master guid + u32 current node + u32[8] known-node mask
      // (vMaNGOS WorldPackets::Taxi::ShowTaxiNodes::AppendBodyTo).
      try {
        const r = new Reader(packet.body);
        const showUi = r.u32();
        if (showUi !== 1) return;
        const guid = guidHex(r.bytes(8));
        const currentNode = r.u32();
        const knownMask: number[] = [];
        for (let word = 0; word < 8 && r.remaining >= 4; word++) knownMask.push(r.u32());
        this.emitInteraction({ kind: 'taxi', state: { guid, currentNode, knownMask } });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`SMSG_SHOWTAXINODES parse failed: ${(e as Error).message}`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_ACTIVATETAXIREPLY) {
      try {
        const r = new Reader(packet.body);
        const code = r.u32();
        // ERR_TAXIOK starts the flight and has no error text. All failures use the stock 1.12.1
        // UI-error strings above, including the deliberately loud unspecified-server message.
        if (code !== 0) {
          this.emitInteraction({
            kind: 'taxiReply',
            code,
            message: TAXI_REPLY_MESSAGES[code] ?? `Taxi service failed (${code}).`,
          });
        }
      } catch (e) {
        this.progress(`world: taxi reply parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_SHOW_BANK) {
      try {
        this.currentBankGuid = readGuid64(new Reader(packet.body));
        const state = this.getBankState();
        if (state) this.emitInteraction({ kind: 'bank', state });
      } catch (e) {
        this.progress(`world: bank response parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_BUY_BANK_SLOT_RESULT) {
      const reason = packet.body.length >= 4 ? new Reader(packet.body).u32() : 1;
      const messages: Record<number, string> = {
        0: 'Bank bag slot purchased.',
        1: 'You have purchased all available bank bag slots.',
        2: 'You do not have enough money.',
        3: 'That target is not a banker.',
        4: 'You cannot do that right now.',
      };
      this.emitInteraction({ kind: 'bankMessage', reason, message: messages[reason] ?? `Could not purchase bank slot (${reason}).` });
      const state = this.getBankState();
      if (state) this.emitInteraction({ kind: 'bank', state });
      return;
    }

    if (this.handleServicePacket(packet)) return;

    if (packet.opcode === OPCODES.SMSG_TRADE_STATUS) {
      this.handleTradeStatus(packet.body);
      return;
    }

    if (packet.opcode === OPCODES.SMSG_TRADE_STATUS_EXTENDED) {
      this.handleExtendedTrade(packet.body);
      return;
    }

    if (packet.opcode === OPCODES.SMSG_MAIL_LIST_RESULT) {
      try {
        const r = new Reader(packet.body);
        const messages: MailMessage[] = [];
        const count = r.u8();
        for (let index = 0; index < count; index++) {
          const id = r.u32();
          const messageType = r.u8();
          let senderGuid: string | undefined;
          let senderEntry: number | undefined;
          if (messageType === 0) senderGuid = readGuid64(r);
          else if (messageType === 2 || messageType === 3 || messageType === 4) senderEntry = r.u32();
          const subject = r.cstring();
          const itemTextId = r.u32();
          r.u32(); // Package.dbc id
          const stationery = r.u32();
          const itemEntry = r.u32();
          r.u32(); // permanent enchant
          r.i32(); // random property
          r.u32(); // suffix factor
          const itemCount = r.u8();
          r.u32(); // charges
          r.u32(); // max durability
          r.u32(); // current durability
          const money = r.u32();
          const cod = r.u32();
          const checked = r.u32();
          const daysLeft = r.f32();
          r.u32(); // MailTemplate.dbc id (present in 1.12.1)
          messages.push({ id, messageType, senderGuid, senderEntry, subject, itemTextId, stationery, itemEntry, itemCount, money, cod, checked, daysLeft });
          if (senderGuid) this.queryPlayerName(senderGuid);
          if (itemEntry) this.queryItem(itemEntry);
        }
        this.mailMessages = messages;
        const state = this.getMailState();
        if (state) this.emitInteraction({ kind: 'mail', state });
      } catch (e) {
        this.progress(`world: mail list parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_ITEM_TEXT_QUERY_RESPONSE) {
      try {
        const r = new Reader(packet.body);
        const itemTextId = r.u32();
        const body = r.cstring();
        const mail = this.mailMessages.find((candidate) => candidate.itemTextId === itemTextId);
        if (mail) mail.body = body;
        const state = this.getMailState();
        if (state) this.emitInteraction({ kind: 'mail', state });
      } catch (e) {
        this.progress(`world: mail body parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_SEND_MAIL_RESULT) {
      try {
        const r = new Reader(packet.body);
        r.u32(); // mail id
        const action = r.u32();
        const error = r.u32();
        const state = this.getMailState();
        if (state) this.emitInteraction({ kind: 'mail', state: { ...state, result: { action, error } } });
        if (!error && this.currentMailboxGuid) this.socket.send(OPCODES.CMSG_GET_MAIL_LIST, guidHexToBytes(this.currentMailboxGuid));
      } catch (e) {
        this.progress(`world: mail result parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_NPC_TEXT_UPDATE) {
      try {
        const r = new Reader(packet.body);
        const textId = r.u32();
        let resolved = '';
        let bestProbability = -1;
        for (let i = 0; i < 8 && r.remaining > 0; i++) {
          const probability = r.f32();
          const maleText = r.cstring();
          const femaleText = r.cstring();
          r.u32(); // language
          for (let emote = 0; emote < 6; emote++) r.u32();
          const candidate = this.activeCharacter?.gender === 1
            ? femaleText || maleText
            : maleText || femaleText;
          if (candidate && probability >= bestProbability) {
            bestProbability = probability;
            resolved = candidate;
          }
        }
        if (resolved) this.npcTexts.set(textId, resolved);
        if (this.currentGossipState?.textId === textId) {
          this.currentGossipState = { ...this.currentGossipState, text: resolved || this.currentGossipState.text };
          this.emitInteraction({ kind: 'gossip', state: this.currentGossipState });
        }
      } catch (e) {
        this.progress(`world: npc text parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_GOSSIP_MESSAGE) {
      try {
        const r = new Reader(packet.body);
        const guid = readGuid64(r);
        const textId = r.u32();
        const optionCount = r.u32();
        const options: GossipOption[] = [];
        for (let i = 0; i < optionCount && r.remaining > 0; i++) {
          const index = r.u32();
          const icon = r.u8();
          const coded = r.u8() !== 0;
          const text = r.cstring();
          options.push({ index, icon, coded, text });
        }
        const questCount = r.u32();
        const quests: GossipQuest[] = [];
        for (let i = 0; i < questCount && r.remaining > 0; i++) {
          quests.push({ questId: r.u32(), icon: r.u32(), level: r.u32(), title: r.cstring() });
        }
        const state: GossipState = { guid, textId, text: this.npcTexts.get(textId), options, quests };
        this.currentGossipGuid = guid;
        this.currentGossipState = state;
        this.emitInteraction({ kind: 'gossip', state });
        if (textId && !state.text) {
          this.socket.send(OPCODES.CMSG_NPC_TEXT_QUERY, concat(u32(textId), guidHexToBytes(guid)));
        }
      } catch (e) {
        this.progress(`world: gossip message parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_GOSSIP_COMPLETE) {
      this.currentGossipGuid = undefined;
      this.currentGossipState = undefined;
      this.emitInteraction({ kind: 'gossipClose' });
      return;
    }

    if (packet.opcode === OPCODES.SMSG_QUESTGIVER_STATUS) {
      // vMaNGOS GossipDef.cpp SendQuestGiverStatus: raw ObjectGuid + uint32 DIALOG_STATUS_*. This is
      // the sole source of the overhead quest marker (! new, ? turn-in, grey = unavailable/incomplete).
      try {
        const r = new Reader(packet.body);
        const guid = readGuid64(r);
        const status = r.u32();
        this.questGiverStatus.set(guid, status);
        this.pendingQuestStatusQueries.delete(guid);
      } catch (e) {
        this.progress(`world: questgiver status parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_QUESTGIVER_QUEST_LIST) {
      try {
        const r = new Reader(packet.body);
        const guid = readGuid64(r);
        const greeting = r.cstring();
        const emoteDelay = r.u32();
        const emote = r.u32();
        const count = r.u8();
        const quests: GossipQuest[] = [];
        for (let i = 0; i < count && r.remaining > 0; i++) {
          quests.push({ questId: r.u32(), icon: r.u32(), level: r.u32(), title: r.cstring() });
        }
        this.emitInteraction({ kind: 'questList', state: { guid, greeting, emoteDelay, emote, quests } });
      } catch (e) {
        this.progress(`world: quest list parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_QUESTGIVER_QUEST_DETAILS) {
      try {
        const r = new Reader(packet.body);
        const guid = readGuid64(r);
        const questId = r.u32();
        const title = r.cstring();
        const details = r.cstring();
        const objectives = r.cstring();
        const autoFinish = r.u32() !== 0;
        const choiceRewards = readRewardItems(r, r.u32());
        const rewards = readRewardItems(r, r.u32());
        const money = signedU32(r.u32());
        const rewardSpell = r.u32();
        const emoteCount = r.u32();
        for (let i = 0; i < emoteCount && r.remaining >= 8; i++) {
          r.u32();
          r.u32();
        }
        for (const item of [...choiceRewards, ...rewards]) this.queryItem(item.itemId);
        const shared = this.entities.get(guid)?.typeId === TypeID.PLAYER || guid.startsWith('0000');
        this.emitInteraction({ kind: 'questDetails', state: { guid, questId, title, details, objectives, autoFinish, choiceRewards, rewards, money, rewardSpell, shared } });
      } catch (e) {
        this.progress(`world: quest details parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_QUESTGIVER_REQUEST_ITEMS) {
      try {
        const r = new Reader(packet.body);
        const guid = readGuid64(r);
        const questId = r.u32();
        const title = r.cstring();
        const text = r.cstring();
        r.u32(); // emote delay
        r.u32(); // emote
        r.u32(); // close on cancel
        const requiredMoney = r.u32();
        const requiredItems = readRewardItems(r, r.u32());
        let complete = false;
        if (r.remaining >= 16) {
          r.u32();
          complete = r.u32() !== 0;
          r.u32();
          r.u32();
        }
        for (const item of requiredItems) this.queryItem(item.itemId);
        this.emitInteraction({ kind: 'questRequestItems', state: { guid, questId, title, text, requiredMoney, requiredItems, complete } });
      } catch (e) {
        this.progress(`world: quest request-items parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_QUESTGIVER_OFFER_REWARD) {
      try {
        const r = new Reader(packet.body);
        const guid = readGuid64(r);
        const questId = r.u32();
        const title = r.cstring();
        const text = r.cstring();
        r.u32(); // autoFinish
        const emoteCount = r.u32();
        for (let i = 0; i < emoteCount && r.remaining >= 8; i++) {
          r.u32();
          r.u32();
        }
        const choiceRewards = readRewardItems(r, r.u32());
        const rewards = readRewardItems(r, r.u32());
        const money = signedU32(r.u32());
        const questFlags = r.u32();
        const rewardSpell = r.remaining >= 4 ? r.u32() : 0;
        for (const item of [...choiceRewards, ...rewards]) this.queryItem(item.itemId);
        this.emitInteraction({ kind: 'questOfferReward', state: { guid, questId, title, text, choiceRewards, rewards, money, questFlags, rewardSpell } });
      } catch (e) {
        this.progress(`world: quest reward parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_QUESTGIVER_QUEST_COMPLETE) {
      try {
        const r = new Reader(packet.body);
        const questId = r.u32();
        r.u32();
        const xp = r.u32();
        const money = signedU32(r.u32());
        const rewards = readRewardItems(r, r.u32());
        for (const item of rewards) this.queryItem(item.itemId);
        this.invalidateQuestGiverStatuses(); // turn-in done: this giver's ? clears, others may change
        this.emitInteraction({ kind: 'questMessage', questId, message: `Quest complete. XP ${xp}, money ${money}.` });
      } catch (e) {
        this.progress(`world: quest complete parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_QUESTGIVER_QUEST_FAILED) {
      try {
        const r = new Reader(packet.body);
        this.emitInteraction({ kind: 'questMessage', questId: r.u32(), reason: r.u32(), message: 'Quest failed.' });
      } catch (e) {
        this.progress(`world: quest failed parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_QUESTGIVER_QUEST_INVALID) {
      const reason = packet.body.length >= 4 ? new Reader(packet.body).u32() : 0;
      this.emitInteraction({ kind: 'questMessage', reason, message: 'Quest unavailable.' });
      return;
    }

    if (packet.opcode === OPCODES.SMSG_QUESTLOG_FULL) {
      this.emitQuestProgress({ kind: 'questLogFull' });
      this.emitInteraction({ kind: 'questMessage', message: 'Quest log is full.' });
      return;
    }

    if (packet.opcode === OPCODES.SMSG_QUESTUPDATE_COMPLETE) {
      try {
        const questId = new Reader(packet.body).u32();
        this.invalidateQuestGiverStatuses(); // objectives finished: the turn-in giver's ? can now appear
        this.emitQuestProgress({ kind: 'questComplete', questId });
      } catch (e) {
        this.progress(`world: quest update complete parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_QUESTUPDATE_FAILED || packet.opcode === OPCODES.SMSG_QUESTUPDATE_FAILEDTIMER) {
      try {
        const questId = new Reader(packet.body).u32();
        const timer = packet.opcode === OPCODES.SMSG_QUESTUPDATE_FAILEDTIMER;
        this.emitQuestProgress({ kind: 'questFailed', questId, timer });
        this.emitInteraction({ kind: 'questMessage', questId, message: timer ? 'Quest timer failed.' : 'Quest failed.' });
      } catch (e) {
        this.progress(`world: quest update failed parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_QUESTUPDATE_ADD_ITEM) {
      try {
        const r = new Reader(packet.body);
        const itemId = r.u32();
        const count = r.u32();
        this.queryItem(itemId);
        this.emitQuestProgress({ kind: 'questAddItem', itemId, count });
      } catch (e) {
        this.progress(`world: quest add-item parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_QUESTUPDATE_ADD_KILL) {
      try {
        const r = new Reader(packet.body);
        const questId = r.u32();
        const entry = r.u32();
        const count = r.u32();
        const required = r.u32();
        const guid = readGuid64(r);
        this.emitQuestProgress({ kind: 'questAddKill', questId, entry, count, required, guid });
      } catch (e) {
        this.progress(`world: quest add-kill parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_LIST_INVENTORY) {
      try {
        const r = new Reader(packet.body);
        const guid = readGuid64(r);
        const count = r.u8();
        if (count === 0) {
          const error = r.remaining >= 1 ? r.u8() : undefined;
          this.currentVendorGuid = guid;
          this.emitInteraction({ kind: 'vendor', state: { guid, items: [], error, canRepair: this.npcHasRepairFlag(guid) } });
          return;
        }
        const items: VendorItem[] = [];
        for (let i = 0; i < count && r.remaining >= 28; i++) {
          const vendorSlot = r.u32();
          const entry = r.u32();
          const displayInfoId = r.u32();
          const stock = r.u32();
          const price = r.u32();
          const maxDurability = r.u32();
          const buyCount = r.u32();
          this.queryItem(entry);
          items.push({ vendorSlot, entry, displayInfoId, stock, price, maxDurability, buyCount });
        }
        this.currentVendorGuid = guid;
        this.emitInteraction({ kind: 'vendor', state: { guid, items, canRepair: this.npcHasRepairFlag(guid) } });
      } catch (e) {
        this.progress(`world: vendor list parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_BUY_ITEM || packet.opcode === OPCODES.SMSG_BUY_FAILED || packet.opcode === OPCODES.SMSG_SELL_ITEM) {
      try {
        const r = new Reader(packet.body);
        readGuid64(r);
        if (packet.opcode === OPCODES.SMSG_BUY_FAILED) {
          const itemEntry = r.u32();
          const reason = r.remaining >= 1 ? r.u8() : 0;
          this.emitInteraction({ kind: 'vendorMessage', reason, message: `Could not buy item ${itemEntry}.` });
        } else if (packet.opcode === OPCODES.SMSG_BUY_ITEM) {
          r.u32(); // vendor slot
          r.u32(); // new stock count
          const count = r.u32();
          this.emitInteraction({ kind: 'vendorMessage', message: `Bought ${count} item(s).` });
        } else {
          readGuid64(r);
          const reason = r.remaining >= 1 ? r.u8() : 0;
          this.emitInteraction({ kind: 'vendorMessage', reason, message: reason ? 'Could not sell item.' : 'Item sold.' });
        }
      } catch (e) {
        this.progress(`world: vendor result parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_TRAINER_LIST) {
      try {
        const r = new Reader(packet.body);
        const guid = readGuid64(r);
        const trainerType = r.u32();
        const count = r.u32();
        const spells: TrainerSpell[] = [];
        for (let i = 0; i < count && r.remaining >= 38; i++) {
          spells.push({
            spellId: r.u32(),
            state: r.u8(),
            cost: r.u32(),
            primaryProfessionAllowed: r.u32() !== 0,
            primaryProfessionConfirm: r.u32() !== 0,
            requiredLevel: r.u8(),
            requiredSkill: r.u32(),
            requiredSkillValue: r.u32(),
            requiredSpell1: r.u32(),
            requiredSpell2: r.u32(),
          });
          r.u32(); // reserved
        }
        const title = r.remaining > 0 ? r.cstring() : 'Training';
        this.currentTrainerGuid = guid;
        this.emitInteraction({ kind: 'trainer', state: { guid, trainerType, spells, title } });
      } catch (e) {
        this.progress(`world: trainer list parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_TRAINER_BUY_SUCCEEDED || packet.opcode === OPCODES.SMSG_TRAINER_BUY_FAILED) {
      try {
        const r = new Reader(packet.body);
        readGuid64(r);
        const spellId = r.u32();
        const reason = packet.opcode === OPCODES.SMSG_TRAINER_BUY_FAILED && r.remaining >= 4 ? r.u32() : undefined;
        this.emitInteraction({
          kind: 'trainerMessage',
          spellId,
          reason,
          message: packet.opcode === OPCODES.SMSG_TRAINER_BUY_SUCCEEDED ? `Learned spell ${spellId}.` : `Could not learn spell ${spellId}.`,
        });
      } catch (e) {
        this.progress(`world: trainer buy result parse skipped (${(e as Error).message})`);
      }
      return;
    }

    // --- Zone/world states used by minimap and battleground UI ---
    if (packet.opcode === OPCODES.SMSG_INIT_WORLD_STATES) {
      try {
        const r = new Reader(packet.body);
        r.u32(); // map_id
        r.u32(); // zone_id
        r.u32(); // area_id
        const count = r.u16();
        const states: Record<number, number> = {};
        for (let i = 0; i < count; i++) states[r.u32()] = r.u32();
        this.worldStates = states;
        this.emitWorldState();
      } catch (e) {
        this.progress(`world: init world states parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_UPDATE_WORLD_STATE) {
      try {
        const r = new Reader(packet.body);
        const stateId = r.u32();
        this.worldStates[stateId] = r.u32();
        this.emitWorldState();
      } catch (e) {
        this.progress(`world: update world state parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_UPDATE_AURA_DURATION) {
      // vMaNGOS SpellAuraHolder::UpdateAuraDuration: uint8 slot, uint32 durationMs.
      try {
        const r = new Reader(packet.body);
        const slot = r.u8();
        const durationMs = r.u32();
        if (slot < 48) {
          if (durationMs > 0) this.playerAuraDurations.set(slot, { durationMs, expiresAt: Date.now() + durationMs });
          else this.playerAuraDurations.delete(slot);
          if (this.activeCharacter) this.emitAura(this.activeCharacter.guid, this.getAuras(this.activeCharacter.guid));
        }
      } catch (e) {
        this.progress(`world: aura duration parse skipped (${(e as Error).message})`);
      }
      return;
    }

    // --- Cast and channel lifecycle packets ---
    if (packet.opcode === OPCODES.SMSG_SPELL_START) {
      try {
        const r = new Reader(packet.body);
        // vMaNGOS Spell::SendSpellStart writes the CastItem GUID first (m_caster when there is no
        // item), THEN m_casterUnit. For an ITEM cast — Hearthstone, potions, trinkets — the first
        // packed GUID is the item's GUID, not the player's; only the second is the casting unit.
        // Reading the first as the caster made item casts appear to come from the item: the player
        // never got the cast pose (routed to a nonexistent entity), isCasting()/the cast bar never
        // armed (guid !== playerGuid), and the sustain cast sound was keyed to the item so move-
        // interrupt's stopCasterSounds(playerGuid) never matched — the Hearthstone "no animation +
        // sound never stops" bug. Anchor on m_casterUnit (identical to the caster for non-item casts).
        readPackedGuid(r); // m_CastItem (item casts) or m_caster — discard
        const casterGuid = readPackedGuid(r); // m_casterUnit: the real casting unit
        const castSourceGuid = readPackedGuid(new Reader(packet.body));
        const castItemGuid = castSourceGuid !== casterGuid ? castSourceGuid : undefined;
        const spellId = r.u32();
        const castFlags = r.u16();
        const castTimeMs = r.u32();
        const targets = readServerSpellCastTargets(r);
        const ammoDisplayId = (castFlags & SPELL_CAST_FLAG_AMMO) !== 0 && r.remaining >= 8 ? r.u32() : undefined;
        const ammoInventoryType = ammoDisplayId !== undefined ? r.u32() : undefined;
        if (r.remaining !== 0) throw new Error(`SMSG_SPELL_START left ${r.remaining} unread bytes`);
        this.emitCombat({
          kind: 'spellStart',
          casterGuid,
          castSourceGuid,
          castItemGuid,
          spellId,
          castTimeMs,
          castFlags,
          targetGuid: primarySpellObjectTarget(targets),
          destination: targets.destination,
          targets,
          ammoDisplayId,
          ammoInventoryType,
        });
      } catch (e) {
        this.progress(`world: spell start parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_SPELL_GO) {
      try {
        const r = new Reader(packet.body);
        // Same GUID pair as SMSG_SPELL_START: CastItem-or-caster first, then m_casterUnit. Use the
        // caster unit so item casts (Hearthstone etc.) resolve their impact/GO visuals to the player.
        readPackedGuid(r); // m_CastItem (item casts) or m_caster — discard
        const casterGuid = readPackedGuid(r); // m_casterUnit: the real casting unit
        const castSourceGuid = readPackedGuid(new Reader(packet.body));
        const castItemGuid = castSourceGuid !== casterGuid ? castSourceGuid : undefined;
        const spellId = r.u32();
        // vMaNGOS SendSpellGo: u16 castFlags, then WriteSpellGoTargets = raw 8-byte hit GUIDs,
        // raw 8-byte miss GUIDs + miss reason (and reflect result), followed by SpellCastTargets.
        // The first hit is the primary victim used to anchor impact/missile visuals.
        const hitGuids: string[] = [];
        const castFlags = r.u16();
        const hitCount = r.u8();
        for (let i = 0; i < hitCount; i++) hitGuids.push(guidHex(r.bytes(8)));
        const targetGuid: string | undefined = hitGuids[0];
        const misses: Array<{ guid: string; reason: number; reflectResult?: number }> = [];
        const missCount = r.u8();
        for (let i = 0; i < missCount; i++) {
          const guid = guidHex(r.bytes(8));
          const reason = r.u8();
          const reflectResult = reason === SPELL_MISS_REFLECT ? r.u8() : undefined;
          misses.push({ guid, reason, reflectResult });
        }
        const targets = readServerSpellCastTargets(r);
        const ammoDisplayId = (castFlags & SPELL_CAST_FLAG_AMMO) !== 0 && r.remaining >= 8 ? r.u32() : undefined;
        const ammoInventoryType = ammoDisplayId !== undefined ? r.u32() : undefined;
        if (r.remaining !== 0) throw new Error(`SMSG_SPELL_GO left ${r.remaining} unread bytes`);
        this.emitCombat({
          kind: 'spellGo',
          casterGuid,
          castSourceGuid,
          castItemGuid,
          spellId,
          targetGuid: primarySpellObjectTarget(targets) ?? targetGuid ?? misses[0]?.guid,
          hitGuids,
          misses,
          destination: targets.destination,
          targets,
          ammoDisplayId,
          ammoInventoryType,
        });
      } catch (e) {
        this.progress(`world: spell go parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (
      packet.opcode === OPCODES.SMSG_PLAY_SPELL_VISUAL
      || packet.opcode === OPCODES.SMSG_PLAY_SPELL_IMPACT
    ) {
      // vMaNGOS Server/Packets/Spell.cpp:54 (PlaySpellVisual) and :61 (PlaySpellImpact) both
      // serialize a plain ObjectGuid followed by uint32 spellVisualId, documented in Spell.h:93
      // as a "SpellVisualKit.dbc index" — NOT a spell id and NOT a SpellVisual id. PLAY_SPELL_VISUAL
      // names the caster; PLAY_SPELL_IMPACT names the target.
      try {
        const r = new Reader(packet.body);
        const guid = guidHex(r.bytes(8));
        const kitId = r.u32();
        if (kitId) {
          this.emitCombat({
            kind: 'playSpellVisualKit',
            guid,
            kitId,
            onTarget: packet.opcode === OPCODES.SMSG_PLAY_SPELL_IMPACT,
          });
        }
      } catch (e) {
        this.progress(`world: play spell visual parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_SPELL_FAILURE) {
      try {
        const r = new Reader(packet.body);
        const casterGuid = readPackedGuid(r);
        const spellId = r.u32();
        const reason = r.remaining >= 1 ? r.u8() : 0;
        this.emitCombat({ kind: 'spellFailure', casterGuid, spellId, reason });
      } catch (e) {
        this.progress(`world: spell failure parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_SPELL_FAILED_OTHER) {
      // vMaNGOS Spell::SendInterrupted: raw ObjectGuid + uint32 spellId.
      try {
        const r = new Reader(packet.body);
        const casterGuid = guidHex(r.bytes(8));
        const spellId = r.u32();
        this.emitCombat({ kind: 'spellFailure', casterGuid, spellId, reason: 0 });
      } catch (e) {
        this.progress(`world: spell failed other parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_SPELL_DELAYED) {
      try {
        const r = new Reader(packet.body);
        this.emitCombat({ kind: 'spellDelayed', ...decodeSpellDelayedPayload(r) });
      } catch (e) {
        this.progress(`world: spell delayed parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.MSG_CHANNEL_START) {
      try {
        const r = new Reader(packet.body);
        const spellId = r.u32();
        const durationMs = r.u32();
        this.emitCombat({ kind: 'channelStart', casterGuid: this.activeCharacter?.guid ?? '', spellId, durationMs });
      } catch (e) {
        this.progress(`world: channel start parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.MSG_CHANNEL_UPDATE) {
      try {
        const r = new Reader(packet.body);
        this.emitCombat({ kind: 'channelUpdate', casterGuid: this.activeCharacter?.guid ?? '', timeRemainingMs: r.u32() });
      } catch (e) {
        this.progress(`world: channel update parse skipped (${(e as Error).message})`);
      }
      return;
    }

    // vMaNGOS WorldPackets::Misc::LogXpGain: guid64, total XP, type, then kill-only
    // base XP + group bonus. The update field follows, but this packet is the immediate
    // authoritative event used by the original client for XP text/bar feedback.
    if (packet.opcode === OPCODES.SMSG_LOG_XPGAIN) {
      try {
        const r = new Reader(packet.body);
        const victimGuid = readGuid64(r);
        const totalXp = r.u32();
        const xpType = r.u8();
        const baseXp = xpType === 0 && r.remaining >= 4 ? r.u32() : undefined;
        const groupBonus = xpType === 0 && r.remaining >= 4 ? r.f32() : undefined;
        this.emitCombat({ kind: 'xpGain', victimGuid, totalXp, xpType, baseXp, groupBonus });
      } catch (e) {
        this.progress(`world: XP gain parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_LEVELUP_INFO) {
      try {
        const r = new Reader(packet.body);
        const level = r.u32();
        const healthGain = r.u32();
        const powerGains = Array.from({ length: 5 }, () => r.u32());
        const statGains = Array.from({ length: 5 }, () => r.u32());
        this.emitCombat({ kind: 'levelUp', level, healthGain, powerGains, statGains });
      } catch (e) {
        this.progress(`world: level-up parse skipped (${(e as Error).message})`);
      }
      return;
    }

    // --- Spells / action bar (formats verified vs vmangos Player::SendInitialSpells +
    //     MasterPlayer::SendInitialActionButtons + Packets/Spell.cpp CastResult) ---
    if (packet.opcode === OPCODES.SMSG_INITIAL_SPELLS) {
      try {
        const r = new Reader(packet.body);
        r.u8(); // always 0
        const count = r.u16();
        const spells: number[] = [];
        for (let i = 0; i < count; i++) {
          spells.push(r.u16());
          r.u16(); // not a slot id, always 0
        }
        this.knownSpells = spells;
        this.emitActionData();
        this.progress(`world: learned ${spells.length} spells`);
        // Cooldown tail (verified vs vmangos Player::SendInitialSpells, Player.cpp): u16 cdCount,
        // per cd: u16 spellId, u16 castItemId, u16 category, u32 spellCdMs, u32 categoryCdMs.
        // Permanent cooldowns are spellCd=1 with 0x80000000 set on the category cooldown — skip those.
        if (r.remaining >= 2) {
          const cdCount = r.u16();
          for (let i = 0; i < cdCount && r.remaining >= 14; i++) {
            const spellId = r.u16();
            r.u16(); // cast item id
            r.u16(); // spell category
            const spellCdMs = r.u32();
            const catCdMs = r.u32();
            if ((catCdMs & 0x80000000) !== 0) continue; // permanent (disabled) — not a timed cooldown
            const cooldownMs = Math.max(spellCdMs, catCdMs);
            if (cooldownMs > 0) this.emitCombat({ kind: 'spellCooldown', spellId, cooldownMs });
          }
        }
      } catch (e) {
        this.progress(`world: initial spells parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_LEARNED_SPELL) {
      try {
        const r = new Reader(packet.body);
        const spellId = r.u16();
        if (!this.knownSpells.includes(spellId)) this.knownSpells.push(spellId);
        this.emitActionData();
      } catch (e) {
        this.progress(`world: learned-spell parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_SUPERCEDED_SPELL) {
      try {
        const r = new Reader(packet.body);
        const oldSpellId = r.u16();
        const newSpellId = r.u16();
        this.knownSpells = this.knownSpells.filter((spellId) => spellId !== oldSpellId);
        if (!this.knownSpells.includes(newSpellId)) this.knownSpells.push(newSpellId);
        this.actionButtons = this.actionButtons.map((button) =>
          button && button.type === 0 && button.action === oldSpellId ? { ...button, action: newSpellId } : button);
        this.emitActionData();
        this.progress(`world: upgraded spell ${oldSpellId} -> ${newSpellId}`);
      } catch (e) {
        this.progress(`world: superseded-spell parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_REMOVED_SPELL) {
      try {
        const spellId = new Reader(packet.body).u16();
        this.knownSpells = this.knownSpells.filter((known) => known !== spellId);
        this.actionButtons = this.actionButtons.map((button) =>
          button && button.type === 0 && button.action === spellId ? null : button);
        this.emitActionData();
      } catch (e) {
        this.progress(`world: removed-spell parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_ACTION_BUTTONS) {
      try {
        const r = new Reader(packet.body);
        const buttons: ActionButton[] = [];
        while (r.remaining >= 4) {
          const packed = r.u32();
          buttons.push(packed === 0 ? null : { action: packed & 0x00ffffff, type: (packed >>> 24) & 0xff });
        }
        this.actionButtons = buttons;
        this.emitActionData();
      } catch (e) {
        this.progress(`world: action buttons parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_CAST_RESULT) {
      // WorldPackets::Spell::CastResult: u32 spell, u8 status; FAIL adds u8 reason and the
      // reason-dependent optional u32 arguments selected in Spell::SendCastResult.
      try {
        const r = new Reader(packet.body);
        const spellId = r.u32();
        const status = r.u8();
        const reason = status === 2 && r.remaining >= 1 ? r.u8() : undefined;
        let failureArg1: number | undefined;
        let failureArg2: number | undefined;
        if (status === 2 && reason !== undefined) {
          // Build 5875 SpellCastResult ordinals. NOT_READY's permanent-cooldown argument is
          // conditional; focus/area always append one; equipped-class variants append two.
          const allowsOne = reason === 60 || reason === 93 || reason === 94;
          const requiresTwo = reason === 25 || reason === 26 || reason === 27;
          if (requiresTwo) {
            if (r.remaining !== 8) throw new Error(`reason ${reason} expected 8 argument bytes, got ${r.remaining}`);
            failureArg1 = r.u32();
            failureArg2 = r.u32();
          } else if (allowsOne && r.remaining === 4) {
            failureArg1 = r.u32();
          } else if (r.remaining !== 0) {
            throw new Error(`reason ${reason} has unexpected ${r.remaining} argument bytes`);
          }
        }
        if (r.remaining !== 0) throw new Error(`SMSG_CAST_RESULT left ${r.remaining} unread bytes`);
        this.emitCombat({
          kind: 'castResult',
          spellId,
          success: status !== 2,
          reason,
          failureArg1,
          failureArg2,
        });
      } catch (e) {
        this.progress(`world: cast result parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_SPELL_COOLDOWN) {
      // vMaNGOS WorldPackets::Spell::SpellCooldown::AppendBodyTo:
      // raw ObjectGuid caster, then repeated uint32 spellId + uint32 cooldownMs.
      try {
        const r = new Reader(packet.body);
        const casterGuid = guidHex(r.bytes(8));
        while (r.remaining >= 8) {
          const spellId = r.u32();
          const cooldownMs = r.u32();
          if (!this.activeCharacter || casterGuid === this.activeCharacter.guid) {
            this.emitCombat({ kind: 'spellCooldown', spellId, cooldownMs });
          }
        }
      } catch (e) {
        this.progress(`world: spell cooldown parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_COOLDOWN_EVENT) {
      // vMaNGOS WorldPackets::Spell::CooldownEvent::AppendBodyTo:
      // uint32 spellId, raw ObjectGuid caster.
      try {
        const r = new Reader(packet.body);
        const spellId = r.u32();
        const casterGuid = guidHex(r.bytes(8));
        if (!this.activeCharacter || casterGuid === this.activeCharacter.guid) this.emitCombat({ kind: 'cooldownEvent', spellId });
      } catch (e) {
        this.progress(`world: cooldown event parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_CLEAR_COOLDOWN) {
      // vMaNGOS WorldPackets::Spell::ClearCooldown::AppendBodyTo:
      // uint32 spellId, raw ObjectGuid target.
      try {
        const r = new Reader(packet.body);
        const spellId = r.u32();
        const targetGuid = guidHex(r.bytes(8));
        if (!this.activeCharacter || targetGuid === this.activeCharacter.guid) this.emitCombat({ kind: 'clearCooldown', spellId });
      } catch (e) {
        this.progress(`world: clear cooldown parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_SPELLDAMAGESHIELD) {
      // WorldPackets::Combat::SpellDamageShield::AppendBodyTo (Server/Packets/Combat.cpp:73-79):
      // raw ObjectGuid victimGuid (the shield WEARER), raw ObjectGuid attackerGuid (who takes the
      // damage), u32 damage, u32 school.
      try {
        const r = new Reader(packet.body);
        const shieldGuid = guidHex(r.bytes(8));
        const victimGuid = guidHex(r.bytes(8));
        const damage = r.u32();
        const school = r.u32();
        this.emitCombat({ kind: 'damageShield', shieldGuid, victimGuid, damage, school });
      } catch (e) {
        this.progress(`world: damage shield parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_SPELLHEALLOG) {
      try {
        const r = new Reader(packet.body);
        const targetGuid = readPackedGuid(r);
        const healerGuid = readPackedGuid(r);
        const spellId = r.u32();
        const amount = r.u32();
        const critical = r.remaining >= 1 ? r.u8() !== 0 : false;
        this.emitCombat({ kind: 'spellHeal', healerGuid, targetGuid, spellId, amount, critical });
      } catch (e) {
        this.progress(`world: spell heal log parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_SPELLENERGIZELOG) {
      try {
        const r = new Reader(packet.body);
        const targetGuid = readPackedGuid(r);
        const casterGuid = readPackedGuid(r);
        const spellId = r.u32();
        const powerType = r.u32();
        const amount = r.u32();
        this.emitCombat({ kind: 'spellEnergize', casterGuid, targetGuid, spellId, powerType, amount });
      } catch (e) {
        this.progress(`world: spell energize log parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_SPELLNONMELEEDAMAGELOG) {
      try {
        const r = new Reader(packet.body);
        const targetGuid = readPackedGuid(r);
        const attackerGuid = readPackedGuid(r);
        const spellId = r.u32();
        const damage = r.u32();
        const school = r.u8();
        const absorb = r.u32();
        const resist = r.i32();
        const periodic = r.u8() !== 0;
        r.u8(); // unused
        const blocked = r.u32();
        const hitInfo = r.u32();
        if (r.remaining >= 1) r.u8(); // extendedData, always 0 in vMaNGOS 1.12.1
        this.emitCombat({ kind: 'spellDamage', attackerGuid, targetGuid, spellId, damage, school, absorb, resist, blocked, hitInfo, periodic });
      } catch (e) {
        this.progress(`world: spell damage log parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_SPELLLOGMISS) {
      try {
        const r = new Reader(packet.body);
        const spellId = r.u32();
        const casterGuid = guidHex(r.bytes(8));
        const useExtendedInfo = r.u8() !== 0;
        const count = r.u32();
        for (let i = 0; i < count; i++) {
          const targetGuid = guidHex(r.bytes(8));
          const missInfo = r.u8();
          if (useExtendedInfo) {
            r.f32();
            r.f32();
          }
          this.emitCombat({ kind: 'spellMiss', casterGuid, targetGuid, spellId, missInfo });
        }
      } catch (e) {
        this.progress(`world: spell miss log parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_PERIODICAURALOG) {
      try {
        const r = new Reader(packet.body);
        const targetGuid = readPackedGuid(r);
        const casterGuid = readPackedGuid(r);
        const spellId = r.u32();
        const count = r.u32();
        for (let i = 0; i < count; i++) {
          const auraType = r.u32();
          const payload = decodePeriodicAuraPayload(r, auraType);
          if (payload) this.emitCombat({ kind: 'periodicAura', casterGuid, targetGuid, spellId, auraType, ...payload });
          else {
            this.progress(`world: periodic aura type ${auraType} skipped`);
            break;
          }
        }
      } catch (e) {
        this.progress(`world: periodic aura log parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_PROCRESIST || packet.opcode === OPCODES.SMSG_SPELLORDAMAGE_IMMUNE) {
      try {
        const r = new Reader(packet.body);
        const casterGuid = guidHex(r.bytes(8));
        const targetGuid = guidHex(r.bytes(8));
        const spellId = r.u32();
        if (r.remaining >= 1) r.u8(); // logFormat
        this.emitCombat({
          kind: 'spellMiss',
          casterGuid,
          targetGuid,
          spellId,
          missInfo: packet.opcode === OPCODES.SMSG_PROCRESIST ? 2 : 7,
        });
      } catch (e) {
        this.progress(`world: spell resist/immune parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_PET_CAST_FAILED) {
      // WorldPackets::Pet::PetCastFailed: u32 spell, u8 result status, u8 SpellCastResult.
      try {
        const r = new Reader(packet.body);
        this.emitCombat({ kind: 'petCastFailed', spellId: r.u32(), status: r.u8(), reason: r.u8() });
      } catch (e) {
        this.progress(`world: pet cast failure parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_CANCEL_AUTO_REPEAT) {
      // WorldPackets::Misc::CancelAutoRepeat is an empty body. SpellCaster::InterruptSpell sends it
      // whenever the player's CURRENT_AUTOREPEAT_SPELL is actually removed.
      this.emitCombat({ kind: 'autoRepeatCancelled' });
      return;
    }

    if (packet.opcode === OPCODES.SMSG_PET_ACTION_FEEDBACK) {
      // WorldPackets::Pet::PetActionFeedback: one uint8 ActionFeedback code.
      try {
        this.emitCombat({ kind: 'petActionFeedback', message: new Reader(packet.body).u8() });
      } catch (e) {
        this.progress(`world: pet action feedback parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_PET_TAME_FAILURE) {
      // WorldPackets::Pet::PetTameFailure: one uint8 PetTameFailureReason.
      try {
        this.emitCombat({ kind: 'petTameFailure', reason: new Reader(packet.body).u8() });
      } catch (e) {
        this.progress(`world: pet tame failure parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_PET_BROKEN) {
      // Empty body; loyalty reached zero and the pet ran away.
      this.emitCombat({ kind: 'petBroken' });
      return;
    }

    if (packet.opcode === OPCODES.SMSG_AI_REACTION) {
      // WorldPackets::Misc::AiReaction: raw unit ObjectGuid + u32 AIReaction.
      try {
        const r = new Reader(packet.body);
        this.emitCombat({ kind: 'aiReaction', guid: readGuid64(r), reaction: r.u32() });
      } catch (e) {
        this.progress(`world: AI reaction parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_CANCEL_COMBAT) {
      // Empty body; Player::SendAttackSwingCancelAttack uses this to reject/terminate auto-attack.
      this.emitCombat({ kind: 'combatCancelled' });
      return;
    }

    if (packet.opcode === OPCODES.SMSG_PARTYKILLLOG) {
      // WorldPackets::Combat::PartyKillLog: raw killer and victim ObjectGuids.
      try {
        const r = new Reader(packet.body);
        this.emitCombat({ kind: 'partyKill', killerGuid: readGuid64(r), victimGuid: readGuid64(r) });
      } catch (e) {
        this.progress(`world: party kill log parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_SPELLLOGEXECUTE) {
      // Spell::SendLogExecute: packed caster, spell id, then exact per-effect target records.
      try {
        const r = new Reader(packet.body);
        const casterGuid = readPackedGuid(r);
        const spellId = r.u32();
        const effectCount = r.u32();
        const effects: Array<{
          effectId: number;
          count: number;
          targetGuids: string[];
          records: SpellExecuteRecord[];
        }> = [];
        for (let effectIndex = 0; effectIndex < effectCount; effectIndex++) {
          const effectId = r.u32();
          const count = r.u32();
          const records: SpellExecuteRecord[] = [];
          const targetGuids: string[] = [];
          for (let targetIndex = 0; targetIndex < count; targetIndex++) {
            const record = readSpellExecuteRecord(r, effectId);
            records.push(record);
            if (record.targetGuid) targetGuids.push(record.targetGuid);
          }
          effects.push({ effectId, count, targetGuids, records });
        }
        if (r.remaining !== 0) throw new Error(`SMSG_SPELLLOGEXECUTE left ${r.remaining} unread bytes`);
        this.emitCombat({ kind: 'spellExecute', casterGuid, spellId, effects });
      } catch (e) {
        this.progress(`world: spell execute log parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_SPELLDISPELLOG) {
      // Build 5875 vMaNGOS: packed victim, packed caster, u32 count, then dispelled aura spell ids.
      try {
        const r = new Reader(packet.body);
        const targetGuid = readPackedGuid(r);
        const casterGuid = readPackedGuid(r);
        const count = r.u32();
        const spellIds: number[] = [];
        for (let i = 0; i < count; i++) spellIds.push(r.u32());
        this.emitCombat({ kind: 'spellDispel', casterGuid, targetGuid, spellIds, success: true });
      } catch (e) {
        this.progress(`world: spell dispel log parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_DISPEL_FAILED) {
      // SpellEffects.cpp::EffectDispel: raw caster, raw victim, then spell ids to packet end.
      try {
        const r = new Reader(packet.body);
        const casterGuid = readGuid64(r);
        const targetGuid = readGuid64(r);
        const spellIds: number[] = [];
        while (r.remaining >= 4) spellIds.push(r.u32());
        this.emitCombat({ kind: 'spellDispel', casterGuid, targetGuid, spellIds, success: false });
      } catch (e) {
        this.progress(`world: failed dispel log parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_FEIGN_DEATH_RESISTED) {
      // WorldPackets::Combat::FeignDeathResisted has an empty body.
      this.emitCombat({ kind: 'feignDeathResisted' });
      return;
    }

    if (packet.opcode === OPCODES.SMSG_SPELLINSTAKILLLOG) {
      // Spell::EffectInstaKill: raw victim ObjectGuid + u32 spell id.
      try {
        const r = new Reader(packet.body);
        this.emitCombat({ kind: 'spellInstaKill', victimGuid: readGuid64(r), spellId: r.u32() });
      } catch (e) {
        this.progress(`world: spell instant-kill log parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_SPELL_UPDATE_CHAIN_TARGETS) {
      // Spell::SendChannelStart: raw caster, u32 spell, u32 count, raw target ObjectGuids.
      try {
        const r = new Reader(packet.body);
        const casterGuid = readGuid64(r);
        const spellId = r.u32();
        const count = r.u32();
        const targetGuids: string[] = [];
        for (let i = 0; i < count; i++) targetGuids.push(readGuid64(r));
        this.emitCombat({ kind: 'spellChainTargets', casterGuid, spellId, targetGuids });
      } catch (e) {
        this.progress(`world: spell chain target parse skipped (${(e as Error).message})`);
      }
      return;
    }

    // --- Combat (wire formats verified vs vmangos Server/Packets/Combat.cpp + Unit.cpp) ---
    const swingErrorReason = SWING_ERROR_REASONS[packet.opcode];
    if (swingErrorReason) {
      this.emitCombat({ kind: 'swingError', reason: swingErrorReason });
      return;
    }

    if (packet.opcode === OPCODES.SMSG_EMOTE) {
      // EmoteNotify: u32 Emotes.dbc id, u64 raw unit guid (vmangos Misc.cpp AppendBodyTo).
      try {
        const r = new Reader(packet.body);
        const emoteId = r.u32();
        this.emitCombat({ kind: 'emote', guid: guidHex(r.bytes(8)), emoteId });
      } catch (e) {
        this.progress(`world: emote parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_ATTACKSTART) {
      // AttackStart: attacker u64, victim u64 (plain guids).
      try {
        const r = new Reader(packet.body);
        this.emitCombat({ kind: 'attackStart', attackerGuid: guidHex(r.bytes(8)), victimGuid: guidHex(r.bytes(8)) });
      } catch (e) {
        this.progress(`world: attack start parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_ATTACKSTOP) {
      // vMaNGOS Unit::SendMeleeAttackStop serializes the attacker's !IsAlive() state.
      try {
        const r = new Reader(packet.body);
        const attackerGuid = readPackedGuid(r);
        const victimGuid = readPackedGuid(r);
        const attackerDead = r.remaining >= 4 ? r.u32() !== 0 : false;
        this.emitCombat({ kind: 'attackStop', attackerGuid, victimGuid, attackerDead });
      } catch (e) {
        this.progress(`world: attack stop parse skipped (${(e as Error).message})`);
      }
      return;
    }

    if (packet.opcode === OPCODES.SMSG_ATTACKERSTATEUPDATE) {
      // u32 hitInfo, packGUID attacker, packGUID victim, u32 totalDamage, u8 subCount,
      // per sub: u32 school, f32 dmg, u32 dmg, u32 absorb, i32 resist;
      // then u32 targetState, u32 unk, u32 spellId, u32 blocked.
      try {
        const r = new Reader(packet.body);
        const hitInfo = r.u32();
        const attackerGuid = readPackedGuid(r);
        const victimGuid = readPackedGuid(r);
        const totalDamage = r.u32();
        const subCount = r.u8();
        let school = 0;
        let absorb = 0;
        let resist = 0;
        for (let i = 0; i < subCount; i++) {
          const subSchool = r.u32();
          r.f32(); // damage as float (duplicate of the next u32)
          r.u32(); // damage
          absorb += r.u32();
          const rawResist = r.u32();
          resist += rawResist > 0x7fffffff ? rawResist - 0x100000000 : rawResist;
          if (i === 0) school = subSchool;
        }
        const targetState = r.u32();
        r.u32(); // unused
        const spellId = r.u32();
        const blocked = r.u32();
        this.emitCombat({
          kind: 'meleeDamage',
          attackerGuid, victimGuid, hitInfo, totalDamage, school, absorb, resist, targetState, blocked, spellId,
        });
      } catch (e) {
        this.progress(`world: attacker state parse skipped (${(e as Error).message})`);
      }
      return;
    }
    this.recordUnknownOpcode(packet, context);
  }

  /**
   * Invoke every listener in isolation.
   *
   * A throwing listener must never abort packet processing. `pump()` treats any exception that
   * escapes `handlePacket()` as a socket failure, stops the read loop and never reconnects — so
   * before this guard existed, one bad subscriber (unit frames, nameplates, action bar, quest log)
   * reacting to an ordinary entity update was enough to silently disconnect the player mid-play.
   * Listener faults are reported and swallowed; the realm connection outlives buggy UI.
   */
  private recordUnknownOpcode(packet: WorldPacket, context: PacketDispatchContext) {
    const knownName = packetName(packet.opcode);
    const query = typeof window === 'undefined' ? undefined : new URLSearchParams(window.location.search);
    this.unknownOpcodeTelemetry.record({
      opcode: packet.opcode,
      name: knownName.startsWith('0x') ? undefined : knownName,
      bodySize: packet.body.byteLength,
      sessionGeneration: this.sessionGeneration,
      worldGeneration: this.worldGeneration,
      compressedParent: context.parentOpcode,
      compressedRecordIndex: context.recordIndex,
      verbose: !!query && (query.has('debugtools') || query.has('packetdebug')),
    });
  }

  private dispatch<L>(listeners: Iterable<L>, invoke: (listener: L) => void, label: string) {
    if (BROWSERPORT_INSTRUMENTATION_ENABLED) emitBrowserPortTrace('world.event', label);
    for (const listener of listeners) {
      try {
        invoke(listener);
      } catch (e) {
        this.progress(`world: ${label} listener failed (${(e as Error).message})`);
      }
    }
  }

  private emitCombat(event: CombatEvent) {
    this.dispatch(this.combatListeners, (listener) => listener(event), 'combat');
  }

  private emitNearTeleport(dest: NearTeleport) {
    this.dispatch(this.nearTeleportListeners, (listener) => listener(dest), 'nearTeleport');
  }

  private emitDeath(event: DeathEvent) {
    this.dispatch(this.deathListeners, (listener) => listener(event), 'death');
  }

  private emitChat(event: ChatEvent) {
    this.dispatch(this.chatListeners, (listener) => listener(event), 'chat');
  }

  private emitChannelNotify(event: ChannelNotifyEvent) {
    this.dispatch(this.channelNotifyListeners, (listener) => listener(event), 'channelNotify');
  }

  private emitExploration(event: ExplorationEvent) {
    this.dispatch(this.explorationListeners, (listener) => listener(event), 'exploration');
  }

  private emitMinimapPing(event: MinimapPingEvent) {
    this.dispatch(this.minimapPingListeners, (listener) => listener(event), 'minimapPing');
  }

  private emitAuction() {
    const state = this.getAuctionState();
    if (state) this.emitInteraction({ kind: 'auction', state });
  }

  private emitWeather(event: WeatherEvent) {
    this.dispatch(this.weatherListeners, (listener) => listener(event), 'weather');
  }

  private emitSound(event: WorldSoundEvent) {
    this.dispatch(this.soundListeners, (listener) => listener(event), 'sound');
  }

  private async emitWorldTransfer(event: WorldTransferEvent) {
    // Awaited transfer listeners still need isolation from the packet pump.
    for (const listener of this.worldTransferListeners) {
      try {
        await listener(event);
      } catch (e) {
        this.progress(`world: worldTransfer listener failed (${(e as Error).message})`);
      }
    }
  }

  private emitMirrorTimer(event: MirrorTimerEvent) {
    this.dispatch(this.mirrorTimerListeners, (listener) => listener(event), 'mirrorTimer');
  }

  private resetForWorldTransfer() {
    this.worldGeneration++;
    this.restoreControlledMover('transfer', false);
    const removed = this.entities.snapshot().map((entity) => entity.guid);
    this.entities.clear();
    this.stats.entities = 0;
    this.playerAuraDurations.clear();
    this.worldStates = {};
    this.currentLoot = undefined;
    this.masterLootEligible = [];
    this.currentGossipGuid = undefined;
    this.currentGossipState = undefined;
    this.currentVendorGuid = undefined;
    this.currentTrainerGuid = undefined;
    this.closeBank();
    this.tradeState = undefined;
    this.closeMailbox();
    this.closeAuctionHouse();
    this.closePetition();
    this.closeStable();
    this.questItems.reset();
    this.names.resetPending();
    this.invalidateQuestGiverStatuses();
    this.activeJumpInfo = undefined;
    this.activeJumpStartedAt = undefined;
    for (const guid of removed) this.dispatch(this.entityRemoveListeners, (listener) => listener(guid), 'entityRemove');
    this.emitWorldState();
  }

  private emitActionData() {
    this.dispatch(this.actionDataListeners, (listener) => listener(), 'actionData');
  }

  private emitAura(unitGuid: string, auras: readonly AuraSlot[]) {
    this.dispatch(this.auraListeners, (listener) => listener(unitGuid, auras), 'aura');
  }

  private emitWorldState() {
    const snapshot = { ...this.worldStates };
    this.dispatch(this.worldStateListeners, (listener) => listener(snapshot), 'worldState');
  }

  private emitInventoryData() {
    if (!this.inventoryListeners.size || this.closed) return;
    const snapshot = this.getInventory();
    this.dispatch(this.inventoryListeners, (listener) => listener(snapshot), 'inventory');
    const bank = this.getBankState();
    if (bank) this.emitInteraction({ kind: 'bank', state: bank });
  }

  private emitSkillData() {
    if (!this.skillListeners.size || this.closed) return;
    const snapshot = this.getSkills();
    this.dispatch(this.skillListeners, (listener) => listener(snapshot), 'skill');
  }

  private emitHonorData() {
    if (!this.honorListeners.size || this.closed) return;
    const snapshot = this.getHonor();
    this.dispatch(this.honorListeners, (listener) => listener(snapshot), 'honor');
  }

  private emitReputationData() {
    if (!this.reputationListeners.size || this.closed) return;
    const snapshot = this.getReputation();
    this.dispatch(this.reputationListeners, (listener) => listener(snapshot), 'reputation');
  }

  private emitPetData() {
    if (!this.petListeners.size || this.closed) return;
    const snapshot = this.getPet();
    this.dispatch(this.petListeners, (listener) => listener(snapshot), 'pet');
  }

  private emitQuestLog() {
    if (!this.questLogListeners.size || this.closed) return;
    const snapshot = this.getQuestLog();
    for (const entry of snapshot.entries) this.queryQuestInfo(entry.questId);
    this.dispatch(this.questLogListeners, (listener) => listener(snapshot), 'questLog');
  }

  private emitQuestProgress(event: QuestProgressEvent) {
    this.dispatch(this.questProgressListeners, (listener) => listener(event), 'questProgress');
  }

  private emitLootRoll(event: LootRollEvent) {
    this.dispatch(this.lootRollListeners, (listener) => listener(event), 'lootRoll');
  }

  /** Dispatch the small service parsers; true means the packet was consumed. */
  private handleServicePacket(packet: WorldPacket): boolean {
    const O = OPCODES;
    const say = (message: string) =>
      this.emitChat({ type: CHAT_MSG.SYSTEM, language: 0, chatTag: 0, message });
    const guard = (label: string, run: () => void) => {
      try { run(); } catch (e) { this.progress(`world: ${label} skipped (${(e as Error).message})`); }
      return true;
    };

    let feedback: ReturnType<typeof readServiceFeedback>;
    try {
      feedback = readServiceFeedback(packet.opcode, new Reader(packet.body), readGuid64, this.activeCharacter?.name);
    } catch (e) { this.progress(`world: service feedback skipped (${(e as Error).message})`); return true; }
    if (feedback) {
      if (feedback.kind === 'system') say(feedback.message);
      else if (feedback.kind === 'channelList') this.channelLists.accept(feedback);
      else if (feedback.kind === 'uiError') this.emitInteraction({ kind: 'uiError', message: feedback.message });
      else if (feedback.kind === 'openContainer' || feedback.kind === 'petUnlearnConfirm') this.emitInteraction(feedback);
      else if (feedback.kind === 'raidGroupOnly') this.emitCombat({ ...feedback, bindAreaId: this.bindPoint?.areaId });
      return true;
    }

    switch (packet.opcode) {
      // --- Fixed login state and stock player feedback ---
      case O.SMSG_TUTORIAL_FLAGS:
        return guard('tutorial flags', () => {
          const r = new Reader(packet.body);
          const tutorialFlags = readTutorialFlags(r);
          if (r.remaining !== 0) throw new Error(`expected 32 bytes, got ${packet.body.length}`);
          this.tutorialFlags = tutorialFlags;
        });
      case O.SMSG_FISH_NOT_HOOKED:
        this.emitInteraction({ kind: 'uiError', message: 'No fish are hooked.' });
        return true;
      case O.SMSG_FISH_ESCAPED:
        this.emitInteraction({ kind: 'uiError', message: 'Your fish got away!' });
        return true;
      case O.SMSG_GOSSIP_POI:
        return guard('gossip POI', () => {
          const r = new Reader(packet.body);
          const poi = readGossipPoi(r);
          if (r.remaining !== 0) throw new Error(`left ${r.remaining} unread bytes`);
          this.emitInteraction({ kind: 'gossipPoi', poi });
        });

      // --- Innkeeper hearthstone binding ---
      case O.SMSG_BINDER_CONFIRM:
        // Body is the binder's guid only. UIParent.lua turns the binary event into CONFIRM_BINDER;
        // the UI layer resolves the name used for its `%s` placeholder.
        return guard('binder confirm', () => {
          this.emitInteraction({ kind: 'binderConfirm', guid: readGuid64(new Reader(packet.body)) });
        });
      case O.SMSG_BINDPOINTUPDATE:
        return guard('bind point update', () => {
          this.bindPoint = readBindPoint(new Reader(packet.body));
          this.emitInteraction({
            kind: 'bindPointUpdate', areaId: this.bindPoint.areaId, mapId: this.bindPoint.mapId,
          });
        });
      case O.SMSG_PLAYERBOUND:
        return guard('player bound', () => {
          const r = new Reader(packet.body);
          readGuid64(r);
          this.emitInteraction({ kind: 'bindPointUpdate', areaId: r.u32(), mapId: this.bindPoint?.mapId ?? 0 });
        });
      case O.SMSG_PLAYERBINDERROR:
        say('You cannot bind here.');
        return true;

      // --- Talent reset ---
      case O.MSG_TALENT_WIPE_CONFIRM:
        return guard('talent wipe confirm', () => {
          const r = new Reader(packet.body);
          const guid = readGuid64(r);
          const cost = r.u32();
          // SkillHandler.cpp:52 re-sends with an EMPTY guid to mean "no points spent".
          if (/^0+$/.test(guid)) { say('You have not spent any talent points.'); return; }
          this.emitInteraction({ kind: 'talentWipeConfirm', guid, cost });
        });

      // --- Exploration ---
      case O.SMSG_EXPLORATION_EXPERIENCE:
        return guard('exploration xp', () => this.emitExploration(readExploration(new Reader(packet.body))));
      case O.SMSG_SET_REST_START:
        // u32 restStateTime. Informational only — the rested pool itself arrives as
        // PLAYER_REST_STATE_EXPERIENCE in the object update, which the HUD already reads.
        return true;

      // --- Group utilities ---
      case O.MSG_RANDOM_ROLL:
        return guard('random roll', () => {
          const event = readRandomRoll(new Reader(packet.body), readGuid64);
          const name = this.playerNames.get(event.rollerGuid)?.name;
          if (!name) this.queryPlayerName(event.rollerGuid);
          this.emitChat({
            type: CHAT_MSG.SYSTEM, language: 0, chatTag: 0, senderGuid: event.rollerGuid,
            message: randomRollMessage(name ?? 'Someone', event),
          });
        });
      case O.MSG_MINIMAP_PING:
        return guard('minimap ping', () => this.emitMinimapPing(readMinimapPing(new Reader(packet.body), readGuid64)));
      // --- Guild identity ---
      case O.SMSG_GUILD_QUERY_RESPONSE:
        return guard('guild query response', () => {
          const { guildId, name, rankNames } = readGuildQueryResponse(new Reader(packet.body));
          this.pendingGuildQueries.delete(guildId);
          this.guildNames.set(guildId, { name, rankNames });
          if (guildId === this.ownGuildId()) { this.social = { ...this.social, guildName: name, guildRankNames: rankNames.slice(0, this.social.guildRankRights.length) }; this.emitSocial(); }
        });

      // --- Server-driven notices ---
      case O.SMSG_NOTIFICATION:
        return guard('notification', () => say(new Reader(packet.body).cstring()));
      case O.SMSG_SERVER_MESSAGE:
        return guard('server message', () => {
          const r = new Reader(packet.body);
          r.u32(); // messageType — the text is already formatted for display.
          say(r.cstring());
        });
      case O.SMSG_AREA_TRIGGER_MESSAGE:
        // u32 length + cstring. Vanilla shows these in the raid-warning banner; the system chat
        // line keeps the text visible without inventing a frame we have no art for.
        return guard('area trigger message', () => {
          const r = new Reader(packet.body);
          r.u32();
          say(r.cstring());
        });
      case O.SMSG_PLAYED_TIME:
        return guard('played time', () => {
          const r = new Reader(packet.body);
          say(`Total time played: ${formatPlayedTime(r.u32())}`);
          say(`Time played this level: ${formatPlayedTime(r.u32())}`);
        });
      case O.SMSG_RECEIVED_MAIL:
        this.unreadMail = true;
        say('You have new mail.');
        return true;
      case O.SMSG_ITEM_NAME_QUERY_RESPONSE:
        return guard('item name query', () => {
          const r = new Reader(packet.body);
          const entry = r.u32();
          const name = r.cstring();
          this.pendingItemNameQueries.delete(entry);
          if (name) this.itemNames.set(entry, name);
        });

      // --- Auction house ---
      case O.MSG_AUCTION_HELLO:
        return guard('auction hello', () => {
          const r = new Reader(packet.body);
          this.currentAuctioneerGuid = readGuid64(r);
          this.auctionHouseId = r.u32();
          this.auctionPages = emptyAuctionPages();
          this.auctionPending = undefined;
          this.emitAuction();
        });
      case O.SMSG_AUCTION_LIST_RESULT:
      case O.SMSG_AUCTION_OWNER_LIST_RESULT:
      case O.SMSG_AUCTION_BIDDER_LIST_RESULT: {
        const tab: AuctionTab = packet.opcode === O.SMSG_AUCTION_LIST_RESULT ? 'browse'
          : packet.opcode === O.SMSG_AUCTION_OWNER_LIST_RESULT ? 'auctions' : 'bids';
        return guard(`auction ${tab} list`, () => {
          const { entries, totalCount } = readAuctionList(new Reader(packet.body), readGuid64);
          this.auctionPages = {
            ...this.auctionPages,
            [tab]: { entries, totalCount, page: this.auctionPages[tab].page },
          };
          if (this.auctionPending === tab) this.auctionPending = undefined;
          // Rows carry only an item entry; names and icons come from the normal item cache.
          for (const entry of entries) this.requestItemInfo(entry.itemEntry);
          this.emitAuction();
        });
      }
      case O.SMSG_AUCTION_COMMAND_RESULT:
        return guard('auction command result', () => {
          const r = new Reader(packet.body);
          r.u32(); // auctionId
          const action = r.u32();
          const error = r.u32();
          this.emitInteraction({
            kind: 'auctionMessage', action, error,
            message: error === 0
              ? AUCTION_ACTION_MESSAGES[action] ?? 'Auction updated.'
              : AUCTION_ERROR_MESSAGES[error] ?? `Auction error ${error}.`,
          });
          // A completed action invalidates whichever list it touched; vanilla re-queries too.
          if (error !== 0 || !this.currentAuctioneerGuid) return;
          if (action === 0 || action === 1) this.auctionListOwnerItems(this.auctionPages.auctions.page);
          else this.auctionListItems({ ...this.lastAuctionFilters, page: this.auctionPages.browse.page });
        });
      case O.SMSG_AUCTION_BIDDER_NOTIFICATION:
      case O.SMSG_AUCTION_OWNER_NOTIFICATION:
      case O.SMSG_AUCTION_REMOVED_NOTIFICATION:
        return guard('auction notification', () => {
          const r = new Reader(packet.body);
          let itemEntry = 0;
          let template = '';
          if (packet.opcode === O.SMSG_AUCTION_BIDDER_NOTIFICATION) {
            r.u32(); r.u32(); readGuid64(r);
            const bidOrZero = r.u32();
            r.u32();
            itemEntry = r.u32();
            // AuctionHouse.h:120 — a zero bid means you WON; non-zero means you were outbid.
            template = bidOrZero === 0 ? 'You won an auction for %s' : 'You have been outbid on %s.';
          } else if (packet.opcode === O.SMSG_AUCTION_OWNER_NOTIFICATION) {
            r.u32(); r.u32(); r.u32(); readGuid64(r);
            itemEntry = r.u32();
            template = 'Your auction of %s sold.';
          } else {
            r.u32();
            itemEntry = r.u32();
            template = 'Your auction of %s has expired.';
          }
          const name = this.itemInfo.get(itemEntry)?.name ?? this.itemNames.get(itemEntry);
          if (!name) this.requestItemName(itemEntry);
          say(template.replace('%s', name ?? `item ${itemEntry}`));
        });

      // --- Guild charters ---
      case O.SMSG_PETITION_SHOWLIST:
        return guard('petition showlist', () => {
          const state = readPetitionShowList(new Reader(packet.body), readGuid64);
          this.currentPetitionVendorGuid = state.guid;
          this.emitInteraction({ kind: 'petitionVendor', state });
        });
      case O.SMSG_PETITION_SHOW_SIGNATURES:
        return guard('petition signatures', () => {
          const state = readPetitionSignatures(new Reader(packet.body), readGuid64);
          // Keep a name already resolved for this same charter, so a re-poll does not blank it.
          this.currentPetition = {
            ...state,
            name: this.currentPetition?.petitionGuid === state.petitionGuid ? this.currentPetition.name : undefined,
          };
          for (const guid of state.signatures) this.queryPlayerName(guid);
          this.queryPlayerName(state.ownerGuid);
          this.petitionQuery(state.petitionGuid, state.itemGuid);
          this.emitInteraction({ kind: 'petition', state: this.getPetitionState()! });
        });
      case O.SMSG_PETITION_QUERY_RESPONSE:
        // u32 petitionGuid, u64 ownerGuid, cstring name, then a tail the 1.12 UI ignores.
        return guard('petition query', () => {
          const r = new Reader(packet.body);
          const petitionGuid = r.u32();
          readGuid64(r);
          const name = r.cstring();
          if (this.currentPetition?.petitionGuid !== petitionGuid) return;
          this.currentPetition = { ...this.currentPetition, name };
          this.emitInteraction({ kind: 'petition', state: this.getPetitionState()! });
        });
      case O.SMSG_PETITION_SIGN_RESULTS:
        return guard('petition sign result', () => {
          const r = new Reader(packet.body);
          const itemGuid = readGuid64(r);
          readGuid64(r);
          const result = r.u32();
          this.emitInteraction({
            kind: 'petitionMessage', result,
            message: PETITION_SIGN_MESSAGES[result] ?? `Signature result ${result}.`,
          });
          if (result === 0) this.petitionShowSignatures(itemGuid);
        });
      case O.SMSG_TURN_IN_PETITION_RESULTS: {
        const result = packet.body.length >= 4 ? new Reader(packet.body).u32() : 0;
        this.emitInteraction({
          kind: 'petitionMessage', result,
          message: PETITION_TURN_IN_MESSAGES[result] ?? `Charter result ${result}.`,
        });
        if (result === 0) this.closePetition();
        return true;
      }
      case O.MSG_PETITION_RENAME:
        return guard('petition rename', () => {
          const r = new Reader(packet.body);
          readGuid64(r);
          const name = r.cstring();
          if (!this.currentPetition) return;
          this.currentPetition = { ...this.currentPetition, name };
          this.emitInteraction({ kind: 'petition', state: this.getPetitionState()! });
        });
      case O.MSG_PETITION_DECLINE:
        return guard('petition decline', () => {
          const guid = readGuid64(new Reader(packet.body));
          const name = this.playerNames.get(guid)?.name;
          if (!name) this.queryPlayerName(guid);
          this.emitInteraction({
            kind: 'petitionMessage',
            message: `${name ?? 'A player'} declined to sign your charter.`,
          });
        });

      // --- Hunter stable ---
      case O.MSG_LIST_STABLED_PETS:
        return guard('stabled pet list', () => {
          const state = readStabledPets(new Reader(packet.body), readGuid64);
          this.currentStableGuid = state.guid;
          this.stableSlots = state.stableSlots;
          this.stablePets = state.pets;
          this.emitInteraction({ kind: 'stable', state: this.getStableState()! });
        });
      case O.SMSG_STABLE_RESULT: {
        const result = packet.body.length ? packet.body[0] : 0;
        this.emitInteraction({
          kind: 'stableMessage', result,
          message: STABLE_RESULT_MESSAGES[result] ?? `Stable result ${result}.`,
        });
        // Every success mutates the list; re-request rather than guessing the new layout.
        if (this.currentStableGuid && STABLE_SUCCESS_CODES.includes(result)) {
          this.listStabledPets(this.currentStableGuid);
        }
        return true;
      }

      default:
        return false;
    }
  }

  private handleTradeStatus(body: Uint8Array) {
    try {
      const r = new Reader(body);
      const status = r.u32();
      if (status === 1) {
        const guid = readGuid64(r);
        this.tradeState = {
          partnerGuid: guid, playerMoney: 0, targetMoney: 0,
          playerItems: Array(7), targetItems: Array(7), playerAccepted: false, targetAccepted: false,
        };
        this.queryPlayerName(guid);
        this.emitInteraction({ kind: 'tradeRequest', guid });
        return;
      }
      if (status === 2) {
        this.tradeState ??= {
          playerMoney: 0, targetMoney: 0,
          playerItems: Array(7), targetItems: Array(7), playerAccepted: false, targetAccepted: false,
        };
        this.emitInteraction({ kind: 'trade', state: this.getTradeState()! });
        return;
      }
      if (status === 4 && this.tradeState) {
        this.tradeState.targetAccepted = true;
        this.emitInteraction({ kind: 'trade', state: this.getTradeState()! });
        return;
      }
      if (status === 7 && this.tradeState) {
        this.tradeState.playerAccepted = false;
        this.tradeState.targetAccepted = false;
        this.emitInteraction({ kind: 'trade', state: this.getTradeState()! });
        return;
      }
      if (status === 8) {
        this.tradeState = undefined;
        this.emitInteraction({ kind: 'tradeClose', message: 'Trade complete.' });
        return;
      }
      const messages: Record<number, string> = {
        0: 'That player is busy.', 3: 'Trade canceled.', 5: 'That player is busy.', 6: 'No trade target.',
        9: 'Trade declined.', 10: 'That player is too far away.', 11: 'You cannot trade with that faction.',
        12: 'Trade closed.', 13: 'Trade canceled.', 14: 'That player is ignoring you.',
        15: 'You are stunned.', 16: 'That player is stunned.', 17: 'You are dead.', 18: 'That player is dead.',
        19: 'You are logging out.', 20: 'That player is logging out.', 21: 'Trial accounts cannot trade.',
        22: 'Only conjured items can be traded here.',
      };
      if (messages[status]) {
        this.tradeState = undefined;
        this.emitInteraction({ kind: 'tradeClose', message: messages[status] });
      }
    } catch (e) {
      this.progress(`world: trade status parse skipped (${(e as Error).message})`);
    }
  }

  private handleExtendedTrade(body: Uint8Array) {
    try {
      const r = new Reader(body);
      const targetSide = r.u8() !== 0;
      const slotCount = Math.min(7, r.u32());
      r.u32(); // repeated slot count in the Vanilla wire layout
      const money = r.u32();
      r.u32(); // spell applied to the non-traded slot
      const items: Array<TradeItem | undefined> = Array(7);
      for (let index = 0; index < slotCount && r.remaining >= 61; index++) {
        const tradeSlot = r.u8();
        const entry = r.u32();
        const displayInfoId = r.u32();
        const count = r.u32();
        for (let field = 0; field < 12; field++) r.u32();
        if (entry && tradeSlot < 7) {
          items[tradeSlot] = { entry, displayInfoId, count: Math.max(1, count) };
          this.queryItem(entry);
        }
      }
      this.tradeState ??= {
        playerMoney: 0, targetMoney: 0,
        playerItems: Array(7), targetItems: Array(7), playerAccepted: false, targetAccepted: false,
      };
      if (targetSide) {
        this.tradeState.targetMoney = money;
        this.tradeState.targetItems = items;
      } else {
        this.tradeState.playerMoney = money;
        this.tradeState.playerItems = items;
      }
      this.tradeState.playerAccepted = false;
      this.tradeState.targetAccepted = false;
      this.emitInteraction({ kind: 'trade', state: this.getTradeState()! });
    } catch (e) {
      this.progress(`world: extended trade parse skipped (${(e as Error).message})`);
    }
  }

  private emitInteraction(event: InteractionEvent) {
    this.dispatch(this.interactionListeners, (listener) => listener(event), 'interaction');
  }

  private flushItemPushes(itemEntry: number) {
    const info = this.itemInfo.get(itemEntry);
    const matches = this.pendingItemPushes.filter((result) => result.itemEntry === itemEntry);
    for (let index = this.pendingItemPushes.length - 1; index >= 0; index--) {
      if (this.pendingItemPushes[index].itemEntry === itemEntry) this.pendingItemPushes.splice(index, 1);
    }
    for (const result of matches) {
      const item = `[${info?.name ?? `Item ${itemEntry}`}]`;
      const self = result.playerGuid === this.activeCharacter?.guid;
      const player = self ? 'You' : (this.playerNames.get(result.playerGuid)?.name ?? 'A player');
      const message = result.created && self
        ? `You create: ${item}.`
        : result.received
          ? self ? `You receive item: ${item}.` : `${player} receives item: ${item}.`
          : self ? `You receive loot: ${item}.` : `${player} receives loot: ${item}.`;
      this.emitInteraction({ kind: 'itemPush', itemEntry, message });
    }
  }

  private clearChangedPlayerAuraDurations(previous?: readonly number[], current?: readonly number[]) {
    for (let slot = 0; slot < 48; slot++) {
      const before = previous?.[slot] ?? 0;
      const after = current?.[slot] ?? 0;
      if (!after || before !== after) this.playerAuraDurations.delete(slot);
    }
  }

  private recordUpdate(data: Uint8Array) {
    const parsed = parseWorldUpdatePacket(data, (guid) => this.entities.typeOf(guid));
    this.stats.updateBlocks += parsed.blockCount;
    this.stats.updateParseErrors += parsed.errors.length;
    if (parsed.errors[0]) {
      const error = parsed.errors[0];
      const detail = [
        error.context ? `ctx ${error.context}` : '',
        error.nextBytes ? `next ${error.nextBytes}` : '',
      ]
        .filter(Boolean)
        .join(' | ');
      this.progress(
        `world: update parse warning at block ${error.blockIndex} offset ${error.offset}: ${error.message}${
          detail ? ` | ${detail}` : ''
        }`,
      );
    }

    let inventoryDirty = false;
    let questLogDirty = false;
    let skillDirty = false;
    let honorDirty = false;
    let reputationDirty = false;
    let petDirty = false;
    for (const block of parsed.blocks) {
      const previousGuildId = block.guid === this.activeCharacter?.guid ? this.ownGuildId() : undefined;
      const previousAuraIds =
        block.guid === this.activeCharacter?.guid ? this.entities.get(block.guid)?.auraSpellIds?.slice(0, 48) : undefined;
      let movementPredictionAgeMs: number | undefined;
      if (block.movement) {
        const receiptTime = this.clockSync.now();
        this.clockSync.registerServerTimestamp(block.movement.time, receiptTime);
        movementPredictionAgeMs = this.clockSync.calculatePredictionAge(
          block.movement.time,
          receiptTime,
          (block.movement.flags & MOVEMENTFLAG_JUMPING) !== 0,
        );
      }
      const change = this.entities.apply(block, movementPredictionAgeMs);
      if (change.kind === 'remove') {
        this.stats.entityRemoves++;
        inventoryDirty = true;
        petDirty = true;
        if (change.guid === this.activeCharacter?.guid) this.playerAuraDurations.clear();
        this.dispatch(this.entityRemoveListeners, (listener) => listener(change.guid), 'entityRemove');
      } else if (change.kind === 'create') {
        this.stats.entityCreates++;
        // pumpStarted flips true only after enterWorld's login burst finishes, so this isolates
        // entities the server streamed while moving from the initial-visibility burst. If this
        // stays ~0 while walking into mobs, the server never relocated us (movement not accepted).
        if (this.pumpStarted) this.stats.postLoginEntityCreates++;
        this.emitEntity(change.entity, change);
        if (this.isInventoryRelevantEntity(change.entity)) inventoryDirty = true;
        if (this.isPetRelevantEntity(change.entity)) petDirty = true;
        if (change.entity.guid === this.activeCharacter?.guid) {
          const authoritativeMoney = change.entity.fields.get(PLAYER_FIELD_COINAGE);
          if (authoritativeMoney !== undefined) this.lastKnownMoney = authoritativeMoney;
          questLogDirty = true;
          skillDirty = true;
          honorDirty = true;
          reputationDirty = true;
          petDirty = true;
        }
        if (block.values?.some((field) => isAuraField(field.index))) {
          if (change.entity.guid === this.activeCharacter?.guid) {
            this.clearChangedPlayerAuraDurations(previousAuraIds, change.entity.auraSpellIds);
          }
          this.emitAura(change.entity.guid, this.getAuras(change.entity.guid));
        }
      } else if (change.kind === 'update') {
        this.stats.entityUpdates++;
        this.emitEntity(change.entity, change);
        if (this.isInventoryRelevantEntity(change.entity)) inventoryDirty = true;
        if (
          change.entity.typeId === TypeID.CONTAINER &&
          change.changedFields.some((field) => field === CONTAINER_FIELD_NUM_SLOTS || (field >= CONTAINER_FIELD_SLOT_1 && field < CONTAINER_FIELD_SLOT_1 + 72))
        ) {
          this.confirmInventoryPredictionsFor(change.changedFields.map((field) => `${change.entity.guid}:${field}`));
        }
        if (this.isPetRelevantEntity(change.entity) && change.changedFields.some((field) => this.isPetField(field))) petDirty = true;
        // The control flags describing an already-decoded SMSG_PET_SPELLS land here, one tick after
        // the packet itself. Re-derive the layout instead of leaving it on the pre-flag guess.
        if (
          change.entity.guid === this.petSpellState?.guid
          && change.changedFields.some((field) => field === UNIT_FIELD_FLAGS || field === UNIT_FIELD_CHARMEDBY || field === UNIT_FIELD_CHARMEDBY + 1)
          && this.repriseControlLayout()
        ) {
          petDirty = true;
        }
        if (change.entity.guid === this.activeCharacter?.guid) {
          // PLAYER_FIELD_COINAGE changes in-place for loot, vendors, quests, mail, and trades.
          // It does not alter an item/container entity or a slot pointer, so it must explicitly
          // invalidate the inventory snapshot that supplies the backpack SmallMoneyFrame.
          if (change.changedFields.includes(PLAYER_FIELD_COINAGE)) {
            this.lastKnownMoney = change.entity.fields.get(PLAYER_FIELD_COINAGE) ?? this.lastKnownMoney;
            inventoryDirty = true;
          }
          if (change.changedFields.some((field) => this.isQuestLogField(field))) questLogDirty = true;
          if (change.changedFields.some((field) => this.isSkillField(field))) skillDirty = true;
          if (change.changedFields.some((field) => this.isHonorField(field))) honorDirty = true;
          if (change.changedFields.includes(PLAYER_FIELD_WATCHED_FACTION_INDEX)) reputationDirty = true;
          if (change.changedFields.some((field) => this.isPetField(field))) petDirty = true;
          // Authoritative slot state confirms (or corrects) pending optimistic moves.
          const slotFieldEnd = PLAYER_FIELD_PACK_SLOT_1 + BACKPACK_SLOT_COUNT * 2;
          if (change.changedFields.some((field) => (field >= PLAYER_FIELD_INV_SLOT_HEAD && field < slotFieldEnd) || isKeyringField(field))) {
            // Authoritative slot state arrived — the prediction is now confirmed
            // (or corrected by the absolute values), so drop the pending revert.
            this.confirmInventoryPredictionsFor(change.changedFields.map((field) => `${change.entity.guid}:${field}`));
          }
        }
        if (change.changedFields.some(isAuraField)) {
          if (change.entity.guid === this.activeCharacter?.guid) {
            this.clearChangedPlayerAuraDurations(previousAuraIds, change.entity.auraSpellIds);
          }
          this.emitAura(change.entity.guid, this.getAuras(change.entity.guid));
        }
      }
      if (previousGuildId !== undefined && (change.kind === 'create' || change.kind === 'update') && change.changedFields.includes(PLAYER_FIELDS.PLAYER_GUILDID)) this.reconcileGuildMembership(previousGuildId);
    }
    this.stats.entities = this.entities.size;
    if (inventoryDirty) {
      this.emitInventoryData();
    }
    if (questLogDirty) this.emitQuestLog();
    if (skillDirty) this.emitSkillData();
    if (honorDirty) this.emitHonorData();
    if (reputationDirty) this.emitReputationData();
    if (petDirty) this.emitPetData();
  }

  private emitStats() {
    if (!this.statsListeners.size || this.closed) return;
    const now = globalThis.performance?.now?.() ?? Date.now();
    const dueIn = 100 - (now - this.statsLastEmittedAt);
    if (dueIn > 0) {
      if (this.statsEmitTimer === undefined) {
        this.statsEmitTimer = setTimeout(() => this.flushStats(), dueIn);
      }
      return;
    }
    if (this.statsEmitTimer !== undefined) {
      clearTimeout(this.statsEmitTimer);
      this.statsEmitTimer = undefined;
    }
    this.flushStats();
  }

  private recordClientMove(kind: MoveKind | 'heartbeat' | 'spline_done', x: number, y: number, z: number, o: number, flags: number) {
    this.stats.clientMovementPackets++;
    this.stats.lastClientMove = {
      moverGuid: this.controlledMover?.moverGuid ?? this.activeCharacter?.guid,
      kind,
      x,
      y,
      z,
      o,
      flags,
      sentAt: Date.now(),
    };
  }

  private flushStats() {
    if (!this.statsListeners.size || this.closed) return;
    this.statsEmitTimer = undefined;
    this.statsLastEmittedAt = globalThis.performance?.now?.() ?? Date.now();
    const snapshot = { ...this.stats };
    this.dispatch(this.statsListeners, (listener) => listener(snapshot), 'stats');
  }
}

export async function connectWorld(
  worldProxyUrl: string,
  session: AuthSession,
  realm: RealmInfo,
  progress: WorldProgress = () => {},
) {
  return RealmWorldClient.connect(worldProxyUrl, session, realm, progress);
}

export async function fetchCharacters(
  worldProxyUrl: string,
  session: AuthSession,
  realm: RealmInfo,
  progress: WorldProgress = () => {},
): Promise<CharacterInfo[]> {
  const client = await RealmWorldClient.connect(worldProxyUrl, session, realm, progress);
  try {
    return client.characters;
  } finally {
    client.close();
  }
}
