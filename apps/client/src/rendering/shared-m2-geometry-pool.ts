import * as THREE from 'three';
import type { M2StaticSkinAttributes } from './m2-gpu-skinning';
import { releaseSharedTextureForModel, retainSharedTextureForModel } from './shared-texture-cache';

type GeometrySource = {
  positions: ArrayLike<number>;
  normals?: ArrayLike<number> | null;
  uvs: ArrayLike<number>;
  boneWeights: ArrayLike<number>;
  boneIndices: ArrayLike<number>;
};
type GeometryPart = { indices: number[] | Uint16Array | Uint32Array };
type Entry = {
  refs: number;
  geometries: THREE.BufferGeometry[];
  position: THREE.Float32BufferAttribute;
  normal: THREE.Float32BufferAttribute | null;
  skinAttributes: M2StaticSkinAttributes;
};

export type SharedM2GeometryLease = Omit<Entry, 'refs'> & { release: () => void };
const RELEASE_KEY = 'releaseSharedM2Geometry';
const TEXTURES_KEY = 'sharedM2Textures';

export function createSharedM2GeometryGroup(lease: SharedM2GeometryLease, materials: readonly THREE.Material[]): THREE.Group {
  const group = new THREE.Group();
  for (let index = 0; index < lease.geometries.length; index++) group.add(new THREE.Mesh(lease.geometries[index], materials[index]));
  const textures = [...new Set(materials.map((material) => (material as THREE.ShaderMaterial).uniforms?.uMap?.value)
    .filter((texture): texture is THREE.Texture => texture?.isTexture === true))];
  for (const texture of textures) retainSharedTextureForModel(texture);
  group.userData[TEXTURES_KEY] = textures;
  group.userData[RELEASE_KEY] = lease.release;
  return group;
}

/**
 * GPU skinning does not update Three.js' CPU-side geometry bounds. Some Build 5875 GameObjects
 * author their bind vertices far from the object origin and use the root bone to move the visible
 * pose back to it (DuelingFlag is roughly z=9..15 in bind pose, then Stand lowers it to ground).
 * Keep ordinary frustum culling, but make its sphere conservatively cover both the origin and every
 * bind-pose vertex so a valid skinned pose cannot be rejected using only the displaced bind pose.
 */
export function centerM2BoundsOnOrigin(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    const bounds = mesh.geometry.boundingSphere;
    if (!bounds) return;
    bounds.radius += bounds.center.length();
    bounds.center.set(0, 0, 0);
  });
}

export function releaseSharedM2Geometry(root: THREE.Object3D | undefined): boolean {
  const release = root?.userData?.[RELEASE_KEY] as (() => void) | undefined;
  if (!release) return false;
  const textures = (root!.userData[TEXTURES_KEY] ?? []) as THREE.Texture[];
  delete root!.userData[RELEASE_KEY]; delete root!.userData[TEXTURES_KEY]; release();
  for (const texture of textures) releaseSharedTextureForModel(texture);
  return true;
}

/** Ref-count immutable bind-pose geometry; animator palettes remain per rendered entity. */
export class SharedM2GeometryPool {
  private readonly entries = new Map<string, Entry>();
  private created = 0; private released = 0; private peakEntries = 0;

  acquire(key: string, source: GeometrySource, parts: readonly GeometryPart[]): SharedM2GeometryLease {
    let entry = this.entries.get(key);
    if (!entry) {
      const position = new THREE.Float32BufferAttribute(new Float32Array(source.positions), 3);
      position.setUsage(THREE.StaticDrawUsage);
      const normal = source.normals?.length === source.positions.length
        ? new THREE.Float32BufferAttribute(new Float32Array(source.normals), 3) : null;
      normal?.setUsage(THREE.StaticDrawUsage);
      const uv = new THREE.Float32BufferAttribute(new Float32Array(source.uvs), 2);
      const skinAttributes: M2StaticSkinAttributes = {
        boneIndex: new THREE.Uint8BufferAttribute(Uint8Array.from(source.boneIndices), 4, false),
        boneWeight: new THREE.Uint8BufferAttribute(Uint8Array.from(source.boneWeights), 4, true),
      };
      const geometries = parts.map((part) => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', position); geometry.setAttribute('uv', uv);
        geometry.setAttribute('wowBoneIndex', skinAttributes.boneIndex);
        geometry.setAttribute('wowBoneWeight', skinAttributes.boneWeight);
        if (normal) geometry.setAttribute('normal', normal);
        geometry.setIndex(Array.isArray(part.indices) ? part.indices : new THREE.BufferAttribute(part.indices, 1));
        if (!normal) geometry.computeVertexNormals();
        return geometry;
      });
      entry = { refs: 0, geometries, position, normal, skinAttributes };
      this.entries.set(key, entry); this.created++; this.peakEntries = Math.max(this.peakEntries, this.entries.size);
    }
    entry.refs++;
    let active = true;
    return { ...entry, release: () => {
      if (!active) return; active = false; entry!.refs--; this.released++;
      if (entry!.refs > 0) return;
      for (const geometry of entry!.geometries) geometry.dispose();
      this.entries.delete(key);
    } };
  }

  diagnostics() { return { entries: this.entries.size, liveRefs: [...this.entries.values()].reduce((n, e) => n + e.refs, 0), created: this.created, released: this.released, peakEntries: this.peakEntries }; }
}
