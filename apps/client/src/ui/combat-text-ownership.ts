/**
 * Vanilla floating combat text belongs to the local player: outgoing player/pet effects and
 * effects landing on the player. Selecting a unit does not make other players' damage ours.
 */
export function ownsFloatingCombatText(
  playerGuid: string | undefined,
  petGuid: string | undefined,
  sourceGuid: string,
  targetGuid: string,
): boolean {
  return sourceGuid === playerGuid || (!!petGuid && sourceGuid === petGuid) || targetGuid === playerGuid;
}
