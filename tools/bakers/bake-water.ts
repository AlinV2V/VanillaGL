/** Asset conversion utility. */
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { openClientArchive, openClientArchives, ClientArchiveSet } from '@vanillagl/assets';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const PUBLIC = fileURLToPath(new URL('../../apps/client/public/terrain', import.meta.url));
const N = 129;

const LIQUID_RIVER = 0x4;
const LIQUID_OCEAN = 0x8;
const LIQUID_MAGMA = 0x10;
const LIQUID_SLIME = 0x20;
const LIQUID_MASK = LIQUID_RIVER | LIQUID_OCEAN | LIQUID_MAGMA | LIQUID_SLIME;

function bakeTileWater(adt: Uint8Array): { grid: Float32Array; depth: Uint8Array; hasWater: boolean; type: number } {
  const dv = new DataView(adt.buffer, adt.byteOffset, adt.byteLength);
  const tag = (o: number) => String.fromCharCode(adt[o], adt[o + 1], adt[o + 2], adt[o + 3]);
  const grid = new Float32Array(N * N).fill(NaN);
  const depth = new Uint8Array(N * N);

  // Locate MCIN (chunk offset index; chunk tags are stored reversed, so MCIN -> "NICM").
  let o = 0;
  let mcin = -1;
  while (o + 8 <= adt.length) {
    const sz = dv.getUint32(o + 4, true);
    if (tag(o) === 'NICM') { mcin = o + 8; break; }
    o += 8 + sz;
  }
  if (mcin < 0) return { grid, depth, hasWater: false, type: 0 };

  let hasWater = false;
  const typeVotes: Record<number, number> = {};
  for (let ci = 0; ci < 256; ci++) {
    const mcnkOff = dv.getUint32(mcin + ci * 16, true);
    if (!mcnkOff) continue;
    const h = mcnkOff + 8; // MCNK header (after tag+size)
    const flags = dv.getUint32(h + 0x00, true);
    const sizeMCLQ = dv.getUint32(h + 0x64, true);
    if (sizeMCLQ <= 8 || (flags & LIQUID_MASK) === 0) continue;
    const lq = h + dv.getUint32(h + 0x60, true);

    const liquidBit = flags & LIQUID_MASK;
    const type = liquidBit & LIQUID_RIVER ? 1 : liquidBit & LIQUID_OCEAN ? 2 : liquidBit & LIQUID_MAGMA ? 3 : 4;
    typeVotes[type] = (typeVotes[type] ?? 0) + 1;

    const cx = ci % 16;
    const cy = (ci / 16) | 0;
    const flagsBase = lq + 8 + 81 * 8;
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        // Skip a vertex only when every quad touching it is the dry sentinel (0x0F low nibble).
        let anyWet = false;
        for (const [tr, tc] of [[r - 1, c - 1], [r - 1, c], [r, c - 1], [r, c]] as const) {
          if (tr < 0 || tr > 7 || tc < 0 || tc > 7) continue;
          if ((adt[flagsBase + tr * 8 + tc] & 0x0f) !== 0x0f) { anyWet = true; break; }
        }
        if (!anyWet) continue;
        const vi = (cy * 8 + r) * N + (cx * 8 + c);
        const vOff = lq + 8 + (r * 9 + c) * 8;
        const surface = dv.getFloat32(vOff + 4, true);
        grid[vi] = surface;
        depth[vi] = Math.max(depth[vi], adt[vOff] ?? 0);
        hasWater = true;
      }
    }
  }
  const type = Number(Object.keys(typeVotes).sort((a, b) => typeVotes[Number(b)] - typeVotes[Number(a)])[0] ?? 0);
  return { grid, depth, hasWater, type };
}

async function main() {
  console.log('=== bake-water (ADT MCLQ liquid) ===');
  const only = process.env.TILE_KEY;
  const requested = process.argv.slice(2);
  const implicitAll = !only && requested.length === 0;
  let keys = only
    ? [only]
    : requested.length
      ? requested
      : readdirSync(`${PUBLIC}/tiles`).filter((k) => existsSync(`${PUBLIC}/tiles/${k}/meta.json`));

  const missingWater = keys.filter((key) => !existsSync(`${PUBLIC}/tiles/${key}/water.json`));
  if (process.env.VERIFY_ONLY === '1') {
    if (missingWater.length) {
      throw new Error(`Water output missing for ${missingWater.length} tiles: ${missingWater.slice(0, 20).join(', ')}`);
    }
    console.log(`verified water output for ${keys.length}/${keys.length} baked tiles.`);
    return;
  }

  // A no-argument setup pass used to re-read every ADT even when the tile-local
  // pipeline had already produced water.json. Treat it as a resume/verification
  // pass by default and only repair missing outputs. BAKE_FORCE=1 preserves the
  // explicit full rebuild behavior.
  if (implicitAll && process.env.BAKE_FORCE !== '1') {
    if (!missingWater.length) {
      console.log(`water output already complete for ${keys.length}/${keys.length} baked tiles.`);
      return;
    }
    console.log(`repairing water output for ${missingWater.length}/${keys.length} baked tiles.`);
    keys = missingWater;
  }

  // patch-4 > patch-2 > patch.MPQ shadow the base terrain archive; patch.MPQ alone replaces 2,090
  // ADTs. Read them patch-first, exactly like bake-tile / bake-inner-heights / bake-wmos, so water
  // is baked from the same ADT bytes the client (and every sibling baker) actually loads.
  const terrainBase = await openClientArchive(CACHE, 'terrain.MPQ');
  const patches = await openClientArchives(CACHE, []);
  const terrain = new ClientArchiveSet([...patches, terrainBase]);

  let withWater = 0;
  for (const key of keys) {
    const dir = `${PUBLIC}/tiles/${key}`;
    const meta = JSON.parse(readFileSync(`${dir}/meta.json`, 'utf8'));
    const source: string | undefined = meta.source;
    if (!source || !terrain.has(source)) { continue; }
    const { grid, depth, hasWater, type } = bakeTileWater(terrain.extract(source));
    if (!hasWater) {
      writeFileSync(`${dir}/water.json`, JSON.stringify({ hasWater: false }));
      continue;
    }
    writeFileSync(`${dir}/water.f32`, Buffer.from(grid.buffer));
    writeFileSync(`${dir}/water-depth.u8`, Buffer.from(depth.buffer));
    writeFileSync(`${dir}/water.json`, JSON.stringify({ hasWater: true, type }));
    withWater++;
    console.log(`  ${key}: water type=${type}`);
  }
  console.log(`done — ${withWater}/${keys.length} processed tiles have liquid.`);
  terrain.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
