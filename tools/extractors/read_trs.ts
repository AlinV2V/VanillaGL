import { ClientArchiveSet } from '@vanillagl/assets';
import { writeFileSync } from 'node:fs';
import { CACHE_DIR } from '../utils/paths.ts';
import { MINIMAP_TRANSLATION_PATH, MINIMAP_TRS_ARCHIVE_PATH } from '../utils/minimap-index.ts';

async function main() {
  const archives = await ClientArchiveSet.open(CACHE_DIR, ['texture.MPQ']);
  try {
    if (!archives.has(MINIMAP_TRS_ARCHIVE_PATH)) {
      throw new Error(`${MINIMAP_TRS_ARCHIVE_PATH} not found in patch-aware texture archives`);
    }
    const text = new TextDecoder('utf-8').decode(archives.extract(MINIMAP_TRS_ARCHIVE_PATH));
    writeFileSync(MINIMAP_TRANSLATION_PATH, text);
    console.log(`Saved ${MINIMAP_TRS_ARCHIVE_PATH} to ${MINIMAP_TRANSLATION_PATH}`);
  } finally {
    archives.close();
  }
}

main().catch((error) => {
  console.error('FATAL', error);
  process.exitCode = 1;
});
