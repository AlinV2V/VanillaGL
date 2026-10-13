/** Asset conversion utility. */
export const M2_PARTICLE_STRIDE = 0x1f8;
export const M2_RIBBON_STRIDE = 0xdc;
const M2_TRACK_SIZE = 0x1c;

/**
 * `enabledIn` — the emitter's authored on/off timeline, and the final field of the struct.
 *
 * Located by scanning every 4-byte-aligned tail offset for a well-formed M2Track across the
 * whole spell-model corpus (tools/probe-spell-model-timing.ts):
 *   0x1dc scores 864/864 particles plausible with 471 animated; no other tail offset has a
 *   single animated hit. 0x1dc + M2_TRACK_SIZE == 0x1f8 == M2_PARTICLE_STRIDE exactly, so the
 *   track closes the struct with no slack.
 * Contents are a step track of uint8 values: across 1777 keys the only values present are
 * 0 (770) and 1 (1007), interpolation is 0, and timestamps are plain milliseconds — e.g.
 * ArcaneExplosion_Impact_Chest emitters 1-3 are keyed on at 1000ms and off at 1200-1300ms.
 */
export const M2_PARTICLE_ENABLED_TRACK = 0x1dc;

const PARTICLE_ARRAY_HDR = 0x13c; // (count, ofs) into the MD20 header
const RIBBON_ARRAY_HDR = 0x134;
const BONES_HDR = 0x34;
const TEXTURES_HDR = 0x5c;
const TEXTURE_LOOKUP_HDR = 0x94;

export interface M2EmitterTrack {
  interpolation: number;
  globalSequence: number;
  ranges: [number, number][];
  timestamps: number[]; // ms
  values: number[]; // flattened by `components`
  components: number;
}

export interface VanillaM2ParticleEmitter {
  id: number;
  flags: number;
  position: [number, number, number];
  bone: number;
  textureIndex: number; // resolved through the model's textureLookup table
  blendType: number; // 0 opaque · 1 alphaKey · 2 alpha · 3 noAlphaAdd · 4 add · 5 mod · 6 mod2x
  emitterType: number; // 1 plane · 2 sphere · 3 spline (0 = legacy/none seen in some vanilla files)
  colorReplaceId: number;
  rows: number; // flipbook grid
  cols: number;
  // Emission parameters — first/representative value of each (mostly-constant) track.
  emissionSpeed: number; // yards/sec
  speedVariation: number;
  verticalRange: number; // radians
  horizontalRange: number; // radians
  gravity: number; // yards/sec^2
  lifespan: number; // seconds
  emissionRate: number; // particles/sec
  emissionAreaLength: number;
  emissionAreaWidth: number;
  zSource: number;
  /** Normalized lifetime split used by the three authored color/scale keys. */
  midpoint: number;
  /** Vanilla v256 stores three inline BGRA lifetime keys, converted here to RGBA 0..1. */
  colors: [[number, number, number, number], [number, number, number, number], [number, number, number, number]];
  /** Three inline billboard-size keys sampled at 0, midpoint, and 1. */
  scales: [number, number, number];
  /** Inclusive head/tail atlas-cell ranges from the old particle layout. */
  headCells: [number, number];
  tailCells: [number, number];
  tailLength: number;
  twinkleSpeed: number;
  twinklePercent: number;
  twinkleScale: [number, number];
  /** Squirt/burst multiplier and exponential velocity drag. */
  burstMultiplier: number;
  drag: number;
  // Raw emission tracks (in order) kept for later keyframe animation.
  emissionTracks: M2EmitterTrack[];
  /**
   * The authored on/off track (`enabledIn`) — the LAST field of the particle struct.
   * See M2_PARTICLE_ENABLED_TRACK below for the byte proof.
   */
  enabledTrack: M2EmitterTrack;
}

export interface VanillaM2RibbonEmitter {
  id: number;
  bone: number;
  position: [number, number, number];
  textureIndices: number[];
  materialIndices: number[];
  color: [number, number, number]; // first colorTrack value (RGB 0..1)
  alpha: number; // first alphaTrack value (0..1)
  above: number; // heightAbove first value
  below: number; // heightBelow first value
  edgesPerSecond: number;
  edgeLifetime: number; // seconds
  gravity: number;
  rows: number;
  cols: number;
}

export interface M2Emitters {
  particles: VanillaM2ParticleEmitter[];
  ribbons: VanillaM2RibbonEmitter[];
}

export interface M2EmitterTiming {
  globalSequences: number[];
  sequences: Array<{ id: number; timeStart: number; timeEnd: number; duration: number }>;
}

class Cursor {
  readonly data: Uint8Array;
  readonly dv: DataView;
  readonly len: number;
  constructor(data: Uint8Array) {
    this.data = data;
    this.dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.len = data.byteLength;
  }
  u16(o: number) { return this.dv.getUint16(o, true); }
  i16(o: number) { return this.dv.getInt16(o, true); }
  u32(o: number) { return this.dv.getUint32(o, true); }
  i32(o: number) { return this.dv.getInt32(o, true); }
  f32(o: number) { return this.dv.getFloat32(o, true); }
  arr(o: number) { return { count: this.u32(o), ofs: this.u32(o + 4) }; }

