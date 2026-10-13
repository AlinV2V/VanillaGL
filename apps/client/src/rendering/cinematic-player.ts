import * as THREE from 'three';
import {
  CINEMATIC_CAMERAS,
  CINEMATIC_SEQUENCES,
  type CinematicCameraData,
  type CinematicSplineKeyF32,
  type CinematicSplineKeyVec3,
} from '../data/cinematics';
/** Asset conversion utility. */
/** Radians. Every shipped camera authors its FOV horizontally at 4:3 — see below. */
type Vec3 = [number, number, number];

export interface CinematicPlayerDeps {
  camera: THREE.PerspectiveCamera;
  /** World -> render space. The render origin moves during playback, so this is called per frame. */
  worldToLocal: (wx: number, wy: number) => { x: number; y: number };
  /** Called when the camera's world position enters a new tile so terrain can stream ahead of it. */
  onCameraWorldPosition?: (wx: number, wy: number, wz: number) => void;
  /** Fired once when the path finishes or the player skips. Sends CMSG_COMPLETE_CINEMATIC. */
  onFinished: (reason: 'completed' | 'skipped') => void;
  /**
   * Start the race narration for a CinematicCamera.dbc soundId, returning a handle to stop it.
   * Eight of the ten cameras carry one (`DwarfFlyByNarration` = 3740 is the giveaway); they resolve
   * to `Sound/CinematicVoices/<Race>Narration.mp3`, which the sound bake already ships.
   */
  playNarration?: (soundId: number) => { stop: () => void } | null;
  log?: (message: string) => void;
}

/** Locate the segment containing `ms`. Keys are sorted; paths are short enough for a linear scan. */
function bracket(keys: { t: number }[], ms: number): number {
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].t <= ms) i++;
  return i;
}

/**
 * Time-parameterized Catmull-Rom through the authored key positions.
 *
 * Why not the M2 Hermite: the two extra slots in each 36-byte key look like in/out tangents but
 * their scale is unresolved, and evaluating the standard Hermite on them throws the camera 170-365x
 * the chord off course — 53yd mean excursion, 181yd worst. That is what made the first version of
 * this flythrough fly underground and wander off the real path.
 *
 * Why the TIME-parameterized form rather than the uniform one: the keys are unevenly spaced (0.3s
 * to 12s apart), and uniform Catmull-Rom bulges on a short segment sandwiched between long ones —
 * measured at 4.4yd off an 8.6yd chord on FlybyUndead's first segment. Deriving each tangent from
 * the real timestamps removes that: the worst excursion over the whole corpus drops well under the
 * chord, while the curve still passes exactly through every authored key.
 */
function sampleVec3(keys: CinematicSplineKeyVec3[], ms: number, out: THREE.Vector3): THREE.Vector3 {
  if (keys.length === 0) return out.set(0, 0, 0);
  if (keys.length === 1 || ms <= keys[0].t) return out.fromArray(keys[0].v);
  const last = keys[keys.length - 1];
  if (ms >= last.t) return out.fromArray(last.v);
  const i = bracket(keys, ms);
  const a = keys[i];
  const b = keys[i + 1];
  const dt = b.t - a.t;
  const f = dt > 0 ? (ms - a.t) / dt : 0;
  // Clamped endpoints: the first and last keys act as their own neighbours.
  const prev = keys[Math.max(0, i - 1)];
  const next = keys[Math.min(keys.length - 1, i + 2)];
  const spanA = b.t - prev.t;
  const spanB = next.t - a.t;
  const f2 = f * f;
  const f3 = f2 * f;
  const h00 = 2 * f3 - 3 * f2 + 1;
  const h10 = f3 - 2 * f2 + f;
  const h01 = -2 * f3 + 3 * f2;
  const h11 = f3 - f2;
  for (let c = 0; c < 3; c++) {
    // Finite-difference tangents over the real timestamps, rescaled to this segment's duration.
    const mA = spanA > 0 ? ((b.v[c] - prev.v[c]) / spanA) * dt : 0;
    const mB = spanB > 0 ? ((next.v[c] - a.v[c]) / spanB) * dt : 0;
    const value = h00 * a.v[c] + h10 * mA + h01 * b.v[c] + h11 * mB;
    if (c === 0) out.x = value;
    else if (c === 1) out.y = value;
    else out.z = value;
  }
  return out;
}

