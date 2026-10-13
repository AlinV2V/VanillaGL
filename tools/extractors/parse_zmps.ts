import { openClientArchive } from '@vanillagl/assets';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CACHE_DIR, DBC_DIR, RUNTIME_TERRAIN_DIR } from '../utils/paths.ts';

async function main() {
  const worldMapAreaPath = path.join(DBC_DIR, 'WorldMapArea.json');

  if (!fs.existsSync(worldMapAreaPath)) {
    console.error(`Missing WorldMapArea.json: ${worldMapAreaPath}`);
    return;
  }

  const areas = JSON.parse(fs.readFileSync(worldMapAreaPath, 'utf8')).records;
  const areaMap = new Map<number, string>();
  for (const r of areas) {
    areaMap.set(r.field_0, r.field_3_str || `Zone_${r.field_0}`);
  }

  const archive = await openClientArchive(CACHE_DIR, 'interface.MPQ');
  const zmpFiles = [
    { mapName: 'Azeroth', file: 'Interface\\WorldMap\\Azeroth.zmp' },
    { mapName: 'Kalimdor', file: 'Interface\\WorldMap\\Kalimdor.zmp' },
  ];

  try {
    for (const item of zmpFiles) {
      if (archive.has(item.file)) {
        const bytes = archive.extract(item.file);
        console.log(`\n=== Mappings for ${item.mapName} (${item.file}, ${bytes.length} bytes) ===`);

        const uniqueVals = new Set<number>();
        for (let i = 0; i < bytes.length; i++) uniqueVals.add(bytes[i]);

        console.log(`Unique values in grid (${uniqueVals.size}):`);
        const sortedVals = Array.from(uniqueVals).sort((a, b) => a - b);
        for (const val of sortedVals) {
          const zoneName = areaMap.get(val) || 'Unknown / Unmapped';
          console.log(`  Value ${val} (0x${val.toString(16).padStart(2, '0')}): ${zoneName}`);
        }

        fs.mkdirSync(RUNTIME_TERRAIN_DIR, { recursive: true });
        const outPath = path.join(RUNTIME_TERRAIN_DIR, `${item.mapName.toLowerCase()}_zmp.bin`);
        fs.writeFileSync(outPath, bytes);
        console.log(`Saved ZMP binary to ${outPath}`);
      } else {
        console.log(`Archive does not contain ${item.file}`);
      }
    }
  } finally {
    archive.close();
  }
}

main().catch((error) => {
  console.error('FATAL', error);
  process.exitCode = 1;
});
