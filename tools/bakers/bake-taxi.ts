/** Asset conversion utility. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ClientArchiveSet, DbcFile, openClientArchive, openClientArchives } from '@vanillagl/assets';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const OUT_DIR = fileURLToPath(new URL('../../apps/client/public/taxi', import.meta.url));
const TERRAIN_INDEX = fileURLToPath(new URL('../../apps/client/public/terrain/index.json', import.meta.url));

const archive = await openClientArchive(CACHE, 'dbc.MPQ');
const patches = await openClientArchives(CACHE, []);
const dbcSet = new ClientArchiveSet([...patches, archive]);
const nodesDbc = new DbcFile(dbcSet.extract('DBFilesClient\\TaxiNodes.dbc'));
const pathsDbc = new DbcFile(dbcSet.extract('DBFilesClient\\TaxiPath.dbc'));
console.log(`TaxiNodes rows=${nodesDbc.recordCount} fields=${nodesDbc.fieldCount}`);
console.log(`TaxiPath rows=${pathsDbc.recordCount} fields=${pathsDbc.fieldCount}`);

type TaxiNode = { id: number; map: number; x: number; y: number; name: string };
const rawNodes: TaxiNode[] = [];
for (let index = 0; index < nodesDbc.recordCount; index++) {
  const name = nodesDbc.getString(index, 5);
  if (!name) continue;
  rawNodes.push({
    id: nodesDbc.getUint(index, 0),
    map: nodesDbc.getUint(index, 1),
    x: nodesDbc.getFloat(index, 2),
    y: nodesDbc.getFloat(index, 3),
    name,
  });
}
const probe = rawNodes.find((node) => node.name.startsWith('Stormwind'));
console.log(probe && probe.map === 0
  ? `probe: "${probe.name}" id=${probe.id} map=${probe.map} x=${probe.x.toFixed(0)} y=${probe.y.toFixed(0)}`
  : 'probe FAILED: Stormwind node not on map 0 — check field offsets');

const rawPaths: Array<{ id: number; from: number; to: number; cost: number }> = [];
for (let index = 0; index < pathsDbc.recordCount; index++) {
  rawPaths.push({
    id: pathsDbc.getUint(index, 0),
    from: pathsDbc.getUint(index, 1),
    to: pathsDbc.getUint(index, 2),
    cost: pathsDbc.getUint(index, 3),
  });
}

const TILE = 533.33;
const index = JSON.parse(readFileSync(TERRAIN_INDEX, 'utf8')) as Array<{
  key: string; map: number; dir: string; originX: number; originY: number;
}>;
const bakedTile = (node: TaxiNode) => index.find((tile) => tile.map === node.map
  && node.x >= tile.originX && node.x <= tile.originX + TILE
  && node.y >= tile.originY && node.y <= tile.originY + TILE);
const rounded = (value: number) => Number(value.toFixed(5));
const excludedNodes = rawNodes.filter((node) => !bakedTile(node)).map((node) => {
  const gx = Math.floor(node.x / TILE), gy = Math.floor(node.y / TILE);
  const originX = rounded(gx * TILE), originY = rounded(gy * TILE);
  const dir = index.find((tile) => tile.map === node.map)?.dir ?? `Map${node.map}`;
  return { ...node, missingRect: { key: `${dir}_${32 - gy}_${32 - gx}`, originX, originY,
    maxX: rounded(originX + TILE), maxY: rounded(originY + TILE) } };
});
const excludedIds = new Set(excludedNodes.map((node) => node.id));
const nodes = rawNodes.filter((node) => !excludedIds.has(node.id));
const excludedPaths = rawPaths.filter((path) => excludedIds.has(path.from) || excludedIds.has(path.to))
  .map((path) => ({ ...path, reason: excludedIds.has(path.to) ? 'destination-unbaked' : 'source-unbaked' }));
const paths = rawPaths.filter((path) => !excludedIds.has(path.from) && !excludedIds.has(path.to));

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(`${OUT_DIR}/taxi.json`, JSON.stringify({ nodes, paths,
  coverage: { tileSize: TILE, excludedNodes, excludedPaths } }));
console.log(`wrote taxi.json: ${nodes.length}/${rawNodes.length} nodes, ${paths.length}/${rawPaths.length} paths`);
for (const patch of patches) patch.close();
archive.close();
