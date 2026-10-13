/** Asset conversion utility. */
export interface VanillaM2Texture {
  type: number;
  flags: number;
  filename: string;
}

export interface VanillaM2Submesh {
  partId: number;
  triangleStart: number;
  triangleCount: number;
  textureIndex: number;
  boneCount: number;
  boneComboIndex: number;
  boneInfluences: number;
  centerBoneIndex: number;
  // From the M2 material this submesh's texture unit points at (render flags + blend mode).
  renderFlags: number; // 0x01 unlit, 0x04 two-sided, 0x10 no-z-write
  blendMode: number; // 0 opaque, 1 alpha-key, 2 alpha, 3/4 add, 5 mod, 6 mod2x
  /** Index into `textureTransforms`, or -1 for a static (identity) UV. */
  textureTransform: number;
  /** Direct M2Batch colour index, or -1 when this pass has no animated colour. */
  colorIndex: number;
  /** Resolved M2TextureWeight index, or -1 when this pass has no animated opacity. */
  textureWeight: number;
}

export interface VanillaM2Sequence {
  id: number;
  variationIndex: number;
  timeStart: number;
  timeEnd: number;
  duration: number;
  moveSpeed: number;
  flags: number;
  frequency: number;
  blendTime: number;
}

export interface VanillaM2Track {
  interpolation: number;
  globalSequence: number;
  ranges: [number, number][];
  timestamps: number[];
  values: number[];
  components: number;
}

export interface VanillaM2Bone {
  keyBoneId: number;
  flags: number;
  parentIndex: number;
  pivot: [number, number, number];
  translation: VanillaM2Track;
  rotation: VanillaM2Track;
  scale: VanillaM2Track;
}

export interface VanillaM2Attachment {
  id: number;
  bone: number;
  position: [number, number, number];
}

/**
 * Animated UV transform (M2TextureTransform) — three tracks applied to a texture unit's coords.
 * This is what scrolls waterfalls, portals, force fields and dust devils.
 */
export interface VanillaM2TextureTransform {
  translation: VanillaM2Track; // vec3, .xy used as a UV offset
  rotation: VanillaM2Track; // quat, rotates UV about the .z axis
  scaling: VanillaM2Track; // vec3, .xy used as a UV scale
}

/** Embedded model camera. Type 0 is the unit-portrait camera; type 1 is the character-info camera. */
export interface VanillaM2Camera {
  type: number;
  fov: number;
  farClip: number;
  nearClip: number;
  positionTrack: VanillaM2Track;
  positionBase: [number, number, number];
  targetTrack: VanillaM2Track;
  targetBase: [number, number, number];
  roll: VanillaM2Track;
}

/** Per-pass animated RGB and alpha from the Vanilla M2Color array. */
export interface VanillaM2Color {
  color: VanillaM2Track;
  alpha: VanillaM2Track;
}

export interface VanillaM2Mesh {
  version: number;
  /** Independent looping timelines used by facial/idle bones (blink, gaze, glows). */
  globalSequences: number[];
  vertexCount: number;
  positions: Float32Array; // vertexCount * 3
  normals: Float32Array; // vertexCount * 3
  uvs: Float32Array; // vertexCount * 2
  boneWeights: Uint8Array; // vertexCount * 4, normalized by /255 at render time
  boneIndices: Uint8Array; // vertexCount * 4, global bone indices
  indices: Uint32Array; // triangle list into positions
  /** Dedicated M2 collision shell from bounding_triangles / bounding_vertices. */
  collisionPositions: Float32Array;
  collisionIndices: Uint32Array;
  textures: VanillaM2Texture[];
  sequences: VanillaM2Sequence[];
  animLookup: Int16Array;
  bones: VanillaM2Bone[];
  attachments: VanillaM2Attachment[];
  cameras: VanillaM2Camera[];
  /** Animated UV transforms, referenced by VanillaM2Submesh.textureTransform. */
  textureTransforms: VanillaM2TextureTransform[];
  /** Animated material colours from header slot 0x54. */
  colors: VanillaM2Color[];
  /** Animated transparency tracks from header slot 0x64. */
  textureWeights: VanillaM2Track[];
  // Per-submesh triangle ranges (into `indices`) + which texture each uses. A vanilla
  // doodad is several submeshes (trunk/canopy/...) each with its own texture.
  submeshes: VanillaM2Submesh[];
}

const VERTEX_STRIDE = 48;
const VANILLA_SEQUENCE_STRIDE = 0x44;
const VANILLA_BONE_STRIDE = 0x6c;

