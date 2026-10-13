import * as THREE from 'three';
import { setM2PerDrawUniform } from './m2-per-draw-uniforms.ts';

export const M2_BONE_TEXTURE_WIDTH = 7;
/** Asset conversion utility. */
const skinningByMesh = new WeakMap<THREE.Object3D, M2GpuSkinning>();
export type M2StaticSkinAttributes = { boneIndex: THREE.Uint8BufferAttribute; boneWeight: THREE.Uint8BufferAttribute };
let activeRigs = 0;
let rigsCreated = 0;
let paletteUpdates = 0;
let bonesPrepared = 0;
let paletteBytesMarkedForUpload = 0;
let snapshotsCreated = 0;

export const m2GpuSkinningDiagnostics = () => ({
  activeRigs,
  rigsCreated,
  paletteUpdates,
  bonesPrepared,
  paletteBytesMarkedForUpload,
  snapshotsCreated,
  note: 'Palette bytes count CPU DataTexture payloads marked dirty; WebGL uploads occur lazily on the next rendered use.',
});

/** First GPU-skinning rig under `root`, or null when the model is unskinned (static props, ammo). */
export function resolveM2Skinning(root: THREE.Object3D | undefined): M2GpuSkinning | null {
  if (!root) return null;
  let found: M2GpuSkinning | null = null;
  root.traverse((object) => {
    if (found) return;
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    found = skinningByMesh.get(mesh) ?? null;
  });
  return found;
}

/**
 * Per-rig GPU skinning state. Four texels hold the final position matrix and three hold its
 * inverse-transpose normal matrix. This is the WebGL2 equivalent of Build 5875's vertex-program
 * palette, without the native 21-bone constant-register limit.
 */
export class M2GpuSkinning {
  readonly texture: THREE.DataTexture;
  readonly boneIndexAttribute: THREE.Uint8BufferAttribute;
  readonly boneWeightAttribute: THREE.Uint8BufferAttribute;
  readonly texelData: Float32Array;

  private readonly boneCount: number;
  private readonly skinMatrix = new THREE.Matrix4();
  private readonly skinNormal = new THREE.Matrix3();
  private disposed = false;

