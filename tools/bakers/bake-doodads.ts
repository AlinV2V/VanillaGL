/** Asset conversion utility. */
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { ClientArchiveSet, readVanillaM2, readM2Emitters, readM2TextureFilenames } from '@vanillagl/assets';
import { Map as WowMap, MapArea, Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import { encodePng } from '../utils/png.ts';
import { bakeM2TextureTransforms, type BakedM2Transform } from '../utils/bake-m2-material-animation.ts';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const PUBLIC = fileURLToPath(new URL('../../apps/client/public/terrain', import.meta.url));
const TILE = 533.33333;
const wdtPath = (dir: string) => `World\\Maps\\${dir}\\${dir}.wdt`;
const normName = (n: string) => n.replace(/\.(mdx|mdl)$/i, '.m2');

type Part = { indices: number[]; tex: number; blendMode: number; renderFlags: number; xf: number };
type ParticleDef = {
  pos: [number, number, number]; bone: number; tex: string | null;
  blend: number; type: number; rows: number; cols: number; flags: number;
  speed: number; speedVar: number; vRange: number; hRange: number; gravity: number;
  life: number; rate: number; areaL: number; areaW: number; zSource: number;
};
type RibbonDef = {
  pos: [number, number, number]; bone: number; tex: (string | null)[];
  color: [number, number, number]; alpha: number; above: number; below: number;
  edgesPerSec: number; edgeLife: number; gravity: number; rows: number; cols: number;
};
type Mesh = { source: string; positions: number[]; normals: number[]; uvs: number[]; parts: Part[]; texXf?: BakedM2Transform[]; gs?: number[]; collision?: { positions: number[]; indices: number[] }; particles?: ParticleDef[]; ribbons?: RibbonDef[] };

async function main() {
  console.log('=== bake-doodads (per-submesh textured) ===');
  // Which tile to bake doodads for: TILE_KEY env, else the last tile bake-tile.ts wrote.
  const key = process.env.TILE_KEY || readFileSync(`${PUBLIC}/.last-baked`, 'utf8').trim();
  const TILE_DIR = `${PUBLIC}/tiles/${key}`;
  const meta = JSON.parse(readFileSync(`${TILE_DIR}/meta.json`, 'utf8'));
  const tilePath: string = meta.source;
  const dir: string = meta.dir ?? tilePath.split('\\')[2] ?? 'Azeroth';
  console.log(`baking doodads for tile "${key}"`);

  // Parse placements and resolve assets from the same patch-first view the original client uses.
  // The old code searched patches for textures, but loaded WDT/ADT placement bytes from the base
  // terrain.MPQ; 83 indexed ADTs differ and their patched MDDF placements disappeared at the bake.
  const terrain = await ClientArchiveSet.open(CACHE, ['terrain.MPQ']);
  const models = await ClientArchiveSet.open(CACHE, ['model.MPQ']);
  const texture = await ClientArchiveSet.open(CACHE, ['texture.MPQ']);
  const interfaceMpq = await ClientArchiveSet.open(CACHE, ['interface.MPQ']);
  const map = new WowMap().load(terrain.extract(wdtPath(dir)));
  const area = new MapArea(map.layerSplatDepth).load(terrain.extract(tilePath));

  const c0 = area.chunks[0].position!;
  const centerX = c0[0] - TILE / 2;
  const centerY = c0[1] - TILE / 2;

  // Vanilla (1.12.1) MDDF rotation is Euler angles in DEGREES: [rotX(pitch), rotY(YAW), rotZ(roll)],
  // exactly like MODF (see bake-wmos.ts + BAKE_SOURCE_OF_TRUTH.md). @wowserhq normalizes it the
  // WotLK way, which faced every building 180° backwards — the same error hides on rotationally
  // symmetric trees/rocks but is glaring on fences/carts/signposts. Parse raw MDDF ourselves,
  // keyed by uniqueId; only @wowserhq's normalized *position* is kept (verified correct).
  const adtBytes = terrain.extract(tilePath);
  const adv = new DataView(adtBytes.buffer, adtBytes.byteOffset, adtBytes.byteLength);
  const findAdtChunk = (sig: string): { off: number; sz: number } | null => {
    const rev = sig.split('').reverse().join('');
    for (let i = 0x14; i < adtBytes.length - 8; i++) {
      if (String.fromCharCode(adtBytes[i], adtBytes[i + 1], adtBytes[i + 2], adtBytes[i + 3]) === rev) {
        return { off: i + 8, sz: adv.getUint32(i + 4, true) };
      }
    }
    return null;
  };
  const rawRotById = new Map<number, [number, number, number]>();
  const mddfChunk = findAdtChunk('MDDF');
  if (mddfChunk) {
    const n = Math.floor(mddfChunk.sz / 36); // 36-byte MDDF entries
    for (let i = 0; i < n; i++) {
      const o = mddfChunk.off + i * 36;
      const uid = adv.getUint32(o + 4, true); // uniqueId @+4 (nameId @+0)
      rawRotById.set(uid, [adv.getFloat32(o + 20, true), adv.getFloat32(o + 24, true), adv.getFloat32(o + 28, true)]);
    }
  }
  /** Vanilla MDDF Euler (degrees) -> placement quaternion [x,y,z,w] in our Z-up render space.
   *  Same convention as bake-wmos.ts vanillaQuat: pure yaw about world-up + the +180° model-forward
   *  offset (verified in-engine on the Northshire Abbey door). */
  const vanillaQuat = (rotDeg: [number, number, number] | undefined, fallback: number[]): [number, number, number, number] => {
    if (!rotDeg) return [fallback[0] ?? 0, fallback[1] ?? 0, fallback[2] ?? 0, -(fallback[3] ?? 1)]; // legacy fallback
    const YAW_OFFSET = Math.PI;
    const [pitch, yaw, roll] = rotDeg.map((d) => (d * Math.PI) / 180);
    if (pitch === 0 && roll === 0) {
      const h = (yaw + YAW_OFFSET) / 2;
      return [0, 0, Math.sin(h), Math.cos(h)];
    }
    const mul = (a: number[], b: number[]): [number, number, number, number] => [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
    const ax = (axis: [number, number, number], ang: number): number[] => {
      const s = Math.sin(ang / 2);
      return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(ang / 2)];
    };
    // Match Map.getNormalizedDefRotation: quat.fromEuler(rotZ, rotX, rotY + 180). The model
    // vertices are already in the normalized map basis, so rotX is +Y and rotZ is +X here.
    // Negating both axes raises the far end of sloped, end-pivoted models such as these fences.
    const qY = ax([0, 0, 1], yaw + YAW_OFFSET);
    const qX = ax([0, 1, 0], pitch);
    const qZ = ax([1, 0, 0], roll);
    return mul(mul(qY, qX), qZ);
  };

  mkdirSync(`${TILE_DIR}/doodad_tex`, { recursive: true });
  mkdirSync(`${TILE_DIR}/doodad_fx_tex`, { recursive: true });

  // Global texture cache: filename -> index (and writes PNG).
  const texIndex = new Map<string, number>();
  const textureUrls: string[] = [];
  const resolveTexture = (name: string): number => {
    if (!name) return -1;
    if (texIndex.has(name)) return texIndex.get(name)!;
    let idx = -1;
    for (const mpq of [texture, models, terrain, interfaceMpq]) {
      if (!mpq.has(name)) continue;
      try {
        const blp = new Blp().load(mpq.extract(name));
        const img = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
        idx = textureUrls.length;
        writeFileSync(`${TILE_DIR}/doodad_tex/${idx}.png`, encodePng(img.width, img.height, img.data));
        textureUrls.push(`doodad_tex/${idx}.png`);
      } catch {
        idx = -1;
      }
      break;
    }
    texIndex.set(name, idx);
    return idx;
  };
  const effectTexIndex = new Map<string, string | null>();
  const resolveEffectTexture = (name: string, modelPath: string): string | null => {
    if (!name) return null;
    const dir = modelPath.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
    const baseName = name.split(/[\\/]/).pop() ?? name;
    const candidates = [
      name,
      name.replace(/\//g, '\\'),
      `${dir}/${baseName}`.replace(/\//g, '\\'),
      `Textures\\${baseName}`,
    ];
    const found = candidates.find((c) => [texture, models, terrain, interfaceMpq].some((mpq) => mpq.has(c)));
    const key = (found ?? name).toLowerCase();
    if (effectTexIndex.has(key)) return effectTexIndex.get(key)!;
    let ref: string | null = null;
    if (found) {
      for (const mpq of [texture, models, terrain, interfaceMpq]) {
        if (!mpq.has(found)) continue;
        try {
          const blp = new Blp().load(mpq.extract(found));
          const img = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
          const idx = effectTexIndex.size;
          writeFileSync(`${TILE_DIR}/doodad_fx_tex/${idx}.png`, encodePng(img.width, img.height, img.data));
          ref = `terrain/tiles/${keyFromTileDir(TILE_DIR)}/doodad_fx_tex/${idx}.png`;
        } catch {
          ref = null;
        }
        break;
      }
    }
    effectTexIndex.set(key, ref);
    return ref;
  };
  const toEffectAsset = (bytes: Uint8Array, modelPath: string) => {
    const emit = readM2Emitters(bytes);
    const texNames = readM2TextureFilenames(bytes);
    const texRef = (globalIdx: number) => resolveEffectTexture(texNames[globalIdx] ?? '', modelPath);
    const particles: ParticleDef[] = emit.particles.map((p) => ({
      pos: p.position, bone: p.bone, tex: texRef(p.textureIndex), blend: p.blendType, type: p.emitterType,
      rows: p.rows, cols: p.cols, flags: p.flags,
      speed: p.emissionSpeed, speedVar: p.speedVariation, vRange: p.verticalRange, hRange: p.horizontalRange,
      gravity: p.gravity, life: p.lifespan, rate: p.emissionRate, areaL: p.emissionAreaLength,
      areaW: p.emissionAreaWidth, zSource: p.zSource,
    }));
    const ribbons: RibbonDef[] = emit.ribbons.map((r) => ({
      pos: r.position, bone: r.bone, tex: r.textureIndices.map(texRef),
      color: r.color, alpha: r.alpha, above: r.above, below: r.below,
      edgesPerSec: r.edgesPerSecond, edgeLife: r.edgeLifetime, gravity: r.gravity, rows: r.rows, cols: r.cols,
    }));
    return { particles, ribbons };
  };
  const keyFromTileDir = (dir: string) => dir.replace(/\\/g, '/').split('/').pop() ?? key;

  const meshIndex = new Map<string, number>();
  const meshes: Mesh[] = [];
  const instances: { m: number; x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number; s: number }[] = [];
  let missing = 0;
  let totalParts = 0;

  for (const d of area.doodadDefs as any[]) {
    const name = normName(d.name);
    let mi = meshIndex.get(name);
    if (mi === undefined) {
      mi = -1;
      if (models.has(name)) {
        try {
          const bytes = models.extract(name);
          const effects = toEffectAsset(bytes, name);
          let m: ReturnType<typeof readVanillaM2> | null = null;
          try { m = readVanillaM2(bytes); } catch { m = null; }
          if (!m && !effects.particles.length && !effects.ribbons.length) throw new Error('no geometry or emitters');
          const positions = m ? Array.from(m.positions) : [];
          const normals = m ? Array.from(m.normals) : [];
          const uvs = m ? Array.from(m.uvs) : [];

          // Split into per-submesh parts, each with its own texture.
          const parts: Part[] = [];
          if (m) {
            const subs = m.submeshes.length
              ? m.submeshes
              : [{ triangleStart: 0, triangleCount: m.indices.length, textureIndex: 0, textureTransform: -1, blendMode: 0, renderFlags: 0 }];
            for (const sub of subs) {
              const end = sub.triangleStart + sub.triangleCount;
              if (sub.triangleCount <= 0 || end > m.indices.length) continue;
              const texName = m.textures[sub.textureIndex]?.filename || m.textures.find((t) => t.filename)?.filename || '';
              parts.push({
                indices: Array.from(m.indices.subarray(sub.triangleStart, end)),
                tex: resolveTexture(texName),
                blendMode: sub.blendMode ?? 0,
                renderFlags: sub.renderFlags ?? 0,
                xf: sub.textureTransform ?? -1,
              });
            }
          }
          totalParts += parts.length;
          meshes.push({
            source: name,
            positions,
            normals,
            uvs,
            parts,
            ...(m?.textureTransforms.length ? { texXf: bakeM2TextureTransforms(m.textureTransforms), gs: Array.from(m.globalSequences) } : {}),
            ...(m?.collisionIndices.length ? { collision: { positions: Array.from(m.collisionPositions), indices: Array.from(m.collisionIndices) } } : {}),
            ...(effects.particles.length ? { particles: effects.particles } : {}),
            ...(effects.ribbons.length ? { ribbons: effects.ribbons } : {}),
          });
          mi = meshes.length - 1;
        } catch {
          missing++;
        }
      } else {
        missing++;
      }
      meshIndex.set(name, mi);
    }
    if (mi < 0) continue;

    // Vanilla-correct quaternion from raw MDDF degrees (see vanillaQuat above), matched by uniqueId.
    const [qx, qy, qz, qw] = vanillaQuat(rawRotById.get(d.id), d.rotation ?? [0, 0, 0, 1]);
    instances.push({
      m: mi,
      x: d.position[0] - centerX,
      y: d.position[1] - centerY,
      z: d.position[2],
      qx, qy, qz, qw,
      s: (d.scale ?? 1024) / 1024,
    });
  }

  console.log(`uniqueMeshes=${meshes.length} parts=${totalParts} textures=${textureUrls.length} instances=${instances.length} missing=${missing}`);

  const json = JSON.stringify({ meshes, textures: textureUrls, instances });
  writeFileSync(`${TILE_DIR}/doodads.json`, json);
  console.log(`wrote doodads.json (${(json.length / 1048576).toFixed(2)} MB) + ${textureUrls.length} texture PNGs`);

  terrain.close();
  models.close();
  texture.close();
  interfaceMpq.close();
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
