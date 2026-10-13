import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, win32 } from 'node:path';
import { ClientArchiveSet, readVanillaM2 } from '@vanillagl/assets';
import { Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import { encodePng } from '../utils/png.ts';

const CACHE = fileURLToPath(new URL('../../.client-cache', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../../apps/client/public/login', import.meta.url));

type GlueSceneDefinition = {
  archivePath: string;
  outputName: string;
};

const GLUE_SCENES: Record<string, GlueSceneDefinition> = {
  mainmenu: {
    archivePath: 'Interface\\Glues\\Models\\UI_MainMenu\\UI_MainMenu.m2',
    outputName: 'mainmenu',
  },
  human: {
    archivePath: 'Interface\\Glues\\Models\\UI_Human\\UI_Human.m2',
    outputName: 'human',
  },
  dwarf: {
    archivePath: 'Interface\\Glues\\Models\\UI_Dwarf\\UI_Dwarf.m2',
    outputName: 'dwarf',
  },
  nightelf: {
    archivePath: 'Interface\\Glues\\Models\\UI_NightElf\\UI_NightElf.m2',
    outputName: 'nightelf',
  },
  orc: {
    archivePath: 'Interface\\Glues\\Models\\UI_Orc\\UI_Orc.m2',
    outputName: 'orc',
  },
  scourge: {
    archivePath: 'Interface\\Glues\\Models\\UI_Scourge\\UI_Scourge.m2',
    outputName: 'scourge',
  },
  tauren: {
    archivePath: 'Interface\\Glues\\Models\\UI_Tauren\\UI_Tauren.m2',
    outputName: 'tauren',
  },
};

function selectedScenes(): GlueSceneDefinition[] {
  const arg = process.argv.find((value) => value.startsWith('--scene='));
  const configured = arg ? arg.slice('--scene='.length) : process.env.GLUE_SCENE;
  if (!configured) return Object.values(GLUE_SCENES);
  const requested = configured.toLowerCase();
  const scene = GLUE_SCENES[requested];
  if (!scene) {
    throw new Error(`Unknown glue scene "${requested}". Choose one of: ${Object.keys(GLUE_SCENES).join(', ')}`);
  }
  return [scene];
}

async function main() {
  const scenes = selectedScenes();
  const archives = await ClientArchiveSet.open(CACHE, [
    'interface.MPQ',
    'model.MPQ',
    'texture.MPQ',
    'misc.MPQ',
  ]);

  try {
    for (const scene of scenes) {
      const outputRoot = scene.outputName === 'mainmenu'
        ? PUBLIC_DIR
        : join(PUBLIC_DIR, 'glue-scenes', scene.outputName);
      const textureDir = join(outputRoot, 'textures');
      console.log(`=== Baking ${scene.archivePath} 3D glue model from local MPQs ===`);

    if (!archives.has(scene.archivePath)) {
      throw new Error(`${scene.archivePath} was not found in the supplied 1.12.1 archives`);
    }

    const data = archives.extract(scene.archivePath);
    const m2 = readVanillaM2(data);
    console.log(`Parsed M2: version=${m2.version}, vertices=${m2.vertexCount}, indices=${m2.indices.length}, submeshes=${m2.submeshes.length}`);

    mkdirSync(textureDir, { recursive: true });
    const texturesList: string[] = [];

    for (let index = 0; index < m2.textures.length; index++) {
      const authored = (m2.textures[index].filename || '').replace(/\//g, '\\');
      const base = authored ? win32.basename(authored, win32.extname(authored)) : `texture_${index}`;
      const pngName = `${base}.png`;
      texturesList.push(pngName);

      const candidates = authored ? [...new Set([
        authored,
        win32.join(win32.dirname(scene.archivePath), authored),
        win32.join(win32.dirname(scene.archivePath), win32.basename(authored)),
      ])] : [];
      const archivePath = candidates.find((candidate) => archives.has(candidate));
      if (!archivePath) {
        console.warn(`  Login texture not found in archives: ${authored || `(texture slot ${index})`}`);
        continue;
      }

      try {
        const blp = new Blp().load(archives.extract(archivePath));
        const image = blp.getImage(0, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
        writeFileSync(join(textureDir, pngName), encodePng(image.width, image.height, image.data));
        console.log(`  ${archivePath} -> ${pngName}`);
      } catch (error) {
        console.warn(`  Failed to decode ${authored}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const u32 = (offset: number) => dv.getUint32(offset, true);
    const f32 = (offset: number) => dv.getFloat32(offset, true);
    const readTrackFirstVec3 = (trackOffset: number): [number, number, number] => {
      const valueCount = u32(trackOffset + 0x14);
      const valueOffset = u32(trackOffset + 0x18);
      if (valueCount > 0 && valueOffset + 12 <= data.length) {
        return [f32(valueOffset), f32(valueOffset + 4), f32(valueOffset + 8)];
      }
      return [0, 0, 0];
    };

    let camera: Record<string, unknown> | null = null;
    const cameraCount = u32(0x124);
    const cameraOffset = u32(0x128);
    if (cameraCount > 0 && cameraOffset + 124 <= data.length) {
      const o = cameraOffset;
      const posBase: [number, number, number] = [f32(o + 44), f32(o + 48), f32(o + 52)];
      const targetBase: [number, number, number] = [f32(o + 84), f32(o + 88), f32(o + 92)];
      const posAnim = readTrackFirstVec3(o + 16);
      const targetAnim = readTrackFirstVec3(o + 56);
      camera = {
        type: u32(o),
        fov: f32(o + 4),
        farClip: f32(o + 8),
        nearClip: f32(o + 12),
        position: posBase.map((value, i) => value + posAnim[i]),
        target: targetBase.map((value, i) => value + targetAnim[i]),
      };
    }

    const modelJson = {
      source: scene.archivePath,
      camera,
      positions: Array.from(m2.positions),
      normals: Array.from(m2.normals),
      uvs: Array.from(m2.uvs),
      indices: Array.from(m2.indices),
      textures: texturesList,
      parts: m2.submeshes.map((sub) => ({
        partId: sub.partId,
        triangleStart: sub.triangleStart,
        triangleCount: sub.triangleCount,
        textureIndex: sub.textureIndex,
        blendMode: sub.blendMode,
        renderFlags: sub.renderFlags,
      })),
    };

    const outPath = join(outputRoot, scene.outputName === 'mainmenu' ? 'mainmenu.json' : 'model.json');
    mkdirSync(outputRoot, { recursive: true });
    writeFileSync(outPath, JSON.stringify(modelJson));
    console.log(`Wrote ${outPath}`);
    }
  } finally {
    archives.close();
  }
}

main().catch((error) => {
  console.error('Glue-scene bake failed:', error);
  process.exit(1);
});
