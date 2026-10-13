/** Asset conversion utility. */
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname } from 'node:path';
import { Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import { ClientArchiveSet, DbcFile, MpqArchive, openClientArchive, openClientArchives, readVanillaM2 } from '@vanillagl/assets';
import { encodePng } from '../utils/png.ts';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const PUBLIC = fileURLToPath(new URL('../../apps/client/public/creatures', import.meta.url));
const DEFAULT_MODEL_RE = /TallStrider/i;

type CreatureDisplay = {
  id: number;
  modelId: number;
  extendedDisplayId: number;
  displayScale: number;
  alpha: number;
  textureNames: string[];
};

type CreatureDisplayExtra = {
  id: number;
  hairGeoset: number;
  facialParts: number[];
  bakeName: string;
  // Raw character-appearance fields (CreatureDisplayInfoExtra). Humanoid NPCs use BakeName as
  // their body atlas at runtime; these fields select the character mesh, hair, face, and geosets.
  race: number;
  gender: number;
  skin: number;
  face: number;
  hairStyleId: number;
  hairColor: number;
  facialHairId: number;
  itemDisplayIds: number[]; // equipped ItemDisplayInfo IDs (head..tabard), 0 = empty slot
};

type CreatureModel = {
  id: number;
  path: string;
  modelScale: number;
};

type Part = {
  indices: number[];
  tex: number;
  blendMode: number;
  renderFlags: number;
};

type ManifestEntry = {
  modelId: number;
  path: string;
  scale: number;
  textures: string[];
};

type AssetReader = {
  has(path: string): boolean;
  extract(path: string): Uint8Array;
};

function normModelPath(path: string) {
  return path.replace(/\.(mdx|mdl)$/i, '.m2');
}

function readDbc(archives: ClientArchiveSet, name: string) {
  return new DbcFile(archives.extract(`DBFilesClient\\${name}`));
}

function loadCreatureTables(archives: ClientArchiveSet) {
  const displayDbc = readDbc(archives, 'CreatureDisplayInfo.dbc');
  const modelDbc = readDbc(archives, 'CreatureModelData.dbc');
  const extraDbc = readDbc(archives, 'CreatureDisplayInfoExtra.dbc');
  const hairDbc = readDbc(archives, 'CharHairGeosets.dbc');
  const facialDbc = readDbc(archives, 'CharacterFacialHairStyles.dbc');
  const displays = new Map<number, CreatureDisplay>();
  const models = new Map<number, CreatureModel>();
  const extras = new Map<number, CreatureDisplayExtra>();

  for (let i = 0; i < modelDbc.recordCount; i++) {
    const id = modelDbc.getUint(i, 0);
    const path = modelDbc.getString(i, 2);
    if (!id || !path) continue;
    models.set(id, { id, path: normModelPath(path), modelScale: modelDbc.getFloat(i, 4) || 1 });
  }

  for (let i = 0; i < displayDbc.recordCount; i++) {
    const id = displayDbc.getUint(i, 0);
    if (!id) continue;
    displays.set(id, {
      id,
      modelId: displayDbc.getUint(i, 1),
      extendedDisplayId: displayDbc.getUint(i, 3),
      displayScale: displayDbc.getFloat(i, 4) || 1,
      alpha: displayDbc.getUint(i, 5),
      textureNames: [6, 7, 8].map((field) => displayDbc.getString(i, field)).filter(Boolean),
    });
  }

  for (let i = 0; i < extraDbc.recordCount; i++) {
    const id = extraDbc.getUint(i, 0);
    if (!id) continue;
    const race = extraDbc.getUint(i, 1);
    const gender = extraDbc.getUint(i, 2);
    const hairStyle = extraDbc.getUint(i, 5);
    const facialHair = extraDbc.getUint(i, 7);
    const hair = Array.from({ length: hairDbc.recordCount }, (_, row) => row).find(
      (row) => hairDbc.getUint(row, 1) === race && hairDbc.getUint(row, 2) === gender && hairDbc.getUint(row, 3) === hairStyle,
    );
    const facial = Array.from({ length: facialDbc.recordCount }, (_, row) => row).find(
      (row) => facialDbc.getUint(row, 0) === race && facialDbc.getUint(row, 1) === gender && facialDbc.getUint(row, 2) === facialHair,
    );
    // Column order is [group100, group300, group200] — see bake-character-models.ts. Mapping
    // column 7 to group 200 erased troll NPC tusks (troll M2s only have group-300 facial geosets).
    const facialParts = facial === undefined
      ? []
      : [6, 7, 8]
          .map((field, index) => ({ value: facialDbc.getUint(facial, field), group: [100, 300, 200][index] }))
          .filter(({ value }) => value > 0 && value < 100)
          .map(({ value, group }) => group + value);
    extras.set(id, {
      id,
      hairGeoset: hair === undefined ? 0 : hairDbc.getUint(hair, 4),
      facialParts,
      bakeName: extraDbc.getString(i, 18),
      race, gender, skin: extraDbc.getUint(i, 3), face: extraDbc.getUint(i, 4),
      hairStyleId: hairStyle, hairColor: extraDbc.getUint(i, 6), facialHairId: facialHair,
      // NPCItemDisplay[10] live in fields 8..17:
      // head, shoulder, shirt, chest, belt, legs, boots, wrist, hands, tabard.
      itemDisplayIds: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((f) => extraDbc.getUint(i, f)),
    });
  }

  return { displays, models, extras };
}

function selectedDisplayIds(displays: Map<number, CreatureDisplay>, models: Map<number, CreatureModel>) {
  const raw = process.env.DISPLAY_IDS?.trim();
  // DISPLAY_IDS=all -> every display that resolves to a real model (full-world coverage).
  if (raw && raw.toLowerCase() === 'all') {
    const ids: number[] = [];
    for (const display of displays.values()) {
      if (models.has(display.modelId)) ids.push(display.id);
    }
    return ids.sort((a, b) => a - b);
  }
  const explicit = raw?.split(',').map((v) => Number(v.trim())).filter(Number.isFinite);
  if (explicit?.length) return explicit;

  const modelRe = new RegExp(process.env.MODEL_RE ?? DEFAULT_MODEL_RE.source, 'i');
  const ids: number[] = [];
  for (const display of displays.values()) {
    const model = models.get(display.modelId);
    if (model && modelRe.test(model.path)) ids.push(display.id);
  }
  return ids.sort((a, b) => a - b);
}

function makeTextureIndex(archives: MpqArchive[]) {
  const byLower = new Map<string, { archive: MpqArchive; path: string }>();
  const byBase = new Map<string, { archive: MpqArchive; path: string }>();
  for (const archive of archives) {
    for (const path of archive.list('*.blp')) {
      const lower = path.toLowerCase();
      byLower.set(lower, { archive, path });
      const base = lower.split('\\').pop();
      if (base && !byBase.has(base)) byBase.set(base, { archive, path });
    }
  }
  return { byLower, byBase };
}

function findTexture(
  name: string,
  modelPath: string,
  index: ReturnType<typeof makeTextureIndex>,
  archives: MpqArchive[],
): { archive: MpqArchive; path: string } | null {
  if (!name) return null;
  const withExt = /\.(blp)$/i.test(name) ? name : `${name}.blp`;
  const modelDir = dirname(modelPath).replace(/\//g, '\\');
  const candidates = [
    withExt,
    `${modelDir}\\${withExt}`,
    withExt.replace(/\//g, '\\'),
  ].map((path) => path.toLowerCase());

  for (const candidate of candidates) {
    const indexed = index.byLower.get(candidate);
    if (indexed) return indexed;
    for (const archive of archives) {
      if (archive.has(candidate)) return { archive, path: candidate };
    }
  }

  return index.byBase.get(withExt.toLowerCase().split('\\').pop() ?? '') ?? null;
}

function writeBlp(texture: { archive: MpqArchive; path: string }, outPath: string) {
  const blp = new Blp().load(texture.archive.extract(texture.path));
  const img = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
  writeFileSync(outPath, encodePng(img.width, img.height, img.data));
}

/** Filesystem-safe key from a WoW asset path (e.g. "Creature\Kobold\Kobold.m2" -> "creature_kobold_kobold"). */
function assetKey(path: string): string {
  return path.toLowerCase().replace(/\.(m2|mdx|mdl|blp)$/i, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/**
 * Resolve + bake a texture ONCE into the shared, deduplicated texture pool (`creatures/tex/<key>.png`),
 * keyed by source BLP path. Many displays share skins and many models share hardcoded textures, so this
 * collapses thousands of duplicate PNGs to the unique set. Returns the relative ref or null.
 */
function dedupTexture(
  name: string,
  modelPath: string,
  index: ReturnType<typeof makeTextureIndex>,
  archives: MpqArchive[],
  texDir: string,
  pool: Map<string, string>,
): string | null {
  if (!name) return null;
  const resolved = findTexture(name, modelPath, index, archives);
  if (!resolved) return null;
  const key = resolved.path.toLowerCase();
  const cached = pool.get(key);
  if (cached) return cached;
  const file = `${assetKey(resolved.path)}.png`;
  const out = `${texDir}\\${file}`;
  if (!existsSync(out)) {
    try { writeBlp(resolved, out); } catch { return null; }
  }
  const ref = `/creatures/tex/${file}`; // absolute — client resolves directly
  pool.set(key, ref);
  return ref;
}

type Submesh = {
  partId: number;
  textureType: number;
  /** Source BLP for hardcoded (type-0) textures — model-specific, baked with the model. */
  type0Tex: string | null;
  blendMode: number;
  renderFlags: number;
  indexStart: number;
  indexCount: number;
};

/**
 * Bake one M2 model's geometry ONCE (binary `geo.bin` + small `model.json` meta) into
 * `creatures/models/<key>/`. Returns the model key + submesh table (shared by every display that
 * uses this model). geo.bin layout (LE), all for vertexCount V:
 *   positions f32[3V] | normals f32[3V] | uvs f32[2V] | boneWeights u8[4V] | boneIndices u8[4V] | indices (u16 or u32)[I]
 */
function bakeModel(
  modelPath: string,
  modelArchive: AssetReader,
  modelsDir: string,
  texDir: string,
  index: ReturnType<typeof makeTextureIndex>,
  archives: MpqArchive[],
  texPool: Map<string, string>,
  cache: Map<string, { key: string; submeshes: Submesh[]; vertexCount: number; cameras: ReturnType<typeof readVanillaM2>['cameras'] } | null>,
): { key: string; submeshes: Submesh[]; vertexCount: number; cameras: ReturnType<typeof readVanillaM2>['cameras'] } | null {
  const cached = cache.get(modelPath);
  if (cached !== undefined) return cached;

  const key = assetKey(modelPath);
  const dir = `${modelsDir}\\${key}`;
  let mesh: ReturnType<typeof readVanillaM2>;
  try {
    mesh = readVanillaM2(modelArchive.extract(modelPath));
  } catch (e) {
    console.warn(`  model parse failed ${modelPath}: ${(e as Error).message}`);
    cache.set(modelPath, null); // don't retry this model
    return null;
  }
  const vertexCount = mesh.positions.length / 3;
  const subs = mesh.submeshes.length
    ? mesh.submeshes
    : [{ triangleStart: 0, triangleCount: mesh.indices.length, textureIndex: 0, blendMode: 0, renderFlags: 0, partId: 0 }];

  // Concatenate every submesh's indices; record each submesh's [start,count) into that flat buffer.
  const allIndices: number[] = [];
  const submeshes: Submesh[] = [];
  for (const sub of subs) {
    const end = sub.triangleStart + sub.triangleCount;
    if (sub.triangleCount <= 0 || end > mesh.indices.length) continue;
    const indexStart = allIndices.length;
    for (let i = sub.triangleStart; i < end; i++) allIndices.push(mesh.indices[i]);
    const slot = mesh.textures[sub.textureIndex];
    submeshes.push({
      partId: (sub as { partId?: number }).partId ?? 0,
      textureType: slot?.type ?? -1,
      type0Tex: slot?.type === 0 ? dedupTexture(slot.filename, modelPath, index, archives, texDir, texPool) : null,
      blendMode: sub.blendMode ?? 0,
      renderFlags: sub.renderFlags ?? 0,
      indexStart,
      indexCount: end - sub.triangleStart,
    });
  }

  const useU32 = vertexCount > 65535;
  const geo = Buffer.concat([
    Buffer.from(new Float32Array(mesh.positions).buffer),
    Buffer.from(new Float32Array(mesh.normals?.length === mesh.positions.length ? mesh.normals : new Float32Array(mesh.positions.length)).buffer),
    Buffer.from(new Float32Array(mesh.uvs).buffer),
    Buffer.from(Uint8Array.from(mesh.boneWeights).buffer),
    Buffer.from(Uint8Array.from(mesh.boneIndices).buffer),
    Buffer.from((useU32 ? Uint32Array.from(allIndices) : Uint16Array.from(allIndices)).buffer),
  ]);

  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}\\geo.bin`, geo);
  // model.json holds the bone animation tracks (the bulk) — gzip it (~6-8× on JSON numbers). The
  // client fetches model.json.gz and inflates via DecompressionStream. geo.bin stays raw (binary
  // floats barely compress and slicing the ArrayBuffer is simplest uncompressed).
  const metaJson = JSON.stringify({
    source: modelPath,
    vertexCount,
    indexCount: allIndices.length,
    indexType: useU32 ? 'u32' : 'u16',
    hasNormals: mesh.normals?.length === mesh.positions.length,
    submeshes,
    sequences: mesh.sequences,
    globalSequences: mesh.globalSequences,
    animLookup: Array.from(mesh.animLookup),
    bones: mesh.bones,
    attachments: mesh.attachments,
    cameras: mesh.cameras,
  });
  writeFileSync(`${dir}\\model.json.gz`, gzipSync(Buffer.from(metaJson), { level: 9 }));
  const result = { key, submeshes, vertexCount, cameras: mesh.cameras };
  cache.set(modelPath, result);
  return result;
}

async function main() {
  // Creature display tables changed across Vanilla patches (Moonkin and Spirit of Redemption are
  // absent from the base dbc.MPQ but present in the Build-5875 patch DBC). Read patch-first from the
  // same client archives as the model/texture assets; the former loose wow_extracted directory was
  // a stale pre-patch snapshot and silently reported those valid 1.12 displays as missing.
  const patches = await openClientArchives(CACHE, []);
  const baseDbc = await openClientArchive(CACHE, 'dbc.MPQ');
  const { displays, models, extras } = loadCreatureTables(new ClientArchiveSet([...patches, baseDbc]));
  const ids = selectedDisplayIds(displays, models);
  const modelsDir = `${PUBLIC}\\models`;
  const texDir = `${PUBLIC}\\tex`;
  const displayDir = `${PUBLIC}\\display`;
  mkdirSync(modelsDir, { recursive: true });
  mkdirSync(texDir, { recursive: true });
  mkdirSync(displayDir, { recursive: true });

  const modelArchive = await openClientArchive(CACHE, 'model.MPQ');
  const textureArchive = await openClientArchive(CACHE, 'texture.MPQ');
  // Patch archives shadow the base ones (11,470 files in patch.MPQ alone). Array scans get `patches`
  // prepended; direct handle reads go through a patch-first set. See @vanillagl/assets.
  const modelSet = new ClientArchiveSet([...patches, modelArchive]);
  const archives = [...patches, textureArchive, modelArchive];
  const textureIndex = makeTextureIndex(archives);

  const manifestPath = `${PUBLIC}\\manifest.json`;
  const manifest: Record<string, ManifestEntry> = {};
  const modelCache = new Map<string, { key: string; submeshes: Submesh[]; vertexCount: number; cameras: ReturnType<typeof readVanillaM2>['cameras'] } | null>();
  const texPool = new Map<string, string>(); // dedup textures across ALL displays/models
  let baked = 0, missing = 0;
  const limit = Number(process.env.LIMIT ?? 0) || Infinity;

  for (const id of ids) {
    if (baked >= limit) break;
    const display = displays.get(id);
    const model = display ? models.get(display.modelId) : undefined;
    const extra = display?.extendedDisplayId ? extras.get(display.extendedDisplayId) : undefined;
    if (!display || !model || !modelSet.has(model.path)) { missing++; continue; }

    // Geometry/bones/anims baked ONCE per unique model and shared by every display that uses it.
    const baseModel = bakeModel(model.path, modelSet, modelsDir, texDir, textureIndex, archives, texPool, modelCache);
    if (!baseModel) { missing++; continue; }

    // Per-display: skins for texture types (11/12/13 monster skins, 1 = character bake skin), deduped.
    const skins = display.textureNames.map((n) => dedupTexture(n, model.path, textureIndex, archives, texDir, texPool));
    const bakeSkin = extra?.bakeName ? dedupTexture(extra.bakeName, model.path, textureIndex, archives, texDir, texPool) : null;

    // Per-display visible submeshes (humanoid NPCs filter by hair/facial/body geosets; others show all).
    const bodyGeosets = new Map<number, number>();
    if (extra) {
      for (const s of baseModel.submeshes) {
        if (s.partId < 400) continue;
        const g = Math.floor(s.partId / 100);
        const cur = bodyGeosets.get(g);
        if (cur === undefined || s.partId < cur) bodyGeosets.set(g, s.partId);
      }
    }
    const visible: number[] = [];
    baseModel.submeshes.forEach((s, i) => {
      const show = !extra || s.partId === 0
        ? true
        : s.partId > 0 && s.partId < 100 ? s.partId === extra.hairGeoset
        : s.partId >= 100 && s.partId < 400 ? extra.facialParts.includes(s.partId)
        : bodyGeosets.get(Math.floor(s.partId / 100)) === s.partId;
      if (show) visible.push(i);
    });

    const scale = (model.modelScale || 1) * (display.displayScale || 1);
    // Humanoid NPC (Extra with a player race 1-8): emit customization metadata for the character
    // renders it through the SAME pipeline as players (loadBakedCharacterModel) — proper composited
    // skin/face/hair + worn armor — instead of the usually-empty BakeName. equipment = NPCItemDisplay
    // ItemDisplayInfo IDs mapped to inventory-type slots.
    const INV = [1, 3, 4, 5, 6, 7, 8, 9, 10, 19]; // head, shoulder, shirt, chest, waist, legs, feet, wrist, hands, tabard
    const character = extra && extra.race >= 1 && extra.race <= 8 ? {
      race: extra.race, gender: extra.gender, skin: extra.skin, face: extra.face,
      hairStyle: extra.hairStyleId, hairColor: extra.hairColor, facialHair: extra.facialHairId,
      equipment: extra.itemDisplayIds
        .map((displayInfoId, k) => ({ displayInfoId, inventoryType: INV[k] }))
        .filter((e) => e.displayInfoId > 0),
    } : null;
    writeFileSync(`${displayDir}\\${id}.json`, JSON.stringify({
      displayId: id,
      model: baseModel.key,
      scale,
      alpha: display.alpha,
      skins,      // [type11, type12, type13] refs (absolute /creatures/tex/...)
      bakeSkin,   // type-1 character skin ref (humanoid NPCs)
      visible,    // indices into model.submeshes to render
      cameras: baseModel.cameras,
      ...(character ? { character } : {}),
    }));
    manifest[String(id)] = { modelId: model.id, path: model.path, scale, textures: display.textureNames };
    baked++;
    if (baked % 200 === 0) console.log(`  ...${baked} displays, ${modelCache.size} models, ${texPool.size} textures`);
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`baked=${baked} missing=${missing} | unique models=${modelCache.size} unique textures=${texPool.size} candidates=${ids.length}`);
  modelArchive.close();
  textureArchive.close();
  baseDbc.close();
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
