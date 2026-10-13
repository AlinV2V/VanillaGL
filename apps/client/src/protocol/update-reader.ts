const guidHex = (bytes: Uint8Array) => Array.from(bytes)
  .reverse()
  .map((byte) => byte.toString(16).padStart(2, '0'))
  .join('');

/** Bounds-checked little-endian reader for SMSG_UPDATE_OBJECT payloads. */
export class UpdateReader {
  offset = 0;

  constructor(private readonly data: Uint8Array) {}

  get remaining() { return this.data.length - this.offset; }

  ensure(length: number) {
    if (this.offset + length > this.data.length) {
      throw new Error(`truncated at ${this.offset}, need ${length}, have ${this.data.length - this.offset}`);
    }
  }

  u8() { this.ensure(1); return this.data[this.offset++]; }

  u32() {
    this.ensure(4);
    const value = this.data[this.offset]
      | (this.data[this.offset + 1] << 8)
      | (this.data[this.offset + 2] << 16)
      | (this.data[this.offset + 3] << 24);
    this.offset += 4;
    return value >>> 0;
  }

  i32() { const value = this.u32(); return value > 0x7fffffff ? value - 0x100000000 : value; }

  f32() {
    this.ensure(4);
    const value = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 4).getFloat32(0, true);
    this.offset += 4;
    return value;
  }

  guid() {
    this.ensure(8);
    const bytes = this.data.slice(this.offset, this.offset + 8);
    this.offset += 8;
    return guidHex(bytes);
  }

  peekHex(length = 32) {
    return Array.from(this.data.slice(this.offset, Math.min(this.data.length, this.offset + length)))
      .map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
  }
}
