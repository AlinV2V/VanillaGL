import type { Vector3 } from 'three';

export const CAMERA_ORBIT_LEFT = 1;
export const CAMERA_STEER_RIGHT = 2;

/** Track camera-only left orbit independently from right-button mouse-look steering. */
export function installCameraMouseButtons(element: HTMLElement | SVGElement | null): () => number {
  let buttons = 0;
  element?.addEventListener('pointerdown', (event) => {
    const button = (event as PointerEvent).button;
    if (button === 0) buttons |= CAMERA_ORBIT_LEFT;
    if (button === 2) buttons |= CAMERA_STEER_RIGHT;
  });
  window.addEventListener('pointerup', (event) => {
    if (event.button === 0) buttons &= ~CAMERA_ORBIT_LEFT;
    if (event.button === 2) buttons &= ~CAMERA_STEER_RIGHT;
  });
  window.addEventListener('pointercancel', () => { buttons = 0; });
  window.addEventListener('blur', () => { buttons = 0; });
  return () => buttons;
}

/** Keep travel on authored unit facing unless right-button mouse-look is actively steering it. */
export function applyMouseSteeringBasis(
  cameraHeading: number,
  unitHeading: number,
  mouseSteering: boolean,
  forward: Vector3,
  right: Vector3,
  up: Vector3,
): number {
  if (mouseSteering) return cameraHeading;
  forward.set(Math.cos(unitHeading), Math.sin(unitHeading), 0);
  right.crossVectors(forward, up).normalize();
  return unitHeading;
}
