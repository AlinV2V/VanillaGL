/** Asset conversion utility. */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import { encodePng } from '../utils/png.ts';

const SRC_ROOT = (process.env.EXTRACTED_INTERFACE_DIR || path.join(process.cwd(), 'data/extracted/Interface'));
const DST_ROOT = path.join(process.cwd(), path.join(process.cwd(), 'apps/client/public/ui/Interface'));
const DIRS = ['WorldMap', 'Minimap'];

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (/\.blp$/i.test(entry.name)) out.push(full);
  }
  return out;
}

let converted = 0;
for (const dir of DIRS) {
  const srcDir = path.join(SRC_ROOT, dir);
  if (!existsSync(srcDir)) continue;
  for (const file of await walk(srcDir)) {
    const rel = path.relative(SRC_ROOT, file);
    const dst = path.join(DST_ROOT, rel).replace(/\.blp$/i, '.png');
    const blp = new Blp().load(new Uint8Array(await readFile(file)));
    const img = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
    await mkdir(path.dirname(dst), { recursive: true });
    await writeFile(dst, encodePng(img.width, img.height, img.data));
    converted++;
  }
}

console.log(`Converted ${converted} WorldMap/Minimap BLP assets to ${DST_ROOT}`);