function readArrayHeader(u32: (offset: number) => number, offset: number) {
  return { count: u32(offset), offset: u32(offset + 4) };
}

export function readVanillaM2(data: Uint8Array): VanillaM2Mesh {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const magic = String.fromCharCode(data[0], data[1], data[2], data[3]);
  if (magic !== 'MD20') throw new Error(`not an M2 (magic="${magic}")`);
  const version = dv.getUint32(4, true);

  const u32 = (o: number) => dv.getUint32(o, true);
  const u16 = (o: number) => dv.getUint16(o, true);
  const i16 = (o: number) => dv.getInt16(o, true);
  const i32 = (o: number) => dv.getInt32(o, true);
  const f32 = (o: number) => dv.getFloat32(o, true);

  const nVerts = u32(0x44);
  const ofsVerts = u32(0x48);
  const nViews = u32(0x4c);
  const ofsViews = u32(0x50);

  const collisionTriangleHeader = readArrayHeader(u32, 0xec);
  const collisionVertexHeader = readArrayHeader(u32, 0xf4);
  const collisionVertexCount = collisionVertexHeader.count <= 2_000_000
    && collisionVertexHeader.offset + collisionVertexHeader.count * 12 <= data.length ? collisionVertexHeader.count : 0;
  const collisionIndexCount = collisionTriangleHeader.count <= 6_000_000
    && collisionTriangleHeader.offset + collisionTriangleHeader.count * 2 <= data.length ? collisionTriangleHeader.count : 0;
  const collisionPositions = new Float32Array(collisionVertexCount * 3);
  const collisionIndices = new Uint32Array(collisionIndexCount);
  for (let i = 0; i < collisionPositions.length; i++) collisionPositions[i] = f32(collisionVertexHeader.offset + i * 4);
  for (let i = 0; i < collisionIndices.length; i++) collisionIndices[i] = u16(collisionTriangleHeader.offset + i * 2);

  if (nVerts <= 0 || nVerts > 2_000_000 || ofsVerts + nVerts * VERTEX_STRIDE > data.length) {
    throw new Error(`vertex block out of range (n=${nVerts} ofs=${ofsVerts} len=${data.length})`);
  }
  if (nViews <= 0 || ofsViews + 16 > data.length) {
    throw new Error(`view block out of range (n=${nViews} ofs=${ofsViews})`);
  }

  // Vanilla M2 global loops are a plain M2Array<uint32> at header 0x14. Bone tracks whose
  // globalSequence is non-negative use this duration and run independently of the active
  // locomotion/emote sequence (notably the old character models' eyelid blink tracks).
  const globalSequenceHeader = readArrayHeader(u32, 0x14);
  const globalSequences: number[] = [];
  if (
    globalSequenceHeader.count > 0 &&
    globalSequenceHeader.count < 4096 &&
    globalSequenceHeader.offset + globalSequenceHeader.count * 4 <= data.length
  ) {
    for (let i = 0; i < globalSequenceHeader.count; i++) {
      globalSequences.push(u32(globalSequenceHeader.offset + i * 4));
    }
  }

  const positions = new Float32Array(nVerts * 3);
  const normals = new Float32Array(nVerts * 3);
  const uvs = new Float32Array(nVerts * 2);
  const boneWeights = new Uint8Array(nVerts * 4);
  const boneIndices = new Uint8Array(nVerts * 4);
  for (let i = 0; i < nVerts; i++) {
    const o = ofsVerts + i * VERTEX_STRIDE;
    positions[i * 3] = f32(o);
    positions[i * 3 + 1] = f32(o + 4);
    positions[i * 3 + 2] = f32(o + 8);
    for (let j = 0; j < 4; j++) {
      boneWeights[i * 4 + j] = data[o + 12 + j];
      boneIndices[i * 4 + j] = data[o + 16 + j];
    }
    normals[i * 3] = f32(o + 20);
    normals[i * 3 + 1] = f32(o + 24);
    normals[i * 3 + 2] = f32(o + 28);
    uvs[i * 2] = f32(o + 32);
    uvs[i * 2 + 1] = f32(o + 36);
  }

  // View 0 (highest detail): indices (lookup into vertices) + triangles (into lookup).
  const v = ofsViews;
  const nIndex = u32(v);
  const ofsIndex = u32(v + 4);
  const nTris = u32(v + 8);
  const ofsTris = u32(v + 12);

  if (
    ofsIndex + nIndex * 2 > data.length ||
    ofsTris + nTris * 2 > data.length ||
    nTris % 3 !== 0
  ) {
    throw new Error(`view 0 geometry out of range (nIndex=${nIndex} nTris=${nTris})`);
  }

  const lookup = new Uint16Array(nIndex);
  for (let i = 0; i < nIndex; i++) lookup[i] = u16(ofsIndex + i * 2);

  // NOTE: the view's per-vertex "properties" at view+0x10 are GPU-skinning *palette* indices
  // (local to each submesh's boneComboIndex window), NOT global bone ids. The model vertex
  // boneIndices read above (vertex stride +16) are already GLOBAL bone ids — use those directly
  // for CPU skinning. (Overwriting them with the palette bytes detaches limbs.)

  const indices = new Uint32Array(nTris);
  for (let i = 0; i < nTris; i++) indices[i] = lookup[u16(ofsTris + i * 2)];

  // Submeshes (geosets, 32-byte stride): triangleStart@0x08, triangleCount@0x0A (into the
  // view triangle array = our `indices`). Texture units map a submesh to a texture combo.
  // (texLookup is identity for typical doodads, so combo == texture index.)
  const submeshes: VanillaM2Submesh[] = [];
  /** submesh index -> raw texunit +0x16 combo, resolved against the lookup once tracks are readable. */
  const submeshTransformCombo = new Map<number, number>();
  const submeshColorIndex = new Map<number, number>();
  const submeshWeightCombo = new Map<number, number>();
  const nSub = u32(v + 0x18);
  const ofsSub = u32(v + 0x1c);
  const nTexUnit = u32(v + 0x20);
  const ofsTexUnit = u32(v + 0x24);

  const textureLookup: number[] = [];
  const nTextureLookup = u32(0x94);
  const ofsTextureLookup = u32(0x98);
  if (nTextureLookup > 0 && nTextureLookup < 4096 && ofsTextureLookup + nTextureLookup * 2 <= data.length) {
    for (let i = 0; i < nTextureLookup; i++) textureLookup.push(u16(ofsTextureLookup + i * 2));
  }

  // Materials (render flags + blend mode). Vanilla M2Array<M2Material{flags:u16, blendingMode:u16}>
  // @0x84 — verified empirically on character M2s (0x7c is a u16 lookup; 0x84 holds clean values:
  // flags 0x04=two-sided, blend 0=opaque/1=alpha-key). The texture unit (@+0x0a) links submesh->material.
  const materials: { flags: number; blend: number }[] = [];
  const nMat = u32(0x84);
  const ofsMat = u32(0x88);
  if (nMat > 0 && nMat < 1024 && ofsMat + nMat * 4 <= data.length) {
    for (let i = 0; i < nMat; i++) materials.push({ flags: u16(ofsMat + i * 4), blend: u16(ofsMat + i * 4 + 2) });
  }

  if (nSub > 0 && nSub < 1024 && ofsSub + nSub * 0x20 <= data.length) {
    for (let i = 0; i < nSub; i++) {
      const s = ofsSub + i * 0x20;
      submeshes.push({
        partId: u16(s),
        triangleStart: u16(s + 0x08),
        triangleCount: u16(s + 0x0a),
        textureIndex: 0,
        boneCount: u16(s + 0x0c),
        boneComboIndex: u16(s + 0x0e),
        boneInfluences: u16(s + 0x10),
        centerBoneIndex: u16(s + 0x12),
        renderFlags: 0,
        blendMode: 0,
        textureTransform: -1,
        colorIndex: -1,
        textureWeight: -1,
      });
    }
    if (nTexUnit > 0 && ofsTexUnit + nTexUnit * 0x18 <= data.length) {
      // Texture units are ordered by pass: the first unit hitting a submesh is the opaque
      // diffuse base (pass 0); later units on the same submesh are secondary shine/envmap
      // overlays (additive). Letting a later unit overwrite the submesh promoted opaque
      // blades to additive blend — the semi-transparent-weapon bug in single-pass bakes.
      const submeshAssigned = new Set<number>();
      for (let i = 0; i < nTexUnit; i++) {
        const t = ofsTexUnit + i * 0x18;
        const sub = u16(t + 0x04);
        const textureComboIndex = u16(t + 0x10);
        const textureIndex = textureLookup[textureComboIndex] ?? textureComboIndex;
        if (sub < submeshes.length && !submeshAssigned.has(sub)) {
          submeshAssigned.add(sub);
          submeshes[sub].textureIndex = textureIndex;
          const mat = materials[u16(t + 0x0a)]; // material index lives at texunit +0x0a
          if (mat) {
            submeshes[sub].renderFlags = mat.flags;
            submeshes[sub].blendMode = mat.blend;
          }
          // Animated UV: texunit +0x16 indexes the transform LOOKUP (0xAC), which indexes the
          // transform array (0x74). Both offsets recovered empirically, not assumed — see
          // tools/probe-m2-texanim.ts / probe-m2-texanim2.ts. Resolved below, once readTrack exists.
          submeshTransformCombo.set(sub, u16(t + 0x16));
          submeshColorIndex.set(sub, i16(t + 0x08));
          submeshWeightCombo.set(sub, u16(t + 0x14));
        }
      }
    }
  }

  // Textures: M2Array<M2Texture> at 0x5C (count) / 0x60 (offset). Each M2Texture is
  // 16 bytes { type:u32, flags:u32, nFilename:u32, ofsFilename:u32 }. type 0 = the
  // filename is embedded (doodads); other types are runtime-supplied (body/skin).
  const textures: VanillaM2Texture[] = [];
  const nTextures = u32(0x5c);
  const ofsTextures = u32(0x60);
  if (nTextures > 0 && nTextures < 256 && ofsTextures + nTextures * 16 <= data.length) {
    for (let i = 0; i < nTextures; i++) {
      const t = ofsTextures + i * 16;
      const type = u32(t);
      const nFn = u32(t + 8);
      const ofsFn = u32(t + 12);
      let filename = '';
      if (type === 0 && nFn > 0 && ofsFn + nFn <= data.length) {
        let end = ofsFn;
        const max = ofsFn + nFn;
        while (end < max && data[end] !== 0) end++;
        filename = new TextDecoder('latin1').decode(data.subarray(ofsFn, end));
      }
      textures.push({ type, flags: u32(t + 4), filename });
    }
  }

  const sequences: VanillaM2Sequence[] = [];
  const seq = readArrayHeader(u32, 0x1c);
  if (seq.count > 0 && seq.count < 4096 && seq.offset + seq.count * VANILLA_SEQUENCE_STRIDE <= data.length) {
    for (let i = 0; i < seq.count; i++) {
      const o = seq.offset + i * VANILLA_SEQUENCE_STRIDE;
      const timeStart = u32(o + 0x04);
      const timeEnd = u32(o + 0x08);
      sequences.push({
        id: u16(o),
        variationIndex: u16(o + 0x02),
        timeStart,
        timeEnd,
        duration: Math.max(0, timeEnd - timeStart),
        moveSpeed: f32(o + 0x0c),
        flags: u32(o + 0x10),
        frequency: i16(o + 0x14),
        blendTime: u32(o + 0x20),
      });
    }
  }

  const animLookupHeader = readArrayHeader(u32, 0x24);
  const hasAnimLookup =
    animLookupHeader.count > 0 &&
    animLookupHeader.count < 4096 &&
    animLookupHeader.offset + animLookupHeader.count * 2 <= data.length;
  const animLookup = new Int16Array(hasAnimLookup ? animLookupHeader.count : 0);
  if (hasAnimLookup) {
    for (let i = 0; i < animLookup.length; i++) animLookup[i] = i16(animLookupHeader.offset + i * 2);
  }

  const readRangeArray = (offset: number): [number, number][] => {
    const h = readArrayHeader(u32, offset);
    if (h.count <= 0 || h.count > 8192 || h.offset + h.count * 8 > data.length) return [];
    const out: [number, number][] = [];
    for (let i = 0; i < h.count; i++) out.push([u32(h.offset + i * 8), u32(h.offset + i * 8 + 4)]);
    return out;
  };

  const readU32Array = (offset: number): number[] => {
    const h = readArrayHeader(u32, offset);
    if (h.count <= 0 || h.count > 200_000 || h.offset + h.count * 4 > data.length) return [];
    const out: number[] = [];
    for (let i = 0; i < h.count; i++) out.push(u32(h.offset + i * 4));
    return out;
  };

  const readValueArray = (offset: number, components: number, kind: 'float' | 'quat16' | 'fixed16'): number[] => {
    const h = readArrayHeader(u32, offset);
    const bytesPerValue = kind === 'float' ? components * 4 : components * 2;
    if (h.count <= 0 || h.count > 200_000 || h.offset + h.count * bytesPerValue > data.length) return [];
    const out: number[] = [];
    for (let i = 0; i < h.count; i++) {
      const o = h.offset + i * bytesPerValue;
      for (let c = 0; c < components; c++) {
        if (kind === 'float') {
          out.push(f32(o + c * 4));
        } else if (kind === 'fixed16') {
          // Vanilla ABlock_s is a signed 1.15 fixed value: 0x7fff is 1.0 and negative
          // authored/tangent values do not contribute to visible opacity.
          out.push(Math.max(0, i16(o + c * 2) / 32767));
        } else {
          const raw = i16(o + c * 2);
          const normalized = Math.max(-1, Math.min(1, raw / 32767));
          out.push(c === 0 ? -normalized : normalized);
        }
      }
    }
    return out;
  };

  const readTrack = (offset: number, components: number, kind: 'float' | 'quat16' | 'fixed16'): VanillaM2Track => ({
    interpolation: u16(offset),
    globalSequence: i16(offset + 0x02),
    ranges: readRangeArray(offset + 0x04),
    timestamps: readU32Array(offset + 0x0c),
    values: readValueArray(offset + 0x14, components, kind),
    components,
  });

  // Animated UV transforms. Header slot 0x74 and lookup slot 0xAC were recovered by probing every
  // candidate M2Array between the verified textures(0x5C) and materials(0x84) arrays, then
  // validating: at 0x74 every entry parses as exactly three well-formed M2Tracks (stride 0x54) in
  // 100% of models that use it, while 0x64/0x6C/0x7C all fail; and 0xAC is the only lookup slot
  // whose int16 entries all fall in [-1, nTransforms) across every model tested. Confirmed against
  // real values: Maraudon_Waterfall01.m2 scrolls V by -1.000 over 3333ms.
  // See tools/probe-m2-texanim.ts and tools/probe-m2-texanim2.ts.
  const TEXTURE_TRANSFORM_STRIDE = 0x54; // 3 tracks x 0x1C
  const textureTransforms: VanillaM2TextureTransform[] = [];
  const xfHeader = readArrayHeader(u32, 0x74);
  if (xfHeader.count > 0 && xfHeader.count < 256 && xfHeader.offset + xfHeader.count * TEXTURE_TRANSFORM_STRIDE <= data.length) {
    for (let i = 0; i < xfHeader.count; i++) {
      const o = xfHeader.offset + i * TEXTURE_TRANSFORM_STRIDE;
      textureTransforms.push({
        translation: readTrack(o, 3, 'float'),
        // Vanilla stores rotation quaternions as 4x float32 (same finding as the bone tracks).
        rotation: readTrack(o + 0x1c, 4, 'float'),
        scaling: readTrack(o + 0x38, 3, 'float'),
      });
    }
  }

  const textureTransformLookup: number[] = [];
  const xfLookupHeader = readArrayHeader(u32, 0xac);
  if (xfLookupHeader.count > 0 && xfLookupHeader.count < 4096 && xfLookupHeader.offset + xfLookupHeader.count * 2 <= data.length) {
    for (let i = 0; i < xfLookupHeader.count; i++) textureTransformLookup.push(i16(xfLookupHeader.offset + i * 2));
  }

  for (const [sub, combo] of submeshTransformCombo) {
    const index = textureTransformLookup[combo];
    if (index !== undefined && index >= 0 && index < textureTransforms.length) submeshes[sub].textureTransform = index;
  }

  // Vanilla M2Color: vec3 RGB track + signed fixed16 alpha track (2 * 0x1C).
  // M2TextureWeight: one signed fixed16 opacity track. The header slots and both M2Batch
  // references were validated across all 7,838 MD20 models by probe-m2-color-transparency.ts.
  const colors: VanillaM2Color[] = [];
  const colorHeader = readArrayHeader(u32, 0x54);
  if (colorHeader.count > 0 && colorHeader.count < 4096 && colorHeader.offset + colorHeader.count * 0x38 <= data.length) {
    for (let i = 0; i < colorHeader.count; i++) {
      const o = colorHeader.offset + i * 0x38;
      colors.push({ color: readTrack(o, 3, 'float'), alpha: readTrack(o + 0x1c, 1, 'fixed16') });
    }
  }

  const textureWeights: VanillaM2Track[] = [];
  const weightHeader = readArrayHeader(u32, 0x64);
  if (weightHeader.count > 0 && weightHeader.count < 4096 && weightHeader.offset + weightHeader.count * 0x1c <= data.length) {
    for (let i = 0; i < weightHeader.count; i++) textureWeights.push(readTrack(weightHeader.offset + i * 0x1c, 1, 'fixed16'));
  }
  const weightLookup: number[] = [];
  const weightLookupHeader = readArrayHeader(u32, 0xa4);
  if (weightLookupHeader.count > 0 && weightLookupHeader.count < 65536 && weightLookupHeader.offset + weightLookupHeader.count * 2 <= data.length) {
    for (let i = 0; i < weightLookupHeader.count; i++) weightLookup.push(i16(weightLookupHeader.offset + i * 2));
  }
  for (const [sub, index] of submeshColorIndex) {
    if (index >= 0 && index < colors.length) submeshes[sub].colorIndex = index;
  }
  for (const [sub, combo] of submeshWeightCombo) {
    const index = weightLookup[combo];
    if (index !== undefined && index >= 0 && index < textureWeights.length) submeshes[sub].textureWeight = index;
  }

  const bones: VanillaM2Bone[] = [];
  const boneHeader = readArrayHeader(u32, 0x34);
  if (boneHeader.count > 0 && boneHeader.count < 1024 && boneHeader.offset + boneHeader.count * VANILLA_BONE_STRIDE <= data.length) {
    for (let i = 0; i < boneHeader.count; i++) {
      const o = boneHeader.offset + i * VANILLA_BONE_STRIDE;
      bones.push({
        keyBoneId: i32(o),
        flags: u32(o + 0x04),
        parentIndex: i16(o + 0x08),
        translation: readTrack(o + 0x0c, 3, 'float'),
        // Vanilla (v256/257) stores rotation quaternions as 4x float32 (16B/value), NOT the
        // 1.12 specification handling.
        // int16 -> non-unit garbage. Reading as quat16 was exploding the skinned pose.
        rotation: readTrack(o + 0x28, 4, 'float'),
        scale: readTrack(o + 0x44, 3, 'float'),
        pivot: [f32(o + 0x60), f32(o + 0x64), f32(o + 0x68)],
      });
    }
  }

  const attachments: VanillaM2Attachment[] = [];
  const attachmentHeader = readArrayHeader(u32, 0x104);
  if (
    attachmentHeader.count > 0 &&
    attachmentHeader.count < 256 &&
    attachmentHeader.offset + attachmentHeader.count * 48 <= data.length
  ) {
    for (let i = 0; i < attachmentHeader.count; i++) {
      const o = attachmentHeader.offset + i * 48;
      attachments.push({
        id: u32(o),
        bone: u32(o + 0x04),
        position: [f32(o + 0x08), f32(o + 0x0c), f32(o + 0x10)],
      });
    }
  }

  // Vanilla M2 camera block (header 0x124, 0x7c-byte records). Player models carry
  // a type-0 portrait camera authored per race/gender and a type-1 character-info camera.
  // SetPortraitTexture uses the former; its position/target tracks are offsets from the bases.
  const cameras: VanillaM2Camera[] = [];
  const cameraHeader = readArrayHeader(u32, 0x124);
  const CAMERA_STRIDE = 0x7c;
  if (
    cameraHeader.count > 0 &&
    cameraHeader.count < 64 &&
    cameraHeader.offset + cameraHeader.count * CAMERA_STRIDE <= data.length
  ) {
    for (let i = 0; i < cameraHeader.count; i++) {
      const o = cameraHeader.offset + i * CAMERA_STRIDE;
      cameras.push({
        type: i32(o),
        fov: f32(o + 0x04),
        farClip: f32(o + 0x08),
        nearClip: f32(o + 0x0c),
        positionTrack: readTrack(o + 0x10, 3, 'float'),
        positionBase: [f32(o + 0x2c), f32(o + 0x30), f32(o + 0x34)],
        targetTrack: readTrack(o + 0x38, 3, 'float'),
        targetBase: [f32(o + 0x54), f32(o + 0x58), f32(o + 0x5c)],
        roll: readTrack(o + 0x60, 1, 'float'),
      });
    }
  }

  return {
    version,
    globalSequences,
    vertexCount: nVerts,
    positions,
    normals,
    uvs,
    boneWeights,
    boneIndices,
    indices,
    collisionPositions,
    collisionIndices,
    textures,
    sequences,
    animLookup,
    bones,
    attachments,
    cameras,
    textureTransforms,
    colors,
    textureWeights,
    submeshes,
  };
}
