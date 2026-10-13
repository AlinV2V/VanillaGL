/** Asset conversion utility. */
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { ClientArchiveSet, openClientArchive, openClientArchives, MpqArchive } from '@vanillagl/assets';
import { Map as WowMap, MapArea } from '@wowserhq/format';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const PUBLIC = fileURLToPath(new URL('../../apps/client/public/terrain', import.meta.url));
const wdtPath = (dir: string) => `World\\Maps\\${dir}\\${dir}.wdt`;

async function bakeTile(key: string, terrain: ClientArchiveSet, mapCache: Map<string, WowMap>) {
  const dir = `${PUBLIC}/tiles/${key}`;
  const meta = JSON.parse(readFileSync(`${dir}/meta.json`, 'utf8'));
  const mapDir: string = meta.dir ?? meta.source.split('\\')[2];
  let map = mapCache.get(mapDir);
  if (!map) { map = new WowMap().load(terrain.extract(wdtPath(mapDir))); mapCache.set(mapDir, map); }
  const area = new MapArea(map.layerSplatDepth).load(terrain.extract(meta.source));
  const inner = new Float32Array(128 * 128);
  // Real MCNR per-vertex normals (signed bytes /127), in mesh-vertex order: outer 129x129 then
  // inner 128x128 — so the client can use WoW's authored smooth shading instead of recomputing.
  const outerN = new Float32Array(129 * 129 * 3);
  const innerN = new Float32Array(128 * 128 * 3);
  for (let ci = 0; ci < area.chunks.length && ci < 256; ci++) {
    const cx = ci % 16, cy = (ci / 16) | 0;
    const ch = area.chunks[ci] as any;
    const base = ch.position?.[2] ?? 0;
    const mcvt = ch.vertexHeights;
    const nrm = ch.vertexNormals; // @wowserhq exposes MCNR as `vertexNormals` (Int8Array, 145*3)
    if (!mcvt) continue;
    for (let ir = 0; ir < 8; ir++) {
      for (let ic = 0; ic < 8; ic++) {
        inner[(cy * 8 + ir) * 128 + (cx * 8 + ic)] = base + mcvt[ir * 17 + 9 + ic];
        if (nrm) {
          const ni = (ir * 17 + 9 + ic) * 3;
          const ii = ((cy * 8 + ir) * 128 + (cx * 8 + ic)) * 3;
          innerN[ii] = nrm[ni] / 127; innerN[ii + 1] = nrm[ni + 1] / 127; innerN[ii + 2] = nrm[ni + 2] / 127;
        }
      }
    }
    if (nrm) {
      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) {
          const ni = (r * 17 + c) * 3;
          const oi = ((cy * 8 + r) * 129 + (cx * 8 + c)) * 3;
          outerN[oi] = nrm[ni] / 127; outerN[oi + 1] = nrm[ni + 1] / 127; outerN[oi + 2] = nrm[ni + 2] / 127;
        }
      }
    }
  }
  writeFileSync(`${dir}/heights_inner.f32`, Buffer.from(inner.buffer));
  const normals = new Float32Array(129 * 129 * 3 + 128 * 128 * 3);
  normals.set(outerN, 0);
  normals.set(innerN, 129 * 129 * 3);
  writeFileSync(`${dir}/normals.f32`, Buffer.from(normals.buffer));
}

async function main() {

  // Patch archives shadow the base ones (2,070 of 2,352 ADTs, 5,889 textures, 668 models).
  // See openClientArchives in @vanillagl/assets.
  const patches = await openClientArchives(CACHE, []);
  const terrain = new ClientArchiveSet([...patches, await openClientArchive(CACHE, 'terrain.MPQ')]);
  const mapCache = new Map<string, WowMap>();
  let keys = process.argv.slice(2);
  if (!keys.length) keys = JSON.parse(readFileSync(`${PUBLIC}/index.json`, 'utf8')).map((e: any) => e.key);
  for (const key of keys) {
    try { await bakeTile(key, terrain, mapCache); console.log(`${key}: heights_inner.f32 (128x128)`); }
    catch (e) { console.log(`${key}: FAILED ${(e as Error).message}`); }
  }
  terrain.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
