export type MovementRestrictions = {
  translationLocked: boolean;
  turningLocked: boolean;
  jumpingLocked: boolean;
};
/** Asset conversion utility. */
export function movementRestrictions(
  deathLocked: boolean,
  serverRooted: boolean,
  stunned: boolean,
): MovementRestrictions {
  const translationLocked = deathLocked || serverRooted || stunned;
  return {
    translationLocked,
    turningLocked: deathLocked || stunned,
    jumpingLocked: translationLocked,
  };
}
