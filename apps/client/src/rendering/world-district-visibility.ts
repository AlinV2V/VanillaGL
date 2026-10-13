import * as THREE from 'three';
import { districtCameraSupported } from './world-cell-proof';
import { districtVisibilityEnabled as districtEnabled, districtPartId, districtSourceChecksum, type DistrictCatalog, type DistrictModel, type DistrictSource } from './world-district-format';
import { wmoFamilyFor } from './wmo-family-ownership';
import type { Draw } from './wmo-material-family';
import { WMO_EXTERIOR_VERT, WMO_EXTERIOR_FRAG, WMO_INTERIOR_VERT, WMO_INTERIOR_FRAG } from './wmo-shaders';

type Stamp = { parent: THREE.Object3D | null; material: THREE.ShaderMaterial; mv: number; geometry: THREE.BufferGeometry; position: THREE.BufferAttribute; index: THREE.BufferAttribute; pv: number; iv: number; start: number; count: number; vertex: string; fragment: string; side: number };
type Part = { mesh: Draw; stamp: Stamp };
type Proof = { target: string; wall: string; targetGroup: string; wallGroup: string };
type Cell = { proofs: Proof[]; witnesses: Set<string> };
type Root = { root: THREE.Group; model: string; groups: Map<string, string>; parts: Map<string, Part>; catalog?: DistrictCatalog; compiled?: DistrictModel; cells?: Map<string, Cell>; proven: Set<Draw>; walls: Map<Part, boolean> };
const roots = new Map<THREE.Group, Root>(), catalogs = new Map<string, Promise<DistrictCatalog | null>>();
let missing = 0, failures = 0, currentHidden = 0, currentCells = 0, lastMs = 0;
const failureReasons: string[] = [];
const point = new THREE.Vector3(), inverse = new THREE.Matrix4();
const treeVisible = (object: THREE.Object3D) => { for (let node: THREE.Object3D | null = object; node; node = node.parent) if (!node.visible) return false; return true; };
const attached = (object: THREE.Object3D, scene: THREE.Scene) => { while (object.parent) object = object.parent; return object === scene; };
const stamp = (mesh: Draw): Stamp => ({ parent: mesh.parent, material: mesh.material, mv: mesh.material.version, geometry: mesh.geometry, position: mesh.geometry.getAttribute('position') as THREE.BufferAttribute,
  index: mesh.geometry.index!, pv: (mesh.geometry.getAttribute('position') as THREE.BufferAttribute).version, iv: mesh.geometry.index!.version,
  start: mesh.geometry.drawRange.start, count: mesh.geometry.drawRange.count, vertex: mesh.material.vertexShader, fragment: mesh.material.fragmentShader, side: mesh.material.side });
const identity = (mesh: THREE.Object3D) => {
  if (mesh.matrixAutoUpdate) mesh.updateMatrix();
  return mesh.matrix.elements.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-10);
};

function unchanged(part: Part): boolean {
  const { mesh, stamp: s } = part, g = mesh.geometry, m = mesh.material;
  return mesh.parent === s.parent && m === s.material && m.version === s.mv && !mesh.morphTargetInfluences?.length &&
    g === s.geometry && g.getAttribute('position') === s.position && g.index === s.index &&
    s.position.version === s.pv && s.index.version === s.iv && g.drawRange.start === s.start && g.drawRange.count === s.count &&
    m.vertexShader === s.vertex && m.fragmentShader === s.fragment && m.side === s.side && identity(mesh);
}
function wallDraws(part: Part, camera: THREE.Camera): boolean {
  if (!unchanged(part)) return false;
  const source = part.mesh, m = source.material, family = wmoFamilyFor(source), draw = family?.mesh ?? source;
  if (source.userData.wmoPick.blendMode !== 0 || !opaqueWallMaterial(m)) return false;
  return treeVisible(draw) && draw.layers.test(camera.layers) && (m.side === THREE.FrontSide || m.side === THREE.DoubleSide) && (!family ||
    (family.intact() && draw.parent === source.parent && draw.material.side === m.side && opaqueWallMaterial(draw.material) && identity(draw)));
}
function opaqueWallMaterial(m: THREE.ShaderMaterial): boolean {
  return m.visible && !m.transparent && m.depthWrite && m.depthTest && m.colorWrite && !m.wireframe && !m.stencilWrite &&
    m.depthFunc === THREE.LessEqualDepth && !m.polygonOffset && !m.clippingPlanes?.length && m.alphaTest === 0 &&
    !m.alphaToCoverage && m.uniforms.uAlphaTest?.value === 0;
}
function rigidTransform(matrix: THREE.Matrix4): boolean {
  const e = matrix.elements;
  if (!e.every(Number.isFinite) || Math.abs(matrix.determinant() - 1) > 1e-7) return false;
  for (let i = 0; i < 3; i++) for (let j = i; j < 3; j++) {
    const dot = e[i * 4] * e[j * 4] + e[i * 4 + 1] * e[j * 4 + 1] + e[i * 4 + 2] * e[j * 4 + 2];
    if (Math.abs(dot - (i === j ? 1 : 0)) > 1e-7) return false;
  }
  return Math.abs(e[3]) + Math.abs(e[7]) + Math.abs(e[11]) + Math.abs(e[15] - 1) < 1e-10;
}

