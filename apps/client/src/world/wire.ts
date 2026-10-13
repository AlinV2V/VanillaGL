/** Asset conversion utility. */
/** The subset of `world.ts`'s `Reader` a domain parser is allowed to use. */
export type Reader = {
  readonly remaining: number;
  u8(): number;
  u16(): number;
  u32(): number;
  i32(): number;
  f32(): number;
  bytes(length: number): Uint8Array;
  cstring(): string;
};

/** Byte encoders supplied by `world.ts`, so packet encoding has exactly one implementation. */
export type WireCodec = {
  u32(value: number): Uint8Array;
  cstring(value: string): Uint8Array;
  /** Little-endian 8-byte GUID from the hex form used throughout the client. */
  guid(hex: string): Uint8Array;
  concat(...parts: Uint8Array[]): Uint8Array;
};

/**
 * Reads a raw little-endian u64 GUID. Generic over the reader so that `world.ts`'s concrete
 * `Reader` class (which has private members, and so is not assignable to the structural type
 * above) can be passed straight through.
 */
export type ReadGuid<R extends Reader = Reader> = (r: R) => string;
