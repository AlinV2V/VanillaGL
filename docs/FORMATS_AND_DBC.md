# Build 5875 formats and DBC contracts

This document records the layouts exercised by current VanillaGL parsers/bakers. All multibyte values below are little-endian unless stated otherwise. Chunk files store a four-byte signature and u32 payload size; several current low-level probes see on-disk signatures reversed (`MCNK` as `KNCM`) and normalize them before comparison. Raw corpus authority is the locally mounted Build 5875 MPQs in `.client-cache`.

## ADT terrain

Current readers: `tools/extractors/parse-adt.ts`, `tools/bakers/bake-tile.ts`, `bake-terrain-shader.ts`, `bake-water.ts`, and `bake-grass.ts`. A top-level ADT contains MVER, MHDR, MCIN (256 16-byte entries), name/placement chunks, then 256 MCNKs.

| Structure | Exact current contract | Units/counts/conditions |
|---|---|---|
| MCNK header | Payload +0x04 u32 indexX, +0x08 u32 indexY, +0x0C u32 nLayers, +0x3C low u16 4×4 hole mask, +0x60 u32 ofsMCLQ, +0x64 u32 sizeMCLQ, +0x68 float3 position; base height is position.z at +0x70. Subchunks begin at payload +0x80. | 256 per ADT; indices 0–15. Offsets are relative according to the owning field contract; raw scanners locate subchunks by signature to falsify offset mistakes. |
| MCVT | 145 f32 height deltas: 9×9 outer rows interleaved with 8×8 inner rows. Add MCNK base Z. | Yards. Baked to 129×129 outer and 128×128 inner grids across the tile. |
| MCNR | 145 triples of signed i8 normals; divide by 127 and apply the parser's verified axis convention. | One normal per MCVT vertex. Trailing format bytes are not treated as vertices. |
| MCLY | 16-byte records: u32 textureId +0, u32 flags +4, u32 MCAL offset +8, u32 effectId +12. | `nLayers` records. textureId joins MTEX; effectId joins GroundEffectTexture.dbc. Flags select compressed alpha and related layer behavior. |
| MCAL | Alpha data for layers after base. Uncompressed maps use 64×64 bytes; 4-bit maps pack two texels per byte; compressed maps use Build 5875 RLE control bytes (high bit fill/literal selector, low 7 bits run length). | Layer flags and payload bounds decide mode. Edge-fix/old-alpha behavior must be derived from the actual chunk, not a later ADT version. |
| MCSH | 64×64 one-bit shadow mask = 512 bytes. | One bit per shadow texel; current grass and terrain bakers share it. |

Known unknown: Clean delegates part of high-level ADT parsing to `@wowserhq/format`. Its output is accepted only where local raw-byte gates anchor the Build 5875 fields above; later-version optional chunks are not authority.

## M2 (`MD20`)

Authoritative current parser: `packages/assets/src/m2-vanilla.ts`; particle/ribbon extension: `m2-emitters.ts`. The parser rejects non-`MD20`, out-of-range counts/offsets, and non-triangle view data.

| Header/record | Offset and layout |
|---|---|
| Header | magic +0x00, version u32 +0x04; every array header is `{u32 count,u32 offset}`. Global sequences +0x14; sequences +0x1C; animation lookup +0x24; bones +0x34; vertices count/offset +0x44/+0x48; views +0x4C/+0x50; colors +0x54; textures +0x5C; texture weights +0x64; texture transforms +0x74; materials +0x84; texture lookup +0x94; weight lookup +0xA4; texture-transform lookup +0xAC; collision triangle/vertex arrays +0xEC/+0xF4; attachments +0x104; cameras +0x124. |
| Vertex | 48 bytes: position float3 +0x00, four u8 bone weights +0x0C, four u8 global bone indices +0x10, normal float3 +0x14, UV float2 +0x20; remaining bytes are not reinterpreted as another vertex. |
| View 0 | +0x00 index lookup array, +0x08 triangle-index array, +0x18 submeshes, +0x20 texture units. View triangle u16 values index the u16 vertex lookup. |
| Sequence | 0x44 bytes: u16 id +0, u16 variation +2, u32 start/end +4/+8, f32 move speed +0x0C, u32 flags +0x10, i16 frequency +0x14, u32 blend time +0x20. Times are milliseconds. |
| Track | 0x1C bytes: u16 interpolation, i16 global-sequence index, array of `{u32 start,end}` ranges +4, u32 timestamp array +0x0C, value array +0x14. Bone rotation values in this corpus are four float32 components; signed fixed16 is used for opacity tracks. |
| Bone | 0x6C bytes: i32 keyBone +0, u32 flags +4, i16 parent +8, translation track +0x0C, rotation +0x28, scale +0x44, pivot float3 +0x60. |
| Texture | 16 bytes: u32 type, u32 flags, u32 filename length, u32 filename offset. Type 0 uses the embedded C string; other types are runtime-supplied. |
| Material/submesh | material is `{u16 flags,u16 blend}`. Submesh stride 0x20: id +0, triangle start/count +8/+A, bone count/combo/influences/center +C/+E/+10/+12. Texture-unit stride 0x18 maps submesh, material, color, texture combo, weight combo, and transform combo. |
| Attachment | 48 bytes: u32 id, u32 bone, float3 position +8; the remaining record contains animation data not consumed by the attachment placement path. Attachment lookup remains a separate signed-u16 header array in the MD20 family and must be validated before use. |
| Particle/ribbon | `m2-emitters.ts` anchors the particle array header at 0x13C and reads bounded records/tracks; ribbons carry bone/local position, texture references, color/alpha, above/below widths, edge rate/lifetime, gravity, and UV rows/columns. Only fields consumed by that parser are canonical here. |

