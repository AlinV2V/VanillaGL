/** Asset conversion utility. */
import { openClientArchive } from '@vanillagl/assets';

const MHDR_BASE = 0x14; // MHDR data starts here, all offsets are relative to this

function readStrings(data: Uint8Array, off: number, len: number): string[] {
  return new TextDecoder('ascii').decode(data.slice(off, off + len)).split('\0').filter(Boolean);
}

function parseAdt(data: Uint8Array, name: string) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const offs: number[] = [];
  for (let i = 0; i < 16; i++) offs.push(dv.getUint32(MHDR_BASE + i * 4, true));

  const abs = (rel: number) => MHDR_BASE + rel;

  const ofsMcin = abs(offs[1]);
  const ofsMtex = abs(offs[2]);
  const ofsMmdx = abs(offs[3]);
  const ofsMwmo = abs(offs[5]);
  const ofsMwid = abs(offs[6]);
  const ofsMddf = abs(offs[7]);
  const ofsModf = abs(offs[8]);

  let mtex: string[] = [];
  let mmdx: string[] = [];
  let mwmo: string[] = [];
  let modfCount = 0;
  const modfEntries: any[] = [];
  let mddfCount = 0;
  const mcnkSample: any = {};

  // MTEX
  if (ofsMtex > 0 && ofsMtex + 8 < data.length) {
    const sz = dv.getUint32(ofsMtex + 4, true);
    if (sz > 0 && ofsMtex + 8 + sz <= data.length) {
      mtex = readStrings(data, ofsMtex + 8, sz);
    }
  }

  // MMDX
  if (ofsMmdx > 0 && ofsMmdx + 8 < data.length) {
    const sz = dv.getUint32(ofsMmdx + 4, true);
    if (sz > 0 && ofsMmdx + 8 + sz <= data.length) {
      mmdx = readStrings(data, ofsMmdx + 8, sz);
    }
  }

  // MWMO
  if (ofsMwmo > 0 && ofsMwmo + 8 < data.length) {
    const sz = dv.getUint32(ofsMwmo + 4, true);
    if (sz > 0 && ofsMwmo + 8 + sz <= data.length) {
      mwmo = readStrings(data, ofsMwmo + 8, sz);
    }
  }

  // MODF (64 bytes per entry)
  if (ofsModf > 0 && ofsModf + 8 < data.length) {
    const sz = dv.getUint32(ofsModf + 4, true);
    modfCount = Math.floor(sz / 64);
    for (let i = 0; i < Math.min(modfCount, 10); i++) {
      const e = ofsModf + 8 + i * 64;
      modfEntries.push({
        nameId: dv.getUint32(e, true),
        uniqueId: dv.getUint32(e + 4, true),
        pos: [dv.getFloat32(e + 8, true), dv.getFloat32(e + 12, true), dv.getFloat32(e + 16, true)],
        rot: [dv.getFloat32(e + 20, true), dv.getFloat32(e + 24, true), dv.getFloat32(e + 28, true)],
        extentsLow: [dv.getFloat32(e + 32, true), dv.getFloat32(e + 36, true), dv.getFloat32(e + 40, true)],
        extentsHigh: [dv.getFloat32(e + 44, true), dv.getFloat32(e + 48, true), dv.getFloat32(e + 52, true)],
        doodadSet: dv.getUint16(e + 58, true),
        nameSet: dv.getUint16(e + 60, true),
        flags: dv.getUint16(e + 56, true),
        unk: dv.getUint16(e + 62, true),
      });
    }
  }

  // MDDF (36 bytes per entry)
  if (ofsMddf > 0 && ofsMddf + 8 < data.length) {
    const sz = dv.getUint32(ofsMddf + 4, true);
    mddfCount = Math.floor(sz / 36);
  }

  // MCNK sample (first chunk)
  if (ofsMcin > 0 && ofsMcin + 8 + 16 <= data.length) {
    const firstOff = dv.getUint32(ofsMcin + 8, true);
    if (firstOff > 0 && firstOff + 128 <= data.length) {
      const b = firstOff + 8;
      mcnkSample.flags = dv.getUint32(b, true);
      mcnkSample.ix = dv.getUint32(b + 4, true);
      mcnkSample.iy = dv.getUint32(b + 8, true);
      mcnkSample.nLayers = dv.getUint32(b + 12, true);
      mcnkSample.nDoodadRefs = dv.getUint32(b + 16, true);
      mcnkSample.areaId = dv.getUint32(b + 52, true);
      mcnkSample.nMapObjRefs = dv.getUint32(b + 56, true);
      mcnkSample.holes = dv.getUint32(b + 60, true);
      const ofsHeight = dv.getUint32(b + 20, true);
      if (ofsHeight > 0) {
        const htOff = firstOff + 8 + 128 + ofsHeight;
        const count = Math.min(10, Math.floor((data.length - htOff) / 4));
        const hts: number[] = [];
        for (let hi = 0; hi < count; hi++) {
          if (htOff + hi * 4 + 4 <= data.length) {
            hts.push(dv.getFloat32(htOff + hi * 4, true));
          }
        }
        mcnkSample.heights = hts;
      }
    }
  }

  return { name, size: data.length, mtex, mmdx, mwmo, modfCount, modfEntries: modfEntries.slice(0, 3), mddfCount, mcnkSample };
}

