/** Asset conversion utility. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import {
  openClientArchives, readVanillaM2, readM2Emitters, readM2EmitterTiming, readM2TextureFilenames,
  type MpqArchive, type VanillaM2Track,
} from '@vanillagl/assets';
import { encodePng } from '../utils/png.ts';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const OUT = fileURLToPath(new URL('../../apps/client/public/spells', import.meta.url));

const assetKey = (p: string) =>
  p.toLowerCase().replace(/\.(m2|mdx|mdl|blp)$/i, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

type BakedTrack = { i: number; g: number; ts: number[]; v: number[]; r?: [number, number][] };
const round = (value: number) => Math.round(value * 10_000) / 10_000;
/**
 * Keep EVERY key, plus the vanilla per-animation key windows.
 *
 * This used to retain only the first valid range, on the assumption that "spell models run
 * sequence zero". State kits do not — they request AnimationData 158 (Hold), and a vanilla
 * material track scopes its keys per animation. IceBarrier_State authors
 * `ts=[3333,3500,4200,8333,9333] v=[0,0,1,1,0]` with `seq0=[0,2] seq158=[2,3] seq159=[3,4]`:
 * dropping keys 3-4 threw away the Hold window's constant alpha 1.0 (the solid ice block) and
 * left only the intro fade-in. Measured over the 100 state-kit models, retaining only range[0]
 * put 41 of 53 comparable tracks at the wrong alpha for the sequence actually played, 3 of them
 * by a full 1.0. Ranges are index pairs into `ts`/`v`, one per sequence, exactly as the M2 ships
 * them — the renderer picks the window for the sequence it is playing.
 */
const bakeTrack = (track: VanillaM2Track | undefined, identity: number): BakedTrack | undefined => {
  if (!track?.timestamps.length || !track.values.length) return undefined;
  const timestamps = track.timestamps.slice();
  const values = track.values.slice(0, timestamps.length * track.components);
  if (!timestamps.length || values.length < timestamps.length * track.components) return undefined;
  if (timestamps.length === 1 && values.every((value) => Math.abs(value - identity) < 1e-6)) return undefined;
  const baked: BakedTrack = {
    i: track.interpolation,
    g: track.globalSequence,
    ts: timestamps,
    v: values.map(round),
  };
  // Global-sequence tracks loop on their own period and are not scoped per animation.
  if (track.globalSequence < 0 && track.ranges.length) {
    baked.r = track.ranges.map(([a, b]) => [
      Math.max(0, Math.min(timestamps.length - 1, a)),
      Math.max(0, Math.min(timestamps.length - 1, b)),
    ] as [number, number]);
  }
  return baked;
};