  u16Array(o: number): number[] {
    const { count, ofs } = this.arr(o);
    if (count <= 0 || count > 4096 || ofs + count * 2 > this.len) return [];
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(this.u16(ofs + i * 2));
    return out;
  }
  u32Array(o: number): number[] {
    const { count, ofs } = this.arr(o);
    if (count <= 0 || count > 200_000 || ofs + count * 4 > this.len) return [];
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(this.u32(ofs + i * 4));
    return out;
  }

  rangeArray(o: number): [number, number][] {
    const { count, ofs } = this.arr(o);
    if (count <= 0 || count > 4096 || ofs + count * 8 > this.len) return [];
    const out: [number, number][] = [];
    for (let i = 0; i < count; i++) out.push([this.u32(ofs + i * 8), this.u32(ofs + i * 8 + 4)]);
    return out;
  }

  /** Read an M2Track at `off`. `kind`: float (4B), fixed16 (uint16/32767 -> 0..1), or uint8 (1B). */
  track(off: number, components: number, kind: 'float' | 'fixed16' | 'uint8'): M2EmitterTrack {
    const interpolation = this.u16(off);
    const globalSequence = this.i16(off + 2);
    const ranges = this.rangeArray(off + 0x04);
    const timestamps = this.u32Array(off + 0x0c);
    const valHdr = this.arr(off + 0x14);
    const values: number[] = [];
    const bpv = kind === 'float' ? 4 : kind === 'fixed16' ? 2 : 1;
    if (valHdr.count > 0 && valHdr.count < 200_000 && valHdr.ofs + valHdr.count * components * bpv <= this.len) {
      for (let i = 0; i < valHdr.count; i++) {
        for (let c = 0; c < components; c++) {
          const o = valHdr.ofs + (i * components + c) * bpv;
          if (kind === 'float') values.push(this.f32(o));
          else if (kind === 'fixed16') values.push(this.u16(o) / 32767);
          else values.push(this.data[o]);
        }
      }
    }
    return { interpolation, globalSequence, ranges, timestamps, values, components };
  }
}

const first = (t: M2EmitterTrack, fallback = 0): number => (t.values.length ? t.values[0] : fallback);

/** Resolve a packed particle texture index (low 5 bits) through the model textureLookup table. */
function resolveTexture(c: Cursor, packed: number): number {
  const lookup = c.u16Array(TEXTURE_LOOKUP_HDR);
  const idx = packed & 0x1f;
  return lookup[idx] ?? idx;
}

/**
 * Read just the M2 textures block (index -> embedded type-0 filename), independent of geometry.
 * Spell effect models are often pure-emitter with zero vertices, so readVanillaM2 throws on them;
 * emitters still need their texture filenames. Textures: M2Array @0x5c, 16B each
 * { type:u32, flags:u32, nFilename:u32, ofsFilename:u32 }; type 0 => filename embedded.
 */
export function readM2TextureFilenames(data: Uint8Array): string[] {
  if (data.length < 0x64) return [];
  const c = new Cursor(data);
  if (String.fromCharCode(data[0], data[1], data[2], data[3]) !== 'MD20') return [];
  const { count, ofs } = c.arr(0x5c);
  if (count <= 0 || count > 256 || ofs + count * 16 > data.length) return [];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = ofs + i * 16;
    const type = c.u32(t);
    const nFn = c.u32(t + 8);
    const ofsFn = c.u32(t + 12);
    let filename = '';
    if (type === 0 && nFn > 0 && ofsFn + nFn <= data.length) {
      let end = ofsFn;
      while (end < ofsFn + nFn && data[end] !== 0) end++;
      filename = new TextDecoder('latin1').decode(data.subarray(ofsFn, end));
    }
    out.push(filename);
  }
  return out;
}

