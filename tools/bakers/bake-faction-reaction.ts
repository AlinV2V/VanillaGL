/** Asset conversion utility. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DBC_DIR = (process.env.DBC_SOURCE_DIR || path.join(process.cwd(), 'data/dbcs'));
const OUT = fileURLToPath(new URL('../../apps/client/public/data/faction-templates.json', import.meta.url));

type DbcRecord = Record<string, number | string>;

function readDbc(name: string): DbcRecord[] {
  const json = JSON.parse(readFileSync(`${DBC_DIR}/${name}.json`, 'utf8'));
  return json.records ?? [];
}

function n(record: DbcRecord, field: number): number {
  return Number(record[`field_${field}`] ?? 0);
}

function main(): void {
  const records = readDbc('FactionTemplate');
  if (!records.length) throw new Error('FactionTemplate.dbc produced no records');

  // Compact tuple per template, keyed by template ID:
  //   [faction, ourMask, friendlyMask, hostileMask, enemyFactions[], friendFactions[]]
  // Zero enemy/friend faction slots are dropped to keep the table small.
  const table: Record<number, [number, number, number, number, number[], number[]]> = {};
  for (const rec of records) {
    const id = n(rec, 0);
    const faction = n(rec, 1);
    const ourMask = n(rec, 3);
    const friendlyMask = n(rec, 4);
    const hostileMask = n(rec, 5);
    const enemyFactions = [n(rec, 6), n(rec, 7), n(rec, 8), n(rec, 9)].filter((v) => v !== 0);
    const friendFactions = [n(rec, 10), n(rec, 11), n(rec, 12), n(rec, 13)].filter((v) => v !== 0);
    table[id] = [faction, ourMask, friendlyMask, hostileMask, enemyFactions, friendFactions];
  }

  mkdirSync(fileURLToPath(new URL('../../apps/client/public/data/', import.meta.url)), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ version: 1, templates: table }, null, 2), 'utf8');
  console.log(`Wrote ${Object.keys(table).length} faction templates -> ${OUT}`);
}

main();
