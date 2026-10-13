import type { PlayerAnimState } from '../model-loader';

type Point = { x: number; y: number };

/** Stateful implementation of FrameXML FollowByName's continuous forward movement. */
export class UnitFollowController {
  private guid?: string;
  followingForward = false;

  constructor() {
    window.addEventListener('wow-follow-unit', (event) => {
      const guid = (event as CustomEvent<{ guid?: string }>).detail?.guid;
      if (guid) this.guid = guid;
    });
  }

  cancel() {
    this.guid = undefined;
    this.followingForward = false;
  }

  travelAngle(
    origin: Point,
    locked: boolean,
    manualTranslation: boolean,
    resolve: (guid: string) => Point | undefined,
  ): number | undefined {
    this.followingForward = false;
    if (manualTranslation) this.guid = undefined;
    if (locked || !this.guid) return undefined;
    const target = resolve(this.guid);
    if (!target) { this.guid = undefined; return undefined; }
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;
    if (Math.hypot(dx, dy) <= 3) return undefined;
    this.followingForward = true;
    return Math.atan2(dy, dx);
  }
}

export function groundLocomotionState(input: {
  moving: boolean;
  strafeLeft: boolean;
  strafeRight: boolean;
  backward: boolean;
  forward: boolean;
  walking: boolean;
}): PlayerAnimState {
  if (!input.moving) return 'stand';
  if (input.strafeLeft) return 'strafeLeft';
  if (input.strafeRight) return 'strafeRight';
  if (input.backward && !input.forward) return 'walkBack';
  return input.walking ? 'walk' : 'run';
}

export function cameraBobProfile(state: PlayerAnimState): { rate: number; amplitude: number } | undefined {
  if (state === 'walk') return { rate: 5.5, amplitude: 0.03 };
  if (state === 'run' || state === 'strafeLeft' || state === 'strafeRight') return { rate: 9.5, amplitude: 0.055 };
  return undefined;
}
