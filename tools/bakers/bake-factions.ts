/** Build reputation UI metadata from the user's local Faction.dbc. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DBC_DIR = process.env.DBC_SOURCE_DIR || path.join(process.cwd(), 'data', 'dbcs');
const OUT_DIR = path.join(process.cwd(), 'apps', 'client', 'public', 'data');
const OUT = path.join(OUT_DIR, 'factions.json');

type DbcRecord = Record<string, number | string>;
type FactionMeta = {
  id: number;
  reputationListId: number;
  parentFactionId: number;
  name: string;
  description: string;
};
type StagedDbc = { records?: DbcRecord[] };

const input = JSON.parse(readFileSync(path.join(DBC_DIR, 'Faction.json'), 'utf8')) as StagedDbc;
const records = input.records ?? [];
if (!records.length) throw new Error('Faction.dbc produced no rows');

const n = (row: DbcRecord, field: number) => Number(row[`field_${field}`] ?? 0);
const s = (row: DbcRecord, field: number) => String(row[`field_${field}_str`] ?? '');
const factionsByReputationIndex: Record<number, FactionMeta> = {};

for (const row of records) {
  const id = n(row, 0);
  const reputationListId = Number((n(row, 1) << 0));
  if (!id || reputationListId < 0) continue;
  factionsByReputationIndex[reputationListId] = {
    id,
    reputationListId,
    parentFactionId: n(row, 18),
    name: s(row, 19),
    // Descriptions are not required by the current UI, so do not persist them.
    description: '',
  };
}

if (!Object.keys(factionsByReputationIndex).length) {
  throw new Error('No reputation-list factions were decoded');
}
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, JSON.stringify({ version: 1, factionsByReputationIndex }, null, 2), 'utf8');
console.log(`factions: ${Object.keys(factionsByReputationIndex).length} reputation rows -> ${OUT}`);
