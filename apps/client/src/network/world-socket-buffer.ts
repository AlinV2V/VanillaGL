export const MAX_UNPARSED_WORLD_BYTES = 16 * 1024 * 1024;
export const MAX_QUEUED_WORLD_PACKETS = 4096;
export const MAX_QUEUED_WORLD_PACKET_BYTES = 32 * 1024 * 1024;

/** Chunked receive storage: bytes are copied once when consumed, never on every WebSocket frame. */
export class ChunkedReceiveBuffer {
  private readonly chunks: Uint8Array[] = [];
  private headIndex = 0;
  private headOffset = 0;
  private bytes = 0;

  constructor(readonly maxBytes = MAX_UNPARSED_WORLD_BYTES) {}

  get length(): number { return this.bytes; }

  append(chunk: Uint8Array): void {
    if (!chunk.length) return;
    if (this.bytes + chunk.length > this.maxBytes) {
      throw new Error(`world receive buffer exceeded ${this.maxBytes} bytes`);
    }
    this.chunks.push(chunk);
    this.bytes += chunk.length;
  }

  read(length: number): Uint8Array | null {
    if (!Number.isInteger(length) || length < 0) throw new Error(`invalid receive read length ${length}`);
    if (length > this.bytes) return null;
    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const head = this.chunks[this.headIndex]!;
      const available = head.length - this.headOffset;
      const count = Math.min(available, length - written);
      result.set(head.subarray(this.headOffset, this.headOffset + count), written);
      written += count;
      this.headOffset += count;
      this.bytes -= count;
      if (this.headOffset === head.length) {
        this.headIndex++;
        this.headOffset = 0;
      }
    }
    if (this.headIndex > 1024 && this.headIndex * 2 >= this.chunks.length) {
      this.chunks.splice(0, this.headIndex);
      this.headIndex = 0;
    }
    return result;
  }

  clear(): void {
    this.chunks.length = 0;
    this.headIndex = 0;
    this.headOffset = 0;
    this.bytes = 0;
  }
}

/** Count- and byte-bounded decoded packet queue used when no packet reader is waiting. */
export class BoundedPacketQueue<T> {
  private readonly values: Array<{ value: T; bytes: number }> = [];
  private headIndex = 0;
  private bytes = 0;

  constructor(
    readonly maxCount = MAX_QUEUED_WORLD_PACKETS,
    readonly maxBytes = MAX_QUEUED_WORLD_PACKET_BYTES,
  ) {}

  get length(): number { return this.values.length - this.headIndex; }
  get byteLength(): number { return this.bytes; }

  push(value: T, bytes: number): void {
    const normalizedBytes = Math.max(0, bytes | 0);
    if (this.length + 1 > this.maxCount || this.bytes + normalizedBytes > this.maxBytes) {
      throw new Error(
        `world packet queue overflow: ${this.length + 1}/${this.maxCount} packets, `
        + `${this.bytes + normalizedBytes}/${this.maxBytes} bytes`,
      );
    }
    this.values.push({ value, bytes: normalizedBytes });
    this.bytes += normalizedBytes;
  }

  shift(): T | undefined {
    if (this.headIndex >= this.values.length) return undefined;
    const entry = this.values[this.headIndex++];
    this.bytes = Math.max(0, this.bytes - entry.bytes);
    if (this.headIndex >= this.values.length) {
      this.values.length = 0;
      this.headIndex = 0;
    } else if (this.headIndex >= 1024 && this.headIndex * 2 >= this.values.length) {
      this.values.splice(0, this.headIndex);
      this.headIndex = 0;
    }
    return entry.value;
  }

  clear(): void {
    this.values.length = 0;
    this.headIndex = 0;
    this.bytes = 0;
  }
}
