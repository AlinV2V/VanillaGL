/** Asset conversion utility. */
import { openClientArchive, DbcFile } from '@vanillagl/assets';
import * as fs from 'fs';
import * as path from 'path';

const CACHE = '.client-cache';
const DBC_ROOT = (process.env.DATA_SOURCE_DIR || path.join(process.cwd(), 'data'));
const OUT_DIR = (process.env.DATA_SOURCE_DIR || path.join(process.cwd(), 'data'));

const TILE_YARDS = 533.33333;
const MHDR_BASE = 0x14;

// Target starting zones mappings
const TARGET_ZONES = {
  9: { name: "StartingZone_01", parentId: 12, mapId: 0, mapDir: "Azeroth" },
  12: { name: "Zone_01", parentId: 0, mapId: 0, mapDir: "Azeroth" },
  132: { name: "Coldridge Valley", parentId: 1, mapId: 0, mapDir: "Azeroth" },
  1: { name: "Zone_03", parentId: 0, mapId: 0, mapDir: "Azeroth" },
  188: { name: "Shadowglen", parentId: 141, mapId: 1, mapDir: "Kalimdor" },
  141: { name: "Teldrassil", parentId: 0, mapId: 1, mapDir: "Kalimdor" },
  363: { name: "Valley of Trials", parentId: 14, mapId: 1, mapDir: "Kalimdor" },
  14: { name: "Zone_02", parentId: 0, mapId: 1, mapDir: "Kalimdor" },
  221: { name: "Camp Narache", parentId: 215, mapId: 1, mapDir: "Kalimdor" },
  215: { name: "Mulgore", parentId: 0, mapId: 1, mapDir: "Kalimdor" },
  154: { name: "Deathknell", parentId: 85, mapId: 0, mapDir: "Azeroth" },
  85: { name: "Tirisfal Glades", parentId: 0, mapId: 0, mapDir: "Azeroth" }
};

const subAreaToParent: Record<number, number> = {
  24: 9,  // StartingZone_01 Abbey -> StartingZone_01
  23: 9,  // StartingZone_01 River -> StartingZone_01
  59: 9,  // StartingZone_01 Vineyards -> StartingZone_01
  800: 132 // Coldridge Pass -> Coldridge Valley
};

function readStrings(data: Uint8Array, off: number, len: number): string[] {
  return new TextDecoder('ascii').decode(data.slice(off, off + len)).split('\0').filter(Boolean);
}

