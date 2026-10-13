import * as THREE from 'three';
import { blobShadowMeshes } from './blob-shadow-registry';
import { shadowPerformanceMode } from './performance-controls';
import { recordBlobShadow, shouldSampleBlobShadowTiming } from './performance-subsystem-metrics';
/** Asset conversion utility. */
/** Height above ground at which the disc starts fading, and where it is gone entirely (yards). */
const FADE_START_Z = 1.5;
const FADE_END_Z = 12;
/** Half-width of the finite-difference used to read the ground slope under a unit (yards). */
const SLOPE_EPSILON = 0.6;
/** Steepest slope the disc will follow. Beyond this it would stand up like a wall. */
const MAX_TILT_COS = 0.5; // ~60 degrees
/** How much the disc spreads at FADE_END_Z, mimicking an occluder receding from the ground. */
const MAX_SPREAD = 1.35;
const GROUND_LIFT = 0.05; // beat z-fighting with the terrain
export const BLOB_SHADOW_MAX_DISTANCE = 160;
const BLOB_SHADOW_SLOPE_DISTANCE = 60;

type BlobShadowLodState = {
  groundZ: number;
  sampledX: number;
  sampledY: number;
  groundAt: number;
  slopeX: number;
  slopeY: number;
  slopeAt: number;
};

let sharedTexture: THREE.CanvasTexture | null = null;
let sharedGeometry: THREE.PlaneGeometry | null = null;
/** Global sun scale: 0 inside a lit WMO interior, 1 outdoors. See setBlobShadowSunScale. */
let sunScale = 1;
const lodStates = new WeakMap<THREE.Mesh, BlobShadowLodState>();

// Scratch for the slope solve — one shared set, this runs per unit per frame.
const slopeNormal = new THREE.Vector3();
const slopeQuat = new THREE.Quaternion();
const slopeParentQuat = new THREE.Quaternion();
const PLANE_UP = new THREE.Vector3(0, 0, 1);

