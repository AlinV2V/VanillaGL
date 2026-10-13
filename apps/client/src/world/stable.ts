/** Asset conversion utility. */
import type { ReadGuid, Reader } from './wire';

/**
 * One row of MSG_LIST_STABLED_PETS. NOTE the wire slot numbering: the server sends the pet that is
 * currently OUT as slot 1 (`uint8(0x01)`, NPCHandler.cpp:545) and stable slots 1..2 as 2..3
 * (`uint8(it->slot + 1)`, :568). Consumers must subtract 1 to get a UI slot.
 */
export type StabledPet = {
  slot: number;
  petNumber: number;
  entry: number;
  level: number;
  name: string;
  loyalty: number;
};

export type StableState = {
  guid: string;
  /** `Player::m_stableSlots` — purchased slots. Capped at MAX_PET_STABLES (Objects/Pet.h:37). */
  stableSlots: number;
  pets: StabledPet[];
};

/**
 * `StableResultCode`, NPCHandler.cpp:40-48. These five are the only codes the 1.12 stable path
 * emits. GlobalStrings.lua ships NO ERR_STABLE_* entries — the only stable strings vanilla has are
 * EMPTY_STABLE_SLOT / STABLED_PETS / STABLES / STABLE_SLOT_TEXT — so the text below is ours and is
 * NOT a citation. Only the codes are authoritative.
 */
export const STABLE_RESULT_MESSAGES: Readonly<Record<number, string>> = {
  0x01: "You don't have enough money.", // STABLE_ERR_MONEY
  0x06: 'You cannot do that right now.', // STABLE_ERR_STABLE — generic failure
  0x08: 'Pet stabled.',                  // STABLE_SUCCESS_STABLE
  0x09: 'Pet called from the stable.',   // STABLE_SUCCESS_UNSTABLE (also swap)
  0x0a: 'Stable slot purchased.',        // STABLE_SUCCESS_BUY_SLOT
};

/** The three codes that mutate the listing and therefore require a re-request. */
export const STABLE_SUCCESS_CODES = [0x08, 0x09, 0x0a];

/**
 * MSG_LIST_STABLED_PETS body: u64 npcGuid, u8 petCount, u8 stableSlots, then per pet
 * u32 petNumber, u32 entry, u32 level, cstring name, u32 loyalty, u8 slot.
 * The slot byte comes LAST, after the name — not with the other numeric fields.
 */
export function readStabledPets<R extends Reader>(r: R, readGuid: ReadGuid<R>): StableState {
  const guid = readGuid(r);
  const count = r.u8();
  const stableSlots = r.u8();
  const pets: StabledPet[] = [];
  for (let i = 0; i < count; i++) {
    const petNumber = r.u32();
    const entry = r.u32();
    const level = r.u32();
    const name = r.cstring();
    const loyalty = r.u32();
    pets.push({ slot: r.u8(), petNumber, entry, level, name, loyalty });
  }
  return { guid, stableSlots, pets };
}