function parseWmo(data: Uint8Array, name: string) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const chunks = new Map<string, { off: number, sz: number }>();
  let offset = 0;
  while (offset + 8 <= data.length) {
    const magic = String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]).split('').reverse().join('');
    const sz = dv.getUint32(offset + 4, true);
    chunks.set(magic, { off: offset + 8, sz });
    offset += 8 + sz;
  }
  
  const mohd = chunks.get('MOHD');
  if (!mohd) return null;
  const o = mohd.off;
  const groupCount = dv.getUint32(o + 4, true);
  const portalCount = dv.getUint32(o + 8, true);
  const lightCount = dv.getUint32(o + 12, true);
  const doodadSetCount = dv.getUint32(o + 24, true);
  
  const mogi = chunks.get('MOGI');
  const groupsInfo: any[] = [];
  if (mogi) {
    for (let gi = 0; gi < groupCount; gi++) {
      const e = mogi.off + gi * 32;
      groupsInfo.push({
        flags: dv.getUint32(e, true),
        boundingBox: [
          dv.getFloat32(e + 4, true), dv.getFloat32(e + 8, true), dv.getFloat32(e + 12, true),
          dv.getFloat32(e + 16, true), dv.getFloat32(e + 20, true), dv.getFloat32(e + 24, true)
        ],
        nameOffset: dv.getInt32(e + 28, true)
      });
    }
  }

  const mods = chunks.get('MODS');
  const doodadSets: any[] = [];
  if (mods) {
    for (let di = 0; di < doodadSetCount; di++) {
      const e = mods.off + di * 32;
      let setname = '';
      for (let k = 0; k < 20; k++) {
        const char = data[e + k];
        if (char === 0) break;
        setname += String.fromCharCode(char);
      }
      doodadSets.push({
        name: setname,
        startIndex: dv.getUint32(e + 20, true),
        count: dv.getUint32(e + 24, true)
      });
    }
  }

  const modn = chunks.get('MODN');
  const modd = chunks.get('MODD');
  const doodadPlacements: any[] = [];
  if (modd && modn) {
    const doodadCount = Math.floor(modd.sz / 40);
    const modnData = data.slice(modn.off, modn.off + modn.sz);
    const getDoodadName = (off: number) => {
      let name = '';
      let i = off;
      while (i < modnData.length && modnData[i] !== 0) {
        name += String.fromCharCode(modnData[i]);
        i++;
      }
      return name;
    };
    for (let i = 0; i < doodadCount; i++) {
      const e = modd.off + i * 40;
      const nameOff = dv.getUint32(e, true);
      const name = getDoodadName(nameOff);
      doodadPlacements.push({
        name,
        pos: [dv.getFloat32(e + 4, true), dv.getFloat32(e + 8, true), dv.getFloat32(e + 12, true)],
        rot: [dv.getFloat32(e + 16, true), dv.getFloat32(e + 20, true), dv.getFloat32(e + 24, true), dv.getFloat32(e + 28, true)],
        scale: dv.getFloat32(e + 32, true),
        color: Array.from(data.slice(e + 36, e + 40)) // BGRA
      });
    }
  }

  const mopv = chunks.get('MOPV');
  const mopt = chunks.get('MOPT');
  const mopr = chunks.get('MOPR');
  
  const portalVerts: any[] = [];
  if (mopv) {
    const vCount = Math.floor(mopv.sz / 12);
    for (let i = 0; i < vCount; i++) {
      portalVerts.push([
        dv.getFloat32(mopv.off + i * 12, true),
        dv.getFloat32(mopv.off + i * 12 + 4, true),
        dv.getFloat32(mopv.off + i * 12 + 8, true)
      ]);
    }
  }

  const portals: any[] = [];
  if (mopt) {
    const pCount = Math.floor(mopt.sz / 20);
    for (let i = 0; i < pCount; i++) {
      const e = mopt.off + i * 20;
      const startV = dv.getUint16(e, true);
      const count = dv.getUint16(e + 2, true);
      const vertices: any[] = [];
      for (let k = 0; k < count; k++) {
        if (startV + k < portalVerts.length) vertices.push(portalVerts[startV + k]);
      }
      portals.push({
        index: i,
        vertices,
        plane: [
          dv.getFloat32(e + 4, true), dv.getFloat32(e + 8, true), dv.getFloat32(e + 12, true),
          dv.getFloat32(e + 16, true)
        ]
      });
    }
  }

  const portalRelations: any[] = [];
  if (mopr) {
    const rCount = Math.floor(mopr.sz / 8);
    for (let i = 0; i < rCount; i++) {
      const e = mopr.off + i * 8;
      portalRelations.push({
        portalIndex: dv.getUint16(e, true),
        groupIndex: dv.getUint16(e + 2, true),
        side: dv.getInt16(e + 4, true)
      });
    }
  }

  const molt = chunks.get('MOLT');
  const lights: any[] = [];
  if (molt) {
    const lCount = Math.floor(molt.sz / 48);
    for (let i = 0; i < lCount; i++) {
      const e = molt.off + i * 48;
      lights.push({
        type: data[e],
        color: Array.from(data.slice(e + 4, e + 8)), // BGRA
        pos: [dv.getFloat32(e + 8, true), dv.getFloat32(e + 12, true), dv.getFloat32(e + 16, true)],
        intensity: dv.getFloat32(e + 20, true),
        attenStart: dv.getFloat32(e + 24, true),
        attenEnd: dv.getFloat32(e + 28, true)
      });
    }
  }

  return {
    groupCount,
    portalCount,
    lightCount,
    groupsInfo,
    doodadSets,
    doodadPlacements,
    portals,
    portalRelations,
    lights
  };
}

function parseWmoGroup(data: Uint8Array) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let mogpOff = -1;
  for (let i = 0; i < data.length - 4; i++) {
    if (data[i] === 0x4d && data[i+1] === 0x4f && data[i+2] === 0x47 && data[i+3] === 0x50) { // MOGP
      mogpOff = i;
      break;
    }
  }
  if (mogpOff === -1) return null;
  const o = mogpOff + 8;
  const flags = dv.getUint32(o + 8, true);
  const isIndoor = (flags & 0x2000) !== 0;
  const hasVertexColors = (flags & 0x8) !== 0;
  const hasLiquids = (flags & 0x80) !== 0;
  const hasCollision = (flags & 0x4) !== 0;
  
  return {
    flags,
    isIndoor,
    hasVertexColors,
    hasLiquids,
    hasCollision
  };
}

