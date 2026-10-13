import * as THREE from 'three';
import { blobShadowMeshes } from './blob-shadow-registry';
import { BLOB_SHADOW_VERTEX_SHADER, BLOB_SHADOW_FRAGMENT_SHADER } from './blob-shadow';

type Entry = { mesh: THREE.Mesh; depth: number; strength: number };
type Batch = {
  mesh?: THREE.InstancedMesh; strengths?: THREE.InstancedBufferAttribute; capacity: number;
  entries: Entry[]; records: WeakMap<THREE.Mesh, Entry>; hidden: THREE.Mesh[];
  matrix: THREE.Matrix4; projection: THREE.Matrix4; frustum: THREE.Frustum; position: THREE.Vector3;
  lost?: () => void; failed?: boolean;
};
const batches = new WeakMap<THREE.WebGLRenderer, WeakMap<THREE.Scene, Batch>>();
const defaultEnabled = typeof location === 'undefined' || new URLSearchParams(location.search).get('shadowbatch') !== 'off';
const MIN_SHADOWS = 8;

function eligible(mesh: THREE.Mesh, scene: THREE.Scene, camera: THREE.Camera): boolean {
  if (!mesh.visible || !camera.layers.test(mesh.layers) || mesh.renderOrder !== 1) return false;
  for (let parent = mesh.parent; parent; parent = parent.parent) {
    if (!parent.visible || (parent instanceof THREE.Group && parent.renderOrder !== 0)) return false;
    if (parent === scene) return true;
  }
  return false;
}

function disposeBatch(batch: Batch) {
  batch.mesh?.removeFromParent();
  batch.mesh?.geometry.dispose();
  (batch.mesh?.material as THREE.Material | undefined)?.dispose();
  batch.mesh?.dispose();
  batch.mesh = undefined; batch.strengths = undefined; batch.capacity = 0;
}

function allocate(batch: Batch, source: THREE.Mesh) {
  const previousMaterial = batch.mesh?.material as THREE.ShaderMaterial | undefined;
  // Growing an instance buffer must not delete/recompile the already-warm shadow program.
  batch.mesh?.removeFromParent(); batch.mesh?.geometry.dispose(); batch.mesh?.dispose();
  batch.capacity = Math.max(16, 2 ** Math.ceil(Math.log2(batch.entries.length)));
  const geometry = source.geometry.clone(), material = previousMaterial ?? (source.material as THREE.ShaderMaterial).clone();
  material.uniforms.uMap = { value: (source.material as THREE.ShaderMaterial).uniforms.uMap.value };
  delete material.uniforms.uStrength;
  // Geometry/texture ownership stays with the original entity shadows. Only the tiny batch buffers are owned here.
  batch.strengths = new THREE.InstancedBufferAttribute(new Float32Array(batch.capacity), 1).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('shadowStrength', batch.strengths);
  if (!previousMaterial) {
    material.vertexShader = 'in float shadowStrength;\nflat out float vShadowStrength;\n' + material.vertexShader
      .replace('vUv = uv;', 'vUv = uv; vShadowStrength = shadowStrength;')
      .replace('modelViewMatrix', 'instanceMatrix');
    material.fragmentShader = material.fragmentShader.replace('uniform float uStrength;', 'flat in float vShadowStrength;').replaceAll('uStrength', 'vShadowStrength');
  }
  const mesh = batch.mesh = new THREE.InstancedMesh(geometry, material, batch.capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; mesh.matrixWorldAutoUpdate = false;
  mesh.renderOrder = 1; mesh.name = 'Instanced unit ground shadows'; mesh.userData.isBlobShadowBatch = true;
}

/** Called after Three has updated world/camera matrices, before it builds the render list. */
function prepare(batch: Batch, scene: THREE.Scene, camera: THREE.Camera) {
  batch.entries.length = 0;
  batch.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  batch.frustum.setFromProjectionMatrix(batch.projection);
  let source: THREE.Mesh | undefined;
  for (const mesh of blobShadowMeshes) {
    if (!eligible(mesh, scene, camera) || (mesh.frustumCulled && !batch.frustum.intersectsObject(mesh))) continue;
    const material = mesh.material;
    if (!(material instanceof THREE.ShaderMaterial) || !material.visible || !material.uniforms.uStrength
      || !material.transparent || material.blending !== THREE.MultiplyBlending || material.depthWrite || !material.depthTest
      || material.depthFunc !== THREE.LessEqualDepth || !material.polygonOffset || material.polygonOffsetFactor !== -2
      || material.polygonOffsetUnits !== -2 || material.side !== THREE.FrontSide || material.alphaTest !== 0
      || !material.colorWrite || material.stencilWrite || material.wireframe || material.premultipliedAlpha || material.alphaToCoverage
      || material.glslVersion !== THREE.GLSL3 || material.clippingPlanes?.length
      || material.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile
      || material.vertexShader !== BLOB_SHADOW_VERTEX_SHADER || material.fragmentShader !== BLOB_SHADOW_FRAGMENT_SHADER) return;
    if (!source) source = mesh;
    const first = source.material as THREE.ShaderMaterial;
    // Mixing an individual shadow into the batch changes multiply order at RGBA8 rounding ties.
    // Keep the entire pass individual when a visible shadow has custom rendering semantics.
    if (mesh.geometry !== source.geometry || material.vertexShader !== first.vertexShader || material.fragmentShader !== first.fragmentShader || material.uniforms.uMap?.value !== first.uniforms.uMap?.value) return;
    let entry = batch.records.get(mesh);
    if (!entry) { entry = { mesh, depth: 0, strength: 0 }; batch.records.set(mesh, entry); }
    entry.depth = batch.position.setFromMatrixPosition(mesh.matrixWorld).applyMatrix4(batch.projection).z;
    entry.strength = material.uniforms.uStrength.value;
    batch.entries.push(entry);
  }
  if (!source || batch.entries.length < MIN_SHADOWS) return;
  batch.entries.sort((a, b) => b.depth - a.depth || a.mesh.id - b.mesh.id);
  if (!batch.mesh || batch.capacity < batch.entries.length) allocate(batch, source);
  const mesh = batch.mesh!, strengths = batch.strengths!;
  (mesh.material as THREE.ShaderMaterial).uniforms.uMap.value = (source.material as THREE.ShaderMaterial).uniforms.uMap.value;
  mesh.layers.mask = camera.layers.mask;
  mesh.count = batch.entries.length;
  for (let i = 0; i < batch.entries.length; i++) {
    const entry = batch.entries[i];
    // CPU view*world is exactly the original uniform modelViewMatrix. Precomputing it retains
    // float precision/depth ties that GPU world-space instance multiplication would change.
    batch.matrix.multiplyMatrices(camera.matrixWorldInverse, entry.mesh.matrixWorld);
    mesh.setMatrixAt(i, batch.matrix); strengths.setX(i, entry.strength);
    entry.mesh.visible = false; batch.hidden.push(entry.mesh);
  }
  mesh.instanceMatrix.clearUpdateRanges(); mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16); mesh.instanceMatrix.needsUpdate = true;
  strengths.clearUpdateRanges(); strengths.addUpdateRange(0, mesh.count); strengths.needsUpdate = true;
  scene.add(mesh);
}

