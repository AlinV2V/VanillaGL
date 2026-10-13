import * as THREE from 'three';
import type { LiveTarget, RuntimeHooks, SerializedObject } from './studio-live-contract';

type DoodadBinding = { mesh: THREE.InstancedMesh; instanceId: number };
type TileMeta = { originX?: number; originY?: number };

const TILE_HALF = 533.33333 / 2;
export const hooks = globalThis as RuntimeHooks;
export const standalone = new Map<string, THREE.Object3D>();
const hiddenMatrices = new Map<string, THREE.Matrix4>();
const hiddenVisibility = new Map<string, boolean>();
const tileMetaCache = new Map<string, Promise<TileMeta>>();

export class NotHydratedError extends Error {}

export const activeScene = () => hooks.__wowScene;
export const activeCamera = () => hooks.__wowCamera;
const normalize = (value: string) => value.replaceAll('\\', '/').toLowerCase();
const sameId = (left: unknown, right: unknown) => left !== undefined && right !== undefined && String(left) === String(right);
export const keyFor = (target: LiveTarget) => `${target.tileKey}|${target.kind}|${normalize(target.model)}|${target.sourceId ?? target.recordId}`;
const bindingKey = (binding: DoodadBinding) => `${binding.mesh.uuid}:${binding.instanceId}`;
export const isStudioObject = (object: THREE.Object3D) => {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) if (node.userData?.studioLiveTarget) return true;
  return false;
};

const topSceneChild = (object: THREE.Object3D): THREE.Object3D | null => {
  const scene = activeScene();
  if (!scene) return null;
  let node = object;
  while (node.parent && node.parent !== scene) node = node.parent;
  return node.parent === scene ? node : null;
};

export const wmoRoots = (target: LiveTarget, assetScope = false): THREE.Object3D[] => {
  const scene = activeScene(), matches: THREE.Object3D[] = [];
  if (!scene) return matches;
  scene.traverse((object) => {
    if (isStudioObject(object)) return;
    const meta = object.userData?.wmoPick as Record<string, unknown> | undefined;
    if (meta?.kind !== 'wmo') return;
    if (String(meta.tile ?? '') !== target.tileKey || normalize(String(meta.model ?? '')) !== normalize(target.model)) return;
    if (!assetScope && target.sourceId !== undefined && !sameId(meta.uniqueId, target.sourceId)) return;
    matches.push(object);
  });
  return matches;
};

const sourceIndex = (value: unknown): unknown => {
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return record.sourceIndex ?? record.index ?? record.id ?? value;
};

export const doodadBindings = (target: LiveTarget, assetScope = false): DoodadBinding[] => {
  const scene = activeScene(), matches: DoodadBinding[] = [];
  if (!scene) return matches;
  scene.traverse((object) => {
    if (isStudioObject(object)) return;
    const mesh = object as THREE.InstancedMesh;
    const meta = mesh.userData?.wowDoodad as Record<string, unknown> | undefined;
    if (!mesh.isInstancedMesh || !meta) return;
    if (String(meta.tileKey ?? '') !== target.tileKey || normalize(String(meta.source ?? '')) !== normalize(target.model)) return;
    if (assetScope) { for (let instanceId = 0; instanceId < mesh.count; instanceId++) matches.push({ mesh, instanceId }); return; }
    if (target.sourceId === undefined) return;
    const indices = Array.isArray(meta.sourceIndices) ? meta.sourceIndices : [];
    for (let instanceId = 0; instanceId < Math.min(indices.length, mesh.count); instanceId++) {
      if (sameId(sourceIndex(indices[instanceId]), target.sourceId)) matches.push({ mesh, instanceId });
    }
  });
  return matches;
};

const tileRoot = (tileKey: string): THREE.Object3D | null => {
  const scene = activeScene();
  if (!scene) return null;
  let found: THREE.Object3D | null = null;
  scene.traverse((object) => {
    if (found !== null || isStudioObject(object)) return;
    const wmo = object.userData?.wmoPick as Record<string, unknown> | undefined;
    const doodad = object.userData?.wowDoodad as Record<string, unknown> | undefined;
    if (String(wmo?.tile ?? doodad?.tileKey ?? '') !== tileKey) return;
    found = topSceneChild(object);
  });
  return found as THREE.Object3D | null;
};

const tileMeta = (tileKey: string): Promise<TileMeta> => {
  let request = tileMetaCache.get(tileKey);
  if (!request) {
    request = fetch(`/terrain/tiles/${encodeURIComponent(tileKey)}/meta.json`).then(async (response) => {
      if (!response.ok) throw new Error(`tile meta HTTP ${response.status}`);
      return await response.json() as TileMeta;
    });
    tileMetaCache.set(tileKey, request);
  }
  return request;
};