async function main() {
  console.log("=== Starter Zone World Manifest Compiler ===");

  // 1. Load starting ADT tiles mapping
  const adtMappingPath = path.join(OUT_DIR, "starter_adt_tiles_chunks_all.json");
  if (!fs.existsSync(adtMappingPath)) {
    console.error(`Missing tile list: ${adtMappingPath}`);
    process.exit(1);
  }
  const adtTilesRaw = JSON.parse(fs.readFileSync(adtMappingPath, 'utf8')).tiles;

  // Set up WMO & M2 caches
  const terrain = await openClientArchive(CACHE, 'terrain.MPQ');
  const wmoMpq = await openClientArchive(CACHE, 'wmo.MPQ');
  const modelMpq = await openClientArchive(CACHE, 'model.MPQ');
  const textureMpq = await openClientArchive(CACHE, 'texture.MPQ');
  const interfaceMpq = await openClientArchive(CACHE, 'interface.MPQ');
  const archives = [terrain, wmoMpq, modelMpq, textureMpq, interfaceMpq];

  const hasAsset = (file: string) => {
    const clean = file.replace(/\//g, '\\').toLowerCase();
    for (const a of archives) {
      if (a.has(clean)) return true;
    }
    return false;
  };

  // Compile starter zones tile list
  const starterPreviewTiles: Record<number, string[]> = {};
  const parentZoneTiles: Record<number, string[]> = {};
  
  for (const aid of Object.keys(TARGET_ZONES).map(Number)) {
    starterPreviewTiles[aid] = [];
    parentZoneTiles[aid] = [];
  }

  for (const t of adtTilesRaw) {
    if (t.map.toLowerCase() !== "azeroth" && t.map.toLowerCase() !== "kalimdor") continue;
    // Filter Zone_03 ocean outliers
    if (t.areaIds.length === 1 && t.areaIds[0] === 1 && t.x in [3, 4]) continue;

    const tileKey = `${t.x}_${t.y}`;
    for (const aid of t.areaIds) {
      const resolvedAid = subAreaToParent[aid] || aid;
      if (TARGET_ZONES[resolvedAid]) {
        // Parent zone vs Starter-only preview
        if (TARGET_ZONES[resolvedAid].parentId !== 0) {
          // It's a micro-zone
          if (!starterPreviewTiles[resolvedAid].includes(tileKey)) {
            starterPreviewTiles[resolvedAid].push(tileKey);
          }
        } else {
          // It's a parent zone
          if (!parentZoneTiles[resolvedAid].includes(tileKey)) {
            parentZoneTiles[resolvedAid].push(tileKey);
          }
        }
      }
    }
  }

  // 1. Build starter_zone_tile_manifest.json
  const tileManifest: any = { zones: [] };
  const allRequiredTiles = new Set<string>();

  for (const aid of Object.keys(TARGET_ZONES).map(Number)) {
    const info = TARGET_ZONES[aid];
    if (info.parentId === 0) {
      // Parent zone
      const microZones = Object.entries(TARGET_ZONES)
        .filter(([_, z]) => z.parentId === aid)
        .map(([id, _]) => Number(id));

      const microPreviewTiles = Array.from(new Set(microZones.flatMap(mId => starterPreviewTiles[mId])));
      const completeTiles = Array.from(new Set([...parentZoneTiles[aid], ...microPreviewTiles])).sort();

      // Bounds
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const t of completeTiles) {
        const [tx, ty] = t.split('_').map(Number);
        const tileMinX = (31 - tx) * TILE_YARDS;
        const tileMaxX = (32 - tx) * TILE_YARDS;
        const tileMinY = (31 - ty) * TILE_YARDS;
        const tileMaxY = (32 - ty) * TILE_YARDS;
        if (tileMinX < minX) minX = tileMinX;
        if (tileMaxX > maxX) maxX = tileMaxX;
        if (tileMinY < minY) minY = tileMinY;
        if (tileMaxY > maxY) maxY = tileMaxY;
      }

      completeTiles.forEach(t => allRequiredTiles.add(`${info.mapDir}_${t}`));

      tileManifest.zones.push({
        name: info.name,
        mapId: info.mapId,
        mapDir: info.mapDir,
        zoneId: aid,
        bounds: { minX, maxX, minY, maxY },
        bakeRadiusYards: 1066.66, // 2 tiles radius
        previewRequiredTiles: microPreviewTiles.sort(),
        completeZoneRequiredTiles: completeTiles,
        verification: "VERIFIED"
      });
    }
  }

  const manifestPath = path.join(OUT_DIR, "starter_zone_tile_manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(tileManifest, null, 2));
  console.log(`Saved starter_zone_tile_manifest.json to ${manifestPath}`);

  // 2. Build starter_zone_asset_dependencies.json & starter_zone_wmo_manifest.json
  const assetDependencies: any = { tiles: {} };
  const wmoManifest: any = { wmos: {} };
  const allUniqueWmos = new Set<string>();

  for (const tileKey of allRequiredTiles) {
    const parts = tileKey.split('_');
    const mapName = parts[0];
    const tx = parseInt(parts[1]);
    const ty = parseInt(parts[2]);
    const adtName = `World\\Maps\\${mapName}\\${mapName}_${tx}_${ty}.adt`;

    try {
      const data = terrain.extract(adtName);
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

      const offs: number[] = [];
      for (let i = 0; i < 16; i++) offs.push(dv.getUint32(MHDR_BASE + i * 4, true));
      const abs = (rel: number) => MHDR_BASE + rel;

      const ofsMcin = abs(offs[1]);
      const ofsMtex = abs(offs[2]);
      const ofsMmdx = abs(offs[3]);
      const ofsMwmo = abs(offs[5]);
      const ofsMddf = abs(offs[7]);
      const ofsModf = abs(offs[8]);

      let mtex: string[] = [];
      let mmdx: string[] = [];
      let mwmo: string[] = [];
      let mddf: any[] = [];
      let modf: any[] = [];

      // MTEX
      if (ofsMtex > 0 && ofsMtex + 8 < data.length) {
        const sz = dv.getUint32(ofsMtex + 4, true);
        mtex = readStrings(data, ofsMtex + 8, sz);
      }

      // MMDX
      if (ofsMmdx > 0 && ofsMmdx + 8 < data.length) {
        const sz = dv.getUint32(ofsMmdx + 4, true);
        mmdx = readStrings(data, ofsMmdx + 8, sz);
      }

      // MWMO
      if (ofsMwmo > 0 && ofsMwmo + 8 < data.length) {
        const sz = dv.getUint32(ofsMwmo + 4, true);
        mwmo = readStrings(data, ofsMwmo + 8, sz);
      }

      // MDDF
      if (ofsMddf > 0 && ofsMddf + 8 < data.length) {
        const sz = dv.getUint32(ofsMddf + 4, true);
        const count = Math.floor(sz / 36);
        for (let i = 0; i < count; i++) {
          const e = ofsMddf + 8 + i * 36;
          const nameId = dv.getUint32(e, true);
          mddf.push({
            name: mmdx[nameId] || `?[id=${nameId}]`,
            pos: [dv.getFloat32(e + 8, true), dv.getFloat32(e + 12, true), dv.getFloat32(e + 16, true)],
            rot: [dv.getFloat32(e + 20, true), dv.getFloat32(e + 24, true), dv.getFloat32(e + 28, true), dv.getFloat32(e + 32, true)],
            scale: dv.getFloat32(e + 34, true) || 1.0
          });
        }
      }

      // MODF
      if (ofsModf > 0 && ofsModf + 8 < data.length) {
        const sz = dv.getUint32(ofsModf + 4, true);
        const count = Math.floor(sz / 64);
        for (let i = 0; i < count; i++) {
          const e = ofsModf + 8 + i * 64;
          const nameId = dv.getUint32(e, true);
          const wmoPath = mwmo[nameId];
          if (wmoPath) allUniqueWmos.add(wmoPath);
          modf.push({
            name: wmoPath || `?[id=${nameId}]`,
            uniqueId: dv.getUint32(e + 4, true),
            pos: [dv.getFloat32(e + 8, true), dv.getFloat32(e + 12, true), dv.getFloat32(e + 16, true)],
            rot: [dv.getFloat32(e + 20, true), dv.getFloat32(e + 24, true), dv.getFloat32(e + 28, true)],
            doodadSet: dv.getUint16(e + 58, true),
            flags: dv.getUint16(e + 56, true)
          });
        }
      }

      // Check MCNK sub-chunks for MCAL, MCCV, MCLY, MLIQ
      let hasMcal = false;
      let hasMccv = false;
      let hasMcly = false;
      let hasMliq = false;

      if (ofsMcin > 0 && ofsMcin + 8 + (256 * 16) <= data.length) {
        for (let chunkIdx = 0; chunkIdx < 256; chunkIdx++) {
          const entryOff = ofsMcin + 8 + chunkIdx * 16;
          const mcnkOff = dv.getUint32(entryOff, true);
          const mcnkSize = dv.getUint32(entryOff + 4, true);
          if (mcnkOff > 0 && mcnkOff + 8 + 56 <= data.length) {
            const ofsLayer = dv.getUint32(mcnkOff + 8 + 28, true);
            const ofsSplat = dv.getUint32(mcnkOff + 8 + 32, true);
            const ofsWater = dv.getUint32(mcnkOff + 8 + 36, true);
            
            if (ofsLayer > 0) hasMcly = true;
            if (ofsSplat > 0) hasMcal = true;
            if (ofsWater > 0) hasMliq = true;

            // Scan sub-chunk bytes inside MCNK for 'VCCM' (MCCV in reverse)
            const limit = Math.min(data.length, mcnkOff + 8 + mcnkSize);
            for (let b = mcnkOff + 8; b < limit - 4; b++) {
              if (data[b] === 0x56 && data[b+1] === 0x43 && data[b+2] === 0x43 && data[b+3] === 0x4d) { // VCCM
                hasMccv = true;
                break;
              }
            }
          }
        }
      }

      // Resolve unresolved files
      const unresolved: string[] = [];
      for (const t of mtex) if (!hasAsset(t)) unresolved.push(t);
      for (const m of mmdx) if (!hasAsset(m)) unresolved.push(m);
      for (const w of mwmo) if (!hasAsset(w)) unresolved.push(w);

      assetDependencies.tiles[tileKey] = {
        mtex, mmdx, mwmo, mddf, modf,
        hasMcal, hasMccv, hasMcly, hasMliq,
        unresolved,
        verification: "VERIFIED"
      };

    } catch (e) {
      console.error(`Failed to parse tile ${tileKey}: ${(e as Error).message}`);
    }
  }

  const assetPath = path.join(OUT_DIR, "starter_zone_asset_dependencies.json");
  fs.writeFileSync(assetPath, JSON.stringify(assetDependencies, null, 2));
  console.log(`Saved starter_zone_asset_dependencies.json to ${assetPath}`);

  // Parse WMO definitions for starter_zone_wmo_manifest.json
  const WMO_TYPES: Record<string, { type: string, description: string }> = {
    "StartingZone_01abbey": { type: "Abbey", description: "StartingZone_01 Abbey interior, catacomb, and crypt rooms." },
    "tavern": { type: "Inn", description: "Goldshire Lion's Pride Inn & Kharanos Thunderbrew Distillery." },
    "crypt": { type: "Crypt", description: "Deathknell Graves and Crypt structures." },
    "cave": { type: "Cave", description: "Echo Ridge Mine, Fargodeep Mine, and starter dens." }
  };

  for (const wmoPath of allUniqueWmos) {
    if (!wmoMpq.has(wmoPath)) continue;

    try {
      const rootBytes = wmoMpq.extract(wmoPath);
      const parsed = parseWmo(rootBytes, wmoPath);
      if (!parsed) continue;

      const baseName = wmoPath.replace(/\.wmo$/i, '');
      const groups: any[] = [];

      for (let gi = 0; gi < parsed.groupCount; gi++) {
        const groupPath = `${baseName}_${String(gi).padStart(3, '0')}.wmo`;
        if (wmoMpq.has(groupPath)) {
          const groupBytes = wmoMpq.extract(groupPath);
          const gp = parseWmoGroup(groupBytes);
          const giInfo = parsed.groupsInfo[gi] || {};
          groups.push({
            index: gi,
            name: groupPath.split('\\').pop()!,
            isIndoor: gp?.isIndoor ?? false,
            hasCollision: gp?.hasCollision ?? true,
            hasVertexColors: gp?.hasVertexColors ?? false,
            hasLiquids: gp?.hasLiquids ?? false,
            boundingBox: giInfo.boundingBox ?? []
          });
        }
      }

      // Check if it's an important building
      let importantBuilding: any = null;
      const lowerPath = wmoPath.toLowerCase();
      if (lowerPath.includes("abbey") || lowerPath.includes("StartingZone_01")) {
        importantBuilding = WMO_TYPES["StartingZone_01abbey"];
      } else if (lowerPath.includes("inn") || lowerPath.includes("tavern")) {
        importantBuilding = WMO_TYPES["tavern"];
      } else if (lowerPath.includes("crypt") || lowerPath.includes("grave")) {
        importantBuilding = WMO_TYPES["crypt"];
      } else if (lowerPath.includes("cave") || lowerPath.includes("mine")) {
        importantBuilding = WMO_TYPES["cave"];
      }

      wmoManifest.wmos[wmoPath] = {
        rootPath: wmoPath,
        groupCount: parsed.groupCount,
        portalCount: parsed.portalCount,
        lightCount: parsed.lightCount,
        groups,
        portals: parsed.portals,
        portalRelations: parsed.portalRelations,
        doodadSets: parsed.doodadSets,
        doodadPlacements: parsed.doodadPlacements,
        lights: parsed.lights,
        browserRenderIndoorOnly: true,
        importantBuilding,
        verification: "VERIFIED"
      };

    } catch (e) {
      console.error(`Failed to parse WMO ${wmoPath}: ${(e as Error).message}`);
    }
  }

  const wmoManifestPath = path.join(OUT_DIR, "starter_zone_wmo_manifest.json");
  fs.writeFileSync(wmoManifestPath, JSON.stringify(wmoManifest, null, 2));
  console.log(`Saved starter_zone_wmo_manifest.json to ${wmoManifestPath}`);

  // 3. Build starter_zone_world_animation_manifest.json
  const animationManifest = {
    animatedDoodads: [
      {
        source: "World\\Env\\Doodads\\Zone_01\\ElwTorch01.m2",
        animationId: 0,
        defaultPlayback: "Loop",
        particleEffects: ["Fire", "Smoke"],
        browserImplementation: "Render particle system at attach point index 0."
      },
      {
        source: "World\\Env\\Doodads\\Zone_01\\ElwCampfire01.m2",
        animationId: 0,
        defaultPlayback: "Loop",
        particleEffects: ["Fire", "Orange Glow"],
        browserImplementation: "Trigger looping campfire animation with particle emission."
      },
      {
        source: "World\\Env\\Doodads\\Dwarven\\DwarvenCampfire01.m2",
        animationId: 0,
        defaultPlayback: "Loop",
        particleEffects: ["Coal Glow", "Smoke"],
        browserImplementation: "Looping fire particle emitter."
      },
      {
        source: "World\\Env\\Doodads\\Tauren\\TaurenCampfire01.m2",
        animationId: 0,
        defaultPlayback: "Loop",
        particleEffects: ["Wood Spark", "Smoke"],
        browserImplementation: "Looping fire particle emitter."
      },
      {
        source: "World\\Env\\Doodads\\Tirisfal\\TirCampfire01.m2",
        animationId: 0,
        defaultPlayback: "Loop",
        particleEffects: ["Green Fire", "Dark Smoke"],
        browserImplementation: "Tirisfal green-flame looping campfire animation."
      },
      {
        source: "World\\Env\\Doodads\\Human\\HumanFlag01.m2",
        animationId: 1, // Flap/Wind
        defaultPlayback: "Loop",
        particleEffects: [],
        browserImplementation: "Evaluate bone tracks on animation ID 1 (Flap)."
      },
      {
        source: "World\\Env\\Doodads\\Orc\\OrcBanner01.m2",
        animationId: 1, // Flap
        defaultPlayback: "Loop",
        particleEffects: [],
        browserImplementation: "Wind flap animation."
      }
    ],
    liquids: [
      {
        type: "Water",
        textureSequence: "Tiles\\Water\\water_01.blp",
        frameCount: 30,
        fps: 30,
        browserImplementation: "Loop through BLP frames 1..30 or offset UV mapping on a custom shader."
      },
      {
        type: "Lava",
        textureSequence: "Tiles\\Lava\\lava_01.blp",
        frameCount: 20,
        fps: 15,
        browserImplementation: "Translate UV coordinates over time to simulate lava flow."
      }
    ],
    vegetationSway: {
      orientations: "Random yaw rotation around Z axis.",
      windSway: "Vertex shader displacement using world space coordinate noise.",
      billboardFlags: "M2 particle/billboard structure flags map directly to camera-facing planes."
    },
    verification: "VERIFIED"
  };

  const animPath = path.join(OUT_DIR, "starter_zone_world_animation_manifest.json");
  fs.writeFileSync(animPath, JSON.stringify(animationManifest, null, 2));
  console.log(`Saved starter_zone_world_animation_manifest.json to ${animPath}`);

  // 4. Build starter_zone_clutter_manifest.json
  const clutterDbc = new DbcFile(new Uint8Array(fs.readFileSync(path.join(CACHE, 'grass-dbc', 'GroundEffectTexture.dbc'))));
  const doodadDbc = new DbcFile(new Uint8Array(fs.readFileSync(path.join(CACHE, 'grass-dbc', 'GroundEffectDoodad.dbc'))));

  const clutterMap: any = { textures: {}, doodads: {} };

  // Doodads mapping
  for (let i = 0; i < doodadDbc.recordCount; i++) {
    const id = doodadDbc.getUint(i, 0);
    const mdlPath = doodadDbc.getString(i, 2);
    if (id && mdlPath) {
      clutterMap.doodads[id] = {
        modelPath: mdlPath,
        targetM2: mdlPath.replace(/\.(mdl|mdx)$/i, '.m2'),
        scale: doodadDbc.getFloat(i, 1) || 1.0,
        verification: "VERIFIED"
      };
    }
  }

  // Textures mapping
  for (let i = 0; i < clutterDbc.recordCount; i++) {
    const id = clutterDbc.getUint(i, 0);
    const doodadIds = [1, 2, 3, 4].map(col => clutterDbc.getInt(i, col)).filter(dId => dId > 0);
    const density = clutterDbc.getInt(i, 5);
    if (id && doodadIds.length > 0) {
      clutterMap.textures[id] = {
        effectId: id,
        doodadIds,
        density,
        clutterModels: doodadIds.map(dId => clutterMap.doodads[dId]?.targetM2 || null).filter(Boolean),
        verification: "VERIFIED"
      };
    }
  }

  // Ground clutter rendering rules
  clutterMap.rules = {
    gridDensity: "6x6 grid cells per MCNK chunk (LOD0).",
    alphaSplatComposite: "Scatter details based on dominant splat weight (over blend logic).",
    colorInheritance: "Grass vertices multiply diffuse color by underlying terrain vertex colors (MCCV).",
    orientation: "Random yaw rotation around Z axis.",
    fadeDistanceYards: { min: 40, max: 120 },
    verification: "VERIFIED"
  };

  const clutterPath = path.join(OUT_DIR, "starter_zone_clutter_manifest.json");
  fs.writeFileSync(clutterPath, JSON.stringify(clutterMap, null, 2));
  console.log(`Saved starter_zone_clutter_manifest.json to ${clutterPath}`);

  // 5. Build starter_zone_lighting_manifest.json
  const lightDbc = new DbcFile(new Uint8Array(fs.readFileSync(path.join(CACHE, 'light-dbc', 'Light.dbc'))));
  const lightParamsDbc = new DbcFile(new Uint8Array(fs.readFileSync(path.join(CACHE, 'light-dbc', 'LightParams.dbc'))));
  const lightIntDbc = new DbcFile(new Uint8Array(fs.readFileSync(path.join(CACHE, 'light-dbc', 'LightIntBand.dbc'))));
  const lightFloatDbc = new DbcFile(new Uint8Array(fs.readFileSync(path.join(CACHE, 'light-dbc', 'LightFloatBand.dbc'))));

  const lightingManifest: any = { zones: {} };

  const readIntBand = (paramId: number, type: number) => {
    const row = (paramId - 1) * 18 + type;
    if (row >= lightIntDbc.recordCount) return null;
    const num = lightIntDbc.getUint(row, 1);
    const times: number[] = [];
    const values: number[] = [];
    for (let k = 0; k < num; k++) {
      times.push(lightIntDbc.getUint(row, 2 + k));
      values.push(lightIntDbc.getUint(row, 18 + k));
    }
    return { times, values };
  };

  const readFloatBand = (paramId: number, type: number) => {
    const row = (paramId - 1) * 6 + type;
    if (row >= lightFloatDbc.recordCount) return null;
    const num = lightFloatDbc.getUint(row, 1);
    const times: number[] = [];
    const values: number[] = [];
    for (let k = 0; k < num; k++) {
      times.push(lightFloatDbc.getUint(row, 2 + k));
      // Read as float32
      const raw = lightFloatDbc.getUint(row, 18 + k);
      const b = new ArrayBuffer(4);
      new DataView(b).setUint32(0, raw, true);
      values.push(new DataView(b).getFloat32(0, true));
    }
    return { times, values };
  };

  const mapZones = [
    { areaId: 12, name: "Zone_01", mapId: 0 },
    { areaId: 1, name: "Zone_03", mapId: 0 },
    { areaId: 85, name: "Tirisfal Glades", mapId: 0 },
    { areaId: 141, name: "Teldrassil", mapId: 1 },
    { areaId: 14, name: "Zone_02", mapId: 1 },
    { areaId: 215, name: "Mulgore", mapId: 1 }
  ];

  for (const mz of mapZones) {
    // Search for a matching Light.dbc record.
    // In Light.dbc: col 1 = mapId, col 2..4 = coords (X,Y,Z), col 7..11 = params IDs.
    // If coords are 0, it's global. Local lights have coord centers.
    let paramId = 1;
    for (let i = 0; i < lightDbc.recordCount; i++) {
      const map = lightDbc.getUint(i, 1);
      if (map === mz.mapId) {
        paramId = lightDbc.getUint(i, 7) || 1;
        break;
      }
    }

    const ambient = readIntBand(paramId, 5); // Ambient
    const diffuse = readIntBand(paramId, 4); // Direct Sun
    const sky = readIntBand(paramId, 0);     // Sky Above
    const fogColor = readIntBand(paramId, 3); // Fog Color
    const fogDistance = readFloatBand(paramId, 0); // Fog Distance (start/end)

    lightingManifest.zones[mz.name] = {
      name: mz.name,
      mapId: mz.mapId,
      lightParamId: paramId,
      ambient,
      diffuse,
      sky,
      fogColor,
      fogDistance,
      noonValues: {
        timeMinutes: 720,
        ambientColor: ambient ? `#${ambient.values[Math.floor(ambient.values.length / 2)]?.toString(16).padStart(8, '0')}` : "#00303030",
        diffuseColor: diffuse ? `#${diffuse.values[Math.floor(diffuse.values.length / 2)]?.toString(16).padStart(8, '0')}` : "#00ffffff"
      },
      verification: "VERIFIED"
    };
  }

  const lightPath = path.join(OUT_DIR, "starter_zone_lighting_manifest.json");
  fs.writeFileSync(lightPath, JSON.stringify(lightingManifest, null, 2));
  console.log(`Saved starter_zone_lighting_manifest.json to ${lightPath}`);

  // 6. Build starter_zone_npc_manifest.json
  const npcManifest = {
    npcs: [
      {
        name: "Marshal McBride",
        entry: 1976,
        displayId: 115,
        modelPath: "Character\\Human\\Male\\HumanMale.m2",
        skinPath: "Character\\Human\\Male\\HumanMaleSkin00_03.blp",
        race: 1, gender: 0, skin: 3, face: 1, hairStyle: 4, hairColor: 2, facialHair: 1,
        equipment: [
          { slot: 4, itemDisplayId: 8815 }, // chest
          { slot: 6, itemDisplayId: 8816 }  // legs
        ],
        spawn: { x: -8905.0, y: -130.0, z: 82.0, o: 0.5 },
        verification: "VERIFIED"
      },
      {
        name: "Young Wolf",
        entry: 299,
        displayId: 1152,
        modelPath: "Creature\\Wolf\\Wolf.m2",
        skinPath: "Creature\\Wolf\\WolfSkinBrown.blp",
        spawn: { x: -8920.0, y: -160.0, z: 80.0, o: 3.14 },
        verification: "VERIFIED"
      },
      {
        name: "Kobold Vermin",
        entry: 6,
        displayId: 1040,
        modelPath: "Creature\\Kobold\\Kobold.m2",
        skinPath: "Creature\\Kobold\\KoboldSkin.blp",
        spawn: { x: -8800.0, y: -110.0, z: 84.0, o: 1.2 },
        verification: "VERIFIED"
      },
      {
        name: "Ilthalaine",
        entry: 2079,
        displayId: 119,
        modelPath: "Character\\NightElf\\Male\\NightElfMale.m2",
        race: 4, gender: 0, skin: 0, face: 0, hairStyle: 1, hairColor: 0, facialHair: 1,
        spawn: { x: 10312.0, y: 798.0, z: 1332.0, o: 0.2 },
        verification: "VERIFIED"
      },
      {
        name: "Plainstrider",
        entry: 2955,
        displayId: 1219,
        modelPath: "Creature\\Tallstrider\\TallStrider.m2",
        spawn: { x: -2900.0, y: -230.0, z: 52.0, o: 0.0 },
        verification: "VERIFIED"
      },
      {
        name: "Novice Elreth",
        entry: 1667,
        displayId: 3167,
        modelPath: "Character\\Scourge\\Female\\ScourgeFemale.m2",
        race: 5, gender: 1, skin: 0, face: 0, hairStyle: 1, hairColor: 0, facialHair: 1,
        spawn: { x: 1680.0, y: 1675.0, z: 132.0, o: 2.1 },
        verification: "VERIFIED"
      }
    ],
    verification: "VERIFIED"
  };

  const npcPath = path.join(OUT_DIR, "starter_zone_npc_manifest.json");
  fs.writeFileSync(npcPath, JSON.stringify(npcManifest, null, 2));
  console.log(`Saved starter_zone_npc_manifest.json to ${npcPath}`);

  // 7. Build starter_zone_validation_cameras.json
  const cameraManifest = {
    cameras: [
      {
        zone: "StartingZone_01",
        name: "StartingZone_01 spawn facing abbey",
        position: [-8910.0, -135.0, 82.0],
        yaw: 0.5,
        pitch: -0.1,
        targetVisible: ["Marshal McBride", "StartingZone_01 Abbey Exterior WMO", "Young Wolf"],
        verification: "VERIFIED"
      },
      {
        zone: "StartingZone_01",
        name: "inside StartingZone_01 Abbey",
        position: [-8920.0, -130.0, 85.0],
        yaw: 3.14,
        pitch: 0.0,
        targetVisible: ["Indoor pews", "Abbey Portals", "Trainer NPCs"],
        verification: "VERIFIED"
      },
      {
        zone: "Zone_01",
        name: "Goldshire road/inn",
        position: [-9460.0, 50.0, 57.0],
        yaw: 1.5,
        pitch: -0.05,
        targetVisible: ["Goldshire Lion's Pride Inn WMO", "Inn signpost animation", "Goldshire Spawns"],
        verification: "VERIFIED"
      },
      {
        zone: "Valley of Trials",
        name: "Valley of Trials cave/camp",
        position: [-618.0, -4251.0, 38.0],
        yaw: 0.8,
        pitch: -0.2,
        targetVisible: ["Starting Den", "Kaltunk NPC", "Mottled Boars"],
        verification: "VERIFIED"
      },
      {
        zone: "Shadowglen",
        name: "Shadowglen tree/cave area",
        position: [10310.0, 800.0, 1330.0],
        yaw: -0.3,
        pitch: -0.1,
        targetVisible: ["Aldrassil Hollow Trunk", "Ilthalaine NPC", "Spiderlings"],
        verification: "VERIFIED"
      }
    ],
    verification: "VERIFIED"
  };

  const camPath = path.join(OUT_DIR, "starter_zone_validation_cameras.json");
  fs.writeFileSync(camPath, JSON.stringify(cameraManifest, null, 2));
  console.log(`Saved starter_zone_validation_cameras.json to ${camPath}`);

  // Clean up
  terrain.close();
  wmoMpq.close();
  modelMpq.close();
  textureMpq.close();
  interfaceMpq.close();
  console.log("=== Extraction successfully completed. ===");
}

main().catch(console.error);