  constructor(boneWeights: ArrayLike<number>, boneIndices: ArrayLike<number>, boneCount: number, shared?: M2StaticSkinAttributes) {
    this.boneCount = Math.max(1, boneCount);
    activeRigs++;
    rigsCreated++;
    this.texelData = new Float32Array(M2_BONE_TEXTURE_WIDTH * this.boneCount * 4);
    this.boneIndexAttribute = shared?.boneIndex ?? new THREE.Uint8BufferAttribute(Uint8Array.from(boneIndices), 4, false);
    this.boneWeightAttribute = shared?.boneWeight ?? new THREE.Uint8BufferAttribute(Uint8Array.from(boneWeights), 4, true);
    this.texture = new THREE.DataTexture(
      this.texelData,
      M2_BONE_TEXTURE_WIDTH,
      this.boneCount,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    this.texture.name = 'wow-m2-bone-texture';
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;

    const identity = new THREE.Matrix4();
    this.update(Array.from({ length: this.boneCount }, () => identity), identity);
  }

  update(boneMatrices: readonly THREE.Matrix4[], rootInverse: THREE.Matrix4): void {
    for (let bone = 0; bone < this.boneCount; bone++) {
      const source = boneMatrices[bone];
      if (source) this.skinMatrix.multiplyMatrices(rootInverse, source);
      else this.skinMatrix.identity();
      this.skinNormal.getNormalMatrix(this.skinMatrix);

      const row = bone * M2_BONE_TEXTURE_WIDTH * 4;
      this.texelData.set(this.skinMatrix.elements, row);
      const normal = this.skinNormal.elements;
      for (let column = 0; column < 3; column++) {
        const target = row + (4 + column) * 4;
        this.texelData[target] = normal[column * 3];
        this.texelData[target + 1] = normal[column * 3 + 1];
        this.texelData[target + 2] = normal[column * 3 + 2];
        this.texelData[target + 3] = 0;
      }
    }
    this.texture.needsUpdate = true;
    paletteUpdates++;
    bonesPrepared += this.boneCount;
    paletteBytesMarkedForUpload += this.texelData.byteLength;
  }

  bindGroup(group: THREE.Object3D): void {
    group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const positions = mesh.geometry.getAttribute('position');
      if (!positions || positions.count !== this.boneIndexAttribute.count) return;
      skinningByMesh.set(mesh, this);
      mesh.geometry.setAttribute('wowBoneIndex', this.boneIndexAttribute);
      mesh.geometry.setAttribute('wowBoneWeight', this.boneWeightAttribute);
      const previous = mesh.onBeforeRender;
      mesh.onBeforeRender = (renderer, scene, camera, geometry, material, groupData) => {
        previous.call(mesh, renderer, scene, camera, geometry, material, groupData);
        const shader = material as THREE.ShaderMaterial;
        const uniform = shader.uniforms?.uBoneTexture;
        if (!uniform) throw new Error('GPU-skinned M2 material is missing uBoneTexture');
        setM2PerDrawUniform(shader, uniform, this.texture);
      };
    });
  }

  getSkinnedPosition(vertexIndex: number, bindPositions: ArrayLike<number>, target: THREE.Vector3): THREE.Vector3 {
    const weights = this.boneWeightAttribute.array as Uint8Array;
    const indices = this.boneIndexAttribute.array as Uint8Array;
    const x = Number(bindPositions[vertexIndex * 3] ?? 0);
    const y = Number(bindPositions[vertexIndex * 3 + 1] ?? 0);
    const z = Number(bindPositions[vertexIndex * 3 + 2] ?? 0);
    let outX = 0, outY = 0, outZ = 0, total = 0;
    for (let influence = 0; influence < 4; influence++) {
      const weight = weights[vertexIndex * 4 + influence] / 255;
      if (weight <= 0) continue;
      const bone = indices[vertexIndex * 4 + influence];
      if (bone >= this.boneCount) continue;
      const o = bone * M2_BONE_TEXTURE_WIDTH * 4;
      outX += (this.texelData[o] * x + this.texelData[o + 4] * y + this.texelData[o + 8] * z + this.texelData[o + 12]) * weight;
      outY += (this.texelData[o + 1] * x + this.texelData[o + 5] * y + this.texelData[o + 9] * z + this.texelData[o + 13]) * weight;
      outZ += (this.texelData[o + 2] * x + this.texelData[o + 6] * y + this.texelData[o + 10] * z + this.texelData[o + 14]) * weight;
      total += weight;
    }
    return total > 0 ? target.set(outX / total, outY / total, outZ / total) : target.set(x, y, z);
  }

  /**
   * A frozen copy of the current pose, as its own texture.
   *
   * Vanilla unit portraits capture one frame and hold it (`PortraitButton.cpp`), so the portrait
   * must not read the live rig texture: that would keep animating with the world model, and the
   * value is swapped per draw because the M2 material is shared. Copying the texel data detaches
   * both. Also required because the portrait renders through its own WebGLRenderer.
   */
  snapshotTexture(): THREE.DataTexture {
    snapshotsCreated++;
    const snapshot = new THREE.DataTexture(
      this.texelData.slice(),
      M2_BONE_TEXTURE_WIDTH,
      this.boneCount,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    snapshot.name = 'wow-m2-bone-texture-snapshot';
    snapshot.magFilter = THREE.NearestFilter;
    snapshot.minFilter = THREE.NearestFilter;
    snapshot.generateMipmaps = false;
    snapshot.needsUpdate = true;
    return snapshot;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    activeRigs--;
    this.texture.dispose();
  }
}
