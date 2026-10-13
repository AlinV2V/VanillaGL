/** Asset conversion utility. */
import type { ReadGuid, Reader } from './wire';

export type BindPoint = { x: number; y: number; z: number; mapId: number; areaId: number };
export type ExplorationEvent = { areaId: number; experience: number };
export type MinimapPingEvent = { guid: string; x: number; y: number };
export type GuildInfo = { name: string; rankNames: string[] };
export type RandomRollEvent = { minimum: number; maximum: number; roll: number; rollerGuid: string };
export type GossipPoi = { flags: number; x: number; y: number; icon: number; data: number; name: string };

/** SMSG_GUILD_QUERY_RESPONSE always carries exactly 10 rank names, even for a smaller guild. */
export const GUILD_RANK_COUNT = 10;

/** vMaNGOS rejects a /roll with `maximum > 10000` (GroupHandler.cpp:397). */
export const RANDOM_ROLL_MAX = 10000;

/** WorldSession::SendTutorialsData serializes the fixed uint32[8] account tutorial mask. */
export const TUTORIAL_WORD_COUNT = 8;

export function readTutorialFlags(r: Reader): number[] {
  return Array.from({ length: TUTORIAL_WORD_COUNT }, () => r.u32());
}

/** SMSG_GOSSIP_POI, GossipDef.cpp:286-292. Coordinates are world-space, not normalized map UVs. */
export function readGossipPoi(r: Reader): GossipPoi {
  return { flags: r.u32(), x: r.f32(), y: r.f32(), icon: r.u32(), data: r.u32(), name: r.cstring() };
}

/** SMSG_BINDPOINTUPDATE: f32 x, f32 y, f32 z, u32 mapId, u32 areaId (Packets/Misc.cpp:600-607). */
export function readBindPoint(r: Reader): BindPoint {
  return { x: r.f32(), y: r.f32(), z: r.f32(), mapId: r.u32(), areaId: r.u32() };
}

/** SMSG_EXPLORATION_EXPERIENCE: u32 areaId + u32 experience (Packets/Misc.cpp:552-556). */
export function readExploration(r: Reader): ExplorationEvent {
  return { areaId: r.u32(), experience: r.u32() };
}

/** MSG_RANDOM_ROLL broadcast: u32 min, u32 max, u32 roll, u64 rollerGuid. */
export function readRandomRoll<R extends Reader>(r: R, readGuid: ReadGuid<R>): RandomRollEvent {
  const minimum = r.u32();
  const maximum = r.u32();
  const roll = r.u32();
  return { minimum, maximum, roll, rollerGuid: readGuid(r) };
}

/** MSG_MINIMAP_PING relay: u64 guid + f32 x + f32 y. */
export function readMinimapPing<R extends Reader>(r: R, readGuid: ReadGuid<R>): MinimapPingEvent {
  const guid = readGuid(r);
  return { guid, x: r.f32(), y: r.f32() };
}

/**
 * SMSG_GUILD_QUERY_RESPONSE: u32 id + cstring name + 10 cstring rank names, then the emblem
 * fields this client does not use (Packets/Guild.cpp:118-131).
 */
export function readGuildQueryResponse(r: Reader): { guildId: number } & GuildInfo {
  const guildId = r.u32();
  const name = r.cstring();
  const rankNames: string[] = [];
  for (let i = 0; i < GUILD_RANK_COUNT; i++) rankNames.push(r.cstring());
  return { guildId, name, rankNames };
}

/**
 * `SecondsToTime`-style d/h/m used by TIME_PLAYED_TOTAL and TIME_PLAYED_LEVEL
 * (GlobalStrings.lua:3689-3691).
 */
export function formatPlayedTime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (minutes || !parts.length) parts.push(`${minutes} min${minutes === 1 ? '' : 's'}`);
  return parts.join(' ');
}

/**
 * ERR_ZONE_EXPLORED = "Discovered: %s" / ERR_ZONE_EXPLORED_XP = "Discovered %s: %d experience
 * gained" (GlobalStrings.lua:1603-1604). A max-level character gets experience == 0 and the short
 * form, which is why this is a branch and not one template.
 */
export function explorationMessage(areaName: string, experience: number): string {
  return experience > 0
    ? `Discovered ${areaName}: ${experience} experience gained`
    : `Discovered: ${areaName}`;
}

/** RANDOM_ROLL_RESULT = "%s rolls %d (%d-%d)" (GlobalStrings.lua:2738). */
export function randomRollMessage(name: string, event: RandomRollEvent): string {
  return `${name} rolls ${event.roll} (${event.minimum}-${event.maximum})`;
}

/** ERR_DEATHBIND_SUCCESS_S = "%s is now your home." (GlobalStrings.lua:1262) — %s is the AREA. */
export function bindSuccessMessage(areaName: string): string {
  return `${areaName} is now your home.`;
}

/** GlobalStrings.lua:841; UIParent.lua passes the binder event's arg1 into the `%s` placeholder. */
export function binderConfirmation(location: string): string {
  return `Do you want to make ${location} your new home?`;
}

/** CONFIRM_TALENT_WIPE, GlobalStrings.lua:856 — including the double space after the question. */
export const CONFIRM_TALENT_WIPE =
  'Do you want to unlearn all of your talents?  The cost will increase each time you do it.';
