import * as THREE from 'three';
import { beginWmoVisibilityDiagnostics, recordWmoGroupVisibility } from './performance-detail-diagnostics';
import { recordPerformanceWmoVisibilityDecision, WmoVisibilityDecisionReason } from './performance-wmo-visibility-audit';
import { setWorldRenderObjectVisible } from './world-render-admission';

export type WmoVisibilityGroup = {
  index: number;
  flags: number;
  bbox: [[number, number, number], [number, number, number]] | null;
  portalStart: number;
  portalCount: number;
  objects: THREE.Object3D[];
};

export type WmoVisibilityInstance = {
  root: THREE.Group;
  model: any;
  groups: WmoVisibilityGroup[];
  currentGroup: number;
  lightingGroup: number;
  localScratch: THREE.Vector3;
  lightingScratch: THREE.Vector3;
  resolvedCameraPoint: THREE.Vector3;
  resolutionToken: number;
};

// Build 5875 CMapObjGroup flags used by the reversed render walk.
const WMO_FLAG_OUTDOOR = 0x8;      // SMOGroup::OUTDOOR — exterior seed
const WMO_FLAG_UNCULLED = 0x10000; // handled outside the recursive room/portal pass
const wmoBaseName = (inst: WmoVisibilityInstance): string =>
  String(inst.model?.name ?? '').replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';

const pointInWmoGroupBox = (p: THREE.Vector3, group: WmoVisibilityGroup): boolean => {
  const b = group.bbox;
  if (!b) return false;
  return (
    p.x >= b[0][0] &&
    p.x <= b[1][0] &&
    p.y >= b[0][1] &&
    p.y <= b[1][1] &&
    p.z >= b[0][2] &&
    p.z <= b[1][2]
  );
};

// v17 CAaBspNode as baked by bake-wmos (byte-proven layout — see scratch/probe-mobn.ts).
// flags 0/1/2 = split axis X/Y/Z, 4 = leaf; children are node indices, -1 = none.
type WmoBspNode = {
  flags: number;
  negChild: number;
  posChild: number;
  faceCount: number;
  faceStart: number;
  planeDist: number;
};

// Interpolate the triangle's z at (x, y), or null when (x, y) falls outside the
// triangle's XY footprint (walls project to a degenerate footprint and drop out).
const triangleZAt = (
  positions: ArrayLike<number>,
  i0: number,
  i1: number,
  i2: number,
  x: number,
  y: number,
): number | null => {
  const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
  const bx = positions[i1 * 3], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
  const cx = positions[i2 * 3], cy = positions[i2 * 3 + 1], cz = positions[i2 * 3 + 2];
  const v0x = bx - ax, v0y = by - ay;
  const v1x = cx - ax, v1y = cy - ay;
  const denom = v0x * v1y - v1x * v0y;
  if (Math.abs(denom) < 1e-6) return null;
  const px = x - ax, py = y - ay;
  const u = (px * v1y - v1x * py) / denom;
  const v = (v0x * py - px * v0y) / denom;
  if (u < -1e-4 || v < -1e-4 || u + v > 1 + 1e-4) return null;
  return az + u * (bz - az) + v * (cz - az);
};

const bspStack: number[] = [];
/** Asset conversion utility. */
const bspHighestFloorBelow = (model: any, groupIndex: number, p: THREE.Vector3): number | null => {
  const g = model?.groups?.[groupIndex];
  const nodes = g?.bspNodes as WmoBspNode[] | undefined;
  if (!Array.isArray(nodes) || !nodes.length || !Number.isInteger(nodes[0]?.posChild)) return null;
  const faces = g.bspFaces as ArrayLike<number> | undefined;
  const indices = g.indices as ArrayLike<number> | undefined;
  const positions = g.positions as ArrayLike<number> | undefined;
  if (!faces || !indices || !positions) return null;
  let best: number | null = null;
  bspStack.length = 0;
  bspStack.push(0);
  let visits = 0;
  while (bspStack.length) {
    if (visits++ > nodes.length * 2) break; // corrupt-node guard, never loop forever
    const nodeIndex = bspStack.pop()!;
    if (nodeIndex < 0 || nodeIndex >= nodes.length) continue;
    const node = nodes[nodeIndex];
    const axis = node.flags & 0x7;
    if (axis === 4) {
      for (let f = 0; f < node.faceCount; f++) {
        const tri = faces[node.faceStart + f];
        const z = triangleZAt(positions, indices[tri * 3], indices[tri * 3 + 1], indices[tri * 3 + 2], p.x, p.y);
        if (z !== null && z <= p.z + 0.5 && (best === null || z > best)) best = z;
      }
      continue;
    }
    if (axis === 2) {
      if (node.negChild >= 0) bspStack.push(node.negChild);
      if (node.posChild >= 0 && p.z >= node.planeDist) bspStack.push(node.posChild);
      continue;
    }
    const v = axis === 0 ? p.x : p.y;
    const child = v < node.planeDist ? node.negChild : node.posChild;
    if (child >= 0) bspStack.push(child);
  }
  return best;
};

