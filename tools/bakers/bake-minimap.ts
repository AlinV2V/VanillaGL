/** Asset conversion utility. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClientArchiveSet } from '@vanillagl/assets';
import { Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import { encodePng } from '../utils/png.ts';
import { CACHE_DIR, PUBLIC_DIR } from '../utils/paths.ts';
import {
  MINIMAP_INDEX_PATH,
  findMinimapMap,
  minimapArchivePath,
  type MinimapIndex,
} from '../utils/minimap-index.ts';

const PUBLIC = join(PUBLIC_DIR, 'minimap');

async function main() {
  console.log('=== bake-minimap ===');
  const maps = (JSON.parse(readFileSync(MINIMAP_INDEX_PATH, 'utf8')) as MinimapIndex).maps;
  if (!maps || typeof maps !== 'object' || Object.keys(maps).length === 0) {
    throw new Error(`Minimap index is empty or invalid: ${MINIMAP_INDEX_PATH}`);
  }

  // Keep this list in step with MINIMAP_DIR in apps/client/src/main.ts — those are the maps the
  // client can actually put a player on, and verify-public-assets.mjs gates exactly that set.
  const DEFAULT_MAPS = 'Azeroth,Kalimdor,Pvpzone01,Shadowfang,Deadminesinstance,Monasteryinstances';
  const wanted = (process.env.MINIMAP_MAPS ?? DEFAULT_MAPS).split(',').map((s) => s.trim()).filter(Boolean);

  // Minimap BLPs are content assets, so patch archives must shadow texture.MPQ.
  const texture = await ClientArchiveSet.open(CACHE_DIR, ['texture.MPQ']);
  try {
    for (const requestedMapName of wanted) {
      const resolved = findMinimapMap(maps, requestedMapName);
      if (!resolved) {
        console.warn(`  skip "${requestedMapName}" — not in minimap_tile_index.json (have: ${Object.keys(maps).slice(0, 6).join(', ')}...)`);
        continue;
      }

      const { name: sourceMapName, tiles } = resolved;
      const entries = Object.entries(tiles);
      if (!entries.length) {
        throw new Error(`Minimap index contains an empty map entry: ${sourceMapName}`);
      }

      const outDir = join(PUBLIC, requestedMapName);
      mkdirSync(outDir, { recursive: true });

      let baked = 0;
      let missing = 0;
      const present: string[] = [];
      for (const [key, physicalName] of entries) {
        if (!/^\d+_\d+$/.test(key) || typeof physicalName !== 'string' || !physicalName.trim()) {
          throw new Error(`Invalid minimap tile mapping ${sourceMapName}.${key}: ${JSON.stringify(physicalName)}`);
        }

        const archivePath = minimapArchivePath(physicalName);
        if (!texture.has(archivePath)) {
          missing++;
          continue;
        }
        try {
          const blp = new Blp().load(texture.extract(archivePath));
          const img = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
          writeFileSync(join(outDir, `${key}.png`), encodePng(img.width, img.height, img.data));
          present.push(key);
          baked++;
        } catch (error) {
          missing++;
          console.warn(`  ${sourceMapName} ${key}: failed to decode ${archivePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (baked === 0) {
        throw new Error(
          `Minimap map ${sourceMapName} resolved ${entries.length} indexed tiles but none existed/decoded in the patch-aware texture archive set`,
        );
      }

      present.sort((a, b) => {
        const [ax, ay] = a.split('_').map(Number);
        const [bx, by] = b.split('_').map(Number);
        return ax - bx || ay - by;
      });
      writeFileSync(
        join(outDir, 'manifest.json'),
        JSON.stringify({ map: requestedMapName, sourceMap: sourceMapName, tileSize: 256, tiles: present }),
      );
      console.log(`  ${requestedMapName}: ${baked} tiles baked, ${missing} missing (of ${entries.length})`);
    }
  } finally {
    texture.close();
  }

  console.log('done.');
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