Texture transforms are three 0x1C tracks (stride 0x54), colors are RGB track + signed-fixed16 alpha (0x38), and texture weights are one 0x1C opacity track. Those slots were corpus-probed across thousands of Build 5875 models; a later M2/WotLK structure must not replace them.

## WMO

Current raw parser/baker: `tools/bakers/bake-wmos.ts`; compact runtime loader: `apps/client/src/rendering/wmo-binary.ts`; visibility: `wmo-visibility.ts`. Root/group chunks use the common 8-byte chunk envelope.

| Chunk | Layout consumed now |
|---|---|
| MOHD | counts at fixed u32 slots (including lights +0x0C and doodad sets +0x18); ambient BGRA +0x1C; root flags u16 +0x3C. The full 64-byte header also relates materials, groups, portals, doodads, and bounds; consumers must keep count fields tied to their target chunks. |
| MOTX/MOMT | MOTX is a NUL-separated texture-name block. MOMT records provide material flags/shader/blend and primary/secondary texture offsets; current bake preserves shader, blend, and render flags rather than guessing from filenames. |
| MOGP | Group payload header is 68 bytes: flags u32 +0x08, bbox min/max float3 +0x0C/+0x18, portal start/count u16 +0x24/+0x26, batch-A count u16 +0x28. Group subchunks start +68. `0x2000` is interior; `0x08/0x40` are exterior/lit classifications used by current visibility/lighting. |
| MOPT | 20-byte records: u16 firstVertex, u16 vertexCount, float3 normal, f32 plane distance. MOPV supplies float3 vertices. |
| MOPR | 8-byte records: u16 portal index, u16 group index, i16 side, remaining padding/unknown u16. Group portal start/count selects the relation range. |
| MOBN/MOBR | MOBN is a byte-proven 16-byte `CAaBspNode`: u16 flags, i16 negative child, i16 positive child, u16 face count, u32 face start, f32 plane distance. Axis is flags low bits; bit 4 denotes leaf. MOBR is a u16 face-index array. |
| MODS/MODD/MODR | MODS is 32 bytes: 20-byte name, u32 start +20, u32 count +24. MODD is 40 bytes: u32 MODN name offset, float3 position, float4 quaternion, f32 scale, BGRA bytes. MODR is a group-local u16 array of root MODD indices. |
| MOLT/MOCV | MOLT stride 48; current fields are type +0, BGRA +4, position float3 +8, intensity +0x14, attenuation start/end +0x28/+0x2C. MOCV is one BGRA value per MOVT vertex. |

Portal traversal uses MOPT/MOPR plus group bounds/BSP. Collision uses the authored triangle shell and terrain-type face groups, then runtime BVHs. Known unknowns include unconsumed MOHD/MOMT bits and exact client heuristics beyond the validated visibility flags; they remain raw metadata, not invented behavior.

## BLP1

Current bakers decode through `@wowserhq/format` and immediately request ABGR8888; KTX2/WebP are generated from that decoded image. The accepted Build 5875 envelope is `BLP1` magic, little-endian compression/alpha metadata, width/height, 16 mip offsets, and 16 mip sizes. Every mip is bounds-checked against its offset/size.

Paletted BLP uses a 256-entry BGRA palette followed by one index byte per pixel and an alpha plane whose packing is selected by alpha depth (0, 1, 4, or 8 bits). Block-compressed BLP uses 4×4 blocks: DXT1 is 8 bytes, DXT3 and DXT5 are 16 bytes; DXT1 can carry one-bit alpha, DXT3 explicit 4-bit alpha, and DXT5 interpolated alpha. Raw/uncompressed BGRA/RGBA channels are normalized by the decoder before the project's ABGR8888 request. Unsupported compression/alpha combinations fail rather than silently interpreting bytes as RGBA32.

Known limitation: VanillaGL does not yet own a standalone BLP parser with field-by-field gates; the third-party decoder is isolated to baking. A future native parser must be proven against raw mip hashes before replacing it.

## DBC envelope and validated schemas

DBC uses `WDBC`, then four little-endian u32 values: record count +0x04, field count +0x08, record size +0x0C, string-block size +0x10. Fixed records begin +0x14; each field below is four bytes, so field `n` is record offset `4n`. A string field stores a u32 offset into the trailing string block. `packages/assets` `DbcFile` is the current reader.

