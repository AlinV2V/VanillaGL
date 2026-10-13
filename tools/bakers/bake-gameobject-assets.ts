/** Asset conversion utility. */
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import { ClientArchiveSet, DbcFile, MpqArchive, openClientArchive, openClientArchives, readVanillaM2 } from '@vanillagl/assets';
import { encodePng } from '../utils/png.ts';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const PUBLIC = fileURLToPath(new URL('../../apps/client/public/gameobjects', import.meta.url));
const DBC_ROOT = process.env.DBC_SOURCE_DIR || join(process.cwd(), 'data', 'dbcs');

type GameObjectDisplay = {
  id: number;
  path: string;
};

type TextureIndex = ReturnType<typeof makeTextureIndex>;

type Submesh = {
  partId: number;
  textureType: number;
  type0Tex: string | null;
  blendMode: number;
  renderFlags: number;
  indexStart: number;
  indexCount: number;
};

function normModelPath(path: string) {
  return path.replace(/\.(mdx|mdl)$/i, '.m2');
}

function readDbc(name: string) {
  return new DbcFile(new Uint8Array(readFileSync(join(DBC_ROOT, name))));
}

function loadDisplays() {
  const dbc = readDbc('GameObjectDisplayInfo.dbc');
  const displays = new Map<number, GameObjectDisplay>();
  for (let i = 0; i < dbc.recordCount; i++) {
    const id = dbc.getUint(i, 0);
    const model = dbc.getString(i, 1);
    if (!id || !model) continue;
    const path = normModelPath(model);
    if (!/\.m2$/i.test(path)) continue;
    displays.set(id, { id, path });
  }
  return displays;
}

function selectedDisplayIds(displays: Map<number, GameObjectDisplay>) {
  const raw = process.env.DISPLAY_IDS?.trim();
  if (raw?.toLowerCase() === 'all') return Array.from(displays.keys()).sort((a, b) => a - b);
  const explicit = raw?.split(',').map((v) => Number(v.trim())).filter(Number.isFinite);
  if (explicit?.length) return explicit;
  return [603];
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

function findTexture(name: string, modelPath: string, index: TextureIndex, archives: MpqArchive[]) {
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

function assetKey(path: string) {
  return path.toLowerCase().replace(/\.(m2|mdx|mdl|blp)$/i, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function dedupTexture(
  name: string,
  modelPath: string,
  index: TextureIndex,
  archives: MpqArchive[],
  texDir: string,
  pool: Map<string, string>,
) {
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
  const ref = `/gameobjects/tex/${file}`;
  pool.set(key, ref);
  return ref;
}

function bakeModel(
  modelPath: string,
  modelArchive: { extract(path: string): Uint8Array },
  modelsDir: string,
  texDir: string,
  index: TextureIndex,
  archives: MpqArchive[],
  texPool: Map<string, string>,
  cache: Map<string, { key: string; submeshes: Submesh[]; vertexCount: number } | null>,
) {
  const cached = cache.get(modelPath);
  if (cached !== undefined) return cached;

  const key = assetKey(modelPath);
  const dir = `${modelsDir}\\${key}`;
  let mesh: ReturnType<typeof readVanillaM2>;
  try {
    mesh = readVanillaM2(modelArchive.extract(modelPath));
  } catch (e) {
    console.warn(`  model parse failed ${modelPath}: ${(e as Error).message}`);
    cache.set(modelPath, null);
    return null;
  }

  const vertexCount = mesh.positions.length / 3;
  const subs = mesh.submeshes.length
    ? mesh.submeshes
    : [{ triangleStart: 0, triangleCount: mesh.indices.length, textureIndex: 0, blendMode: 0, renderFlags: 0, partId: 0 }];

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
  writeFileSync(`${dir}\\model.json.gz`, gzipSync(Buffer.from(JSON.stringify({
    source: modelPath,
    vertexCount,
    indexCount: allIndices.length,
    indexType: useU32 ? 'u32' : 'u16',
    hasNormals: mesh.normals?.length === mesh.positions.length,
    submeshes,
    sequences: mesh.sequences,
    animLookup: Array.from(mesh.animLookup),
    bones: mesh.bones,
  })), { level: 9 }));

  const result = { key, submeshes, vertexCount };
  cache.set(modelPath, result);
  return result;
}

async function main() {
  const displays = loadDisplays();
  const ids = selectedDisplayIds(displays);
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
  const patches = await openClientArchives(CACHE, []);
  const modelSet = new ClientArchiveSet([...patches, modelArchive]);
  const archives = [...patches, textureArchive, modelArchive];
  const textureIndex = makeTextureIndex(archives);
  const modelCache = new Map<string, { key: string; submeshes: Submesh[]; vertexCount: number } | null>();
  const texPool = new Map<string, string>();
  const manifest: Record<string, { path: string; model: string; textures: string[] }> = {};
  const limit = Number(process.env.LIMIT ?? 0) || Infinity;
  let baked = 0, missing = 0, skipped = 0;

  for (const id of ids) {
    if (baked >= limit) break;
    const display = displays.get(id);
    if (!display) { missing++; continue; }
    if (!modelSet.has(display.path)) { missing++; continue; }
    const model = bakeModel(display.path, modelSet, modelsDir, texDir, textureIndex, archives, texPool, modelCache);
    if (!model) { missing++; continue; }
    if (model.vertexCount <= 0 || !model.submeshes.length) { skipped++; continue; }
    const textures = [...new Set(model.submeshes.map((s) => s.type0Tex).filter((u): u is string => !!u))];
    writeFileSync(`${displayDir}\\${id}.json`, JSON.stringify({
      displayId: id,
      source: display.path,
      model: model.key,
      scale: 1,
      textures,
      visible: model.submeshes.map((_, i) => i),
    }));
    manifest[String(id)] = { path: display.path, model: model.key, textures };
    baked++;
    if (baked % 200 === 0) console.log(`  ...${baked} displays, ${modelCache.size} models, ${texPool.size} textures`);
  }

  writeFileSync(`${PUBLIC}\\manifest.json`, JSON.stringify(manifest, null, 2));
  console.log(`baked=${baked} missing=${missing} skipped=${skipped} | unique models=${modelCache.size} unique textures=${texPool.size} candidates=${ids.length}`);
  modelSet.close();
  textureArchive.close();
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