/**
 * Resolve a WMO-local point without changing the camera/portal state stored on the instance.
 * Dynamic M2 lighting calls this for every rendered unit; letting those probes overwrite
 * `currentGroup` would make portal visibility depend on whichever NPC happened to draw last.
 */
export const resolveWmoGroupAtLocalPoint = (inst: WmoVisibilityInstance, point: THREE.Vector3): number => {
  let bspGroup = -1;
  let bspFloorZ = Number.NEGATIVE_INFINITY;
  let firstInterior = -1;
  let firstCandidate = -1;
  for (const group of inst.groups) {
    if ((group.flags & WMO_FLAG_UNCULLED) !== 0 || !pointInWmoGroupBox(point, group)) continue;
    if (firstCandidate < 0) firstCandidate = group.index;
    if (firstInterior < 0 && (group.flags & 0x2000) !== 0) firstInterior = group.index;
    const floorZ = bspHighestFloorBelow(inst.model, group.index, point);
    if (floorZ !== null && floorZ > bspFloorZ) {
      bspFloorZ = floorZ;
      bspGroup = group.index;
    }
  }
  return bspGroup >= 0 ? bspGroup : firstInterior >= 0 ? firstInterior : firstCandidate;
};

/**
 * Resolve the authored WMO group occupied by a render-space point.
 *
 * This is shared by portal visibility and indoor lighting. City_01 has many overlapping MOGP
 * bounds, so treating each AABB as an exact room can classify an outdoor street as an interior
 * merely because a different storey overlaps it. MOBN floors disambiguate those candidates before
 * the legacy bbox fallback is considered.
 */
export const resolveWmoGroupsAtPoints = (
  inst: WmoVisibilityInstance,
  cameraPoint: THREE.Vector3,
  lightingPoint: THREE.Vector3,
  resolutionToken = -1,
): void => {
  // No explicit matrix refresh: three r176 worldToLocal() performs
  // updateWorldMatrix(true, false) itself, so both probes below refresh the
  // ancestor chain (root local transform is build-time constant; ancestors
  // refresh via StaticWorldGroup; mid-build tiles resolve through the same
  // path). An explicit call here would be a third identical refresh.
  inst.localScratch.copy(cameraPoint);
  inst.root.worldToLocal(inst.localScratch);
  inst.lightingScratch.copy(lightingPoint);
  inst.root.worldToLocal(inst.lightingScratch);
  const samePoint = inst.localScratch.equals(inst.lightingScratch);
  // MOBN pass: among bbox candidates, the room whose authored floor is closest
  // beneath the camera wins — resolves overlapping volumes (multi-story inns,
  // balconies) that the plain AABB test cannot tell apart.
  let bspGroup = -1;
  let bspFloorZ = Number.NEGATIVE_INFINITY;
  let firstInterior = -1;
  let firstCandidate = -1;
  let lightingBspGroup = -1;
  let lightingBspFloorZ = Number.NEGATIVE_INFINITY;
  let lightingFirstInterior = -1;
  let lightingFirstCandidate = -1;
  for (const group of inst.groups) {
    // Build 5875 excludes 0x10000 groups from its OUTDOOR/portal sweep and handles them in their
    // own draw pass. They are not rooms. City_01's broad district-floor groups carry this flag,
    // have no portal relations, and overlap the outdoor camera volume; accepting one as the current
    // room makes the topology test call the whole city "sealed" and hides terrain, clouds and stars.
    if ((group.flags & WMO_FLAG_UNCULLED) !== 0) continue;
    if (pointInWmoGroupBox(inst.localScratch, group)) {
      if (firstCandidate < 0) firstCandidate = group.index;
      if (firstInterior < 0 && (group.flags & 0x2000) !== 0) firstInterior = group.index;
      const floorZ = bspHighestFloorBelow(inst.model, group.index, inst.localScratch);
      if (floorZ !== null && floorZ > bspFloorZ) {
        bspFloorZ = floorZ;
        bspGroup = group.index;
      }
    }
    if (!samePoint && pointInWmoGroupBox(inst.lightingScratch, group)) {
      if (lightingFirstCandidate < 0) lightingFirstCandidate = group.index;
      if (lightingFirstInterior < 0 && (group.flags & 0x2000) !== 0) lightingFirstInterior = group.index;
      const floorZ = bspHighestFloorBelow(inst.model, group.index, inst.lightingScratch);
      if (floorZ !== null && floorZ > lightingBspFloorZ) {
        lightingBspFloorZ = floorZ;
        lightingBspGroup = group.index;
      }
    }
  }
  // Legacy bbox heuristic for bakes without usable BSP nodes.
  inst.currentGroup = bspGroup >= 0 ? bspGroup : firstInterior >= 0 ? firstInterior : firstCandidate;
  inst.lightingGroup = samePoint
    ? inst.currentGroup
    : lightingBspGroup >= 0
      ? lightingBspGroup
      : lightingFirstInterior >= 0
        ? lightingFirstInterior
        : lightingFirstCandidate;
  inst.resolvedCameraPoint.copy(cameraPoint);
  inst.resolutionToken = resolutionToken;
};

