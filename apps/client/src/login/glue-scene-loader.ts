import * as THREE from 'three';
import { cloneMaterialWithSharedTextures } from '../rendering/clone-material-shared-textures';
import { createM2Material } from '../m2-material';

export type GlueSceneKey = 'mainmenu' | 'human' | 'dwarf' | 'nightelf' | 'orc' | 'scourge' | 'tauren';

export type BakedGlueCamera = {
  type: number;
  fov: number;
  farClip: number;
  nearClip: number;
  position: [number, number, number];
  target: [number, number, number];
};

type GlueSceneManifest = {
  camera: BakedGlueCamera | null;
  positions: number[];
  normals?: number[];
  uvs: number[];
  indices: number[];
  textures: string[];
  parts: Array<{
    triangleStart: number;
    triangleCount: number;
    textureIndex: number;
    blendMode?: number;
    renderFlags?: number;
  }>;
};

export type LoadedGlueScene = {
  group: THREE.Group;
  textures: (THREE.Texture | null)[];
  textureNames: string[];
  camera: BakedGlueCamera | null;
};

const SCENE_PATHS: Record<GlueSceneKey, { manifest: string; textureBase: string }> = {
  mainmenu: { manifest: '/login/mainmenu.json', textureBase: '/login/textures/' },
  human: { manifest: '/login/glue-scenes/human/model.json', textureBase: '/login/glue-scenes/human/textures/' },
  dwarf: { manifest: '/login/glue-scenes/dwarf/model.json', textureBase: '/login/glue-scenes/dwarf/textures/' },
  nightelf: { manifest: '/login/glue-scenes/nightelf/model.json', textureBase: '/login/glue-scenes/nightelf/textures/' },
  orc: { manifest: '/login/glue-scenes/orc/model.json', textureBase: '/login/glue-scenes/orc/textures/' },
  scourge: { manifest: '/login/glue-scenes/scourge/model.json', textureBase: '/login/glue-scenes/scourge/textures/' },
  tauren: { manifest: '/login/glue-scenes/tauren/model.json', textureBase: '/login/glue-scenes/tauren/textures/' },
};

/** The original glue client chooses a background model from the selected race. */
export function glueSceneForRace(race: number): GlueSceneKey {
  switch (race) {
    case 2: return 'orc';
    case 3: return 'dwarf';
    case 4: return 'nightelf';
    case 5: return 'scourge';
    case 6: return 'tauren';
    case 8: return 'orc'; // Build 5875 has no separate Troll glue model.
    case 7: return 'human'; // Gnome uses the closest Alliance scene when no model is present.
    default: return 'human';
  }
}

export async function loadGlueScene(key: GlueSceneKey, maxAnisotropy: number): Promise<LoadedGlueScene> {
  const paths = SCENE_PATHS[key];
  const response = await fetch(paths.manifest);
  if (!response.ok) throw new Error(`Glue scene fetch failed (${response.status}): ${paths.manifest}`);
  const data = await response.json() as GlueSceneManifest;
  const loader = new THREE.TextureLoader();
  const textures = await Promise.all(data.textures.map((name) => loader.loadAsync(`${paths.textureBase}${name}`).then((tex) => {
    const image = tex.image as { width?: number; height?: number } | undefined;
    if (!image || Number(image.width) <= 0 || Number(image.height) <= 0) {
      tex.dispose();
      return null;
    }
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = maxAnisotropy;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
  }).catch(() => null)));

  const group = new THREE.Group();
  const positions = new THREE.Float32BufferAttribute(new Float32Array(data.positions), 3);
  const normals = data.normals ? new THREE.Float32BufferAttribute(new Float32Array(data.normals), 3) : null;
  const uvs = new THREE.Float32BufferAttribute(data.uvs, 2);
  const materials = new Map<string, THREE.Material>();
  const materialFor = (part: GlueSceneManifest['parts'][number]) => {
    const cacheKey = `${part.textureIndex}:${part.blendMode ?? 0}:${part.renderFlags ?? 0}`;
    let material = materials.get(cacheKey);
    if (!material) {
      material = createM2Material({ texture: textures[part.textureIndex] ?? null, blendMode: part.blendMode ?? 0, renderFlags: part.renderFlags ?? 0 });
      materials.set(cacheKey, material);
    }
    return material;
  };

  data.parts.forEach((part, index) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', positions);
    if (normals) geometry.setAttribute('normal', normals);
    geometry.setAttribute('uv', uvs);
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(data.indices.slice(part.triangleStart, part.triangleStart + part.triangleCount)), 1));

    const textureName = (data.textures[part.textureIndex] ?? '').toUpperCase();
    let material = materialFor(part);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${key} part ${index}: ${textureName}`;
    mesh.frustumCulled = false;
    if (textureName.includes('SKY') || textureName.includes('CLOUD')) {
      material = cloneMaterialWithSharedTextures(material);
      material.depthWrite = false;
      mesh.material = material;
      mesh.renderOrder = -10 + index;
    }
    group.add(mesh);
  });

  return { group, textures, textureNames: data.textures, camera: data.camera };
}

export function disposeGlueScene(scene: LoadedGlueScene | null): void {
  if (!scene) return;
  const disposedTextures = new Set<THREE.Texture>();
  scene.group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => {
      const texture = (material as THREE.MeshBasicMaterial).map;
      if (texture && !disposedTextures.has(texture)) {
        disposedTextures.add(texture);
        texture.dispose();
      }
      material.dispose();
    });
  });
  scene.textures.forEach((texture) => {
    if (texture && !disposedTextures.has(texture)) texture.dispose();
  });
}
