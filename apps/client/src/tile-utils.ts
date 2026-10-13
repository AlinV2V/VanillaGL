import { PLAYER_COLLISION_CYLINDER } from './world-collision';

export const TILE = 533.33333;
export const TILE_HALF = TILE / 2;

export type TileEntry = {
  key: string;
  map: number;
  dir: string;
  originX: number;
  originY: number;
  minHeight: number;
  maxHeight: number;
  source: string;
  streamRadius?: number;
};

const positionIndexes = new WeakMap<TileEntry[], Map<string, TileEntry[]>>();
const coordinateIndexes = new WeakMap<TileEntry[], Map<string, TileEntry>>();
const positionKey = (map: number, x: number, y: number) => `${map}:${x}:${y}`;
const coordinateKey = (dir: string, x: number, y: number) => `${dir}:${x}:${y}`;

const positionIndex = (tiles: TileEntry[]) => {
  let index = positionIndexes.get(tiles);
  if (index) return index;
  index = new Map();
  for (const tile of tiles) {
    const minX = Math.floor((tile.originX - TILE - 1) / TILE), maxX = Math.floor((tile.originX + 1) / TILE);
    const minY = Math.floor((tile.originY - TILE - 1) / TILE), maxY = Math.floor((tile.originY + 1) / TILE);
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
      const key = positionKey(tile.map, x, y), bucket = index.get(key);
      if (bucket) bucket.push(tile); else index.set(key, [tile]);
    }
  }
  positionIndexes.set(tiles, index);
  return index;
};

/** Find the baked tile (if any) that contains a world position. */
export const tileForCharacter = (
  index: TileEntry[],
  c: { map: number; x: number; y: number; z?: number },
): TileEntry | undefined =>
  positionIndex(index).get(positionKey(c.map, Math.floor(c.x / TILE), Math.floor(c.y / TILE)))?.find(
    (t) =>
      t.map === c.map &&
      c.x <= t.originX + 1 &&
      c.x >= t.originX - TILE - 1 &&
      c.y <= t.originY + 1 &&
      c.y >= t.originY - TILE - 1,
  );

/** O(1) lookup for the ADT coordinate suffix used by neighborhood streaming. */
export const tileByGridCoordinate = (tiles: TileEntry[], dir: string, x: number, y: number): TileEntry | undefined => {
  let index = coordinateIndexes.get(tiles);
  if (!index) {
    index = new Map();
    for (const tile of tiles) {
      const match = /_(\d+)_(\d+)$/.exec(tile.key);
      if (match) index.set(coordinateKey(tile.dir, Number(match[1]), Number(match[2])), tile);
    }
    coordinateIndexes.set(tiles, index);
  }
  return index.get(coordinateKey(dir, x, y));
};

/** Call with terrain sampled at the actor's current position, never at a destination uphill. */
export const shouldAllowWmoBelowTerrain = (currentZ: number, terrainHeightAtCurrentPosition: number) =>
  Number.isFinite(terrainHeightAtCurrentPosition)
  && currentZ < terrainHeightAtCurrentPosition - PLAYER_COLLISION_CYLINDER.skin;