Both base and patch-priority counts were probed. Priority has Light 374×12, Spell 22,357×173, ItemDisplayInfo 29,604×23, AreaTable 1,081×25, GroundEffectDoodad 443×3, Map 44×42, and LiquidType 5×4. Current fixed-index Spell and ItemDisplayInfo bakers deliberately use base schemas: Spell 16,332×162, ItemDisplayInfo 23,852×23, AreaTable 988×21, Map 39×37. Do not mix a priority row with base field indices.

| DBC | Fields consumed and joins | Raw validation example |
|---|---|---|
| Light | 0/id u32; 1/mapId u32→Map.0; 2–4 position f32; 5–6 falloff start/end f32 yards; 7–11 five LightParams IDs. No strings. `bake-lighting.ts` converts client coords with map centre 17066.666… and resolves bands/skyboxes. | Priority row id 1: map 0, zero position/falloff, params `[12,13,10,11,4]`; 374 rows, 48-byte records. |
| Spell (base schema) | Key fields: 0 id; attributes 5/7; targets 9; aura states 12/13; recovery 15/16; power/cost 27/28; range FK 32→SpellRange.0; speed f32 33; totems 36–37; reagent IDs 38–45 and counts 46–53; equipment 54–56; effects 56–58; implicit targets 74–79; radius FKs 80–82→SpellRadius.0; visual 107→SpellVisual.0; icon 109→SpellIcon.0; localized strings name 112–120 and rank 121–129; description 130–138; tooltip 139–147; percent cost 148; GCD 150; family 152/masks 153–154; prevention 156. Strings use the string block. | Base Fireball 133: name Fireball, mana cost 30, range FK 4, speed 24, targetA 6, icon 183, GCD 1500, prevention 1. Blizzard 10: targetA 28 and radius FK 14. Blink 1953: recovery 15000. |
| ItemDisplayInfo (base schema) | 0 id; 1–2 model L/R strings; 3–4 texture L/R strings; 5 icon string; 6–8 geoset groups; 9 flags; 10 spell visual; 11 helmet visibility; 12–21 schema slots used by current consumers for body components/visual data; 20 item visual; 21–22 helmet visibility IDs in the exporter. Joins item display IDs from server item templates and ItemVisuals. | Base id 389 has icon `INV_Shirt_01`; current equipment bake anchors sleeve component `Generic_TaSh_01_Sleeve_AU` at field 14. `prepare-runtime-dbcs.ts` only tags strings for staging and is not a semantic schema authority. |
| AreaTable | 0 areaId; 1 mapId→Map.0; 2 parent/zone area→AreaTable.0; 3 explore flag; 4 flags; 5 sound provider; 6 underwater sound; 7 ambience; 8 zone music; 9 intro sound; 10 level; localized area name begins field 11. Later priority columns remain unconsumed until probed. | Priority area 9: name `Northshire Valley`, parent 12, explore flag 125, flags 64. Current area-name bake validates this exact row. |
| GroundEffectDoodad | 0 id; 1 model-name string; 2 flags/unknown u32 retained. Joined from GroundEffectTexture's four doodad slots. | Priority row id 2: model `ElwFlo01.mdl`, field2 14; 443 rows, 12-byte records. |
| Map | 0 mapId; 1 directory string; 2 instance type; 3 flags; localized map name begins field 4. Remaining base/priority columns cover linked zones, descriptions, entrance/loading/expansion metadata and must be consumed only by an anchored baker. | Priority row id 0: directory `Azeroth`; 44 rows, 168-byte records. |
| LiquidType | 0 id; 1 name string; 2 type/category u32; 3 spell/effect/flags u32 as retained by current data. Joins liquid IDs where modern MH2O exists; legacy MCLQ currently maps flags to water/ocean/magma/slime categories. | Priority rows: `(1 Water,3,0)`, `(2 Ocean,3,0)`, `(3 Magma,0,0)`, `(4 Slime,2,0)`, `(21 Naxxramas - Slime,2,28801)`. |

## Network binary layouts

Authentication is byte-oriented and unencrypted until world-session header activation. The SRP proof body is documented in `docs/PROTOCOL.md`. World client headers are 6 bytes (big-endian size, little-endian u32 opcode); server headers are 4 bytes (big-endian size, little-endian u16 opcode). Only headers are encrypted.

`SMSG_UPDATE_OBJECT` starts u32 block count + u8 transport marker, followed by typed blocks. Packed GUID is u8 presence mask plus the selected low-order bytes. Update masks are u8 u32-block count, the mask words, then one u32 per set bit. MovementInfo is flags/time/x/y/z/o plus transport, pitch, fall/jump, and spline-elevation conditionals exactly as listed in `docs/PROTOCOL.md`. All packet bodies are little-endian. Current authority is `world.ts`, `world-entities.ts`, focused movement decoders, vMaNGOS Build 5875 serialization, and replay/simulation gates.
