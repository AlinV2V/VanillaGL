/** Bake compact native quest-map shards from the official vMaNGOS Build 5875 world database. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

type MapArea = {
  worldMapAreaId: number; mapId: number; areaTableId: number; zoneName: string;
  bounds: { y1_west: number; y2_east: number; x1_north: number; x2_south: number };
};
type QuestRow = Record<string, string | number> & {
  entry: number; Title: string; MinLevel: number; QuestLevel: number; RequiredClasses: number;
  RequiredRaces: number; PrevQuestId: number; RequiredSkill: number; RequiredCondition: number;
  RequiredMinRepFaction: number; RequiredMaxRepFaction: number;
};
type Spawn = { map: number; position_x: number; position_y: number };
type RawMarker = { questId: number; kind: 0 | 1 | 2; objective: number; mapId: number; x: number; y: number };
type MarkerTuple = [questId: number, kind: 0 | 1 | 2, objective: number, worldX: number, worldY: number];
type QuestTuple = [id: number, title: string, minLevel: number, level: number, classMask: number, raceMask: number, prerequisite: number];

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CACHE = join(ROOT, '.client-cache', 'alpha-readiness');
const OUT = join(ROOT, 'apps', 'client', 'public', 'questie-lite');
const MAP_COORDS = join(ROOT, 'apps', 'client', 'public', 'terrain', 'world_map_coords.json');
const PATCH_112 = 10;

function findWorldDb() {
  if (process.env.QUESTIE_WORLD_DB) return resolve(process.env.QUESTIE_WORLD_DB);
  if (!existsSync(CACHE)) return null;
  const candidates: string[] = [];
  for (const entry of readdirSync(CACHE, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(CACHE, entry.name, 'sqlite-dump', 'mangos.sqlite');
    if (existsSync(path)) candidates.push(path);
  }
  return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

const dbPath = findWorldDb();
if (!dbPath) throw new Error('No official vMaNGOS SQLite DB. Run npm run audit:alpha:source first.');
if (!existsSync(MAP_COORDS)) throw new Error(`World-map coordinate catalog missing: ${MAP_COORDS}`);

const db = new DatabaseSync(dbPath, { readOnly: true });
const areas = (JSON.parse(readFileSync(MAP_COORDS, 'utf8')) as { areas: MapArea[] }).areas;
const mapAreas = areas.filter((area) => area.areaTableId !== 0);
const active = (table: string) => db.prepare(`SELECT * FROM ${table} WHERE patch_min<=? AND patch_max>=?`).all(PATCH_112, PATCH_112) as Record<string, number>[];
const quests = db.prepare(`SELECT * FROM (
  SELECT *,ROW_NUMBER() OVER(PARTITION BY entry ORDER BY patch DESC) _rn
  FROM quest_template WHERE patch<=?
) WHERE _rn=1 AND Method!=1 AND QuestLevel<=60 AND ZoneOrSort NOT IN (-368,-369)`).all(PATCH_112) as QuestRow[];
const questIds = new Set(quests.map((quest) => quest.entry));

const relation = (table: string) => {
  const byQuest = new Map<number, number[]>();
  for (const row of active(table)) {
    if (!questIds.has(row.quest)) continue;
    const list = byQuest.get(row.quest) ?? [];
    list.push(row.id);
    byQuest.set(row.quest, list);
  }
  return byQuest;
};

const creatureStarts = relation('creature_questrelation');
const creatureEnds = relation('creature_involvedrelation');
const objectStarts = relation('gameobject_questrelation');
const objectEnds = relation('gameobject_involvedrelation');
const creatureSpawns = new Map<number, Spawn[]>();
const objectSpawns = new Map<number, Spawn[]>();

for (const row of active('creature')) {
  for (const id of [row.id, row.id2, row.id3, row.id4, row.id5]) {
    if (!id) continue;
    const list = creatureSpawns.get(id) ?? [];
    list.push(row as unknown as Spawn);
    creatureSpawns.set(id, list);
  }
}
for (const row of active('gameobject')) {
  const list = objectSpawns.get(row.id) ?? [];
  list.push(row as unknown as Spawn);
  objectSpawns.set(row.id, list);
}

const creatureLootIds = new Map<number, number[]>();
for (const row of db.prepare(`SELECT entry,loot_id FROM (
  SELECT entry,loot_id,ROW_NUMBER() OVER(PARTITION BY entry ORDER BY patch DESC) _rn
  FROM creature_template WHERE patch<=?
) WHERE _rn=1 AND loot_id>0`).all(PATCH_112) as Array<{ entry: number; loot_id: number }>) {
  const list = creatureLootIds.get(row.loot_id) ?? [];
  list.push(row.entry);
  creatureLootIds.set(row.loot_id, list);
}
const objectLootIds = new Map<number, number[]>();
for (const row of db.prepare(`SELECT entry,data1 FROM (
  SELECT entry,data1,ROW_NUMBER() OVER(PARTITION BY entry ORDER BY patch DESC) _rn
  FROM gameobject_template WHERE patch<=?
) WHERE _rn=1 AND data1>0`).all(PATCH_112) as Array<{ entry: number; data1: number }>) {
  const list = objectLootIds.get(row.data1) ?? [];
  list.push(row.entry);
  objectLootIds.set(row.data1, list);
}

const creatureItemSources = new Map<number, Set<number>>();
for (const row of active('creature_loot_template')) {
  if (row.item <= 0) continue;
  const targets = creatureItemSources.get(row.item) ?? new Set<number>();
  for (const creatureId of creatureLootIds.get(row.entry) ?? [row.entry]) targets.add(creatureId);
  creatureItemSources.set(row.item, targets);
}
const objectItemSources = new Map<number, Set<number>>();
for (const row of active('gameobject_loot_template')) {
  if (row.item <= 0) continue;
  const targets = objectItemSources.get(row.item) ?? new Set<number>();
  for (const objectId of objectLootIds.get(row.entry) ?? [row.entry]) targets.add(objectId);
  objectItemSources.set(row.item, targets);
}

const raw: RawMarker[] = [];
const addSpawns = (questId: number, kind: 0 | 1 | 2, objective: number, spawns: readonly Spawn[]) => {
  for (const spawn of spawns) raw.push({ questId, kind, objective, mapId: spawn.map, x: spawn.position_x, y: spawn.position_y });
};
const addCreatures = (questId: number, kind: 0 | 1 | 2, objective: number, ids: Iterable<number>) => {
  for (const id of ids) addSpawns(questId, kind, objective, creatureSpawns.get(id) ?? []);
};
const addObjects = (questId: number, kind: 0 | 1 | 2, objective: number, ids: Iterable<number>) => {
  for (const id of ids) addSpawns(questId, kind, objective, objectSpawns.get(id) ?? []);
};

for (const quest of quests) {
  // Until the browser has authoritative skill/reputation/condition state, omit
  // these starts instead of advertising quests the server may reject.
  const hasDynamicStartGate = quest.RequiredSkill !== 0 || quest.RequiredCondition !== 0
    || quest.RequiredMinRepFaction !== 0 || quest.RequiredMaxRepFaction !== 0;
  if (!hasDynamicStartGate) {
    addCreatures(quest.entry, 0, -1, creatureStarts.get(quest.entry) ?? []);
    addObjects(quest.entry, 0, -1, objectStarts.get(quest.entry) ?? []);
  }
  addCreatures(quest.entry, 1, -1, creatureEnds.get(quest.entry) ?? []);
  addObjects(quest.entry, 1, -1, objectEnds.get(quest.entry) ?? []);
  for (let objective = 0; objective < 4; objective++) {
    const creatureOrGo = Number(quest[`ReqCreatureOrGOId${objective + 1}`] ?? 0);
    if (creatureOrGo > 0) addCreatures(quest.entry, 2, objective, [creatureOrGo]);
    else if (creatureOrGo < 0) addObjects(quest.entry, 2, objective, [-creatureOrGo]);
    const itemId = Number(quest[`ReqItemId${objective + 1}`] ?? 0);
    if (itemId > 0) {
      addCreatures(quest.entry, 2, objective, creatureItemSources.get(itemId) ?? []);
      addObjects(quest.entry, 2, objective, objectItemSources.get(itemId) ?? []);
    }
  }
}

const areaFor = (marker: RawMarker) => mapAreas
  .filter((area) => area.mapId === marker.mapId
    && marker.y <= Math.max(area.bounds.y1_west, area.bounds.y2_east)
    && marker.y >= Math.min(area.bounds.y1_west, area.bounds.y2_east)
    && marker.x <= Math.max(area.bounds.x1_north, area.bounds.x2_south)
    && marker.x >= Math.min(area.bounds.x1_north, area.bounds.x2_south))
  .sort((a, b) => Math.abs((a.bounds.y2_east - a.bounds.y1_west) * (a.bounds.x2_south - a.bounds.x1_north))
    - Math.abs((b.bounds.y2_east - b.bounds.y1_west) * (b.bounds.x2_south - b.bounds.x1_north)))[0];

const clusters = new Map<string, { areaId: number; questId: number; kind: 0 | 1 | 2; objective: number; x: number; y: number; count: number }>();
for (const marker of raw) {
  const area = areaFor(marker);
  if (!area) continue;
  const u = (marker.y - area.bounds.y1_west) / (area.bounds.y2_east - area.bounds.y1_west);
  const v = (marker.x - area.bounds.x1_north) / (area.bounds.x2_south - area.bounds.x1_north);
  const key = `${area.worldMapAreaId}:${marker.questId}:${marker.kind}:${marker.objective}:${Math.round(u * 70)}:${Math.round(v * 70)}`;
  const cluster = clusters.get(key) ?? { areaId: area.worldMapAreaId, questId: marker.questId, kind: marker.kind, objective: marker.objective, x: 0, y: 0, count: 0 };
  cluster.x += marker.x; cluster.y += marker.y; cluster.count++;
  clusters.set(key, cluster);
}

const byArea = new Map<number, MarkerTuple[]>();
for (const marker of clusters.values()) {
  const list = byArea.get(marker.areaId) ?? [];
  list.push([marker.questId, marker.kind, marker.objective,
    Number((marker.x / marker.count).toFixed(2)), Number((marker.y / marker.count).toFixed(2))]);
  byArea.set(marker.areaId, list);
}

mkdirSync(OUT, { recursive: true });
const questTuples: QuestTuple[] = quests.map((quest) => [quest.entry, quest.Title, quest.MinLevel, quest.QuestLevel,
  quest.RequiredClasses, quest.RequiredRaces, Math.abs(quest.PrevQuestId || 0)]).sort((a, b) => a[0] - b[0]);
const sourceHash = createHash('sha256').update(readFileSync(dbPath)).digest('hex');
const areaManifest: Array<[number, string, number]> = [];
for (const [areaId, markers] of [...byArea].sort((a, b) => a[0] - b[0])) {
  markers.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const file = `${areaId}.json`;
  writeFileSync(join(OUT, file), `${JSON.stringify({ v: 1, m: markers })}\n`);
  areaManifest.push([areaId, file, markers.length]);
}
writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify({
  v: 1,
  source: { kind: 'vmangos-db_latest', release: basename(dirname(dirname(dbPath))), sha256: sourceHash, patch: PATCH_112 },
  q: questTuples,
  a: areaManifest,
})}\n`);
console.log(`Questie-lite: ${questTuples.length} quests, ${clusters.size} clustered markers, ${areaManifest.length} map shards.`);
