/** Asset conversion utility. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ClientArchiveSet, readVanillaM2, type VanillaM2Track } from '@vanillagl/assets';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const TILES = fileURLToPath(new URL('../../apps/client/public/terrain/tiles', import.meta.url));
const OUT = fileURLToPath(new URL('../../apps/client/public/terrain/doodad-anims', import.meta.url));

const normalizeSource = (source: string) => source.replace(/\//g, '\\').replace(/\.(mdx|mdl)$/i, '.m2');
const round = (value: number) => Math.round(value * 100000) / 100000;
const track = (value: VanillaM2Track) => ({
  i: value.interpolation,
  g: value.globalSequence,
  r: value.ranges,
  t: Array.from(value.timestamps),
  v: Array.from(value.values, round),
  c: value.components,
});
const trackMoves = (value: VanillaM2Track) => value.timestamps.length > 1;

const sources = new Map<string, string>();
for (const tile of readdirSync(TILES)) {
  const tileDir = `${TILES}/${tile}`;
  if (!statSync(tileDir).isDirectory()) continue;
  for (const name of ['doodads.json', 'wmo_doodads.json']) {
    const path = `${tileDir}/${name}`;
    if (!existsSync(path)) continue;
    const data = JSON.parse(readFileSync(path, 'utf8')) as { meshes?: Array<{ source?: string }> };
    for (const mesh of data.meshes ?? []) {
      if (!mesh.source) continue;
      const source = normalizeSource(mesh.source);
      if (!sources.has(source.toLowerCase())) sources.set(source.toLowerCase(), source);
    }
  }
}

mkdirSync(OUT, { recursive: true });
const archives = await ClientArchiveSet.open(CACHE, ['model.MPQ']);
const manifest: Record<string, string> = {};
let animated = 0;
let bytes = 0;
try {
  for (const [key, source] of sources) {
    if (!archives.has(source)) continue;
    try {
      const model = readVanillaM2(archives.extract(source));
      if (!model.bones.some((bone) =>
        trackMoves(bone.translation) || trackMoves(bone.rotation) || trackMoves(bone.scale))) continue;
      const asset = {
        n: Array.from(model.normals, round),
        w: Array.from(model.boneWeights),
        j: Array.from(model.boneIndices),
        seq: model.sequences.map((sequence) => ({
          id: sequence.id,
          timeStart: sequence.timeStart,
          timeEnd: sequence.timeEnd,
          duration: sequence.duration,
          blendTime: sequence.blendTime,
        })),
        gs: Array.from(model.globalSequences),
        al: Array.from(model.animLookup),
        bones: model.bones.map((bone) => ({
          flags: bone.flags,
          parentIndex: bone.parentIndex,
          pivot: bone.pivot,
          translation: track(bone.translation),
          rotation: track(bone.rotation),
          scale: track(bone.scale),
        })),
      };
      const file = `${createHash('sha1').update(key).digest('hex').slice(0, 20)}.json`;
      const text = JSON.stringify(asset);
      writeFileSync(`${OUT}/${file}`, text);
      manifest[key] = file;
      animated++;
      bytes += Buffer.byteLength(text);
    } catch {
      // A malformed/non-M2 doodad remains static, matching the geometry bake's fallback.
    }
  }
} finally {
  archives.close();
}
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest));
console.log(
  `Doodad skeleton bake: ${animated}/${sources.size} source models, ` +
  `${(bytes / 1048576).toFixed(1)} MB shared animation data.`,
);
