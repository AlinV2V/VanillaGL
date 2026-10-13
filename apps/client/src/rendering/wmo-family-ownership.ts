import * as THREE from 'three';
import type { Draw } from './wmo-material-family';

type Family = { root: THREE.Group; mesh: Draw; sources: Draw[]; objects: THREE.Object3D[]; intact: () => boolean; release: () => void };
const families = new Set<Family>(), owners = new WeakMap<Draw, Family>();
export const wmoFamilyFor = (source: Draw) => owners.get(source);
export const wmoFamiliesForCapture = () => [...families];

export function ownWmoFamily(root: THREE.Group, mesh: Draw, sources: Draw[], objects: THREE.Object3D[], release: () => void): void {
  const geometry = mesh.geometry, material = mesh.material, position = geometry.getAttribute('position'), index = geometry.index;
  const pv = (position as THREE.BufferAttribute).version, iv = index?.version, mv = material.version;
  const vertex = material.vertexShader, fragment = material.fragmentShader, start = geometry.drawRange.start, count = geometry.drawRange.count;
  const intact = () => mesh.parent === root && mesh.geometry === geometry && mesh.material === material && material.version === mv &&
    material.vertexShader === vertex && material.fragmentShader === fragment && geometry.getAttribute('position') === position &&
    (position as THREE.BufferAttribute).version === pv && geometry.index === index && index?.version === iv &&
    geometry.drawRange.start === start && geometry.drawRange.count === count && !mesh.morphTargetInfluences?.length;
  const family = { root, mesh, sources, objects, intact, release }; families.add(family);
  for (const source of sources) owners.set(source, family);
}

/** Synchronous A/B capture in a disposable QA tab; restore every visibility flag even on error. */
export function beforeNativeWmoFamilies(select: (family: Family) => boolean = () => true): () => void {
  const previous: Array<[THREE.Object3D, boolean]> = [];
  for (const family of families) {
    if (!select(family)) continue;
    previous.push([family.mesh, family.mesh.visible]);
    for (const source of family.sources) { previous.push([source, source.visible]); source.visible = family.mesh.visible; }
    family.mesh.visible = false;
  }
  return () => { for (const [object, visible] of previous) object.visible = visible; };
}
export function withNativeWmoFamilies<T>(draw: () => T, select?: (family: Family) => boolean): T {
  const restore = beforeNativeWmoFamilies(select);
  try { return draw(); } finally { restore(); }
}

/** Detach pooled textures before the tile's ordinary material traversal can dispose another owner's page. */
export function releaseWmoFamilies(group: THREE.Object3D): void {
  for (const family of families) {
    let node: THREE.Object3D | null = family.root;
    while (node && node !== group) node = node.parent;
    if (!node) continue;
    family.mesh.removeFromParent();
    const index = family.objects.indexOf(family.mesh); if (index >= 0) family.objects.splice(index, 1);
    for (const source of family.sources) {
      owners.delete(source); delete source.userData.wmoFamilySource; source.visible = family.mesh.visible;
      if (!family.objects.includes(source)) family.objects.push(source);
    }
    family.mesh.geometry.dispose(); family.mesh.material.dispose(); family.release(); families.delete(family);
  }
}