async function main() {
  mkdirSync(`${OUT}/models`, { recursive: true });
  mkdirSync(`${OUT}/tex`, { recursive: true });

  const archives: MpqArchive[] = await openClientArchives(
    CACHE,
    [
      'model.MPQ',
      'texture.MPQ',
      'terrain.MPQ', // several LightSkybox models live with world data
      'interface.MPQ', // spell glows reference Interface\Buttons BLPs
    ],
  );

  const spellModels: string[] = JSON.parse(readFileSync(`${OUT}/spell-visual-models.json`, 'utf8'));
  // LightSkybox.dbc paths. Baking them through the same byte-verified M2 path keeps
  // sky models and spell-effect cores on one renderer and avoids guessed substitutes.
  const skyboxModels = [
    'Environments\\Stars\\StratholmeSkybox.m2',
    'Environments\\Stars\\PortalWorldLegionSky.m2',
    'Environments\\Stars\\DeathClouds.m2',
    'Environments\\Stars\\Stars.m2',
    'Environments\\Stars\\CavernsOfTimeSky.m2',
    'Environments\\Stars\\DireMaulSkyBox.m2',
  ];
  const systemModels = ['Spells\\LevelUp\\LevelUp.m2'];
  const models = [...new Set([...spellModels, ...skyboxModels, ...systemModels])];
  const texPool = new Map<string, string>(); // source BLP path(lower) -> "tex/<key>.png"
  const missingTex = new Set<string>();
  const index: Record<string, string> = {};
  const modelPathsByBase = new Map<string, string[]>();
  const seenModelPaths = new Set<string>();
  for (const archive of archives) {
    for (const path of archive.list('*.m2')) {
      const normalized = path.replace(/\//g, '\\');
      const lower = normalized.toLowerCase();
      if (seenModelPaths.has(lower)) continue;
      seenModelPaths.add(lower);
      const base = lower.split('\\').pop() ?? lower;
      const matches = modelPathsByBase.get(base) ?? [];
      matches.push(normalized);
      modelPathsByBase.set(base, matches);
    }
  }

  const findBytes = (candidates: string[]): Uint8Array | null => {
    for (const c of candidates) for (const a of archives) if (a.has(c)) return a.extract(c);
    return null;
  };

  /** Resolve a texture filename embedded in an M2 (may be bare or path'd) and bake it once to PNG. */
  const resolveTexture = (name: string, modelPath: string): string | null => {
    if (!name) return null;
    const dir = modelPath.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
    const base = name.split(/[\\/]/).pop() ?? name;
    const cands = [name, name.replace(/\//g, '\\'), `${dir}/${base}`.replace(/\//g, '\\'), `Textures\\${base}`];
    const key = cands.find((c) => archives.some((a) => a.has(c)))?.toLowerCase();
    if (!key) { missingTex.add(name); return null; }
    const cached = texPool.get(key);
    if (cached) return cached;
    const ref = `tex/${assetKey(key)}.png`;
    const bytes = findBytes(cands)!;
    try {
      const blp = new Blp().load(bytes);
      const img = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
      writeFileSync(`${OUT}/${ref}`, encodePng(img.width, img.height, img.data));
    } catch (e) {
      missingTex.add(`${name} (decode: ${(e as Error).message})`);
      return null;
    }
    texPool.set(key, ref);
    return ref;
  };

  let ok = 0;
  let totalParts = 0;
  let totalRibbons = 0;
  for (const modelPath of models) {
    const m2path = modelPath.replace(/\.(mdx|mdl)$/i, '.m2').replace(/\//g, '\\');
    let resolvedModelPath = m2path;
    let bytes = findBytes([resolvedModelPath, resolvedModelPath.toLowerCase()]);
    if (!bytes) {
      // Some Build-5875 SpellVisualEffectName rows retain a pre-move directory while the MPQ
      // contains the same uniquely named model under Spells\. Resolve only a unique basename:
      // ambiguous aliases stay red/missing instead of guessing between real authored assets.
      const basename = resolvedModelPath.toLowerCase().split('\\').pop() ?? '';
      const aliases = modelPathsByBase.get(basename) ?? [];
      if (aliases.length === 1) {
        resolvedModelPath = aliases[0];
        bytes = findBytes([resolvedModelPath, resolvedModelPath.toLowerCase()]);
        if (bytes) console.log(`  alias ${modelPath} -> ${resolvedModelPath}`);
      }
    }
    if (!bytes) { console.warn(`  !! missing model ${modelPath}`); continue; }

    const emit = readM2Emitters(bytes);
    const timing = readM2EmitterTiming(bytes);
    const texNames = readM2TextureFilenames(bytes);
    const texRef = (globalIdx: number) => resolveTexture(texNames[globalIdx] ?? '', resolvedModelPath);
    // Geometry is optional — many spell models are pure-emitter (0 verts) and readVanillaM2 throws.
    let mesh: ReturnType<typeof readVanillaM2> | null = null;
    try { mesh = readVanillaM2(bytes); } catch { /* emitter-only model */ }

    const particles = emit.particles.map((p) => ({
      pos: p.position, bone: p.bone, tex: texRef(p.textureIndex), blend: p.blendType, type: p.emitterType,
      rows: p.rows, cols: p.cols, flags: p.flags,
      speed: p.emissionSpeed, speedVar: p.speedVariation, vRange: p.verticalRange, hRange: p.horizontalRange,
      gravity: p.gravity, life: p.lifespan, rate: p.emissionRate, areaL: p.emissionAreaLength,
      areaW: p.emissionAreaWidth, zSource: p.zSource,
      midpoint: p.midpoint, colors: p.colors, scales: p.scales,
      headCells: p.headCells, tailCells: p.tailCells, tailLength: p.tailLength,
      twinkleSpeed: p.twinkleSpeed, twinklePercent: p.twinklePercent, twinkleScale: p.twinkleScale,
      burstMultiplier: p.burstMultiplier, drag: p.drag,
      tracks: p.emissionTracks,
      // Authored on/off timeline. 471 of 864 corpus emitters key this; without it an emitter
      // whose first "on" key is at 1000ms (ArcaneExplosion_Impact_Chest) either never fires or
      // fires from t=0 and never stops.
      enabled: p.enabledTrack.timestamps.length ? p.enabledTrack : undefined,
    }));
    const ribbons = emit.ribbons.map((r) => ({
      pos: r.position, bone: r.bone, tex: r.textureIndices.map(texRef).filter(Boolean),
      color: r.color, alpha: r.alpha, above: r.above, below: r.below,
      edgesPerSec: r.edgesPerSecond, edgeLife: r.edgeLifetime, gravity: r.gravity, rows: r.rows, cols: r.cols,
    }));

    // Light geometry (the static core mesh, if any) — spell models are small.
    let geometry: unknown = null;
    let animation: unknown = null;
    if (mesh && mesh.vertexCount > 0 && mesh.indices.length > 0 && mesh.submeshes.length > 0) {
      geometry = {
        positions: Array.from(mesh.positions, (v) => +v.toFixed(4)),
        normals: Array.from(mesh.normals, (v) => +v.toFixed(3)),
        uvs: Array.from(mesh.uvs, (v) => +v.toFixed(4)),
        boneWeights: Array.from(mesh.boneWeights),
        boneIndices: Array.from(mesh.boneIndices),
        indices: Array.from(mesh.indices),
        submeshes: mesh.submeshes.map((s) => ({
          start: s.triangleStart, count: s.triangleCount, tex: texRef(s.textureIndex),
          blend: s.blendMode, flags: s.renderFlags,
          xf: s.textureTransform, mc: s.colorIndex, mw: s.textureWeight,
        })),
        texXf: mesh.textureTransforms.map((xf) => ({
          t: bakeTrack(xf.translation, 0),
          r: bakeTrack(xf.rotation, 0),
          s: bakeTrack(xf.scaling, 1),
        })),
        matColor: mesh.colors.map((color) => ({
          c: bakeTrack(color.color, 1),
          a: bakeTrack(color.alpha, 1),
        })),
        matWeight: mesh.textureWeights.map((weight) => bakeTrack(weight, 1) ?? null),
        gs: Array.from(mesh.globalSequences),
      };
      // Spell-area models such as Blizzard attach emitters to animated bones. Baking only their
      // bind-pose geometry leaves the snow emitters frozen several yards above the destination.
      // Reuse the same Build-5875 bone/sequence payload as creatures and doodads so both the core
      // mesh and emitter anchors follow the authored M2 animation.
      animation = {
        sequences: mesh.sequences,
        globalSequences: mesh.globalSequences,
        animLookup: Array.from(mesh.animLookup),
        bones: mesh.bones,
        attachments: mesh.attachments,
      };
    }

    const key = assetKey(modelPath);
    index[modelPath] = key;
    writeFileSync(
      `${OUT}/models/${key}.json`,
      JSON.stringify({ model: modelPath, particles, ribbons, geometry, animation, timing }),
    );
    ok++;
    totalParts += particles.length;
    totalRibbons += ribbons.length;
  }

  writeFileSync(`${OUT}/models/index.json`, JSON.stringify(index, null, 1));
  console.log(`\nbaked ${ok}/${models.length} models · ${totalParts} particle emitters · ${totalRibbons} ribbons · ${texPool.size} textures`);
  if (missingTex.size) console.log(`unresolved textures (${missingTex.size}): ${[...missingTex].slice(0, 15).join(', ')}`);
}

await main();
