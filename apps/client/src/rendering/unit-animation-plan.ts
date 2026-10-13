export type UnitAnimationPlanInput = {
  dead: boolean; overrideAnimationId?: number; overrideKind?: string; gameObjectAnimationId?: number;
  airborne: boolean; turningLeft: boolean; turningRight: boolean; backpedaling: boolean;
  moving: boolean; running: boolean;
};

/** Choose the lower-body base and optional moving upper-body action independently. */
export function unitAnimationPlan(input: UnitAnimationPlanInput) {
  const locomotionAnimationId = input.dead ? 1
    : input.gameObjectAnimationId !== undefined ? input.gameObjectAnimationId
      : input.airborne ? 38
        : input.turningLeft ? 11
          : input.turningRight ? 12
            : input.backpedaling ? 13
              : input.moving ? (input.running ? 5 : 4) : 0;
  const animationId = !input.dead && input.overrideAnimationId !== undefined
    ? input.overrideAnimationId
    : locomotionAnimationId;
  const layeredUpperBody = !input.dead && input.moving
    && (input.overrideKind === 'reaction' || input.overrideKind === 'cast')
    && input.overrideAnimationId !== undefined;
  return { locomotionAnimationId, animationId, layeredUpperBody };
}