export function readM2Emitters(data: Uint8Array): M2Emitters {
  const result: M2Emitters = { particles: [], ribbons: [] };
  if (data.length < 0x150) return result;
  const c = new Cursor(data);
  if (String.fromCharCode(data[0], data[1], data[2], data[3]) !== 'MD20') return result;

  const nBones = c.u32(BONES_HDR);
  const nTextures = c.u32(TEXTURES_HDR);

  // ---- Particles ----
  const pArr = c.arr(PARTICLE_ARRAY_HDR);
  if (pArr.count > 0 && pArr.count < 4096 && pArr.ofs + pArr.count * M2_PARTICLE_STRIDE <= data.length) {
    for (let i = 0; i < pArr.count; i++) {
      const b = pArr.ofs + i * M2_PARTICLE_STRIDE;
      const emissionTracks: M2EmitterTrack[] = [];
      for (let t = 0; t < 10; t++) emissionTracks.push(c.track(b + 0x34 + t * M2_TRACK_SIZE, 1, 'float'));
      const [
        emissionSpeed, speedVariation, verticalRange, horizontalRange, gravity,
        lifespan, emissionRate, emissionAreaLength, emissionAreaWidth, zSource,
      ] = emissionTracks.map((t) => first(t));
      const rawTex = c.i16(b + 0x16);
      const colorAt = (offset: number): [number, number, number, number] => [
        data[b + offset + 2] / 255,
        data[b + offset + 1] / 255,
        data[b + offset] / 255,
        data[b + offset + 3] / 255,
      ];
      result.particles.push({
        id: c.i32(b),
        flags: c.u32(b + 0x04),
        position: [c.f32(b + 0x08), c.f32(b + 0x0c), c.f32(b + 0x10)],
        bone: c.i16(b + 0x14),
        textureIndex: Math.min(resolveTexture(c, rawTex), Math.max(0, nTextures - 1)),
        // Offsets verified by corpus byte-distribution (tools/verify-emitter-parse.ts):
        // blend@0x28 {1,2,4}, emitterType@0x2a {1 plane,2 sphere,3 spline}, colorIdx@0x2c, grid@0x30/0x32.
        blendType: data[b + 0x28],
        emitterType: data[b + 0x2a],
        colorReplaceId: c.i16(b + 0x2c),
        rows: c.i16(b + 0x30),
        cols: c.i16(b + 0x32),
        emissionSpeed, speedVariation, verticalRange, horizontalRange, gravity,
        lifespan, emissionRate, emissionAreaLength, emissionAreaWidth, zSource,
        // Old-particle inline life data begins immediately after the ten 0x1c emission tracks.
        // Offsets are verified against raw Build-5875 bytes (particle stride 0x1f8).
        midpoint: c.f32(b + 0x14c),
        colors: [colorAt(0x150), colorAt(0x154), colorAt(0x158)],
        scales: [c.f32(b + 0x15c), c.f32(b + 0x160), c.f32(b + 0x164)],
        headCells: [c.u16(b + 0x168), c.u16(b + 0x16a)],
        tailCells: [c.u16(b + 0x16c), c.u16(b + 0x16e)],
        tailLength: c.f32(b + 0x17c),
        twinkleSpeed: c.f32(b + 0x180),
        twinklePercent: c.f32(b + 0x184),
        twinkleScale: [c.f32(b + 0x188), c.f32(b + 0x18c)],
        burstMultiplier: c.f32(b + 0x194),
        drag: c.f32(b + 0x198),
        emissionTracks,
        enabledTrack: c.track(b + M2_PARTICLE_ENABLED_TRACK, 1, 'uint8'),
      });
    }
  }

  // ---- Ribbons ----
  const rArr = c.arr(RIBBON_ARRAY_HDR);
  if (rArr.count > 0 && rArr.count < 4096 && rArr.ofs + rArr.count * M2_RIBBON_STRIDE <= data.length) {
    for (let i = 0; i < rArr.count; i++) {
      const b = rArr.ofs + i * M2_RIBBON_STRIDE;
      const colorTrack = c.track(b + 0x24, 3, 'float');
      const alphaTrack = c.track(b + 0x40, 1, 'fixed16');
      const aboveTrack = c.track(b + 0x5c, 1, 'float');
      const belowTrack = c.track(b + 0x78, 1, 'float');
      result.ribbons.push({
        id: c.i32(b),
        bone: c.i32(b + 0x04),
        position: [c.f32(b + 0x08), c.f32(b + 0x0c), c.f32(b + 0x10)],
        textureIndices: c.u16Array(b + 0x14).map((t) => Math.min(t, Math.max(0, nTextures - 1))),
        materialIndices: c.u16Array(b + 0x1c),
        color: [first(colorTrack, 1), colorTrack.values[1] ?? 1, colorTrack.values[2] ?? 1],
        alpha: first(alphaTrack, 1),
        above: first(aboveTrack),
        below: first(belowTrack),
        edgesPerSecond: c.f32(b + 0x94),
        edgeLifetime: c.f32(b + 0x98),
        gravity: c.f32(b + 0x9c),
        rows: c.i16(b + 0xa0),
        cols: c.i16(b + 0xa2),
      });
    }
  }

  void nBones;
  return result;
}

/** Timelines needed to sample emitter tracks, including on pure-emitter models with zero vertices. */
export function readM2EmitterTiming(data: Uint8Array): M2EmitterTiming {
  const result: M2EmitterTiming = { globalSequences: [], sequences: [] };
  if (data.length < 0x34) return result;
  const c = new Cursor(data);
  if (String.fromCharCode(data[0], data[1], data[2], data[3]) !== 'MD20') return result;
  result.globalSequences = c.u32Array(0x14);
  const { count, ofs } = c.arr(0x1c);
  const stride = 0x44;
  if (count <= 0 || count > 4096 || ofs + count * stride > data.length) return result;
  for (let i = 0; i < count; i++) {
    const base = ofs + i * stride;
    const timeStart = c.u32(base + 0x04);
    const timeEnd = c.u32(base + 0x08);
    result.sequences.push({
      id: c.u16(base),
      timeStart,
      timeEnd,
      duration: Math.max(0, timeEnd - timeStart),
    });
  }
  return result;
}
