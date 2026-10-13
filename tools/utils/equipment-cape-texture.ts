/** Patch-aware extraction of ItemDisplayInfo's standalone cloak replacement texture. */
import { writeFileSync } from 'node:fs';
import { Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import type { MpqArchive } from '@vanillagl/assets';
import { encodePng } from './png.ts';

const BS = String.fromCharCode(92);

export function bakeCapeTexture(archives: readonly MpqArchive[], outDir: string, authoredName: string): string | null {
  if (!authoredName) return null;
  const stem = authoredName.replace(/\.(?:blp|tga)$/i, '');
  const path = ['Item', 'ObjectComponents', 'Cape', `${stem}.blp`].join(BS);
  const archive = archives.find((candidate) => candidate.has(path));
  if (!archive) return null;
  try {
    const image = new Blp().load(archive.extract(path)).getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
    const file = 'cape.png';
    writeFileSync(`${outDir}${BS}${file}`, encodePng(image.width, image.height, image.data));
    return file;
  } catch {
    return null;
  }
}
