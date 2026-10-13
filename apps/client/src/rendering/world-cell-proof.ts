import * as THREE from 'three';

export type CellWall = { vertices: ArrayLike<number>; doubleSided: boolean };
export type CellProjection = { near: number; fov: number; aspect: number };
export const districtProjection: CellProjection = { near: .5, fov: 90, aspect: 4 };
export type PreparedCellWall = { normal: THREE.Vector3; offset: number; edges: Array<{ normal: THREE.Vector3; offset: number }>; doubleSided: boolean };

const corners = (box: THREE.Box3) => Array.from({ length: 8 }, (_, i) => new THREE.Vector3(
  i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z,
));

/** Offline proof for every eye and target point in the two boxes, including their interiors.
 * The ray/plane edge inequality is bi-affine in eye and target; its extrema are at box corners.
 * A strict interior margin rejects silhouettes. No raster samples or previous camera are used.
 */
export function prepareCellWall(wall: CellWall): PreparedCellWall | null {
  const v = wall.vertices;
  if (v.length < 9 || v.length > 48 || v.length % 3 || !Array.from(v).every(Number.isFinite)) return null;
  const points = Array.from({ length: v.length / 3 }, (_, i) => new THREE.Vector3(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]));
  const a = points[0], normal = points[1].clone().sub(a).cross(points[2].clone().sub(a));
  if (normal.lengthSq() < 1e-12) return null;
  normal.normalize();
  const windingNormal = normal.clone();
  // Compiler output is exactly coplanar. Reject external or damaged catalog input.
  if (points.some(p => Math.abs(p.clone().sub(a).dot(normal)) > 1e-7)) return null;
  const edges: PreparedCellWall['edges'] = [];
  for (let edge = 0; edge < points.length; edge++) {
    const p = points[edge], q = points[(edge + 1) % points.length];
    const inward = windingNormal.clone().cross(q.clone().sub(p));
    if (inward.lengthSq() < 1e-12) return null;
    inward.normalize();
    // A convex polygon contains every other vertex in each edge's inward half-plane.
    if (points.some(point => point.clone().sub(p).dot(inward) < -1e-7)) return null;
    edges.push({ normal: inward, offset: inward.dot(p) });
  }
  return { normal, offset: normal.dot(a), edges, doubleSided: wall.doubleSided };
}

const planeRange = (box: THREE.Box3, normal: THREE.Vector3, offset: number): [number, number] => {
  let min = -offset, max = -offset;
  for (let i = 0; i < 3; i++) { const n = normal.getComponent(i), a = n * box.min.getComponent(i), b = n * box.max.getComponent(i); min += Math.min(a, b); max += Math.max(a, b); }
  return [min, max];
};

export function preparedCellWallHides(eyes: THREE.Box3, target: THREE.Box3, wall: PreparedCellWall,
  projection = districtProjection, margin = .02): boolean {
  if (eyes.isEmpty() || target.isEmpty() || !Number.isFinite(margin) || margin <= 0 ||
    ![projection.near, projection.fov, projection.aspect].every(Number.isFinite) ||
    projection.near <= 0 || projection.fov <= 0 || projection.fov >= 180 || projection.aspect <= 0) return false;
  for(let i=0;i<3;i++)if(![eyes.min.getComponent(i),eyes.max.getComponent(i),target.min.getComponent(i),target.max.getComponent(i)].every(Number.isFinite))return false;
  const eyeRange = planeRange(eyes, wall.normal, wall.offset), targetRange = planeRange(target, wall.normal, wall.offset);
  const sign = wall.doubleSided && eyeRange[1] < 0 ? -1 : 1;
  const tangent = Math.tan(THREE.MathUtils.degToRad(projection.fov / 2));
  const nearRadius = projection.near * Math.sqrt(1 + tangent * tangent * (1 + projection.aspect * projection.aspect));
  if ((sign > 0 ? eyeRange[0] : -eyeRange[1]) <= nearRadius + margin || (sign > 0 ? targetRange[1] : -targetRange[0]) >= -margin) return false;
  const eyePoints = corners(eyes), targetPoints = corners(target);
  const distance = (p: THREE.Vector3) => sign * (wall.normal.dot(p) - wall.offset);
  const de = eyePoints.map(distance), dt = targetPoints.map(distance);
  for (const edge of wall.edges) {
    const he = eyePoints.map(p => edge.normal.dot(p) - edge.offset), ht = targetPoints.map(p => edge.normal.dot(p) - edge.offset);
    for (let e = 0; e < 8; e++) for (let t = 0; t < 8; t++) {
      const denominator = de[e] - dt[t];
      if (de[e] * ht[t] - dt[t] * he[e] <= margin * denominator) return false;
    }
  }
  return true;
}

export function cellWallHides(eyes: THREE.Box3, target: THREE.Box3, wall: CellWall, projection = districtProjection, margin = .02): boolean {
  const prepared = prepareCellWall(wall); return prepared !== null && preparedCellWallHides(eyes, target, prepared, projection, margin);
}

const expectedCamera = new THREE.PerspectiveCamera();
const cameraChecks = new WeakMap<THREE.Camera, { parameters: number[]; matrix: number[]; valid: boolean }>();
export function districtCameraSupported(camera: THREE.Camera, contract = districtProjection): camera is THREE.PerspectiveCamera {
  if (!(camera instanceof THREE.PerspectiveCamera) || camera.near <= 0 || camera.near > contract.near ||
    !Number.isFinite(camera.getEffectiveFOV()) || camera.getEffectiveFOV() <= 0 || camera.getEffectiveFOV() > contract.fov ||
    camera.aspect <= 0 || camera.aspect > contract.aspect || camera.far <= camera.near ||
    camera.coordinateSystem !== THREE.WebGLCoordinateSystem || camera.filmOffset !== 0 || camera.view?.enabled) return false;
  const previous = cameraChecks.get(camera), matrix = camera.projectionMatrix.elements;
  if (previous && previous.parameters[0] === camera.fov && previous.parameters[1] === camera.aspect &&
    previous.parameters[2] === camera.near && previous.parameters[3] === camera.far && previous.parameters[4] === camera.zoom &&
    matrix.every((value, i) => value === previous.matrix[i])) return previous.valid;
  expectedCamera.fov = camera.fov; expectedCamera.aspect = camera.aspect; expectedCamera.near = camera.near;
  expectedCamera.far = camera.far; expectedCamera.zoom = camera.zoom; expectedCamera.updateProjectionMatrix();
  const valid = matrix.every((value, i) => Number.isFinite(value) && Math.abs(value - expectedCamera.projectionMatrix.elements[i]) < 1e-10);
  cameraChecks.set(camera, { parameters: [camera.fov, camera.aspect, camera.near, camera.far, camera.zoom], matrix: [...matrix], valid });
  return valid;
}
