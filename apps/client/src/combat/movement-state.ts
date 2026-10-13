export type UnitSpeedsState = {
  walk: number;
  run: number;
  runBack: number;
  swim: number;
  swimBack: number;
  turnRate: number;
};

export type UnitSpeedStateKind = keyof UnitSpeedsState;

export type UnitMovementModeState = {
  flags?: number;
  speeds?: UnitSpeedsState;
  rooted?: boolean;
  waterWalking?: boolean;
  featherFalling?: boolean;
  hovering?: boolean;
  running?: boolean;
};

const MOVEMENTFLAG_WALK_MODE = 0x00000100;
const MOVEMENTFLAG_ROOT = 0x00001000;
const MOVEMENTFLAG_WATERWALKING = 0x10000000;
const MOVEMENTFLAG_SAFE_FALL = 0x20000000;
const MOVEMENTFLAG_HOVER = 0x40000000;

export const DEFAULT_UNIT_SPEED_STATE: Readonly<UnitSpeedsState> = {
  walk: 2.5,
  run: 7,
  runBack: 4.5,
  swim: 4.722222,
  swimBack: 2.5,
  turnRate: Math.PI,
};

export function applyUnitSpeedState(
  state: UnitMovementModeState,
  kind: UnitSpeedStateKind,
  speed: number,
) {
  let speeds = state.speeds;
  if (!speeds) {
    speeds = {
      walk: DEFAULT_UNIT_SPEED_STATE.walk,
      run: DEFAULT_UNIT_SPEED_STATE.run,
      runBack: DEFAULT_UNIT_SPEED_STATE.runBack,
      swim: DEFAULT_UNIT_SPEED_STATE.swim,
      swimBack: DEFAULT_UNIT_SPEED_STATE.swimBack,
      turnRate: DEFAULT_UNIT_SPEED_STATE.turnRate,
    };
    state.speeds = speeds;
  }
  speeds[kind] = speed;
}

export function applyUnitMovementModeState(
  state: UnitMovementModeState,
  patch: Partial<Pick<
    UnitMovementModeState,
    'rooted' | 'waterWalking' | 'featherFalling' | 'hovering' | 'running'
  >>,
) {
  if (patch.rooted !== undefined) state.rooted = patch.rooted;
  if (patch.waterWalking !== undefined) state.waterWalking = patch.waterWalking;
  if (patch.featherFalling !== undefined) state.featherFalling = patch.featherFalling;
  if (patch.hovering !== undefined) state.hovering = patch.hovering;
  if (patch.running !== undefined) state.running = patch.running;

  let flags = state.flags ?? 0;
  if (patch.rooted !== undefined) flags = patch.rooted ? flags | MOVEMENTFLAG_ROOT : flags & ~MOVEMENTFLAG_ROOT;
  if (patch.waterWalking !== undefined) {
    flags = patch.waterWalking ? flags | MOVEMENTFLAG_WATERWALKING : flags & ~MOVEMENTFLAG_WATERWALKING;
  }
  if (patch.featherFalling !== undefined) {
    flags = patch.featherFalling ? flags | MOVEMENTFLAG_SAFE_FALL : flags & ~MOVEMENTFLAG_SAFE_FALL;
  }
  if (patch.hovering !== undefined) flags = patch.hovering ? flags | MOVEMENTFLAG_HOVER : flags & ~MOVEMENTFLAG_HOVER;
  if (patch.running !== undefined) flags = patch.running ? flags & ~MOVEMENTFLAG_WALK_MODE : flags | MOVEMENTFLAG_WALK_MODE;
  state.flags = flags >>> 0;
}
