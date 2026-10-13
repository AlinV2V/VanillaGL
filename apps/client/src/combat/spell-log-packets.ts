import type { Reader } from '../world/wire.ts';

type ByteReader = Reader & { bytes(length: number): Uint8Array };

const rawGuidHex = (bytes: Uint8Array): string => Array.from(bytes)
  .reverse()
  .map((byte) => byte.toString(16).padStart(2, '0'))
  .join('');

/** vMaNGOS Spell.cpp writes SMSG_SPELL_DELAYED as raw ObjectGuid + uint32 delay. */
export function decodeSpellDelayedPayload<R extends ByteReader>(reader: R) {
  return { casterGuid: rawGuidHex(reader.bytes(8)), delayMs: reader.u32() };
}

export type PeriodicAuraPayload = {
  amount: number;
  school?: number;
  absorb?: number;
  resist?: number;
  powerType?: number;
};

/** Decode one SMSG_PERIODICAURALOG entry after its auraType field. */
export function decodePeriodicAuraPayload<R extends Reader>(reader: R, auraType: number): PeriodicAuraPayload | undefined {
  if (auraType === 3 || auraType === 89) {
    return { amount: reader.u32(), school: reader.u32(), absorb: reader.u32(), resist: reader.i32() };
  }
  if (auraType === 8 || auraType === 20) return { amount: reader.u32() };
  if (auraType === 21 || auraType === 24 || auraType === 64) {
    const payload = { powerType: reader.u32(), amount: reader.u32() };
    if (auraType === 64) reader.f32(); // gain multiplier
    return payload;
  }
  return undefined;
}
