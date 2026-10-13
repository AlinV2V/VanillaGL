/**
 * Stage the client DBCs consumed by runtime metadata bakers.
 *
 * Everything written by this script lives under ignored `data/dbcs/` and is
 * derived from the user's own locally supplied client archives.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ClientArchiveSet, DbcFile, openClientArchive } from '@vanillagl/assets';

const ROOT = process.cwd();
const CACHE = process.env.WOW_DBC_ROOT || path.join(ROOT, '.client-cache');
const OUT = process.env.DBC_SOURCE_DIR || path.join(ROOT, 'data', 'dbcs');

type TableSpec = {
  name: string;
  stringFields?: readonly number[];
  /** Read the original Build 5875 table when downstream code uses fixed column offsets. */
  baseOnly?: boolean;
};

const TABLES: readonly TableSpec[] = [
  { name: 'Map', stringFields: [1, 4] },
  { name: 'AreaTable', stringFields: [11] },
  { name: 'AreaTrigger' },
  { name: 'WorldMapArea', stringFields: [3] },
  { name: 'WorldMapContinent' },
  { name: 'WorldMapOverlay', stringFields: [8] },
  { name: 'AreaPOI', stringFields: [10, 28] },
  { name: 'Emotes', stringFields: [1] },
  { name: 'EmotesText', stringFields: [1] },
  { name: 'FactionTemplate' },
  { name: 'Faction', stringFields: [19, 28] },
  { name: 'SkillLine', stringFields: [3] },
  { name: 'SkillLineCategory', stringFields: [1] },
  { name: 'CharStartOutfit' },
  { name: 'TransportAnimation' },
  { name: 'TaxiNodes', stringFields: [5] },
  { name: 'TaxiPath' },
  { name: 'TaxiPathNode' },
  { name: 'CinematicCamera' },
  { name: 'CinematicSequences' },
  // GameObjectDisplayInfo's consumer remains pinned to its verified base layout.
  { name: 'GameObjectDisplayInfo', stringFields: [1], baseOnly: true },
  {
    name: 'ItemDisplayInfo',
    // The patch-resolved Build 5875 table retains the same 23-field/92-byte schema and adds the
    // post-base item rows used by raids. Fields: model L/R, texture L/R, inventory icon, then the
    // eight character texture-component strings used by equipment composition.
    stringFields: [1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19],
  },
] as const;

type JsonRecord = Record<string, number | string>;

function serializeTable(name: string, bytes: Uint8Array, stringFields: readonly number[] = []) {
  const dbc = new DbcFile(bytes);
  const physicalFieldCount = Math.floor(dbc.recordSize / 4);
  const records: JsonRecord[] = [];

  for (let row = 0; row < dbc.recordCount; row++) {
    const record: JsonRecord = {};
    for (let field = 0; field < physicalFieldCount; field++) {
      record[`field_${field}`] = dbc.getUint(row, field);
    }
    for (const field of stringFields) {
      if (field >= physicalFieldCount) continue;
      record[`field_${field}_str`] = dbc.getString(row, field);
    }
    records.push(record);
  }

  return {
    table: name,
    header: {
      recordCount: dbc.recordCount,
      fieldCount: dbc.fieldCount,
      physicalFieldCount,
      recordSize: dbc.recordSize,
      stringBlockSize: dbc.stringBlockSize,
    },
    records,
  };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const archives = await ClientArchiveSet.open(CACHE, ['dbc.MPQ']);
  const base = await openClientArchive(CACHE, 'dbc.MPQ');
  try {
    for (const table of TABLES) {
      const archivePath = `DBFilesClient\\${table.name}.dbc`;
      const source = table.baseOnly ? base : archives;
      if (!source.has(archivePath)) throw new Error(`Required client table not found: ${archivePath}`);
      const bytes = source.extract(archivePath);
      writeFileSync(path.join(OUT, `${table.name}.dbc`), bytes);
      const json = serializeTable(table.name, bytes, table.stringFields);
      writeFileSync(path.join(OUT, `${table.name}.json`), JSON.stringify(json), 'utf8');
      console.log(
        `staged ${table.name}.dbc: ${json.header.recordCount} rows / ${json.header.recordSize} bytes per row` +
        (table.baseOnly ? ' [base Build 5875 schema]' : ''),
      );
    }
  } finally {
    archives.close();
    base.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
