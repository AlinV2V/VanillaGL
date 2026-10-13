/**
 * Extract every Interface BLP and required UI font directly from the user's
 * local 1.12.1 archives. Patch archives take precedence over interface/fonts
 * MPQs, matching the client file-resolution order.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClientArchiveSet } from '@vanillagl/assets';
import { Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import { encodePng } from '../utils/png.ts';
import { printProgress } from '../utils/cli-progress.ts';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const OUT_ROOT = fileURLToPath(new URL('../../apps/client/public/ui', import.meta.url));
const MANIFEST = join(OUT_ROOT, 'ui-assets-manifest.json');
const FONT_ASSETS = ['Fonts\\FRIZQT__.TTF', 'Fonts\\MORPHEUS.TTF'] as const;

const normalize = (value: string) => value.replace(/\//g, '\\');
const outputPathFor = (source: string) => {
  const parts = normalize(source).split('\\').filter(Boolean);
  const file = parts.pop()!.replace(/\.blp$/i, '.png');
  return join(OUT_ROOT, ...parts, file);
};

async function main() {
  const archives = await ClientArchiveSet.open(CACHE, ['interface.MPQ', 'fonts.MPQ']);
  try {
    const candidates = archives.list()
      .map(normalize)
      .filter((source) => /^Interface\\/i.test(source) && /\.blp$/i.test(source))
      .sort((a, b) => a.localeCompare(b));

    if (candidates.length === 0) {
      throw new Error('No Interface BLP textures were found in the supplied client archives.');
    }

    let converted = 0;
    const failed: Array<{ source: string; error: string }> = [];
    const progressEvery = Math.max(1, Math.floor(candidates.length / 100));

    for (let index = 0; index < candidates.length; index++) {
      const source = candidates[index];
      if (index === 0 || index === candidates.length - 1 || index % progressEvery === 0) {
        printProgress(index, candidates.length, `Extracting UI artwork (${index + 1}/${candidates.length})`);
      }
      try {
        const blp = new Blp().load(archives.extract(source));
        const image = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
        const out = outputPathFor(source);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, encodePng(image.width, image.height, image.data));
        converted++;
      } catch (error) {
        failed.push({ source, error: error instanceof Error ? error.message : String(error) });
      }
    }

    printProgress(candidates.length, candidates.length, `UI artwork complete (${converted}/${candidates.length})`);

    const extractedFonts: string[] = [];
    for (const source of FONT_ASSETS) {
      if (!archives.has(source)) throw new Error(`Required UI font ${source} is missing from the supplied client.`);
      const out = outputPathFor(source);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, archives.extract(source));
      extractedFonts.push(source);
    }

    mkdirSync(OUT_ROOT, { recursive: true });
    writeFileSync(MANIFEST, JSON.stringify({
      schemaVersion: 1,
      candidates: candidates.length,
      converted,
      fonts: extractedFonts,
      failed,
    }, null, 2));

    const cursor = outputPathFor('Interface\\Cursor\\Point.blp');
    const successRatio = converted / candidates.length;
    if (successRatio < 0.98) {
      throw new Error(`Only ${(successRatio * 100).toFixed(1)}% of Interface BLPs converted successfully.`);
    }
    if (!archives.has('Interface\\Cursor\\Point.blp')) {
      throw new Error('Required cursor asset Interface\\Cursor\\Point.blp is missing from the supplied client.');
    }
    // The conversion above writes the same path with a PNG extension. Keeping this
    // assertion here makes cursor failures visible during setup rather than at runtime.
    if (failed.some((entry) => entry.source.toLowerCase() === 'interface\\cursor\\point.blp')) {
      throw new Error(`Required cursor asset failed to decode: ${cursor}`);
    }

    if (failed.length) {
      console.warn(`UI extraction completed with ${failed.length} non-fatal decode failure(s); see ui-assets-manifest.json.`);
    }
  } finally {
    archives.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
