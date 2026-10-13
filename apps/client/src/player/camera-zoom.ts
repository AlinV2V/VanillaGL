/** Asset conversion utility. */

export const CAMERA_ZOOM_STEP_YARDS = 1;

/** cvar `cameraDistanceMoveSpeed`, default string `"8.33"` at `0x0084ff1c`. */
export const ZOOM_MOVE_SPEED_YPS = 8.33;

/** Where a wheel notch wants the orbit radius to end up. `steps` is +out / -in. */
export function zoomTargetDistance(current: number, steps: number, minDistance: number, maxDistance: number): number {
  const wanted = current + steps * CAMERA_ZOOM_STEP_YARDS;
  return Math.max(minDistance, Math.min(maxDistance, wanted));
}

/**
 * Glide the live radius toward the wheel's target at `cameraDistanceMoveSpeed`.
 * Framerate-independent: the step is yards-per-second scaled by the frame's dt, and it never
 * overshoots, so a long frame settles rather than oscillating.
 */
export function easeCameraDistance(current: number, target: number, dt: number, speed = ZOOM_MOVE_SPEED_YPS): number {
  const remaining = target - current;
  if (remaining === 0) return target;
  const step = speed * Math.max(0, dt);
  if (step >= Math.abs(remaining)) return target;
  return current + Math.sign(remaining) * step;
}

/** Wheel deltaY -> vanilla step count. Down (positive deltaY) zooms out, matching the client. */
export function wheelStepsFromDelta(deltaY: number): number {
  if (deltaY > 0) return 1;
  if (deltaY < 0) return -1;
  return 0;
}

/**
 * The follow camera's orbit radius, as one owner.
 *
 * The whole point of this living in its own object is that the radius has exactly one writer.
 * When the wheel wrote straight onto `camera.position`, the follow camera's per-frame restore
 * overwrote it before anything was drawn and zoom looked completely dead; when OrbitControls owns
 * it, a notch dollies off the *collision-clamped* radius instead of the one the player asked for,
 * so zooming near a wall jumps. Both failures disappear if the radius is state rather than a
 * side effect of the camera transform.
 *
 * `PlayerMovementController` is a thin adapter over this, and `tools/verify-camera-zoom.ts`
 * drives this same class, so a regression in the frame logic turns the gate red.
 */
export class FollowCameraZoom {
  /** Live radius the camera is placed at, before collision shortening. */
  private requested?: number;
  /** Radius the wheel asked for; `requested` glides here at cameraDistanceMoveSpeed. */
  private target?: number;

  /** Re-derive the live radius from the camera each frame (the follow camera owns placement). */
  observeRadius(radius: number) {
    if (Number.isFinite(radius)) this.requested = radius;
  }

  /** Forget both, e.g. across a spawn or a free-cam session, so the next frame re-seeds. */
  reset() {
    this.requested = undefined;
    this.target = undefined;
  }

  /** Drop only the wheel goal, keeping the live radius — used when free-cam borrows the camera. */
  releaseTarget() {
    this.target = undefined;
  }

  /** One wheel notch: +1 out, -1 in, one yard each. */
  notch(steps: number, minDistance: number, maxDistance: number) {
    if (!steps) return;
    const base = this.target ?? this.requested;
    if (base === undefined || !Number.isFinite(base)) return;
    this.target = zoomTargetDistance(base, steps, minDistance, maxDistance);
  }

  /**
   * Advance one frame and return the radius the camera should be placed at, or `undefined` while
   * the radius has not been seeded yet (before the first follow frame).
   */
  advance(dt: number, minDistance: number, maxDistance: number): number | undefined {
    if (this.requested === undefined) return undefined;
    if (this.target !== undefined) this.requested = easeCameraDistance(this.requested, this.target, dt);
    return Math.max(minDistance, Math.min(maxDistance, this.requested));
  }

  /** QA/diagnostics only. */
  state() {
    return { requested: this.requested, target: this.target };
  }
}