async function main() {
  const terrain = await openClientArchive('.client-cache', 'terrain.MPQ');
  const list = terrain.list();
  const adts = list.filter((f: string) => f.toLowerCase().endsWith('.adt'));
  const azeroth = adts.filter((f: string) => f.includes('Azeroth'));
  const kalimdor = adts.filter((f: string) => f.includes('Kalimdor'));

  console.log(`Total ADT tiles: ${adts.length} (Azeroth: ${azeroth.length}, Kalimdor: ${kalimdor.length})\n`);

  // Find tiles with WMO placements across ALL tiles
  console.log('=== Scanning for WMO placements (MODF/MWMO) in all ADT tiles ===\n');

  let totalModfTiles = 0;
  let totalMwmoTiles = 0;
  let totalModfEntries = 0;
  let totalMddfEntries = 0;
  const wmoNames = new Set<string>();
  const allModfTiles: string[] = [];
  const tileMtexCounts: Map<string, number> = new Map();
  const areaIds = new Set<number>();

  for (const adtName of adts) {
    const data = terrain.extract(adtName);
    const p = parseAdt(data, adtName);

    tileMtexCounts.set(adtName, p.mtex.length);

    if (p.modfCount > 0) {
      totalModfTiles++;
      totalModfEntries += p.modfCount;
      allModfTiles.push(adtName);
      for (const w of p.mwmo) wmoNames.add(w);
    }
    if (p.mwmo.length > 0) {
      totalMwmoTiles++;
      for (const w of p.mwmo) wmoNames.add(w);
    }
    if (p.mddfCount > 0) totalMddfEntries += p.mddfCount;
    if (p.mcnkSample.areaId) areaIds.add(p.mcnkSample.areaId);
  }

  console.log(`Tiles with WMO placements (MODF): ${totalModfTiles} / ${adts.length}`);
  console.log(`  Total WMO instances: ${totalModfEntries}`);
  console.log(`Tiles with MWMO filenames: ${totalMwmoTiles} / ${adts.length}`);
  console.log(`Unique WMO filenames referenced: ${wmoNames.size}`);
  console.log(`Tiles with doodad placements (MDDF): ${totalMddfEntries > 0 ? 'yes' : 'none scanned'}`);
  console.log(`Unique area IDs seen: ${areaIds.size}\n`);

  // Show some example WMO paths
  const wmoList = [...wmoNames].filter(n => n.includes('.wmo'));
  console.log(`Sample WMO paths (${wmoList.length} total):`);
  for (const w of wmoList.slice(0, 15)) {
    console.log(`  ${w}`);
  }

  // Show tiles with MODF
  console.log(`\n=== First 10 tiles with WMO placements ===`);
  for (const tName of allModfTiles.slice(0, 10)) {
    const data = terrain.extract(tName);
    const p = parseAdt(data, tName);
    console.log(`  ${tName.split('\\').pop()}`);
    console.log(`    MODF=${p.modfCount}  MWMO=${p.mwmo.length}  MTEX=${p.mtex.length}`);
    for (const m of p.modfEntries.slice(0, 2)) {
      const wmoName = p.mwmo[m.nameId] || `?[id=${m.nameId}]`;
      console.log(`    → ${wmoName.split('\\').pop()} @ [${m.pos.map(v => v.toFixed(0)).join(', ')}]  flags=0x${m.flags.toString(16)}  doodadSet=${m.doodadSet}`);
    }
  }

  // Sample starting zones
  console.log(`\n=== Zone_01 sample (Azeroth x~38-44, y~56-65) ===`);
  const Zone_01 = azeroth.filter((f: string) => {
    const m = f.match(/_(\d+)_(\d+)\.adt$/);
    if (!m) return false;
    const x = parseInt(m[1]), y = parseInt(m[2]);
    return x >= 38 && x <= 44 && y >= 56 && y <= 65;
  });
  for (const tName of Zone_01.slice(0, 4)) {
    const data = terrain.extract(tName);
    const p = parseAdt(data, tName);
    const shortName = tName.split('\\').pop()!;
    console.log(`  ${shortName.padEnd(25)} areaId=${p.mcnkSample.areaId || 'N/A'}  MTEX=${p.mtex.length}  MMDX=${p.mmdx.length}  MWMO=${p.mwmo.length}  MODF=${p.modfCount}  MCNK_layers=${p.mcnkSample.nLayers || 0}`);
    if (p.mtex.length > 0) console.log(`    Textures: ${p.mtex.slice(0, 4).map(t => t.split('\\').pop()).join(', ')}`);
    if (p.mcnkSample.heights) console.log(`    Heights: ${p.mcnkSample.heights.map((v: number) => v.toFixed(1)).join(', ')}`);
  }

  console.log(`\n=== Mulgore sample (Kalimdor x~38-45, y~48-56) ===`);
  const mulgore = kalimdor.filter((f: string) => {
    const m = f.match(/_(\d+)_(\d+)\.adt$/);
    if (!m) return false;
    const x = parseInt(m[1]), y = parseInt(m[2]);
    return x >= 38 && x <= 45 && y >= 48 && y <= 56;
  });
  for (const tName of mulgore.slice(0, 4)) {
    const data = terrain.extract(tName);
    const p = parseAdt(data, tName);
    const shortName = tName.split('\\').pop()!;
    console.log(`  ${shortName.padEnd(25)} areaId=${p.mcnkSample.areaId || 'N/A'}  MTEX=${p.mtex.length}  MMDX=${p.mmdx.length}  MWMO=${p.mwmo.length}  MODF=${p.modfCount}  MCNK_layers=${p.mcnkSample.nLayers || 0}`);
    if (p.mtex.length > 0) console.log(`    Textures: ${p.mtex.slice(0, 4).map(t => t.split('\\').pop()).join(', ')}`);
  }

  console.log(`\n=== Zone_02 sample (Kalimdor x~40-46, y~38-45) ===`);
  const Zone_02 = kalimdor.filter((f: string) => {
    const m = f.match(/_(\d+)_(\d+)\.adt$/);
    if (!m) return false;
    const x = parseInt(m[1]), y = parseInt(m[2]);
    return x >= 40 && x <= 46 && y >= 38 && y <= 45;
  });
  for (const tName of Zone_02.slice(0, 4)) {
    const data = terrain.extract(tName);
    const p = parseAdt(data, tName);
    const shortName = tName.split('\\').pop()!;
    console.log(`  ${shortName.padEnd(25)} areaId=${p.mcnkSample.areaId || 'N/A'}  MTEX=${p.mtex.length}  MMDX=${p.mmdx.length}  MWMO=${p.mwmo.length}  MODF=${p.modfCount}  MCNK_layers=${p.mcnkSample.nLayers || 0}`);
    if (p.mtex.length > 0) console.log(`    Textures: ${p.mtex.slice(0, 4).map(t => t.split('\\').pop()).join(', ')}`);
  }

  // Stats
  console.log(`\n=== Data Structure Summary ===`);
  console.log(`Chunk signatures are stored REVERSED (MHDR→RDHM, MCIN→NICM, MWMO→OMWM, MODF→FDOM, MCNK→KNCM)`);
  console.log(`MHDR offset table is relative to 0x14 (not file-absolute)`);
  console.log(`ADT structure: MVER[12B] → MHDR[72B] → MCIN[4104B] → MTEX → MMDX → MMID → MWMO → MWID → MDDF → MODF → MFBO → MCNK[256 chunks]`);

  terrain.close();
  console.log('Done.');
}

main().catch(console.error);