export const BLOB_SHADOW_VERTEX_SHADER = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// MultiplyBlending is dst*src, so RGB 1.0 means "leave the ground alone". Fading therefore lerps the
// sampled disc toward white rather than toward transparent.
export const BLOB_SHADOW_FRAGMENT_SHADER = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uMap;
uniform float uStrength;
void main() {
  vec3 disc = texture(uMap, vUv).rgb;
  outColor = vec4(mix(vec3(1.0), disc, clamp(uStrength, 0.0, 1.0)), 1.0);
}
`;

function getTexture(): THREE.CanvasTexture {
  if (sharedTexture) return sharedTexture;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  // RGB is the darkening factor: dark centre (~0.43x) fading to white (1x = no change) at the rim,
  // so the disc softly darkens the ground and vanishes at the edge.
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, '#6e6e6e');
  g.addColorStop(0.55, '#9c9c9c');
  g.addColorStop(1.0, '#ffffff');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  sharedTexture = new THREE.CanvasTexture(canvas);
  sharedTexture.colorSpace = THREE.NoColorSpace;
  return sharedTexture;
}

function getGeometry(): THREE.PlaneGeometry {
  // PlaneGeometry lies in the XY plane with +Z normal — already flat-on-ground in this Z-up world.
  if (!sharedGeometry) sharedGeometry = new THREE.PlaneGeometry(2, 2); // radius 1; instances scale it
  return sharedGeometry;
}

/**
 * Scale every blob shadow by the current direct-sun availability (0 indoors, 1 outdoors). Mirrors
 * setM2LocalLights/setM2Light: one shared value that all discs read, updated once per frame.
 */
export function setBlobShadowSunScale(scale: number): void {
  sunScale = Number.isFinite(scale) ? Math.max(0, Math.min(1, scale)) : 1;
}

/** A ground shadow disc of the given radius (unscaled model yards). Add it under the entity group. */
export function createBlobShadow(radius: number): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: BLOB_SHADOW_VERTEX_SHADER,
    fragmentShader: BLOB_SHADOW_FRAGMENT_SHADER,
    uniforms: { uMap: { value: getTexture() }, uStrength: { value: 1 } },
    transparent: true,
    blending: THREE.MultiplyBlending,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(getGeometry(), material);
  // Geometry and texture are shared — disposal loops MUST skip this mesh (check userData.isBlobShadow)
  // or one removed entity would dispose every shadow. The per-mesh material is freed by
  // disposeBlobShadow().
  mesh.userData.isBlobShadow = true;
  mesh.userData.blobRadius = radius;
  mesh.scale.setScalar(radius);
  mesh.position.z = GROUND_LIFT;
  mesh.renderOrder = 1; // draw after the opaque terrain
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  blobShadowMeshes.add(mesh);
  material.addEventListener('dispose', () => blobShadowMeshes.delete(mesh));
  return mesh;
}

/**
 * Re-seat the disc on the ground and fade it for height/indoors. Call once per frame per visible
 * unit. `groundZ` is the terrain height under the unit and `unitZ` the world height of the parent
 * group's origin; pass a non-finite groundZ (no terrain sample) to leave the disc at the feet.
 *
 * `slope` (optional) samples ground height at arbitrary world XY. Supplying it tilts the disc into
 * the plane of the ground, which is what stops it slicing into a hillside on the uphill edge and
 * hanging in the air on the downhill one. Costs two extra height lookups per unit per frame; omit
 * it for units where that isn't worth paying (or where the ground isn't terrain).
 */
export function updateBlobShadow(
  mesh: THREE.Mesh,
  groundZ: number,
  unitZ: number,
  slope?: { x: number; y: number; sampleHeight: (x: number, y: number) => number },
): void {
  const material = mesh.material as THREE.ShaderMaterial;
  const radius = (mesh.userData.blobRadius as number) ?? 1;

  const parentScaleZ = mesh.parent?.scale.z || 1;

  if (!Number.isFinite(groundZ)) {
    // No terrain under this unit (unloaded tile): fall back to the feet. `visible` must still be
    // reassigned — a unit that walked indoors and back out onto an unsampled tile would otherwise
    // keep the hidden flag from the indoor frame forever.
    material.uniforms.uStrength.value = sunScale;
    mesh.visible = sunScale > 0.01;
    mesh.position.z = GROUND_LIFT / parentScaleZ;
    mesh.quaternion.identity();
    mesh.scale.setScalar(radius);
    mesh.updateMatrix();
    return;
  }

  const height = Math.max(0, unitZ - groundZ);
  const fade = 1 - Math.min(1, Math.max(0, (height - FADE_START_Z) / (FADE_END_Z - FADE_START_Z)));
  const strength = fade * sunScale;
  material.uniforms.uStrength.value = strength;
  // Fully faded discs still cost a draw call and still z-fight; drop them from the frame instead.
  mesh.visible = strength > 0.01;
  if (!mesh.visible) return;

  // The parent group may carry a display scale; the disc's local offset has to be expressed in that
  // scaled space or a large creature's shadow sinks into (or floats above) the ground it stands on.
  // The lift is divided too, so every disc clears the ground by GROUND_LIFT in world yards rather
  // than by its own display scale.
  mesh.position.z = (groundZ - unitZ + GROUND_LIFT) / parentScaleZ;
  mesh.scale.setScalar(radius * (1 + (MAX_SPREAD - 1) * (1 - fade)));

  // Lie in the plane of the ground rather than dead flat. Central differences over the height field
  // give the surface normal; the disc is then rotated from +Z onto it. The parent group carries the
  // unit's facing, so the rotation is taken into the parent's frame before it is stored.
  if (slope) {
    const e = SLOPE_EPSILON;
    const dzdx = (slope.sampleHeight(slope.x + e, slope.y) - slope.sampleHeight(slope.x - e, slope.y)) / (2 * e);
    const dzdy = (slope.sampleHeight(slope.x, slope.y + e) - slope.sampleHeight(slope.x, slope.y - e)) / (2 * e);
    if (Number.isFinite(dzdx) && Number.isFinite(dzdy)) {
      slopeNormal.set(-dzdx, -dzdy, 1).normalize();
      // Cliff faces and sampling noise at WMO/terrain seams produce near-vertical normals; letting
      // the disc follow those turns it edge-on and it vanishes. Fall back to flat past the limit.
      if (slopeNormal.z >= MAX_TILT_COS) {
        slopeQuat.setFromUnitVectors(PLANE_UP, slopeNormal);
        const parent = mesh.parent;
        if (parent) {
          // world = parentWorld * local, so local = parentWorld⁻¹ * desiredWorld.
          parent.updateWorldMatrix(true, false);
          mesh.quaternion.copy(parent.getWorldQuaternion(slopeParentQuat).invert().multiply(slopeQuat));
        } else {
          mesh.quaternion.copy(slopeQuat);
        }
      } else {
        mesh.quaternion.identity();
      }
    }
  }
  mesh.updateMatrix();
}

/**
 * Low-risk shadow LOD around the exact legacy placement routine. Nearby moving units continue to
 * resample immediately; stationary/distant units reuse their last valid ground and orientation.
 */
function recordShadowLod(
  started: number,
  visible: boolean,
  culled?: 'invisible' | 'distance',
  groundSamples = 0,
  slopeSamples = 0,
  reusedGround = false,
): void {
  recordBlobShadow({
    elapsedMs: started >= 0 ? performance.now() - started : undefined,
    visible,
    culled,
    groundSamples,
    slopeSamples,
    reusedGround,
  });
}

export function updateBlobShadowLod(
  mesh: THREE.Mesh,
  x: number,
  y: number,
  unitZ: number,
  distanceSquared = 0,
  inView = true,
  sampleHeight?: (x: number, y: number) => number,
  now?: number,
): void {
  const mode = shadowPerformanceMode();
  const started = shouldSampleBlobShadowTiming() ? performance.now() : -1;
  distanceSquared = Math.max(0, distanceSquared);
  if (mode === 'off' || !inView || mesh.parent?.visible === false || sunScale <= 0.01) {
    mesh.visible = false;
    recordShadowLod(started, false, 'invisible');
    return;
  }
  if (mode !== 'baseline' && distanceSquared > BLOB_SHADOW_MAX_DISTANCE * BLOB_SHADOW_MAX_DISTANCE) {
    mesh.visible = false;
    recordShadowLod(started, false, 'distance');
    return;
  }
  if (mode === 'baseline') {
    const groundZ = sampleHeight?.(x, y) ?? Number.NaN;
    updateBlobShadow(mesh, groundZ, unitZ, sampleHeight ? { x, y, sampleHeight } : undefined);
    recordShadowLod(started, mesh.visible, undefined, sampleHeight ? 1 : 0, sampleHeight ? 4 : 0);
    return;
  }

  const sampleNow = now ?? performance.now();
  let state = lodStates.get(mesh);
  if (!state) {
    state = {
      groundZ: Number.NaN,
      sampledX: x,
      sampledY: y,
      groundAt: -Infinity,
      slopeX: x,
      slopeY: y,
      slopeAt: -Infinity,
    };
    lodStates.set(mesh, state);
  }
  const distance = Math.sqrt(distanceSquared);
  const groundMove = distance <= 40 ? 0.1 : distance <= 90 ? 0.3 : 0.75;
  const groundInterval = distance <= 40 ? 100 : distance <= 90 ? 200 : 500;
  const dx = x - state.sampledX, dy = y - state.sampledY;
  const needGround = !Number.isFinite(state.groundZ)
    || dx * dx + dy * dy >= groundMove * groundMove
    || sampleNow - state.groundAt >= groundInterval;
  let groundSamples = 0;
  if (needGround && sampleHeight) {
    const sampled = sampleHeight(x, y);
    if (Number.isFinite(sampled)) state.groundZ = sampled;
    state.sampledX = x; state.sampledY = y; state.groundAt = sampleNow; groundSamples = 1;
  }
  const slopeDx = x - state.slopeX, slopeDy = y - state.slopeY;
  const needSlope = Boolean(sampleHeight)
    && distance <= BLOB_SHADOW_SLOPE_DISTANCE
    && (state.slopeAt === -Infinity || slopeDx * slopeDx + slopeDy * slopeDy >= 0.35 * 0.35 || sampleNow - state.slopeAt >= 300);
  if (needSlope) { state.slopeX = x; state.slopeY = y; state.slopeAt = sampleNow; }
  updateBlobShadow(
    mesh,
    state.groundZ,
    unitZ,
    needSlope && sampleHeight ? { x, y, sampleHeight } : undefined,
  );
  recordShadowLod(started, mesh.visible, undefined, groundSamples, needSlope ? 4 : 0, !needGround || !sampleHeight);
}

/** Free the per-mesh material. The geometry and texture are shared and must NOT be disposed here. */
export function disposeBlobShadow(mesh: THREE.Mesh): void {
  blobShadowMeshes.delete(mesh);
  lodStates.delete(mesh);
  (mesh.material as THREE.Material | undefined)?.dispose?.();
}
