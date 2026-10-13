/** Asset conversion utility. */
import type { ReadGuid, Reader, WireCodec } from './wire';

/**
 * SMSG_PETITION_SHOWLIST row (Packets/Petition.cpp:110-124). vMaNGOS notes the 1.12 client only
 * ever renders ONE entry, and `entryFlags & 1` is what makes a row visible at all.
 */
export type PetitionCharterOffer = {
  index: number;
  charterEntry: number;
  charterDisplayId: number;
  cost: number;
  flags: number;
};

export type PetitionVendorState = { guid: string; offers: PetitionCharterOffer[] };

/**
 * A charter being signed or reviewed. `signatures` comes from SMSG_PETITION_SHOW_SIGNATURES:
 * u64 itemGuid, u64 ownerGuid, u32 petitionGuid, u8 count, then count x (u64 signerGuid, u32 0)
 * — PetitionsHandler.cpp:160-168 with the block itself in GuildMgr.cpp:358-365.
 */
export type PetitionState = {
  itemGuid: string;
  ownerGuid: string;
  petitionGuid: number;
  /** From SMSG_PETITION_QUERY_RESPONSE, once it arrives. */
  name?: string;
  signatures: string[];
  requiredSignatures: number;
};

/**
 * vMaNGOS refuses a turn-in below this (`if (signs >= 9)`, PetitionsHandler.cpp:270) and reports
 * the same number as `minSignatures` in the query response (:182). The client agrees:
 * `MAX_PETITION_SIGNATURES = 9` (PetitionFrame.lua:1) — display equals storage here.
 */
export const PETITION_REQUIRED_SIGNATURES = 9;

/** ObjectMgr guild-name validation caps at 24 characters. */
export const MAX_GUILD_NAME_LENGTH = 24;

/**
 * `PetitionSigns` (Guild/Guild.h:146-154) with the matching ERR_PETITION_* text from
 * GlobalStrings.lua:1449-1456. Code 5 (PETITION_SIGN_NOT_SERVER) has no vanilla string.
 */
export const PETITION_SIGN_MESSAGES: Readonly<Record<number, string>> = {
  0: 'Guild charter signed.',
  1: 'You have already signed that guild charter.',
  2: 'You are already in a guild.',
  3: "You can't sign your own guild charter.",
  4: 'You need more signatures.',
};

/** SMSG_TURN_IN_PETITION_RESULTS reuses PetitionSigns (PetitionsHandler.cpp:427/438/473). */
export const PETITION_TURN_IN_MESSAGES: Readonly<Record<number, string>> = {
  0: 'Guild charter accepted.',
  2: 'You are already in a guild.',
  4: 'You need more signatures.',
};

/** SMSG_PETITION_SHOWLIST: u64 npcGuid, u8 count, then count rows. Invisible rows are dropped. */
export function readPetitionShowList<R extends Reader>(r: R, readGuid: ReadGuid<R>): PetitionVendorState {
  const guid = readGuid(r);
  const count = r.u8();
  const offers: PetitionCharterOffer[] = [];
  for (let i = 0; i < count; i++) {
    offers.push({
      index: r.u32(),
      charterEntry: r.u32(),
      charterDisplayId: r.u32(),
      cost: r.i32(),
      flags: r.i32(),
    });
  }
  return { guid, offers: offers.filter((offer) => (offer.flags & 1) !== 0) };
}

/** SMSG_PETITION_SHOW_SIGNATURES. Each signature is a u64 guid followed by a u32 that is always 0. */
export function readPetitionSignatures<R extends Reader>(r: R, readGuid: ReadGuid<R>): PetitionState {
  const itemGuid = readGuid(r);
  const ownerGuid = readGuid(r);
  const petitionGuid = r.u32();
  const count = r.u8();
  const signatures: string[] = [];
  for (let i = 0; i < count; i++) {
    signatures.push(readGuid(r));
    r.u32();
  }
  return {
    itemGuid, ownerGuid, petitionGuid, signatures,
    requiredSignatures: PETITION_REQUIRED_SIGNATURES,
  };
}

/**
 * CMSG_PETITION_BUY. The 1.12 body is mostly zero padding around two real fields
 * (Packets/Petition.cpp:45-67): u64 npcGuid, u32 0, u64 0, cstring name, TEN u32 zeros, u16 0,
 * u8 0, u32 index, u32 0. The server reads every one of those skips, so the padding is not
 * optional — a short packet desynchronises the stream for everything after it.
 */
export const PETITION_BUY_U32_PADDING = 10;

export function buildPetitionBuy(
  codec: WireCodec, npcGuid: string, name: string, index: number,
): Uint8Array {
  return codec.concat(
    codec.guid(npcGuid),
    codec.u32(0),
    new Uint8Array(8),
    codec.cstring(name.trim().slice(0, MAX_GUILD_NAME_LENGTH)),
    ...Array.from({ length: PETITION_BUY_U32_PADDING }, () => codec.u32(0)),
    new Uint8Array(2), // u16 0
    new Uint8Array(1), // u8 0
    codec.u32(index),
    codec.u32(0),
  );
}

/**
 * CMSG_PETITION_SIGN: u64 itemGuid plus one trailing byte the server reads and discards
 * ("argument of /run SignPetition(123) is never used", Packets/Petition.cpp:75).
 */
export function buildPetitionSign(codec: WireCodec, itemGuid: string): Uint8Array {
  return codec.concat(codec.guid(itemGuid), new Uint8Array(1));
}

/** CMSG_PETITION_QUERY: u32 petitionGuid + u64 itemGuid. */
export function buildPetitionQuery(codec: WireCodec, petitionGuid: number, itemGuid: string): Uint8Array {
  return codec.concat(codec.u32(petitionGuid >>> 0), codec.guid(itemGuid));
}

/** CMSG_OFFER_PETITION: u64 itemGuid + u64 targetPlayerGuid. */
export function buildPetitionOffer(codec: WireCodec, itemGuid: string, playerGuid: string): Uint8Array {
  return codec.concat(codec.guid(itemGuid), codec.guid(playerGuid));
}

/** MSG_PETITION_RENAME: u64 itemGuid + cstring newName. */
export function buildPetitionRename(codec: WireCodec, itemGuid: string, newName: string): Uint8Array {
  return codec.concat(codec.guid(itemGuid), codec.cstring(newName.trim().slice(0, MAX_GUILD_NAME_LENGTH)));
}