const renderOrigin = async (tileKey: string): Promise<THREE.Vector2> => {
  const root = tileRoot(tileKey);
  if (!root) throw new NotHydratedError(`tile ${tileKey} is not hydrated yet`);
  const meta = await tileMeta(tileKey);
  const centerX = Number(meta.originX ?? TILE_HALF) - TILE_HALF;
  const centerY = Number(meta.originY ?? TILE_HALF) - TILE_HALF;
  return new THREE.Vector2(centerX - root.position.x, centerY - root.position.y);
};

const vectorScale = (scale: SerializedObject['scale']) => typeof scale === 'number'
  ? new THREE.Vector3(scale, scale, scale) : new THREE.Vector3().fromArray(scale);
const renderMatrix = async (tileKey: string, transform: SerializedObject): Promise<THREE.Matrix4> => {
  const origin = await renderOrigin(tileKey);
  return new THREE.Matrix4().compose(
    new THREE.Vector3(transform.position[0] - origin.x, transform.position[1] - origin.y, transform.position[2]),
    new THREE.Quaternion().fromArray(transform.rotation), vectorScale(transform.scale),
  );
};

const applyObjectTransform = async (object: THREE.Object3D, tileKey: string, transform: SerializedObject) => {
  const desired = await renderMatrix(tileKey, transform);
  if (object.parent) { object.parent.updateWorldMatrix(true, false); desired.premultiply(object.parent.matrixWorld.clone().invert()); }
  desired.decompose(object.position, object.quaternion, object.scale);
  object.visible = true;
  object.updateMatrixWorld(true);
};

const applyBindingTransform = async (binding: DoodadBinding, tileKey: string, transform: SerializedObject) => {
  const desired = await renderMatrix(tileKey, transform);
  binding.mesh.updateWorldMatrix(true, false);
  desired.premultiply(binding.mesh.matrixWorld.clone().invert());
  binding.mesh.setMatrixAt(binding.instanceId, desired);
  binding.mesh.instanceMatrix.needsUpdate = true;
  binding.mesh.computeBoundingSphere();
  hiddenMatrices.delete(bindingKey(binding));
};

export const cloneMaterial = (material: THREE.Material): THREE.Material => {
  const clone = material.clone();
  clone.userData = { ...material.userData, studioLiveClone: true };
  if (clone instanceof THREE.ShaderMaterial) {
    clone.uniforms = THREE.UniformsUtils.clone(clone.uniforms);
    clone.defines = { ...(clone.defines ?? {}) };
    delete clone.defines.WOW_INSTANCED; delete clone.defines.WOW_INSTANCE_TINT;
    if (clone.uniforms.uHasInstanceTint) clone.uniforms.uHasInstanceTint.value = 0;
  }
  return clone;
};
const cloneObjectMaterials = (root: THREE.Object3D) => root.traverse((object) => {
  const mesh = object as THREE.Mesh;
  if (!mesh.isMesh || !mesh.material) return;
  mesh.material = Array.isArray(mesh.material) ? mesh.material.map(cloneMaterial) : cloneMaterial(mesh.material);
});

const hideBinding = (binding: DoodadBinding) => {
  const key = bindingKey(binding), matrix = new THREE.Matrix4();
  binding.mesh.getMatrixAt(binding.instanceId, matrix);
  if (!hiddenMatrices.has(key)) hiddenMatrices.set(key, matrix.clone());
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  matrix.decompose(p, q, s); matrix.compose(p, q, s.setScalar(0));
  binding.mesh.setMatrixAt(binding.instanceId, matrix); binding.mesh.instanceMatrix.needsUpdate = true;
};
const restoreBinding = (binding: DoodadBinding) => {
  const key = bindingKey(binding), matrix = hiddenMatrices.get(key);
  if (!matrix) return;
  binding.mesh.setMatrixAt(binding.instanceId, matrix); binding.mesh.instanceMatrix.needsUpdate = true; hiddenMatrices.delete(key);
};

const standaloneWmo = (target: LiveTarget): THREE.Object3D => {
  const key = keyFor(target), cached = standalone.get(key);
  if (cached) return cached;
  const template = wmoRoots(target, true)[0];
  if (!template) throw new NotHydratedError(`WMO ${target.model} is not hydrated yet`);
  const clone = template.clone(true);
  cloneObjectMaterials(clone);
  clone.userData.wmoPick = { ...(template.userData.wmoPick ?? {}), kind: 'wmo', tile: target.tileKey, model: target.model, uniqueId: target.sourceId ?? target.recordId };
  clone.userData.studioLiveTarget = { ...target }; clone.name = `studio-live:${target.model}`;
  activeScene()!.add(clone); standalone.set(key, clone); return clone;
};