/** Mobile/desktop world submission. Entity ownership, LOD, collision and XR remain unchanged. */
export function renderWithBlobShadowBatch(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, enabled = defaultEnabled) {
  if (!enabled || renderer.xr.isPresenting || blobShadowMeshes.size < MIN_SHADOWS) { renderer.render(scene, camera); return; }
  let scenes = batches.get(renderer);
  if (!scenes) { scenes = new WeakMap(); batches.set(renderer, scenes); }
  let batch = scenes.get(scene);
  if (!batch) {
    batch = { capacity: 0, entries: [], records: new WeakMap(), hidden: [], matrix: new THREE.Matrix4(), projection: new THREE.Matrix4(), frustum: new THREE.Frustum(), position: new THREE.Vector3() };
    scenes.set(scene, batch);
    const current = batch;
    current.lost = () => { disposeBatch(current); current.failed = false; };
    renderer.domElement.addEventListener('webglcontextlost', current.lost);
  }
  if (batch.failed) { renderer.render(scene, camera); return; }
  const original = scene.onBeforeRender, current = batch;
  scene.onBeforeRender = function (...args) {
    original.apply(this, args);
    try { prepare(current, scene, args[2]); } catch (error) {
      for (const mesh of current.hidden) mesh.visible = true;
      current.hidden.length = 0; current.failed = true; disposeBatch(current);
      console.warn('Ground-shadow batching disabled; individual shadows retained', error);
    }
  };
  try { renderer.render(scene, camera); } finally {
    scene.onBeforeRender = original;
    current.mesh?.removeFromParent();
    for (const mesh of current.hidden) mesh.visible = true;
    current.hidden.length = 0;
    current.entries.length = 0;
  }
}

export function disposeBlobShadowBatch(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
  const batch = batches.get(renderer)?.get(scene);
  if (batch) {
    disposeBatch(batch);
    if (batch.lost) renderer.domElement.removeEventListener('webglcontextlost', batch.lost);
    batches.get(renderer)?.delete(scene);
  }
}