export function validateDistrictCatalog(value: DistrictCatalog): void {
  if (value.format !== 'vgl-world-district-v1' || typeof value.sourceHash !== 'string' || !value.sourceHash || !Array.isArray(value.models) || value.models.length > 128 ||
    value.projection?.near !== .5 || value.projection?.fov !== 90 || value.projection?.aspect !== 4) throw new Error('District catalog contract');
  const names = new Set<string>();
  for (const model of value.models) {
    if (typeof model.model !== 'string' || names.has(model.model) || !model.groups || Array.isArray(model.groups) ||
      Object.entries(model.groups).some(([group, checksum]) => !/^\d+$/.test(group) || typeof checksum !== 'string') || !Array.isArray(model.cells) || model.cells.length > 4096 ||
      model.origin?.length !== 3 || model.size?.length !== 3 || !model.origin.every(Number.isFinite) || !model.size.every(v => Number.isFinite(v) && v > 0)) throw new Error('District model layout');
    const keys = new Set<string>();
    for (const cell of model.cells) {
      const key = cell.coordinate?.join(',');
      if (cell.coordinate?.length !== 3 || !cell.coordinate.every(Number.isSafeInteger) || keys.has(key) || !Array.isArray(cell.hidden) || cell.hidden.length > 16384 ||
        cell.hidden.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(id => typeof id !== 'string' || !/^\d+:\d+$/.test(id)) || pair[0] === pair[1])) throw new Error('District cell layout');
      keys.add(key);
    }
    names.add(model.model);
  }
}

function getCatalog(tile: string): Promise<DistrictCatalog | null> {
  const old = catalogs.get(tile); if (old) return old;
  const pending = fetch(`/terrain/world-districts/${encodeURIComponent(tile)}/catalog.json`, { signal: AbortSignal.timeout(3000) }).then(async response => {
    if (response.status === 404 || response.headers?.get('content-type')?.includes('text/html')) { missing++; return null; }
    if (!response.ok) throw new Error(`District HTTP ${response.status}`);
    const value = await response.json() as DistrictCatalog; validateDistrictCatalog(value); return value;
  }).catch(error => { failures++; if (failureReasons.length < 8) failureReasons.push(`${tile}: ${String(error).slice(0,160)}`); return null; });
  catalogs.set(tile, pending); if (catalogs.size > 16) catalogs.delete(catalogs.keys().next().value!); return pending;
}

/** Source registration is outside the frame loop; a missing or changed bake simply keeps native draws. */
export function registerWorldDistrictRoom(model: string, group: number, root: THREE.Group, objects: THREE.Object3D[], source: DistrictSource): void {
  if (!districtEnabled) return;
  const tile = root.userData.wmoPick?.tile; if (typeof tile !== 'string') return;
  let owner = roots.get(root);
  if (!owner) { owner = { root, model, groups: new Map(), parts: new Map(), proven: new Set(), walls: new Map() }; roots.set(root, owner); }
  owner.groups.set(String(group), districtSourceChecksum(source));
  for (const id of owner.parts.keys()) if (id.startsWith(`${group}:`)) owner.parts.delete(id);
  let ordinal = 0;
  for (const object of objects) {
    const mesh = object as Draw;
    if (!mesh.isMesh || mesh.userData.wmoPick?.kind !== 'wmoBatch') continue;
    const id = districtPartId(group, ordinal++);
    if (!(mesh.material instanceof THREE.ShaderMaterial) || !mesh.geometry.index || !mesh.geometry.hasAttribute('position') ||
      mesh.material.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile ||
      !((mesh.material.vertexShader === WMO_EXTERIOR_VERT && mesh.material.fragmentShader === WMO_EXTERIOR_FRAG) ||
        (mesh.material.vertexShader === WMO_INTERIOR_VERT && mesh.material.fragmentShader === WMO_INTERIOR_FRAG))) continue;
    owner.parts.set(id, { mesh, stamp: stamp(mesh) });
  }
  const registered = owner;
  void getCatalog(tile).then(catalog => {
    if (roots.get(root) !== registered || !catalog || registered.catalog === catalog) return;
    registered.catalog = catalog;
    registered.compiled = catalog.models.find(candidate => candidate.model === model);
    registered.cells = new Map(registered.compiled?.cells.map(cell => [cell.coordinate.join(','), {
      witnesses: new Set(cell.hidden.map(pair => pair[1])),
      proofs: cell.hidden.map(([target, wall]) => ({ target, wall, targetGroup: target.split(':')[0], wallGroup: wall.split(':')[0] })),
    }]) ?? []);
  });
}

