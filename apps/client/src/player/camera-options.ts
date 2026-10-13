/** Asset conversion utility. */
import type { InterfaceCvars } from '../ui/interface-cvars';


export const CAMERA_PITCH_LIMIT_RAD = 1.553343;

/** `DAT_008089a8` = `0x00000000`. Zoom-in floor: the client dollies all the way to first person. */
export const CAMERA_DISTANCE_MIN = 0;

export const CAMERA_DISTANCE_MAX = 15;
/** `DAT_008089a4` = `0x42480000` = 50.0 — the cap `cameraDistanceMaxFactor` can never exceed. */
export const CAMERA_DISTANCE_HARD_CAP = 50;


export const CAMERA_NEAR_CLIP = 0.1;

/**
 * Yards the collision result is pulled back by once something is hit.
 * `_DAT_00808a00` = `0x3de38e39` = 0.11111111 (and `_DAT_00808a04`, the height axis, is the same).
 */
export const CAMERA_COLLISION_SKIN = 0.11111111;


export const CAMERA_FIRST_PERSON_DISTANCE = CAMERA_NEAR_CLIP;


export const CAMERA_PIVOT_DX_MAX = 0.05;
export const CAMERA_PIVOT_DY_MIN = 0;

export type SmartPivotInput = {
  /** Lift banked so far, yards. */
  lift: number;
  /** Change in orbit elevation this frame; negative while dragging the camera down. */
  pitchDelta: number;
  /** Change in orbit azimuth this frame. */
  yawDelta: number;
  /** Current orbit elevation; the client gates on `pitch <= 0`. */
  elevation: number;
  /** `cameraPivot` cvar. */
  pivotEnabled: boolean;
  /** The client requires `movementFlags & 0xf` to be clear — Smart Pivot is a standing behaviour. */
  moving: boolean;
  /** Whether collision actually shortened the camera this frame (`camera->flags & 0x30000`). */
  blocked: boolean;
};

/**
 * One frame of Smart Pivot, returning the new banked lift in yards.
 *
 * Once lift has been banked the drag keeps being spent on it even after the gate stops passing,
 * so that dragging back up unwinds the lift smoothly instead of stranding the camera in the air —
 * the client gets the same result from `if (camera->0x104 <= 0)` dropping the channel only when it
 * has been fully paid back.
 */
export function advanceSmartPivot(input: SmartPivotInput): number {
  const engaged =
    input.pivotEnabled &&
    !input.moving &&
    input.elevation <= 0 &&
    input.blocked &&
    Math.abs(input.pitchDelta) > CAMERA_PIVOT_DY_MIN &&
    Math.abs(input.yawDelta) < CAMERA_PIVOT_DX_MAX;
  if (!engaged && !(input.lift > 0)) return 0;
  const next = input.lift - input.pitchDelta;
  return next > 0 ? next : 0;
}


export const CAMERA_PIVOT_ATTACHMENT_ID = 17;
export const CAMERA_PIVOT_ATTACHMENT_BIAS = 0.097222224;
export const CAMERA_PIVOT_BBOX_FACTOR = 0.9;

/**
 * Height used before a character model has loaded. Not a client constant — the client always has a
 * model to measure. Sits between the shortest (gnome, 0.88) and tallest (night elf, 2.29) figures
 * this module returns, so a missing model never throws the camera to an extreme.
 */
export const CAMERA_PIVOT_FALLBACK_HEIGHT = 1.6;

type AttachmentLike = { id: number; position: readonly number[] };


export function cameraPivotHeight(
  model: { attachments?: readonly AttachmentLike[]; positions?: ArrayLike<number> } | undefined,
  scale = 1,
): number {
  if (!model) return CAMERA_PIVOT_FALLBACK_HEIGHT;
  const attachment = model.attachments?.find((entry) => entry.id === CAMERA_PIVOT_ATTACHMENT_ID);
  const attachmentZ = attachment?.position?.[2];
  if (Number.isFinite(attachmentZ)) {
    return ((attachmentZ as number) + CAMERA_PIVOT_ATTACHMENT_BIAS) * scale;
  }
  const positions = model.positions;
  if (positions && positions.length >= 3) {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 2; i < positions.length; i += 3) {
      const z = positions[i];
      if (z < min) min = z;
      if (z > max) max = z;
    }
    if (Number.isFinite(min) && Number.isFinite(max)) {
      return (max - min) * scale * CAMERA_PIVOT_BBOX_FACTOR;
    }
  }
  return CAMERA_PIVOT_FALLBACK_HEIGHT;
}

/**
 * Orbit polar limits, in OrbitControls' convention (0 = directly above the target).
 *
 * The client stores an elevation clamped to ±`CAMERA_PITCH_LIMIT_RAD`; polar is its complement,
 * so the usable band is 1°..179° — the camera really can drop to ground level and sight straight up.
 */
export function cameraPolarLimits(): { min: number; max: number } {
  return {
    min: Math.PI / 2 - CAMERA_PITCH_LIMIT_RAD,
    max: Math.PI / 2 + CAMERA_PITCH_LIMIT_RAD,
  };
}


export function cameraMaxDistance(cvars: Pick<InterfaceCvars, 'cameraDistanceMaxFactor'>): number {
  const factor = Number(cvars.cameraDistanceMaxFactor);
  const wanted = CAMERA_DISTANCE_MAX * (Number.isFinite(factor) && factor > 0 ? factor : 1);
  return Math.max(CAMERA_DISTANCE_MIN, Math.min(CAMERA_DISTANCE_HARD_CAP, wanted));
}
