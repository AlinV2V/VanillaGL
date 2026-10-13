/** Asset conversion utility. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ClientArchiveSet, DbcFile, openClientArchive, openClientArchives } from '@vanillagl/assets';

type V3 = { x: number; y: number; z: number };
type Node = V3 & { map: number; index: number; action: number; delay: number };
type Frame = {
  map: number; x: number; y: number; z: number; teleport: boolean;
  distFromPrev: number; nextDistFromPrev: number; distSinceStop: number; distUntilStop: number;
  timeFrom: number; timeTo: number; arrive: number; depart: number; nextArrive: number;
  segment?: [V3, V3, V3, V3]; initialO: number; arrivalO?: number;
};

const SOURCE = process.env.DBC_SOURCE_DIR || path.join(process.cwd(), 'data', 'dbcs');
const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const OUT = fileURLToPath(new URL('../../apps/client/public/data/ship-paths.json', import.meta.url));
const INDEX = fileURLToPath(new URL('../../apps/client/public/terrain/index.json', import.meta.url));
const SNAPSHOT = fileURLToPath(new URL('../utils/transport-realm-snapshot.json', import.meta.url));
type RealmRow = { entry: number; build: number; name: string; period: number };
type RealmTemplate = { entry: number; path: number; speed: number; accel: number };
const realm = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as {
  clientBuild?: number; transportRows: RealmRow[]; selectedTemplates?: RealmTemplate[];
};
const clientBuild = realm.clientBuild ?? 5875;
const selectedTemplates = realm.selectedTemplates ?? [];
if (selectedTemplates.length === 0) {
  mkdirSync(fileURLToPath(new URL('../../apps/client/public/data/', import.meta.url)), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ version: 2, ships: {}, coverage: { tileSize: 533.33333, routes: [] } }, null, 2));
  console.log(`ship paths: no selected transport templates; wrote empty catalog -> ${OUT}`);
  process.exit(0);
}
const selectedRows = realm.transportRows.filter((row) => row.build <= clientBuild).reduce((rows, row) => {
  const current = rows.get(row.entry);
  if (!current || current.build < row.build) rows.set(row.entry, row);
  return rows;
}, new Map<number, RealmRow>());
const templates = new Map(selectedTemplates.map((template) => [template.entry, template]));
const ROUTES = [...selectedRows.values()].map((row) => {
  const template = templates.get(row.entry);
  if (!template) throw new Error(`realm transport ${row.entry} has no captured template`);
  return { ...row, ...template };
}).sort((a, b) => a.entry - b.entry);
if (ROUTES.length !== templates.size) throw new Error(`realm transport/template mismatch: ${ROUTES.length}/${templates.size}`);
const dbc = new DbcFile(new Uint8Array(readFileSync(path.join(SOURCE, 'TaxiPathNode.dbc'))));
if (dbc.fieldCount !== 9 || dbc.recordSize !== 36) throw new Error(`TaxiPathNode layout: ${dbc.fieldCount}x${dbc.recordSize}`);

// Endpoint policy is audited against the priority-resolved client DBC. The retained routes
// continue to use the staged local copy for the spline bake so this coverage pass cannot perturb their math.
const dbcBase = await openClientArchive(CACHE, 'dbc.MPQ');
const dbcPatches = await openClientArchives(CACHE, []);
const auditDbc = new DbcFile(new ClientArchiveSet([...dbcPatches, dbcBase]).extract('DBFilesClient\\TaxiPathNode.dbc'));
if (auditDbc.fieldCount !== 9 || auditDbc.recordSize !== 36) throw new Error(`priority TaxiPathNode layout: ${auditDbc.fieldCount}x${auditDbc.recordSize}`);
const terrainIndex = JSON.parse(readFileSync(INDEX, 'utf8')) as Array<{ key: string; map: number; dir: string; originX: number; originY: number }>;
const TILE = 533.33;
const rounded = (value: number) => Number(value.toFixed(5));
const covers = (tile: typeof terrainIndex[number], map: number, x: number, y: number) => tile.map === map
  && x >= tile.originX && x <= tile.originX + TILE && y >= tile.originY && y <= tile.originY + TILE;
const missingRect = (map: number, x: number, y: number) => {
  const gx = Math.floor(x / TILE), gy = Math.floor(y / TILE);
  const originX = rounded(gx * TILE), originY = rounded(gy * TILE);
  const dir = terrainIndex.find((tile) => tile.map === map)?.dir ?? `Map${map}`;
  return { key: `${dir}_${32 - gy}_${32 - gx}`, originX, originY,
    maxX: rounded(originX + TILE), maxY: rounded(originY + TILE) };
};
const routeCoverage = ROUTES.map((route) => {
  const endpoints = [] as Array<Record<string, unknown>>;
  for (let row = 0; row < auditDbc.recordCount; row++) {
    if (auditDbc.getUint(row, 1) !== route.path || auditDbc.getUint(row, 7) !== 2) continue;
    const map = auditDbc.getUint(row, 3), x = auditDbc.getFloat(row, 4), y = auditDbc.getFloat(row, 5);
    const tile = terrainIndex.find((candidate) => covers(candidate, map, x, y));
    endpoints.push({ node: auditDbc.getUint(row, 2), map, x, y, z: auditDbc.getFloat(row, 6),
      baked: !!tile, ...(tile ? { tile: tile.key } : { missingRect: missingRect(map, x, y) }) });
  }
  if (!endpoints.length) throw new Error(`taxi path ${route.path} has no stop nodes`);
  return { ...route, baked: endpoints.every((endpoint) => endpoint.baked), endpoints };
});

const nodesByPath = new Map<number, Node[]>();
for (let row = 0; row < dbc.recordCount; row++) {
  const path = dbc.getUint(row, 1);
  const nodes = nodesByPath.get(path) ?? [];
  nodes.push({ index: dbc.getUint(row, 2), map: dbc.getUint(row, 3), x: dbc.getFloat(row, 4),
    y: dbc.getFloat(row, 5), z: dbc.getFloat(row, 6), action: dbc.getUint(row, 7), delay: dbc.getUint(row, 8) });
  nodesByPath.set(path, nodes);
}
for (const nodes of nodesByPath.values()) nodes.sort((a, b) => a.index - b.index);

const lerp = (a: V3, b: V3, t: number): V3 => ({ x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
const point = (s: readonly V3[], t: number): V3 => {
  const t2 = t * t, t3 = t2 * t;
  const w = [-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1,
    -1.5 * t3 + 2 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2];
  return { x: s.reduce((n, p, i) => n + p.x * w[i], 0), y: s.reduce((n, p, i) => n + p.y * w[i], 0),
    z: s.reduce((n, p, i) => n + p.z * w[i], 0) };
};
const derivative = (s: readonly V3[], t: number): V3 => {
  const t2 = t * t, w = [-1.5 * t2 + 2 * t - 0.5, 4.5 * t2 - 5 * t,
    -4.5 * t2 + 4 * t + 0.5, 1.5 * t2 - t];
  return { x: s.reduce((n, p, i) => n + p.x * w[i], 0), y: s.reduce((n, p, i) => n + p.y * w[i], 0),
    z: s.reduce((n, p, i) => n + p.z * w[i], 0) };
};
const segmentLength = (s: readonly V3[]) => {
  let previous = s[1], length = 0;
  for (let step = 1; step <= 3; step++) {
    const next = point(s, step / 3);
    length += Math.hypot(next.x - previous.x, next.y - previous.y, next.z - previous.z);
    previous = next;
  }
  return length;
};

function bakeRoute(config: typeof ROUTES[number]) {
  const path = nodesByPath.get(config.path);
  if (!path || path.length < 4) throw new Error(`taxi path ${config.path} is absent/short`);
  const frames: Array<Frame & { node: Node }> = [];
  const splinePath: V3[] = [];
  const orientationPoints = [lerp(path[0], path[1], -0.2), ...path];
  const tail = lerp(path.at(-1)!, path.at(-2)!, -0.2);
  orientationPoints.push(tail, lerp(tail, path.at(-1)!, -1));
  let mapChange = false;
  for (let i = 1; i < path.length - 1; i++) {
    const node = path[i];
    if (!mapChange) {
      if ((node.action & 1) !== 0 || node.map !== path[i + 1].map) {
        if (!frames.length) throw new Error(`path ${config.path} begins with a map transition`);
        frames.at(-1)!.teleport = true;
        mapChange = true;
      } else {
        const initialDirection = derivative(orientationPoints.slice(i, i + 4), 0);
        frames.push({ node, map: node.map, x: node.x, y: node.y, z: node.z, teleport: false,
          distFromPrev: -1, nextDistFromPrev: 0, distSinceStop: -1, distUntilStop: -1,
          timeFrom: 0, timeTo: 0, arrive: 0, depart: 0, nextArrive: 0,
          initialO: Math.atan2(initialDirection.y, initialDirection.x) + Math.PI });
        splinePath.push(node);
      }
    } else mapChange = false;
  }
  frames.at(-1)!.teleport = true;

  frames[0].distFromPrev = 0;
  let start = 0;
  for (let i = 1; i < frames.length; i++) {
    if (frames[i - 1].teleport || i + 1 === frames.length) {
      const extra = frames[i - 1].teleport ? 0 : 1;
      const controls = splinePath.slice(start, i + extra);
      const internal = [lerp(controls[0], controls[1], -1), ...controls, controls.at(-1)!];
      for (let j = start; j < i + extra; j++) {
        const local = j - start;
        frames[j].distFromPrev = local === 0 ? 0 : segmentLength(internal.slice(local, local + 4));
        if (j > 0) frames[j - 1].nextDistFromPrev = frames[j].distFromPrev;
        if (local + 3 < internal.length) frames[j].segment = internal.slice(local, local + 4) as [V3, V3, V3, V3];
      }
      if (frames[i - 1].teleport) {
        frames[i].distFromPrev = 0;
        frames[i - 1].nextDistFromPrev = 0;
      }
      start = i;
    }
  }
  frames.at(-1)!.nextDistFromPrev = frames[0].distFromPrev;

  const stops = frames.map((frame, index) => frame.node.action === 2 ? index : -1).filter((index) => index >= 0);
  const firstStop = stops[0] ?? 0, lastStop = stops.at(-1) ?? 0;
  let distance = 0;
  for (let i = 0; i < frames.length; i++) {
    const j = (i + lastStop) % frames.length;
    if (frames[j].node.action === 2 || j === lastStop) distance = 0;
    else distance += frames[j].distFromPrev;
    frames[j].distSinceStop = distance;
  }
  distance = 0;
  for (let i = frames.length - 1; i >= 0; i--) {
    const j = (i + firstStop) % frames.length;
    distance += frames[(j + 1) % frames.length].distFromPrev;
    frames[j].distUntilStop = distance;
    if (frames[j].node.action === 2 || j === firstStop) distance = 0;
  }

  const accelDist = 0.5 * config.speed * config.speed / config.accel;
  for (const frame of frames) {
    const total = frame.distSinceStop + frame.distUntilStop;
    if (total < 2 * accelDist) {
      if (frame.distSinceStop < frame.distUntilStop) frame.timeTo = 2 * Math.sqrt(total / config.accel) - Math.sqrt(2 * frame.distSinceStop / config.accel);
      else frame.timeTo = Math.sqrt(2 * frame.distUntilStop / config.accel);
    } else if (frame.distSinceStop < accelDist) frame.timeTo = total / config.speed + config.speed / config.accel - Math.sqrt(2 * frame.distSinceStop / config.accel);
    else if (frame.distUntilStop < accelDist) frame.timeTo = Math.sqrt(2 * frame.distUntilStop / config.accel);
    else frame.timeTo = frame.distUntilStop / config.speed + 0.5 * config.speed / config.accel;
  }
  let segmentTime = 0;
  for (let i = 0; i < frames.length; i++) {
    const j = (i + lastStop) % frames.length;
    if (frames[j].node.action === 2 || j === lastStop) segmentTime = frames[j].timeTo;
    frames[j].timeFrom = segmentTime - frames[j].timeTo;
  }
  let pathSeconds = 0;
  frames[0].arrive = 0;
  if (frames[0].node.action === 2) frames[0].depart = (pathSeconds = frames[0].node.delay) * 1000 >>> 0;
  for (let i = 1; i < frames.length; i++) {
    pathSeconds += frames[i - 1].timeTo;
    if (frames[i].node.action === 2) {
      frames[i].arrive = pathSeconds * 1000 >>> 0;
      frames[i - 1].nextArrive = frames[i].arrive;
      pathSeconds += frames[i].node.delay;
      frames[i].depart = pathSeconds * 1000 >>> 0;
    } else {
      pathSeconds -= frames[i].timeTo;
      frames[i].arrive = pathSeconds * 1000 >>> 0;
      frames[i - 1].nextArrive = frames[i].arrive;
      frames[i].depart = frames[i].arrive;
    }
  }
  frames.at(-1)!.nextArrive = frames.at(-1)!.depart = config.period;
  for (let i = 1; i < frames.length; i++) {
    const previous = frames[i - 1];
    if (previous.segment) {
      const dir = derivative(previous.segment, 1);
      frames[i].arrivalO = Math.atan2(dir.y, dir.x) + Math.PI;
    }
  }
  return { path: config.path, period: config.period, speed: config.speed, accel: config.accel,
    accelTime: config.speed / config.accel, accelDist, frames: frames.map(({ node: _node, ...frame }) => frame) };
}

const included = ROUTES.filter((route) => routeCoverage.find((coverage) => coverage.entry === route.entry)?.baked);
const ships = Object.fromEntries(included.map((route) => [route.entry, bakeRoute(route)]));
mkdirSync(fileURLToPath(new URL('../../apps/client/public/data/', import.meta.url)), { recursive: true });
writeFileSync(OUT, JSON.stringify({ version: 2, ships, coverage: { tileSize: TILE, routes: routeCoverage } }, null, 2));
console.log(`ship paths: ${included.length}/${ROUTES.length} routes / ${Object.values(ships).reduce((n, route) => n + route.frames.length, 0)} frames -> ${OUT}`);
for (const archive of dbcPatches) archive.close();
dbcBase.close();