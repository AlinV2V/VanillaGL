/** Asset conversion utility. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import { ClientArchiveSet } from '@vanillagl/assets';
import { encodePng } from '../utils/png.ts';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const OUT = fileURLToPath(new URL('../../apps/client/public/weather', import.meta.url));
const assets = [
  ['Spells\\snowflake2.blp', 'snowflake.png'],
  ['textures\\Weather\\RainDrop01.blp', 'rain-drop.png'],
  ['textures\\Weather\\RainDropSplash01.blp', 'rain-splash.png'],
  ['textures\\Weather\\SnowMist01.blp', 'rain-mist.png'],
] as const;

// Weather BLPs are content assets, so patches must shadow texture.MPQ.
const archive = await ClientArchiveSet.open(CACHE, ['texture.MPQ']);
try {
  mkdirSync(OUT, { recursive: true });
  for (const [source, name] of assets) {
    if (!archive.has(source)) throw new Error(`Missing weather texture: ${source}`);
    const blp = new Blp().load(archive.extract(source));
    const image = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
    writeFileSync(`${OUT}/${name}`, encodePng(image.width, image.height, image.data));
    console.log(`${source} -> weather/${name} (${image.width}x${image.height})`);
  }
} finally {
  archive.close();
}
