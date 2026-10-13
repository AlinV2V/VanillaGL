import * as THREE from 'three';

export const YARDS_PER_METRE = 1 / 0.9144;
export const XR_TO_GAME = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, -Math.PI / 2, 'ZYX'));

export class SnapTurn {
  private armed = true;
  sample(axis: number): number {
    if (Math.abs(axis) < 0.25) this.armed = true;
    if (!this.armed || Math.abs(axis) < 0.7) return 0;
    this.armed = false;
    return -Math.sign(axis) * Math.PI / 6;
  }
  reset() { this.armed = true; }
}

/** Positions must be in reference-space metres, never transformed world positions. */
export class SwingGesture {
  private previous = new THREE.Vector3();
  private previousTime = -1;
  private armed = false;
  sample(position: THREE.Vector3, time: number, gripping: boolean): boolean {
    const dt = (time - this.previousTime) / 1000;
    const speed = dt > 0 && dt < 0.1 ? position.distanceTo(this.previous) / dt : 0;
    const valid = this.previousTime >= 0 && dt > 0 && dt < 0.1;
    this.previous.copy(position); this.previousTime = time;
    if (!gripping || !valid) { this.armed = false; return false; }
    if (speed < 0.35) this.armed = true;
    if (this.armed && speed > 1.4 && speed < 12) { this.armed = false; return true; }
    return false;
  }
  reset() { this.previousTime = -1; this.armed = false; }
}

export function movementKeys(forward: number, strafe: number, jump: boolean): string[] {
  return [forward > 0.25 ? 'KeyW' : forward < -0.25 ? 'KeyS' : '',
    strafe > 0.25 ? 'KeyE' : strafe < -0.25 ? 'KeyQ' : '', jump ? 'Space' : ''].filter(Boolean);
}
