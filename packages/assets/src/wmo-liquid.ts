export type VanillaWmoLiquid = {
  xverts: number;
  yverts: number;
  xtiles: number;
  ytiles: number;
  corner: [number, number, number];
  heights: Float32Array;
  flags: Uint8Array;
  /** Renderer class: 1 water/river, 2 ocean, 3 magma, 4 slime. */
  type: number;
};

type Chunk = { off: number; size: number };

const reversed = (value: string) => value.split('').reverse().join('');

function findChunk(data: Uint8Array, name: string, start = 0, end = data.length): Chunk | null {
  const signature = reversed(name);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let offset = start; offset + 8 <= end; offset++) {
    if (
      data[offset] !== signature.charCodeAt(0)
      || data[offset + 1] !== signature.charCodeAt(1)
      || data[offset + 2] !== signature.charCodeAt(2)
      || data[offset + 3] !== signature.charCodeAt(3)
    ) continue;
    const size = dv.getUint32(offset + 4, true);
    if (offset + 8 + size <= end) return { off: offset + 8, size };
  }
  return null;
}

function liquidClass(rootFlags: number, groupFlags: number, groupLiquidType: number, flags: Uint8Array): number {
  // This is the Vanilla vMaNGOS extractor's conversion from the raw group liquid entry to the four
  // renderer families. Older roots store an index offset by one; roots with MOHD flag 0x4 store the
  // entry directly. A zero entry falls back to the first enabled MLIQ tile's low nibble.
  let entry = (rootFlags & 0x4) !== 0
    ? groupLiquidType
    : groupLiquidType === 15
      ? 0
      : groupLiquidType + 1;
  if (!entry) {
    const firstWet = flags.find((value) => (value & 0x0f) !== 0x0f);
    if (firstWet !== undefined) entry = (firstWet & 0x0f) + 1;
  }
  if (entry > 0 && entry < 21) {
    switch ((entry - 1) & 3) {
      case 0: return (groupFlags & 0x80000) !== 0 ? 2 : 1;
      case 1: return 2;
      case 2: return 3;
      case 3: return 4;
    }
  }
  // Vanilla vMaNGOS preserves these special liquid IDs after extraction.
  if (entry === 21) return 4;
  if (entry === 41 || entry === 61) return 1;
  return 1;
}

/**
 * Parse a Build 5875 WMO group's raw MLIQ chunk.
 *
 * Layout is byte-checked against the local 1.12.1 MPQs and matches vMaNGOS's Vanilla extractor:
 * 30-byte header, xverts*yverts 8-byte vertices (height at +4), then one flag byte per liquid tile.
 */
export function readVanillaWmoLiquid(data: Uint8Array, rootFlags: number): VanillaWmoLiquid | null {
  const mogp = findChunk(data, 'MOGP');
  if (!mogp || mogp.size < 68) return null;
  const groupEnd = mogp.off + mogp.size;
  const mliq = findChunk(data, 'MLIQ', mogp.off + 68, groupEnd);
  if (!mliq || mliq.size < 30) return null;

  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const xverts = dv.getInt32(mliq.off, true);
  const yverts = dv.getInt32(mliq.off + 4, true);
  const xtiles = dv.getInt32(mliq.off + 8, true);
  const ytiles = dv.getInt32(mliq.off + 12, true);
  if (
    xverts <= 0 || yverts <= 0 || xtiles <= 0 || ytiles <= 0
    || xverts !== xtiles + 1 || yverts !== ytiles + 1
    || xverts > 4096 || yverts > 4096
  ) {
    throw new Error(`invalid Vanilla MLIQ dimensions ${xverts}x${yverts} verts / ${xtiles}x${ytiles} tiles`);
  }

  const vertexCount = xverts * yverts;
  const tileCount = xtiles * ytiles;
  const expected = 30 + vertexCount * 8 + tileCount;
  if (expected > mliq.size) {
    throw new Error(`truncated Vanilla MLIQ chunk: need ${expected}, have ${mliq.size}`);
  }

  const corner: [number, number, number] = [
    dv.getFloat32(mliq.off + 16, true),
    dv.getFloat32(mliq.off + 20, true),
    dv.getFloat32(mliq.off + 24, true),
  ];
  const heights = new Float32Array(vertexCount);
  const verticesAt = mliq.off + 30;
  for (let index = 0; index < vertexCount; index++) {
    heights[index] = dv.getFloat32(verticesAt + index * 8 + 4, true);
  }
  const flagsAt = verticesAt + vertexCount * 8;
  const flags = data.slice(flagsAt, flagsAt + tileCount);
  if (!flags.some((value) => (value & 0x0f) !== 0x0f)) return null;

  const groupLiquidType = dv.getUint32(mogp.off + 0x34, true);
  const groupFlags = dv.getUint32(mogp.off + 0x08, true);
  return {
    xverts,
    yverts,
    xtiles,
    ytiles,
    corner,
    heights,
    flags,
    type: liquidClass(rootFlags, groupFlags, groupLiquidType, flags),
  };
}
