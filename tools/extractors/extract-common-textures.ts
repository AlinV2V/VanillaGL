/** One-off: extract Interface\Common BLPs (input borders etc.) to public/ui. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openClientArchive } from '@vanillagl/assets';
import { Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import { encodePng } from '../utils/png.ts';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const OUT = fileURLToPath(new URL('../../apps/client/public/ui/Interface/Common', import.meta.url));

const archive = await openClientArchive(CACHE, 'interface.MPQ');
const files = archive.list('Interface\\Common\\*.blp');
console.log('Common files:', files);
mkdirSync(OUT, { recursive: true });
for (const file of files) {
  const name = file.split('\\').pop()!.replace(/\.blp$/i, '.png');
  const blp = new Blp().load(archive.extract(file));
  const img = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
  writeFileSync(`${OUT}/${name}`, encodePng(img.width, img.height, img.data));
  console.log('wrote', name, `${img.width}x${img.height}`);
}
archive.close();