export const standaloneDoodad = (target: LiveTarget): THREE.Group => {
  const key = keyFor(target), cached = standalone.get(key);
  if (cached instanceof THREE.Group) return cached;
  const exact = target.sourceId !== undefined ? doodadBindings(target) : [];
  let sources = exact;
  if (!sources.length) {
    const scene = activeScene();
    if (!scene) throw new NotHydratedError('world scene is not ready');
    let cell: string | null = null; const candidates: DoodadBinding[] = [];
    scene.traverse((object) => {
      if (isStudioObject(object)) return;
      const mesh = object as THREE.InstancedMesh, meta = mesh.userData?.wowDoodad as Record<string, unknown> | undefined;
      if (!mesh.isInstancedMesh || mesh.count < 1 || !meta) return;
      if (String(meta.tileKey ?? '') !== target.tileKey || normalize(String(meta.source ?? '')) !== normalize(target.model)) return;
      const candidateCell = String(meta.spatialCell ?? 'default'); cell ??= candidateCell;
      if (candidateCell === cell) candidates.push({ mesh, instanceId: 0 });
    });
    sources = candidates;
  }
  if (!sources.length) throw new NotHydratedError(`M2 ${target.model} is not hydrated yet`);
  const first = sources[0], instanceMatrix = new THREE.Matrix4();
  first.mesh.getMatrixAt(first.instanceId, instanceMatrix); first.mesh.updateWorldMatrix(true, false);
  const group = new THREE.Group();
  first.mesh.matrixWorld.clone().multiply(instanceMatrix).decompose(group.position, group.quaternion, group.scale);
  group.name = `studio-live:${target.model}`; group.userData.studioLiveTarget = { ...target };
  const parts = new Set<string>();
  for (const binding of sources) {
    const meta = binding.mesh.userData?.wowDoodad as Record<string, unknown> | undefined;
    const partKey = `${meta?.meshIndex ?? 'm'}:${meta?.part ?? 'p'}`;
    if (parts.has(partKey)) continue;
    parts.add(partKey);
    const mesh = new THREE.Mesh(binding.mesh.geometry, Array.isArray(binding.mesh.material) ? binding.mesh.material.map(cloneMaterial) : cloneMaterial(binding.mesh.material));
    mesh.userData.wowDoodad = { ...(meta ?? {}) }; group.add(mesh);
  }
  activeScene()!.add(group); standalone.set(key, group); exact.forEach(hideBinding); return group;
};

export const applyTransform = async (target: LiveTarget, transform: SerializedObject) => {
  const live = standalone.get(keyFor(target));
  if (live) return applyObjectTransform(live, target.tileKey, transform);
  if (target.kind === 'wmo') {
    const root = wmoRoots(target)[0];
    if (!root) throw new NotHydratedError(`WMO ${target.model}#${target.sourceId ?? '?'} is not loaded`);
    root.visible = true; return applyObjectTransform(root, target.tileKey, transform);
  }
  if (target.kind === 'm2') {
    const bindings = doodadBindings(target);
    if (!bindings.length) throw new NotHydratedError(`M2 ${target.model}#${target.sourceId ?? '?'} is not loaded`);
    await Promise.all(bindings.map((binding) => applyBindingTransform(binding, target.tileKey, transform))); return;
  }
  throw new Error(`live transform is not implemented for ${target.kind}`);
};

export const spawn = async (target: LiveTarget, transform: SerializedObject) => {
  const object = target.kind === 'wmo' ? standaloneWmo(target) : target.kind === 'm2' ? standaloneDoodad(target) : null;
  if (!object) throw new Error(`live spawn is not implemented for ${target.kind}`);
  await applyObjectTransform(object, target.tileKey, transform);
};

export const remove = (target: LiveTarget) => {
  const key = keyFor(target), live = standalone.get(key);
  if (live) { hiddenVisibility.set(key, live.visible); live.visible = false; return; }
  if (target.kind === 'wmo') {
    const root = wmoRoots(target)[0];
    if (!root) { if (target.sourceId === undefined) return; throw new NotHydratedError(`WMO ${target.model} is not loaded`); }
    hiddenVisibility.set(key, root.visible); root.visible = false; return;
  }
  if (target.kind === 'm2') {
    const bindings = doodadBindings(target);
    if (!bindings.length) { if (target.sourceId === undefined) return; throw new NotHydratedError(`M2 ${target.model} is not loaded`); }
    bindings.forEach(hideBinding); return;
  }
  throw new Error(`live delete is not implemented for ${target.kind}`);
};

export const restore = (target: LiveTarget) => {
  const key = keyFor(target), live = standalone.get(key);
  if (live) { live.visible = hiddenVisibility.get(key) ?? true; hiddenVisibility.delete(key); return; }
  if (target.kind === 'wmo') {
    const root = wmoRoots(target)[0];
    if (!root) throw new NotHydratedError(`WMO ${target.model} is not loaded`);
    root.visible = hiddenVisibility.get(key) ?? true; hiddenVisibility.delete(key); return;
  }
  if (target.kind === 'm2') doodadBindings(target).forEach(restoreBinding);
};
