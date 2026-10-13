import type { PerspectiveCamera, Vector3 } from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const MIN_FOLLOW_SPEED = 90;
const MAX_FOLLOW_SPEED = 270;

export function shouldAutoFollowCameraYaw(style: string, moving: boolean, mouseButtons: number): boolean {
  if (mouseButtons !== 0) return false;
  const mode = style.toLowerCase();
  return mode === 'always' || (mode === 'smart' && moving);
}

/** Native cameraYawSmoothSpeed is degrees/second; take the shortest wrapped yaw path. */
export function cameraFollowYawStep(current: number, wanted: number, dt: number, speed: number): number {
  let delta = ((wanted - current + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  const degreesPerSecond = Math.max(MIN_FOLLOW_SPEED, Math.min(MAX_FOLLOW_SPEED, Number(speed) || 180));
  const limit = degreesPerSecond * Math.PI / 180 * Math.max(0, dt);
  if (Math.abs(delta) > limit) delta = Math.sign(delta) * limit;
  return delta;
}

/** Smoothly rotate the camera offset behind unit facing without changing pitch or zoom. */
export function autoFollowCameraYaw(
  camera: PerspectiveCamera,
  controls: OrbitControls,
  scratch: Vector3,
  facing: number,
  dt: number,
  moving: boolean,
  style: string,
  speed: number,
  mouseButtons: number,
): void {
  if (!shouldAutoFollowCameraYaw(style, moving, mouseButtons)) return;
  scratch.subVectors(camera.position, controls.target);
  if (scratch.x * scratch.x + scratch.y * scratch.y < 1e-8) return;
  const step = cameraFollowYawStep(Math.atan2(scratch.y, scratch.x), facing + Math.PI, dt, speed);
  if (Math.abs(step) < 1e-7) return;
  const cos = Math.cos(step), sin = Math.sin(step), x = scratch.x, y = scratch.y;
  scratch.x = x * cos - y * sin;
  scratch.y = x * sin + y * cos;
  camera.position.copy(controls.target).add(scratch);
  controls.update();
}
