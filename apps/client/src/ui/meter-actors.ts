/** Include the player once without reconstructing a Set of every combat participant each tick. */
export function* trackedMeterActors<T>(actors: ReadonlyMap<string, T>, player?: string): Iterable<string> {
  yield* actors.keys();
  if (player && !actors.has(player)) yield player;
}
