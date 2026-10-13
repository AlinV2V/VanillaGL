/** Build skill/category display metadata from the user's local DBCs. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DBC_DIR = process.env.DBC_SOURCE_DIR || path.join(process.cwd(), 'data', 'dbcs');
const OUT_DIR = path.join(process.cwd(), 'apps', 'client', 'public', 'data');
const OUT = path.join(OUT_DIR, 'skill-lines.json');

type DbcRecord = Record<string, number | string>;
type StagedDbc = { records?: DbcRecord[] };
type SkillLineMeta = { name: string; categoryId: number };

function load(name: string): DbcRecord[] {
  const input = JSON.parse(readFileSync(path.join(DBC_DIR, `${name}.json`), 'utf8')) as StagedDbc;
  return input.records ?? [];
}

const lines = load('SkillLine');
const categories = load('SkillLineCategory');
if (!lines.length || !categories.length) {
  throw new Error(`Missing skill metadata rows: SkillLine=${lines.length}, SkillLineCategory=${categories.length}`);
}

const n = (row: DbcRecord, field: number) => Number(row[`field_${field}`] ?? 0);
const s = (row: DbcRecord, field: number) => String(row[`field_${field}_str`] ?? '').trim();
const skillCategories: Record<number, string> = {};
const skillLines: Record<number, SkillLineMeta> = {};

for (const row of categories) {
  const id = n(row, 0);
  const name = s(row, 1);
  if (id && name) skillCategories[id] = name;
}
for (const row of lines) {
  const id = n(row, 0);
  const categoryId = n(row, 1);
  const name = s(row, 3);
  if (id && name) skillLines[id] = { name, categoryId };
}

if (!Object.keys(skillCategories).length || !Object.keys(skillLines).length) {
  throw new Error('No usable skill/category rows were decoded');
}
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, JSON.stringify({ version: 1, skillCategories, skillLines }, null, 2), 'utf8');
console.log(
  `skills: ${Object.keys(skillLines).length} lines / ${Object.keys(skillCategories).length} categories -> ${OUT}`,
);
