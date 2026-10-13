/** Asset conversion utility. */
export const MOVEFLAG_FORWARD = 0x00000001;
export const MOVEFLAG_BACKWARD = 0x00000002;
export const MOVEFLAG_STRAFE_LEFT = 0x00000004;
export const MOVEFLAG_STRAFE_RIGHT = 0x00000008;
export const MOVEFLAG_TURN_LEFT = 0x00000010;
export const MOVEFLAG_TURN_RIGHT = 0x00000020;
export const MOVEFLAG_WALK_MODE = 0x00000100;
export const MOVEFLAG_ROOT = 0x00001000;
export const MOVEFLAG_MASK_XZ = 0x0000000f;

/** vmangos Unit.cpp:66-74 baseMoveSpeed[MOVE_TURN_RATE]. Used when the server hasn't sent speeds. */
export const DEFAULT_TURN_RATE = 3.141594;
/** vmangos Unit.cpp:3172 — turning while moving runs at 0.75x the in-place turn rate. */
export const MOVING_TURN_RATE_FACTOR = 0.75;

export type ExtrapolationSpeeds = {
  walk: number;
  run: number;
  runBack: number;
  turnRate?: number;
};

export type ExtrapolationInput = {
  /** Plane position carried by the last movement packet. */
  x: number;
  y: number;
  /** Yaw carried by the last movement packet. */
  o: number;
  flags: number;
  speeds: ExtrapolationSpeeds;
  /** Seconds elapsed since that packet, already clamped by the caller's prediction window. */
  ageSeconds: number;
};

export type ExtrapolationResult = {
  x: number;
  y: number;
  /** Yaw after integrating the turn keys. Equals the input yaw when no turn key is held. */
  o: number;
  /** True when the flags describe translation, i.e. x/y actually advanced. */
  moved: boolean;
};

/** Signed turn rate in rad/s for the held turn keys, or 0 when not turning (or turning both ways). */
export function turnRateFor(flags: number, speeds: ExtrapolationSpeeds): number {
  const left = (flags & MOVEFLAG_TURN_LEFT) !== 0;
  const right = (flags & MOVEFLAG_TURN_RIGHT) !== 0;
  if (left === right) return 0;
  // A realm that never sent SMSG_FORCE_TURN_RATE_CHANGE leaves this 0, which would silently
  // straighten every arc back out; treat anything non-positive as "unknown, use the base rate".
  const sent = speeds.turnRate;
  const base = sent !== undefined && sent > 0 ? sent : DEFAULT_TURN_RATE;
  const moving = (flags & MOVEFLAG_MASK_XZ) !== 0;
  const rate = moving ? base * MOVING_TURN_RATE_FACTOR : base;
  return left ? rate : -rate;
}

/**
 * Translation speed for the held keys, mirroring `MovementController.updateWalk`: reverse uses
 * runBack, walk mode uses walk, everything else runs. Diagonals do NOT stack — the mover
 * renormalises its direction, so a single scalar is correct.
 */
export function groundSpeedFor(flags: number, speeds: ExtrapolationSpeeds): number {
  // Root is authoritative even if a delayed observer packet still carries translation bits. The
  // mode packet and the following heartbeat can arrive in the same compressed batch, so stopping
  // here prevents one stale extrapolation frame from sliding a rooted unit.
  if ((flags & MOVEFLAG_ROOT) !== 0) return 0;
  const back = (flags & MOVEFLAG_BACKWARD) !== 0 && (flags & MOVEFLAG_FORWARD) === 0;
  if (back) return speeds.runBack;
  return (flags & MOVEFLAG_WALK_MODE) !== 0 ? speeds.walk : speeds.run;
}

/**
 * Unit travel direction for the held keys in the mover's own frame, before the world yaw is applied.
 * Forward is +x, strafe-left is +y. Returns null when no translation key is held.
 */
function localDirection(flags: number): { fx: number; fy: number } | null {
  let fx = 0;
  let fy = 0;
  if (flags & MOVEFLAG_FORWARD) fx += 1;
  if (flags & MOVEFLAG_BACKWARD) fx -= 1;
  // `right` is fwd x up = (sin o, -cos o), so strafing LEFT is the negative of it: +y in local frame.
  if (flags & MOVEFLAG_STRAFE_LEFT) fy += 1;
  if (flags & MOVEFLAG_STRAFE_RIGHT) fy -= 1;
  const len = Math.hypot(fx, fy);
  if (len === 0) return null;
  return { fx: fx / len, fy: fy / len };
}

/**
 * World-space direction the mover is actually travelling: the facing, plus the offset the strafe and
 * backpedal keys impose on it. W alone is the facing; W+Q is facing+45 degrees; S alone is
 * facing+180. Matches vmangos `Unit.cpp:3138-3152`, which applies the same offsets to `o` before
 * projecting a grounded mover.
 *
 * Returns null when no translation key is held, i.e. there is no travel direction to speak of.
 *
 * Both ends of the wire need this. The observer needs it to project the path; the mover needs it to
 * fill MSG_MOVE_JUMP's cosAngle/sinAngle, which are a VELOCITY direction rather than a facing —
 * vmangos `Unit.cpp:3163-3164` advances a jumper purely by those two floats and never consults the
 * facing or the movement flags, so a backwards jump that reports the facing there gets extrapolated
 * forwards. Sharing one definition is what keeps the two from drifting apart.
 */
export function travelAngleFor(o: number, flags: number): number | null {
  const dir = localDirection(flags);
  return dir ? o + Math.atan2(dir.fy, dir.fx) : null;
}

/**
 * Advance a mover's position and facing by `ageSeconds` of the motion its flags describe.
 *
 * Straight runs integrate to a line; turning runs integrate to a circular arc of radius
 * speed/omega, because the velocity vector rotates with the facing. Turning on the spot only
 * advances the yaw. Returns null when the input is unusable (non-finite yaw, zero/negative age).
 */
export function extrapolateGroundMovement(input: ExtrapolationInput): ExtrapolationResult | null {
  const { x, y, o, flags, speeds, ageSeconds } = input;
  if (!Number.isFinite(o) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const t = Math.max(0, ageSeconds);
  const omega = turnRateFor(flags, speeds);
  const dir = localDirection(flags);

  // Turning on the spot: yaw only. vmangos Unit.cpp:3193-3199 takes this branch when the mover
  // carries turn flags without MOVEFLAG_MASK_MOVING, and returns the position untouched.
  if (!dir) return { x, y, o: o + omega * t, moved: false };

  const speed = groundSpeedFor(flags, speeds);
  if (!Number.isFinite(speed) || speed <= 0) return { x, y, o: o + omega * t, moved: false };

  const travel = o + Math.atan2(dir.fy, dir.fx);

  if (omega === 0) {
    return {
      x: x + Math.cos(travel) * speed * t,
      y: y + Math.sin(travel) * speed * t,
      o,
      moved: true,
    };
  }

  // Constant speed with a constant yaw rate is a circle of radius speed/omega. Integrating
  // (cos, sin)(travel + omega*s) over s in [0, t] gives the chord below.
  const radius = speed / omega;
  const swept = omega * t;
  return {
    x: x + radius * (Math.sin(travel + swept) - Math.sin(travel)),
    y: y - radius * (Math.cos(travel + swept) - Math.cos(travel)),
    o: o + swept,
    moved: true,
  };
}