export const resolveWmoGroupAtPoint = (inst: WmoVisibilityInstance, point: THREE.Vector3): number => {
  resolveWmoGroupsAtPoints(inst, point, point);
  return inst.currentGroup;
};


export const wmoGroupUsesOutdoorLighting = (flags: number): boolean =>
  (flags & (WMO_FLAG_OUTDOOR | 0x0040)) !== 0;

/**
 * Return the complete MOPR-connected component for the current room. The old
 * screen-space pass treated overlapping MOGP AABBs as exact BSP leaves and then
 * clipped rooms out at the near plane. StartingZone_01's entrance is a concrete
 * counterexample: groups 0, 1 and 5 overlap there, so floors/walls vanished until
 * the camera moved deeper into the next box. Until native MOBN leaf resolution is
 * wired, the topology component is the conservative correct draw set: it never
 * drops authored rooms while crossing a portal, and disconnected WMO wings remain
 * culled.
 */
const portalComponents = new WeakMap<WmoVisibilityInstance, Map<number, Set<number>>>();
const portalComponentGroups = (inst: WmoVisibilityInstance, startGroup: number): Set<number> => {
  let cached = portalComponents.get(inst);
  if (!cached) { cached = new Map(); portalComponents.set(inst, cached); }
  const prior = cached.get(startGroup);
  if (prior) return prior;
  const relations = Array.isArray(inst.model?.portalRelations) ? inst.model.portalRelations : [];
  const componentVisited = new Set<number>(), componentQueue: number[] = [];
  componentVisited.add(startGroup);
  componentQueue.push(startGroup);
  for (let cursor = 0; cursor < componentQueue.length; cursor++) {
    const groupIndex = componentQueue[cursor];
    const group = inst.groups[groupIndex];
    if (!group) continue;
    for (let i = 0; i < group.portalCount; i++) {
      const neighbor = relations[group.portalStart + i]?.groupIndex;
      if (!Number.isInteger(neighbor) || neighbor < 0 || neighbor >= inst.groups.length || componentVisited.has(neighbor)) continue;
      componentVisited.add(neighbor);
      componentQueue.push(neighbor);
    }
  }
  cached.set(startGroup, componentVisited);
  return componentVisited;
};

/** Geometry-only exclusions retained for roots that have no authored distant-skyline role. */
const LEVITATING_WMO_GROUPS: Record<string, number[]> = {
  'barrowdens.wmo': [16],
  'corruptbarrowdens.wmo': [13],
};

// Entrance plane through General Marcus Jonathan (entry 466), expressed in Stormwind-root space.
// His authored facing points out of the tunnel; this normal is the opposite, toward Trade District.
// Root-local coordinates survive terrain origin shifts and do not depend on the NPC being loaded.
const STORMWIND_ENTRANCE_POINT_X = 28.840038;
const STORMWIND_ENTRANCE_POINT_Y = 0.409686;
const STORMWIND_ENTRANCE_INWARD_X = -0.999657439;
const STORMWIND_ENTRANCE_INWARD_Y = -0.026172606;

