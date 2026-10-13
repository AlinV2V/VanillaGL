/** Asset conversion utility. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import { ClientArchiveSet } from '@vanillagl/assets';
import { encodePng } from '../utils/png.ts';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const OUT = fileURLToPath(new URL('../../apps/client/public/ui/Interface/SpellShadow', import.meta.url));
const ASSETS = [
  'Interface\\SpellShadow\\Spell-Shadow-Acceptable.blp',
  'Interface\\SpellShadow\\Spell-Shadow-Unacceptable.blp',
] as const;

const archives = await ClientArchiveSet.open(CACHE, ['interface.MPQ']);
mkdirSync(OUT, { recursive: true });
try {
  for (const source of ASSETS) {
    const blp = new Blp().load(archives.extract(source));
    const image = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
    const filename = source.split('\\').at(-1)!.replace(/\.blp$/i, '.png');
    writeFileSync(`${OUT}/${filename}`, encodePng(image.width, image.height, image.data));
    console.log(`${source} -> ${filename} (${image.width}x${image.height})`);
  }
} finally {
  archives.close();
}
