/** Asset conversion utility. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import { ClientArchiveSet, readVanillaM2 } from '@vanillagl/assets';
import { encodePng } from '../utils/png.ts';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const OUT = fileURLToPath(new URL('../../apps/client/public/sky', import.meta.url));
const assets = [
  ['Environments\\Stars\\Stars.blp', 'stars.png'],
  ['Environments\\Stars\\Stars2.blp', 'stars2.png'],
  ['textures\\SunCenter.blp', 'sun-center.png'],
  // The corona/flare halo drawn behind SunCenter. (There is no "SunCorona.blp" in
  // 1.12 texture.MPQ — SunGlare is the authored asset; verified via listfile probe.)
  ['textures\\SunGlare.blp', 'sun-glare.png'],
  ['textures\\moon.blp', 'moon.png'],
] as const;

// Celestial BLPs are content assets, so patch archives must shadow texture.MPQ.
const archive = await ClientArchiveSet.open(CACHE, ['texture.MPQ']);
try {
  mkdirSync(OUT, { recursive: true });
  for (const [source, name] of assets) {
    if (!archive.has(source)) throw new Error(`Missing Vanilla celestial texture: ${source}`);
    const blp = new Blp().load(archive.extract(source));
    const image = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
    writeFileSync(`${OUT}/${name}`, encodePng(image.width, image.height, image.data));
    console.log(`${source} -> sky/${name} (${image.width}x${image.height})`);
  }
} finally {
  archive.close();
}

const models = await ClientArchiveSet.open(CACHE, ['model.MPQ']);
try {
  const model = readVanillaM2(models.extract('Environments\\Stars\\Stars.m2'));
  const parts = model.submeshes
    .filter((part) => part.triangleCount > 0 && part.triangleStart + part.triangleCount <= model.indices.length)
    .map((part) => {
      const weight = part.textureWeight >= 0 ? model.textureWeights[part.textureWeight] : undefined;
      return {
        indices: Array.from(model.indices.subarray(part.triangleStart, part.triangleStart + part.triangleCount)),
        texture: part.textureIndex,
        opacity: weight?.values[0] ?? 1,
        blendMode: part.blendMode,
        renderFlags: part.renderFlags,
      };
    });
  writeFileSync(`${OUT}/stars-model.json`, JSON.stringify({
    positions: Array.from(model.positions),
    uvs: Array.from(model.uvs),
    parts,
  }));
  console.log(`Environments\\Stars\\Stars.m2 -> sky/stars-model.json (${parts.length} layers)`);
} finally {
  models.close();
}