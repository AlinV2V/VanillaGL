/** Asset conversion utility. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import { openClientArchive } from '@vanillagl/assets';
import { encodePng } from '../utils/png.ts';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const DST_BASE = fileURLToPath(new URL('../../apps/client/public/XTextures', import.meta.url));

const sequences = [
  { dir: 'river', base: 'lake_a' },
  { dir: 'ocean', base: 'ocean_h' },
  { dir: 'lava', base: 'lava' },
  { dir: 'slime', base: 'slime' },
] as const;

async function main() {
  console.log('=== convert-liquids (vanilla MCLQ XTextures) ===');
  const texture = await openClientArchive(CACHE, 'texture.MPQ');
  let converted = 0;
  let missing = 0;

  try {
    for (const seq of sequences) {
      const outDir = join(DST_BASE, seq.dir);
      mkdirSync(outDir, { recursive: true });

      for (let frame = 1; frame <= 30; frame++) {
        const mpqPath = `XTextures\\${seq.dir}\\${seq.base}.${frame}.blp`;
        const outPath = join(outDir, `${seq.base}.${frame}.png`);
        if (existsSync(outPath)) continue;

        if (!texture.has(mpqPath)) {
          console.warn(`missing ${mpqPath}`);
          missing++;
          continue;
        }

        const blp = new Blp().load(texture.extract(mpqPath));
        const img = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, encodePng(img.width, img.height, img.data));
        converted++;
      }
    }
  } finally {
    texture.close();
  }

  console.log(`done - converted=${converted}, missing=${missing}`);
  if (missing > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
