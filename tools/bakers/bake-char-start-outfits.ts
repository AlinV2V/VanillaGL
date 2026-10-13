/** Build the character-creation outfit fallback from the user's local DBC. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DBC_DIR = process.env.DBC_SOURCE_DIR || path.join(process.cwd(), 'data', 'dbcs');
const OUT_DIR = path.join(process.cwd(), 'apps', 'client', 'public', 'data');
const OUT = path.join(OUT_DIR, 'char-start-outfits.json');

type DbcRecord = Record<string, number | string>;
type StarterOutfitItem = { displayInfoId: number; inventoryType: number };
type StagedDbc = {
  header?: { recordCount?: number; fieldCount?: number; physicalFieldCount?: number; recordSize?: number };
  records?: DbcRecord[];
};

const input = JSON.parse(readFileSync(path.join(DBC_DIR, 'CharStartOutfit.json'), 'utf8')) as StagedDbc;
const records = input.records ?? [];
if (!records.length) throw new Error('CharStartOutfit.dbc produced no rows');
if ((input.header?.recordSize ?? 0) < 152 || (input.header?.physicalFieldCount ?? 0) < 38) {
  throw new Error(`Unsupported CharStartOutfit.dbc layout: ${JSON.stringify(input.header ?? {})}`);
}

const n = (row: DbcRecord, field: number) => Number(row[`field_${field}`] ?? 0);
const outfits: Record<string, StarterOutfitItem[]> = {};

for (const row of records) {
  // Vanilla stores race/class/gender/outfitId as four packed bytes in physical field 1.
  const packed = n(row, 1) >>> 0;
  const race = packed & 0xff;
  const classId = (packed >>> 8) & 0xff;
  const gender = (packed >>> 16) & 0xff;
  const outfitId = (packed >>> 24) & 0xff;
  if (!race || !classId || gender > 1) continue;

  const items: StarterOutfitItem[] = [];
  for (let i = 0; i < 12; i++) {
    const displayInfoId = n(row, 14 + i);
    const inventoryType = n(row, 26 + i);
    if (displayInfoId > 0 && inventoryType > 0) items.push({ displayInfoId, inventoryType });
  }

  const key = `${race}:${classId}:${gender}`;
  // Stock rows use outfitId 0. If a custom client contains multiple variants,
  // prefer variant 0 and otherwise keep the first usable row.
  if (!(key in outfits) || outfitId === 0) outfits[key] = items;
}

if (!Object.keys(outfits).length) throw new Error('No starter outfit rows were decoded');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, JSON.stringify({ version: 1, outfits }, null, 2), 'utf8');
console.log(`starter outfits: ${Object.keys(outfits).length} race/class/gender combinations -> ${OUT}`);
