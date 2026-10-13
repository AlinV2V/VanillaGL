import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DBC_PATH = process.env.ITEM_DISPLAY_INFO_JSON || path.join(process.cwd(), 'data/dbcs/ItemDisplayInfo.json');
const ICONS_DIR = process.env.EXTRACTED_ICONS_DIR || path.join(process.cwd(), 'apps/client/public/ui/Interface/Icons');
const OUT_PATH = process.env.ITEM_DISPLAY_ICON_OUT || path.join(process.cwd(), 'apps/client/public/items/item-display-icons.json');

const dbc = JSON.parse(await readFile(DBC_PATH, 'utf8'));
const records = Array.isArray(dbc)
  ? dbc
  : Array.isArray(dbc.records)
    ? dbc.records
    : Object.values(dbc.records ?? dbc.rows ?? dbc.data ?? {});

const iconFiles = new Map();
for (const file of await readdir(ICONS_DIR)) {
  if (!/\.png$/i.test(file)) continue;
  const stem = path.basename(file, path.extname(file));
  iconFiles.set(stem.toLowerCase(), stem);
}

const cleanIconName = (value) => String(value ?? '')
  .replace(/^Interface[\\/]+Icons[\\/]+/i, '')
  // A small set of authored 1.12.1 ItemDisplayInfo rows retain the source .tga suffix.
  // Extraction normalizes every supported source texture to PNG, so compare by basename.
  .replace(/\.(?:blp|png|tga)$/i, '')
  .trim();

const map = {};
let matched = 0;
let missing = 0;
for (const record of records) {
  if (!record || typeof record !== 'object') continue;
  const id = Number(record.field_0 ?? record.id);
  if (!Number.isFinite(id) || id <= 0) continue;

  // Build 5875 ItemDisplayInfo field 5 is the inventory icon string.
  const authored = cleanIconName(record.field_5_str ?? record.icon ?? record.icon_str);
  const icon = authored ? iconFiles.get(authored.toLowerCase()) : undefined;
  if (!icon) {
    missing++;
    continue;
  }
  map[String(id)] = icon;
  matched++;
}

await mkdir(path.dirname(OUT_PATH), { recursive: true });
await writeFile(OUT_PATH, JSON.stringify(map));
console.log(`Wrote ${matched} item display icon mappings to ${OUT_PATH} (${missing} displays without a resolved icon).`);

if (matched === 0) {
  throw new Error('No ItemDisplayInfo icon mappings were produced; verify DBC staging and full UI extraction.');
}