/**
 * Return a visibility override for a known authored artifact, or null for the normal portal path.
 *
 * Stormwind group 223 (`exteriorfacade01` in the patched Build 5875 root) is a distant skyline
 * surrogate. It remains eligible through the outer gate, then disappears only after the camera
 * crosses the entrance guard toward Trade District. Ordinary frustum/distance culling still applies.
 */
export const resolveWmoSpecialGroupVisibility = (
  baseName: string,
  groupIndex: number,
  cameraLocalPoint: Pick<THREE.Vector3, 'x' | 'y'>,
): boolean | null => {
  const normalized = baseName.toLowerCase();
  if (normalized === 'stormwind.wmo' && groupIndex === 223) {
    const entranceDepth = (cameraLocalPoint.x - STORMWIND_ENTRANCE_POINT_X) * STORMWIND_ENTRANCE_INWARD_X
      + (cameraLocalPoint.y - STORMWIND_ENTRANCE_POINT_Y) * STORMWIND_ENTRANCE_INWARD_Y;
    return entranceDepth <= 0;
  }
  if (LEVITATING_WMO_GROUPS[normalized]?.includes(groupIndex)) return false;
  return null;
};

/**
 * StartingZone_01's 14-group abbey is small enough to draw whole, and its extended portal planes cross
 * the human spawn camera. At a measured 30-degree orbit, moving the player 0.01yd changed whether
 * group 0 was classified as sealed even though the camera remained outside the WMO. Walls provide
 * the real occlusion here; retaining the authored groups removes that view-dependent hole.
 */
const portalSealExempt = (inst: WmoVisibilityInstance): boolean => {
  return wmoBaseName(inst) === 'nsabbey.wmo';
};

const setWmoGroupObjectsVisible = (inst: WmoVisibilityInstance, group: WmoVisibilityGroup, visible: boolean, reason: WmoVisibilityDecisionReason) => {
  recordWmoGroupVisibility(group, visible);
  recordPerformanceWmoVisibilityDecision(inst.root, group.index, visible, reason, inst.currentGroup);
  for (const obj of group.objects) setWorldRenderObjectVisible(obj, visible);
};





// The client keys WMO visibility off flag 0x8 (OUTDOOR) as a positive marker. It never tests
// 0x2000 anywhere in its WMO group code — that bit is set on 305 of City_01's 306 groups and
// means nothing to the renderer.
const PORTAL_SIDE_EPSILON = 0.01;  // client's DAT_007ffd74

type PortalRect = { x0: number; y0: number; x1: number; y1: number };
type WmoPortalPlane = { firstVertex: number; vertexCount: number; normal: number[]; distance: number };

const portalMvp = new THREE.Matrix4();
const portalScratch = new THREE.Vector4();
const portalCameraLocal = new THREE.Vector3();
const sealedScratch = new Set<number>();
const inboundByRelations = new WeakMap<object, Map<number, { portalIndex: number; side: number }[]>>();


const clipX: number[] = [];
const clipY: number[] = [];
const clipW: number[] = [];

const projectPortal = (
  portalVertices: ArrayLike<number>,
  portal: WmoPortalPlane,
): { rect: PortalRect; clipped: boolean } | null => {
  clipX.length = 0; clipY.length = 0; clipW.length = 0;
  for (let i = 0; i < portal.vertexCount; i++) {
    const v = (portal.firstVertex + i) * 3;
    portalScratch.set(portalVertices[v], portalVertices[v + 1], portalVertices[v + 2], 1);
    portalScratch.applyMatrix4(portalMvp);
    clipX.push(portalScratch.x); clipY.push(portalScratch.y); clipW.push(portalScratch.w);
  }
  const n = clipW.length;
  if (!n) return null;
  // Sutherland-Hodgman against the eye plane w = EPS, in homogeneous clip space. The client does

  // "rejected" bit when that count is zero). Clipping is what makes a portal the camera is standing
  // in resolve to a real, bounded rect instead of being waved through as wide open.
  const EPS = 1e-3;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let kept = 0;
  let clipped = false;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const wi = clipW[i], wj = clipW[j];
    const insideI = wi >= EPS, insideJ = wj >= EPS;
    if (!insideI || !insideJ) clipped = true;
    if (insideI) {
      const x = clipX[i] / wi, y = clipY[i] / wi;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      kept++;
    }
    if (insideI !== insideJ) {
      const t = (EPS - wi) / (wj - wi);
      const w = EPS;
      const x = (clipX[i] + (clipX[j] - clipX[i]) * t) / w;
      const y = (clipY[i] + (clipY[j] - clipY[i]) * t) / w;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      kept++;
    }
  }
  if (!kept || x0 > x1 || y0 > y1) return null; // nothing survived: portal is behind the eye
  return { rect: { x0, y0, x1, y1 }, clipped };
};