function sampleF32(keys: CinematicSplineKeyF32[], ms: number): number {
  if (keys.length === 0) return 0;
  if (keys.length === 1 || ms <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (ms >= last.t) return last.v;
  const i = bracket(keys, ms);
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.t - a.t;
  const f = span > 0 ? (ms - a.t) / span : 0;
  return a.v + (b.v - a.v) * f;
}

/** Duration is the last timestamp across all three tracks, in model-timeline milliseconds. */
function cameraDurationMs(cam: CinematicCameraData): number {
  const last = (keys: { t: number }[]) => (keys.length ? keys[keys.length - 1].t : 0);
  return Math.max(last(cam.position), last(cam.target), last(cam.roll));
}

export interface CinematicPlayer {
  /** True when a sequence has baked data, without starting it. */
  canPlay(sequenceId: number): boolean;
  /**
   * Where the flythrough OPENS, in world space, or null if the sequence is unknown.
   *
   * This matters because a race intro does not start where the player spawns: the Human camera opens
   * over City_01 City, two tiles outside the neighbourhood loaded at world entry, and the Tauren
   * camera opens on Spirit Rise 1788 yards from Camp Narache. Terrain has to be streamed there
   * BEFORE playback begins or the opening shot is a void.
   */
  startWorldPosition(sequenceId: number): { x: number; y: number; z: number } | null;
  /** Returns false when the sequence has no baked data — the caller must ack immediately then. */
  start(sequenceId: number): boolean;
  /** Player pressed ESC. No-op when nothing is playing. */
  skip(): void;
  isPlaying(): boolean;
  /** Advance the path. Returns true while the cinematic owns the camera. */
  update(dt: number): boolean;
  /** Tear down without notifying the server (disconnect, world transfer). */
  cancel(): void;
}

export function createCinematicPlayer(deps: CinematicPlayerDeps): CinematicPlayer {
  const { camera } = deps;
  const log = deps.log ?? (() => {});

  let cameras: CinematicCameraData[] = [];
  let index = -1;
  let elapsedMs = 0;
  let durationMs = 0;
  let savedFov = camera.fov;
  let savedNear = camera.near;
  let savedFar = camera.far;
  let lastTileKey = '';
  let narration: { stop: () => void } | null = null;

  const splineOut = new THREE.Vector3();
  const worldPos = new THREE.Vector3();
  const worldTarget = new THREE.Vector3();
  const localPos = new THREE.Vector3();
  const localTarget = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const lookMatrix = new THREE.Matrix4();

  /** world = origin + Rz(facing) * (base + spline), with Z left unrotated. */
  const compose = (cam: CinematicCameraData, base: Vec3, offset: THREE.Vector3, out: THREE.Vector3) => {
    const x = base[0] + offset.x;
    const y = base[1] + offset.y;
    const c = Math.cos(cam.facing);
    const s = Math.sin(cam.facing);
    return out.set(
      cam.origin[0] + x * c - y * s,
      cam.origin[1] + x * s + y * c,
      cam.origin[2] + base[2] + offset.z,
    );
  };

  const stopNarration = () => {
    try {
      narration?.stop();
    } catch {
      // A finished voice line may already have released its element; skipping must never throw.
    }
    narration = null;
  };

  const restoreCamera = () => {
    camera.fov = savedFov;
    camera.near = savedNear;
    camera.far = savedFar;
    camera.updateProjectionMatrix();
  };

  const finish = (reason: 'completed' | 'skipped') => {
    if (index < 0) return;
    index = -1;
    cameras = [];
    stopNarration();
    restoreCamera();
    log(`cinematic: ${reason}`);
    deps.onFinished(reason);
  };

  const beginCamera = (i: number) => {
    index = i;
    elapsedMs = 0;
    durationMs = cameraDurationMs(cameras[i]);
    lastTileKey = '';
    // Narration is per CAMERA, not per sequence: CinematicSequences.dbc's own soundId is 0 on every
    // shipped row, while CinematicCamera.dbc carries the voice line.
    stopNarration();
    const soundId = cameras[i].soundId;
    if (soundId) {
      narration = deps.playNarration?.(soundId) ?? null;
      log(`cinematic: narration sound ${soundId}${narration ? '' : ' (unavailable)'}`);
    }
  };

  const firstCamera = (sequenceId: number): CinematicCameraData | null => {
    const sequence = CINEMATIC_SEQUENCES[sequenceId];
    if (!sequence) return null;
    for (const id of sequence.cameras) {
      const cam = CINEMATIC_CAMERAS[id];
      if (cam) return cam;
    }
    return null;
  };

  return {
    canPlay(sequenceId: number) {
      return firstCamera(sequenceId) !== null;
    },

    startWorldPosition(sequenceId: number) {
      const cam = firstCamera(sequenceId);
      if (!cam || cam.position.length === 0) return null;
      const out = new THREE.Vector3();
      compose(cam, cam.positionBase, new THREE.Vector3().fromArray(cam.position[0].v), out);
      return { x: out.x, y: out.y, z: out.z };
    },

    start(sequenceId: number) {
      const sequence = CINEMATIC_SEQUENCES[sequenceId];
      if (!sequence) {
        log(`cinematic: no baked data for sequence ${sequenceId}`);
        return false;
      }
      const resolved = sequence.cameras
        .map((id) => CINEMATIC_CAMERAS[id])
        .filter((cam): cam is CinematicCameraData => Boolean(cam));
      if (resolved.length === 0) {
        log(`cinematic: sequence ${sequenceId} resolved to no cameras`);
        return false;
      }
      savedFov = camera.fov;
      savedNear = camera.near;
      savedFar = camera.far;
      cameras = resolved;
      beginCamera(0);
      log(
        `cinematic: sequence ${sequenceId} -> ${resolved.length} camera(s), ` +
          `${(resolved.reduce((sum, cam) => sum + cameraDurationMs(cam), 0) / 1000).toFixed(1)}s`,
      );
      return true;
    },

    skip() {
      // CinematicFrame.xml binds ESCAPE straight to StopCinematic(); the server is told the same
      // way a natural end tells it, via CMSG_COMPLETE_CINEMATIC.
      finish('skipped');
    },

    isPlaying() {
      return index >= 0;
    },

    cancel() {
      if (index < 0) return;
      index = -1;
      cameras = [];
      stopNarration();
      restoreCamera();
    },

    update(dt: number) {
      if (index < 0) return false;
      const cam = cameras[index];
      elapsedMs += dt * 1000;

      if (elapsedMs >= durationMs) {
        if (index + 1 < cameras.length) {
          beginCamera(index + 1);
        } else {
          finish('completed');
          return false;
        }
      }

      const active = cameras[index];
      const ms = elapsedMs;

      sampleVec3(active.position, ms, splineOut);
      compose(active, active.positionBase, splineOut, worldPos);
      sampleVec3(active.target, ms, splineOut);
      compose(active, active.targetBase, splineOut, worldTarget);
      const roll = sampleF32(active.roll, ms);

      // Terrain streams around the CAMERA during playback, not the player — the path travels up to
      // ~1800 yards from the spawn point, far outside the neighbourhood loaded at world entry.
      if (deps.onCameraWorldPosition) {
        // Real ADT tile indices, so streaming fires on the boundaries the loader actually uses.
        const tileKey = `${Math.floor(32 - worldPos.y / 533.3333333)}:${Math.floor(32 - worldPos.x / 533.3333333)}`;
        if (tileKey !== lastTileKey) {
          lastTileKey = tileKey;
          deps.onCameraWorldPosition(worldPos.x, worldPos.y, worldPos.z);
        }
      }

      const p = deps.worldToLocal(worldPos.x, worldPos.y);
      const t = deps.worldToLocal(worldTarget.x, worldTarget.y);
      localPos.set(p.x, p.y, worldPos.z);
      localTarget.set(t.x, t.y, worldTarget.z);

      camera.position.copy(localPos);

      // Build the basis by hand instead of lookAt() so the authored roll can be applied about the
      // view axis. World up is +Z (this repo's world is Z-up).
      forward.subVectors(localTarget, localPos);
      if (forward.lengthSq() < 1e-8) forward.set(1, 0, 0);
      forward.normalize();
      up.set(0, 0, 1);
      right.crossVectors(forward, up);
      if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
      right.normalize();
      up.crossVectors(right, forward).normalize();
      if (roll !== 0) {
        const c = Math.cos(roll);
        const s = Math.sin(roll);
        const rx = right.x * c + up.x * s;
        const ry = right.y * c + up.y * s;
        const rz = right.z * c + up.z * s;
        up.set(up.x * c - right.x * s, up.y * c - right.y * s, up.z * c - right.z * s);
        right.set(rx, ry, rz);
      }
      // three.js cameras look down -Z with +Y up and +X right.
      lookMatrix.makeBasis(right, up, forward.clone().negate());
      camera.quaternion.setFromRotationMatrix(lookMatrix);

      // Vanilla M2 camera FOV is authored HORIZONTALLY at 4:3 — the same convention the portrait
      // camera in ui/unit-frame-canvas.ts:332-336 had to adopt after treating it as vertical made
      // every face 25% too small. Keeping the horizontal angle fixed and deriving vertical from the
      // live aspect also matches vanilla, whose FOV is horizontal-constant across resolutions.
      const aspect = camera.aspect > 0 ? camera.aspect : 4 / 3;
      camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(active.fov / 2) / aspect));
      camera.near = savedNear;
      camera.far = savedFar;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      return true;
    },
  };
}
