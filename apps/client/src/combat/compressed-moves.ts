export type NestedWorldPacket = {
  opcode: number;
  body: Uint8Array;
  recordIndex: number;
};

export type SizedZlibOptions = {
  /** vMaNGOS caps the uncompressed movement buffer below 900,000 bytes. */
  maxInflatedBytes?: number;
  label?: string;
};

const DEFAULT_MAX_INFLATED_BYTES = 900_000;

function readU32LE(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > data.length) throw new Error('missing inflated-size prefix');
  return (
    data[offset]
    | (data[offset + 1] << 8)
    | (data[offset + 2] << 16)
    | (data[offset + 3] << 24)
  ) >>> 0;
}

/**
 * Inflate a vMaNGOS `u32 inflatedSize + zlib-deflate(payload)` body with a hard
 * streaming cap. Checking only after `Response.arrayBuffer()` would still allow
 * a decompression bomb to allocate its entire output before validation.
 */
export async function inflateSizedZlib(
  body: Uint8Array,
  options: SizedZlibOptions = {},
): Promise<Uint8Array> {
  const label = options.label ?? 'compressed packet';
  const maxInflatedBytes = options.maxInflatedBytes ?? DEFAULT_MAX_INFLATED_BYTES;
  if (!Number.isSafeInteger(maxInflatedBytes) || maxInflatedBytes <= 0) {
    throw new Error(`${label}: invalid inflated-size cap ${maxInflatedBytes}`);
  }
  if (body.length <= 4) throw new Error(`${label}: missing zlib payload`);

  const expectedSize = readU32LE(body, 0);
  if (expectedSize === 0) throw new Error(`${label}: zero inflated size`);
  if (expectedSize > maxInflatedBytes) {
    throw new Error(`${label}: inflated size ${expectedSize} exceeds cap ${maxInflatedBytes}`);
  }

  const Decompression = (
    globalThis as {
      DecompressionStream?: new (format: string) => GenericTransformStream;
    }
  ).DecompressionStream;
  if (!Decompression) throw new Error(`${label}: DecompressionStream('deflate') is unavailable`);

  const stream = new Blob([body.slice(4)])
    .stream()
    .pipeThrough(new Decompression('deflate'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maxInflatedBytes || total > expectedSize) {
        await reader.cancel(`${label}: inflated output exceeded declared/capped size`);
        throw new Error(
          `${label}: inflated output exceeded ${Math.min(maxInflatedBytes, expectedSize)} bytes`,
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  if (total !== expectedSize) {
    throw new Error(`${label}: inflated size mismatch: expected ${expectedSize}, got ${total}`);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Exact Build-5875/vMaNGOS SMSG_COMPRESSED_MOVES payload:
 *
 *   u32 inflatedSize
 *   zlib-deflate(repeated { u8 recordSize; u16 nestedOpcode;
 *                           u8 nestedBody[recordSize - 2]; })
 */
export async function decodeCompressedMoves(
  body: Uint8Array,
  options: SizedZlibOptions = {},
): Promise<NestedWorldPacket[]> {
  const inflated = await inflateSizedZlib(body, {
    ...options,
    label: options.label ?? 'SMSG_COMPRESSED_MOVES',
  });
  const packets: NestedWorldPacket[] = [];
  let offset = 0;
  let recordIndex = 0;
  while (offset < inflated.length) {
    const recordOffset = offset;
    const recordSize = inflated[offset++];
    if (recordSize < 2) {
      throw new Error(
        `SMSG_COMPRESSED_MOVES: record ${recordIndex} at ${recordOffset} has size ${recordSize} (< 2)`,
      );
    }
    const recordEnd = offset + recordSize;
    if (recordEnd > inflated.length) {
      throw new Error(
        `SMSG_COMPRESSED_MOVES: record ${recordIndex} at ${recordOffset} is truncated `
        + `(needs ${recordSize} bytes, has ${inflated.length - offset})`,
      );
    }
    const opcode = inflated[offset] | (inflated[offset + 1] << 8);
    offset += 2;
    packets.push({
      opcode,
      body: inflated.slice(offset, recordEnd),
      recordIndex,
    });
    offset = recordEnd;
    recordIndex++;
  }
  if (offset !== inflated.length) {
    // Kept as an explicit invariant even though the loop above can only end on
    // equality; it prevents a future parser rewrite from silently accepting a tail.
    throw new Error(
      `SMSG_COMPRESSED_MOVES: trailing malformed bytes at ${offset}/${inflated.length}`,
    );
  }
  return packets;
}
