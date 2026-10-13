import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClientArchiveSet, DbcFile } from '@vanillagl/assets';
import { printProgress } from '../utils/cli-progress.ts';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CACHE = join(ROOT, '.client-cache');
const OUTPUT = process.env.ADT_SCAN_JSON
  ?? join(process.env.DATA_SOURCE_DIR ?? join(ROOT, 'data'), 'starter_adt_tiles_chunks_all.json');
const MHDR_BASE = 0x14;
const AREA_TABLE = 'DBFilesClient\\AreaTable.dbc';

function readAreaNames(bytes: Uint8Array): Map<number, string> {
  const dbc = new DbcFile(bytes);
  const names = new Map<number, string>();
  for (let row = 0; row < dbc.recordCount; row++) {
    const id = dbc.getUint(row, 0);
    if (id) names.set(id, dbc.getString(row, 11));
  }
  return names;
}

function parseAdtIdentity(name: string): { map: string; x: number; y: number } | null {
  const normalized = name.replace(/\//g, '\\');
  const match = /World\\Maps\\([^\\]+)\\[^\\]+_(\d+)_(\d+)\.adt$/i.exec(normalized);
  if (!match) return null;
  return { map: match[1], x: Number(match[2]), y: Number(match[3]) };
}

function collectAreaIds(data: Uint8Array): number[] {
  if (data.byteLength < MHDR_BASE + 64) return [];
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ofsMcinRelative = dv.getUint32(MHDR_BASE + 4, true);
  const ofsMcin = ofsMcinRelative > 0 ? MHDR_BASE + ofsMcinRelative : -1;
  if (ofsMcin < 0 || ofsMcin + 8 + 256 * 16 > data.length) return [];

  const areaIds = new Set<number>();
  for (let chunkIndex = 0; chunkIndex < 256; chunkIndex++) {
    const entry = ofsMcin + 8 + chunkIndex * 16;
    const mcnkOffset = dv.getUint32(entry, true);
    if (mcnkOffset <= 0 || mcnkOffset + 8 + 56 > data.length) continue;
    const areaId = dv.getUint32(mcnkOffset + 8 + 52, true);
    if (areaId > 0) areaIds.add(areaId);
  }
  return [...areaIds].sort((a, b) => a - b);
}

async function main() {
  console.log('=== scan ADT coverage ===');
  const terrain = await ClientArchiveSet.open(CACHE, ['terrain.MPQ']);
  const dbc = await ClientArchiveSet.open(CACHE, ['dbc.MPQ']);
  try {
    const areaNames = readAreaNames(dbc.extract(AREA_TABLE));
    const adts = terrain.list()
      .filter((name) => /\.adt$/i.test(name) && parseAdtIdentity(name))
      .sort((a, b) => a.localeCompare(b));

    const tiles: Array<{
      adt: string;
      map: string;
      x: number;
      y: number;
      areaIds: number[];
      areaNames: string[];
    }> = [];

    for (let index = 0; index < adts.length; index++) {
      const adt = adts[index];
      if (index % 25 === 0 || index + 1 === adts.length) {
        printProgress(index + 1, adts.length, `Scanning terrain ${index + 1}/${adts.length}`);
      }
      const identity = parseAdtIdentity(adt);
      if (!identity) continue;
      try {
        const areaIds = collectAreaIds(terrain.extract(adt));
        tiles.push({
          adt,
          ...identity,
          areaIds,
          areaNames: areaIds.map((id) => areaNames.get(id) || `Unknown (${id})`),
        });
      } catch (error) {
        console.warn(`Skipping unreadable ADT ${adt}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    mkdirSync(dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, JSON.stringify({ totalTiles: tiles.length, tiles }, null, 2));
    console.log(`Saved ${tiles.length} patch-resolved ADT records to ${OUTPUT}`);
  } finally {
    terrain.close();
    dbc.close();
  }
}

main().catch((error) => {
  console.error('ADT scan failed:', error);
  process.exit(1);
});