export function releaseWorldDistrict(group: THREE.Object3D): void {
  for (const [root] of roots) { let node: THREE.Object3D | null = root; while (node && node !== group) node = node.parent; if (node) roots.delete(root); }
}

/** Temporarily remove only draws whose whole source bounds have a proof for the current eye cell. */
export function beforeWorldDistrict(scene: THREE.Scene, camera: THREE.Camera, renderer?: THREE.WebGLRenderer): () => void {
  currentHidden = 0; currentCells = 0; lastMs = 0;
  if (!districtEnabled || scene.overrideMaterial || renderer?.clippingPlanes.length || !districtCameraSupported(camera)) return () => {};
  const start = performance.now(), hidden: THREE.Object3D[] = [];
  camera.updateMatrixWorld(true);
  for (const owner of roots.values()) {
    const { root, compiled: model, cells } = owner;
    if (!model || !cells || !attached(root, scene) || !treeVisible(root)) continue;
    root.updateWorldMatrix(true, false);
    if (!rigidTransform(root.matrixWorld)) continue;
    inverse.copy(root.matrixWorld).invert(); point.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inverse);
    const key = `${Math.floor((point.x - model.origin[0]) / model.size[0])},${Math.floor((point.y - model.origin[1]) / model.size[1])},${Math.floor((point.z - model.origin[2]) / model.size[2])}`;
    const cell = cells.get(key); if (!cell) continue; currentCells++;
    const { proven, walls } = owner; proven.clear(); walls.clear();
    for (const { target: targetId, wall: wallId, targetGroup, wallGroup } of cell.proofs) {
      if (cell.witnesses.has(targetId)) continue; // All witnesses remain submitted; no dependency cycles.
      const target = owner.parts.get(targetId), wall = owner.parts.get(wallId);
      if (!target || !wall || owner.groups.get(targetGroup) !== model.groups[targetGroup] ||
        owner.groups.get(wallGroup) !== model.groups[wallGroup] || !unchanged(target)) continue;
      let draws = walls.get(wall);
      if (draws === undefined) { draws = wallDraws(wall, camera); walls.set(wall, draws); }
      if (!draws) continue;
      proven.add(target.mesh);
    }
    const checked = new Set<THREE.Object3D>();
    for (const source of proven) {
      const family = wmoFamilyFor(source), draw = family?.mesh ?? source;
      if (checked.has(draw) || !treeVisible(draw)) continue; checked.add(draw);
      if (family && (!family.intact() || draw.parent !== source.parent || !identity(draw) || !family.sources.every(mesh => proven.has(mesh)))) continue;
      hidden.push(draw); draw.visible = false;
    }
  }
  currentHidden = hidden.length; lastMs = performance.now() - start;
  return () => hidden.forEach(mesh => { mesh.visible = true; });
}

export const worldDistrictStats = () => ({ enabled: districtEnabled, roots: roots.size, catalogs: catalogs.size, missing, failures, currentCells, currentHidden, lastMs });
export const worldDistrictDebug = (camera: THREE.Camera) => ({ supported: districtCameraSupported(camera), failureReasons, roots: [...roots.values()].map(owner => {
  const local = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld).applyMatrix4(owner.root.matrixWorld.clone().invert());
  const model = owner.compiled;
  return { tile: owner.root.userData.wmoPick?.tile, model: owner.model, compiled: !!model, parts: owner.parts.size, local: local.toArray(),
    coordinate: model?.origin.map((v, i) => Math.floor((local.getComponent(i) - v) / model.size[i])), cells: owner.cells?.size,
    matchingGroups: model ? [...owner.groups].filter(([id, crc]) => model.groups[id] === crc).length : 0 };
}) });
if (typeof window !== 'undefined') Object.assign(window, { __wowWorldDistrict: worldDistrictStats });
