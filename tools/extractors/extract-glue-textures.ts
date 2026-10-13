import path from 'node:path';
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import { encodePng } from '../utils/png.ts';

const SRC_DIR = (process.env.DATA_SOURCE_DIR || path.join(process.cwd(), 'data'));
const OUT_DIR = fileURLToPath(new URL('../../apps/client/public/login/textures', import.meta.url));

async function main() {
  console.log(`Scanning for BLP files in ${SRC_DIR}...`);
  mkdirSync(OUT_DIR, { recursive: true });

  const files = readdirSync(SRC_DIR).filter((f) => f.toLowerCase().endsWith('.blp'));
  console.log(`Found ${files.length} BLP files to convert.`);

  let count = 0;
  let failed = 0;

  for (const file of files) {
    const srcPath = `${SRC_DIR}\\${file}`;
    const destName = file.substring(0, file.length - 4) + '.png';
    const destPath = `${OUT_DIR}/${destName}`;

    try {
      const blp = new Blp().load(srcPath);
      const img = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
      const png = encodePng(img.width, img.height, img.data);
      writeFileSync(destPath, png);
      count++;
      if (count % 50 === 0 || count === files.length) {
        console.log(`Converted ${count}/${files.length} files...`);
      }
    } catch (e) {
      failed++;
      console.error(`Failed to convert ${file}: ${(e as Error).message}`);
    }
  }

  console.log(`Conversion completed! Converted: ${count}, Failed: ${failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