/**
 * Can we look through this portal from the group that owns the relation?
 *
 * Client: `d = n.x*cam.x + n.y*cam.y + n.z*cam.z + portal.dist`, negated when `MOPR.side < 0`,
 * rejected when `d < epsilon`. Note the sign on `dist` is PLUS — an earlier port of this used minus
 * and inverted the test for every portal in the model, which culled the city down to a void.
 */
/** Distance from the camera to the portal polygon's centroid, in model space. */
const portalCentroidDistance = (portalVertices: ArrayLike<number>, portal: WmoPortalPlane): number => {
  let cx = 0, cy = 0, cz = 0;
  const n = portal.vertexCount;
  if (!n) return Infinity;
  for (let i = 0; i < n; i++) {
    const v = (portal.firstVertex + i) * 3;
    cx += portalVertices[v]; cy += portalVertices[v + 1]; cz += portalVertices[v + 2];
  }
  cx /= n; cy /= n; cz /= n;
  const dx = cx - portalCameraLocal.x, dy = cy - portalCameraLocal.y, dz = cz - portalCameraLocal.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

const portalPlaneDistance = (portal: WmoPortalPlane): number => {
  const n = portal.normal;
  if (!n || n.length < 3) return 0;
  return n[0] * portalCameraLocal.x + n[1] * portalCameraLocal.y + n[2] * portalCameraLocal.z + portal.distance;
};

const portalFacesCamera = (portal: WmoPortalPlane, side: number): boolean => {
  const n = portal.normal;
  if (!n || n.length < 3) return true; // bake without plane data: stay permissive
  let d = portalPlaneDistance(portal);
  if (side < 0) d = -d;
  return d >= PORTAL_SIDE_EPSILON;
};


const portalSealedGroups = (
  inst: WmoVisibilityInstance,
  cameraPosition: THREE.Vector3,
  camera: THREE.Camera,
  prepareCamera: () => void,
): Set<number> | null => {
  const portalVertices = inst.model?.portalVertices as ArrayLike<number> | undefined;
  const portals = inst.model?.portals as WmoPortalPlane[] | undefined;
  const relations = inst.model?.portalRelations as { portalIndex: number; groupIndex: number; side: number }[] | undefined;
  if (!portalVertices?.length || !Array.isArray(portals) || !portals.length || !Array.isArray(relations)) return null;

  // Refresh the camera lazily on first actual portal work: passes over zero,
  // portal-less, or fully exempt instances must cost zero camera refreshes.
  // root.matrixWorld is already authoritative here: every path reaching
  // portal sealing resolves the instance first, and resolveWmoGroupsAtPoints()
  // performs worldToLocal(), which refreshes the root/ancestor chain.
  // The later portal-camera worldToLocal() independently refreshes before
  // its own local-space probe.
  // No subtree walk here on purpose: nothing below reads descendant matrices
  // (MVP uses inst.root.matrixWorld; the worldToLocal probe refreshes the
  // ancestor chain itself). Descendant world matrices stay authoritative from
  // the StaticWorldGroup build/commit/origin-shift refresh, and the renderer's
  // own automatic walk stops at the frozen tile root for the same reason.
  prepareCamera();
  portalMvp.multiplyMatrices((camera as THREE.PerspectiveCamera).projectionMatrix, camera.matrixWorldInverse);
  portalMvp.multiply(inst.root.matrixWorld);
  portalCameraLocal.copy(cameraPosition);
  inst.root.worldToLocal(portalCameraLocal);

  // A group is SEALED when every portal that leads into it is provably shut from where the camera
  // stands: the polygon projects to nothing, or it faces away (MOPR side test). Nothing else is
  // culled. This is deliberately far weaker than the client's full traversal, and the weakness is
  // the point — two attempts at a real aperture walk each shipped a hole. A traversal defines the
  // draw set by what it reaches, so any seed that resolves badly deletes everything it failed to
  // reach: seeded from one group it voided half the city; seeded from the camera's bbox list it
  // erased the whole Cathedral District skyline from an elevated camera at 150yd. This rule can
  // only ever subtract rooms whose every doorway is shut, so a bad frame costs one room, not a city.
  //
  // It still removes `holy01` — group 46 owns its single inbound portal, and that portal's side test
  // fails from essentially everywhere in City_01.
  sealedScratch.clear();
  let inbound = inboundByRelations.get(relations);
  if (!inbound) {
    inbound = new Map<number, { portalIndex: number; side: number }[]>();
    for (const relation of relations) {
      const target = relation?.groupIndex;
      if (!Number.isInteger(target) || target === 0xffff || target < 0 || target >= inst.groups.length) continue;
      let list = inbound.get(target);
      if (!list) { list = []; inbound.set(target, list); }
      list.push(relation);
    }
    inboundByRelations.set(relations, inbound);
  }
  for (const [target, list] of inbound) {
    const group = inst.groups[target];
    if (!group) continue;
    // Never seal the outside face, a "draw regardless" group, or a room the camera is standing in.
    if ((group.flags & (WMO_FLAG_OUTDOOR | WMO_FLAG_UNCULLED)) !== 0) continue;
    if (pointInWmoGroupBox(portalCameraLocal, group)) continue;
    let anyOpen = false;
    for (const relation of list) {
      const portal = portals[relation.portalIndex];
      if (!portal) { anyOpen = true; break; }
      const projected = projectPortal(portalVertices, portal);
      if (!projected) continue;                       // polygon entirely behind the eye: shut
      // "Straddles the eye plane" only means "you are standing in this doorway" when the doorway is
      // actually next to you. A portal 150yd away can still cross the eye plane, and treating that
      // as wide open is what kept `holy01` lit from the Trade District.
      if (projected.clipped && portalCentroidDistance(portalVertices, portal) < 6) { anyOpen = true; break; }
      // NOT safe to add here: "the doorway projects off-screen, therefore seal the room". A room's
      // geometry can be on screen while its doorway is not — every tall building has its door at
      // ground level — so looking up at a spire sealed the building it belongs to. Measured: the
      // draw set collapsed to 3-4 groups on an upward look. An aperture only licenses culling inside
      // a traversal that also carries the room's own screen bounds, which this rule deliberately
      // does not do.
      if (portalFacesCamera(portal, relation.side)) { anyOpen = true; break; }
    }
    if (!anyOpen) sealedScratch.add(target);
  }
  return sealedScratch;
};

/**
 * Per-frame WMO portal visibility. Returns whether the EXTERIOR world (terrain, sky, clouds,
 * celestial bodies) should render: false only when the camera sits in an interior group whose
 * portal graph reaches no exterior group (a fully enclosed room/mine — GFX-37). Standing in a
 * doorway-connected room keeps the outside visible so open doors never frame a void.
 */
export const updateWmoPortalVisibility = (opts: {
  instances: WmoVisibilityInstance[];
  cameraPosition: THREE.Vector3;
  camera?: THREE.Camera;
  disabled: boolean;
  resolutionToken?: number;
}): { exteriorVisible: boolean } => {
  const { instances, cameraPosition, camera, disabled, resolutionToken } = opts;
  beginWmoVisibilityDiagnostics(instances.length);
  if (disabled) {
    for (const inst of instances) for (const group of inst.groups) setWmoGroupObjectsVisible(inst, group, true, WmoVisibilityDecisionReason.Disabled);
    return { exteriorVisible: true };
  }
  let exteriorVisible = true;
  // The camera is not moved by anything in the loop below, so a single
  // refresh per pass (taken lazily on first portal-sealing work) yields
  // identical MVP/probe inputs without taxing portal-free passes.
  let cameraPrepared = false;
  const prepareCamera = (): void => {
    if (cameraPrepared) return;
    cameraPrepared = true;
    camera?.updateMatrixWorld();
  };
  for (const inst of instances) {
    const resolvedThisFrame = resolutionToken !== undefined
      && inst.resolutionToken === resolutionToken
      && inst.resolvedCameraPoint.equals(cameraPosition);
    if (!resolvedThisFrame) resolveWmoGroupsAtPoints(inst, cameraPosition, cameraPosition, resolutionToken);
    const current = inst.currentGroup;
    const currentGroup = current >= 0 ? inst.groups[current] : null;
    const hasPortalData = Array.isArray(inst.model?.portalRelations) && inst.model.portalRelations.length > 0;
    if (!hasPortalData) {
      // Bake predates portal geometry — nothing to reason with, draw the model whole.
      // // Do NOT try to cull on `0x2000` instead. That bit is set on 305 of City_01's 306 groups and
      // is never tested by the real client's WMO code (traced across every group-walking function in

      // is worse still: `holy01`, the shell that floats over the Trade District, has raw MOGI flags
      // 0x020c0 and so SETS 0x0040, while open-air district groups like `The Canals` clear it.
      // Measured, that bit fires on 35% of open-air groups and 40% of building interiors.
      const baseName = wmoBaseName(inst);
      for (const group of inst.groups) {
        const special = resolveWmoSpecialGroupVisibility(baseName, group.index, inst.localScratch);
        const hidden = special === false;
        setWmoGroupObjectsVisible(inst, group, special ?? true, hidden ? WmoVisibilityDecisionReason.Levitating : WmoVisibilityDecisionReason.NoPortalData);
      }
      continue;
    }
    const exempt = portalSealExempt(inst);
    const sealed = camera && !exempt
      ? portalSealedGroups(inst, cameraPosition, camera, prepareCamera)
      : null;
    const baseName = wmoBaseName(inst);
    if (!currentGroup) {
      // Camera is outside every group volume — viewing the city from off in the world. The aperture
      // rule still seals ordinary rooms, while Stormwind's authored skyline surrogate remains
      // eligible for normal renderer frustum/distance culling until the camera enters the city.
      // The exterior world is trivially visible from here, so GFX-37's room-graph test does not
      // apply and must not run: `portalComponentGroups(inst, -1)` would report "reaches no exterior"
      // and hide the terrain and sky.
      for (const group of inst.groups) {
        const special = resolveWmoSpecialGroupVisibility(baseName, group.index, inst.localScratch);
        const portalSealed = special === null && !!sealed?.has(group.index);
        const hidden = special === false;
        const reason = hidden ? WmoVisibilityDecisionReason.Levitating : portalSealed ? WmoVisibilityDecisionReason.PortalSealed : WmoVisibilityDecisionReason.OutsideCamera;
        setWmoGroupObjectsVisible(inst, group, !hidden && !portalSealed, reason);
      }
      continue;
    }
    // GFX-37 stays on the *unclipped* topology component. Whether the outdoor world renders is a
    // question about the room graph ("is this a sealed mine?"), not about what is on screen this
    // frame — deciding it from the clipped set would flicker terrain as the camera turns.
    const component = portalComponentGroups(inst, current);
    // The reversed 1.12 client uses SMOGroup::OUTDOOR (0x8) as the positive exterior marker.
    // 0x2000 is set on 305/306 City_01 groups and is not a sky-visibility bit; treating its
    // absence as "outdoor" hides the entire sky whenever the camera resolves into most city groups.
    let reachesExterior = exempt;
    for (const groupIndex of component) if (((inst.groups[groupIndex]?.flags ?? 0) & WMO_FLAG_OUTDOOR) !== 0) { reachesExterior = true; break; }
    for (const group of inst.groups) {
      const special = resolveWmoSpecialGroupVisibility(baseName, group.index, inst.localScratch);
      const inComponent = component.has(group.index); const portalSealed = special === null && !!sealed?.has(group.index);
      const hidden = special === false;
      const drawn = special === true || (!hidden && (exempt || inComponent) && !portalSealed);
      const reason = hidden ? WmoVisibilityDecisionReason.Levitating : special === true || exempt ? WmoVisibilityDecisionReason.Exempt : !inComponent ? WmoVisibilityDecisionReason.OutsideComponent : portalSealed ? WmoVisibilityDecisionReason.PortalSealed : WmoVisibilityDecisionReason.InteriorComponent;
      setWmoGroupObjectsVisible(inst, group, drawn, reason);
    }
    if (!reachesExterior) exteriorVisible = false;
  }
  return { exteriorVisible };
};
