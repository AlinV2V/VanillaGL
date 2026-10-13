import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizeWmoTile, encodeWmoBinary, hydrateWmoBinary, validateWmoBinaryMeta } from '../utils/wmo-binary.ts';

const TERRAIN = fileURLToPath(new URL('../../apps/client/public/terrain', import.meta.url));
const TILES = join(TERRAIN, 'tiles');
const TILE = 533.33333;
const index = JSON.parse(readFileSync(join(TERRAIN, 'index.json'), 'utf8')) as Array<{
  key: string; map: number; originX: number; originY: number;
}>;

type Occurrence = { key: string; map: number; worldX: number; worldY: number; full: boolean };
const occurrences = new Map<string, Occurrence[]>();
// Keyed on map + MODF uniqueId ONLY. Position must NOT be part of this key.
//
// A WMO spanning several tiles is baked into each of them, and every tile reconstructs the world
// position from ITS OWN origin, so float32 rounding makes the copies disagree in the last decimals.
// Keying on the position therefore splits one building into several "placements", each of which
// elects itself owner and renders — Stormwind (0:10047) was drawn twice, from Azeroth_29_49 and
// Azeroth_30_48, which is the duplicate city seen floating over the real one.
//
// Quantising the position does not fix this: the two Stormwind copies are 0.002 yd apart but
// straddle a bucket edge (-8931.637 -> -8931.64, -8931.635 -> -8931.63), so they still hashed
// apart. Any fixed grid has edges, so any quantum has this failure mode.
//
// uniqueId is per-placement in the ADT, which makes map+id the correct identity. Verified across the
// whole baked corpus: grouping on map+id yields 1531 groups whose worst internal spread is 0.0028 yd
// — every group holds one physical building. This also matches how verify-wmo-assets reports
// duplicates ("0:362609"), so the gate and the repair now agree by construction.
const placementKey = (map: number, id: number) => `${map}:${id}`;

for (const tile of index) {
  const dir = join(TILES, tile.key);
  const path = join(dir, 'wmos.meta.json');
  if (!existsSync(path)) continue;
  const tileMeta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const centerX = Number(tileMeta.originX) - TILE / 2;
  const centerY = Number(tileMeta.originY) - TILE / 2;
  const data = JSON.parse(readFileSync(path, 'utf8'));
  for (const instance of data.instances ?? []) {
    const key = placementKey(tile.map, instance.id);
    const list = occurrences.get(key) ?? [];
    list.push({
      key: tile.key,
      map: tile.map,
      worldX: centerX + Number(instance.x),
      worldY: centerY + Number(instance.y),
      full: !data.models[instance.m]?.proxy,
    });
    occurrences.set(key, list);
  }
}

const owners = new Map<string, string>();
for (const [placement, list] of occurrences) {
  const full = list.filter((item) => item.full);
  if (!full.length) {
    throw new Error(`${placement}: ${list.length} WMO occurrence(s), but every model is a zero-geometry proxy; rebake the raw MODF owner before canonicalizing`);
  }
  // Build 5875 owns one MODF placement identified by map + uniqueId. Prefer the baked ADT that
  // contains that placement's raw world position; float32 copies on overlap tiles may differ by a
  // few thousandths, so fall back to the surviving full copy rather than ever electing a proxy.
  const anchor = list[0];
  const expected = index.find((tile) => tile.map === anchor.map
    && anchor.worldX <= tile.originX + 1 && anchor.worldX >= tile.originX - TILE - 1
    && anchor.worldY <= tile.originY + 1 && anchor.worldY >= tile.originY - TILE - 1);
  const owner = full.find((item) => item.key === expected?.key)
    ?? [...full].sort((a, b) => a.key.localeCompare(b.key))[0];
  owners.set(placement, owner.key);
}

let repacked = 0;
let renderablePlacements = 0;
for (const tile of index) {
  const dir = join(TILES, tile.key);
  const metaPath = join(dir, 'wmos.meta.json');
  const binaryPath = join(dir, 'wmos.bin');
  if (!existsSync(metaPath) || !existsSync(binaryPath)) continue;
  const tileMeta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const centerX = Number(tileMeta.originX) - TILE / 2;
  const centerY = Number(tileMeta.originY) - TILE / 2;
  const encodedMeta = JSON.parse(readFileSync(metaPath, 'utf8'));
  for (const instance of encodedMeta.instances ?? []) {
    const placement = placementKey(tile.map, instance.id);
    instance.ownerKey = owners.get(placement) ?? tile.key;
    if (instance.ownerKey === tile.key) renderablePlacements++;
  }
  const hydrated = hydrateWmoBinary(encodedMeta, readFileSync(binaryPath));
  const canonical = canonicalizeWmoTile(hydrated, tile.key, tileMeta, index);
  const encoded = encodeWmoBinary(canonical);
  validateWmoBinaryMeta(encoded.meta, encoded.binary.byteLength);
  writeFileSync(metaPath, JSON.stringify(encoded.meta));
  writeFileSync(binaryPath, encoded.binary);
  repacked++;
}

console.log(`Canonical WMO ownership OK: ${owners.size} placements, ${renderablePlacements} render owners, ${repacked} tiles repacked.`);
