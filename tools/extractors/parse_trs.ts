import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  MINIMAP_INDEX_PATH,
  MINIMAP_TRANSLATION_PATH,
  parseMinimapTranslation,
} from '../utils/minimap-index.ts';

function main() {
  if (!existsSync(MINIMAP_TRANSLATION_PATH)) {
    throw new Error(`Missing translation file: ${MINIMAP_TRANSLATION_PATH}`);
  }

  const content = readFileSync(MINIMAP_TRANSLATION_PATH, 'utf8');
  const index = parseMinimapTranslation(content);
  const maps = Object.keys(index.maps);
  const tiles = Object.values(index.maps).reduce((sum, entries) => sum + Object.keys(entries).length, 0);
  if (!maps.length || !tiles) {
    throw new Error(`No minimap mappings parsed from ${MINIMAP_TRANSLATION_PATH}`);
  }

  writeFileSync(MINIMAP_INDEX_PATH, JSON.stringify(index, null, 2));
  console.log(`Successfully compiled minimap tile index: ${maps.length} maps, ${tiles} tiles`);
  for (const mapName of maps) {
    console.log(`  Map "${mapName}": ${Object.keys(index.maps[mapName]).length} tiles mapped.`);
  }
  console.log(`Saved index to ${MINIMAP_INDEX_PATH}`);
}

try {
  main();
} catch (error) {
  console.error('FATAL', error);
  process.exitCode = 1;
}
