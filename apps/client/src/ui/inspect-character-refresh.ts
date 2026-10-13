import type { CharacterInfo } from '../world';

type Listener = (character: CharacterInfo) => void;
const listeners = new Set<Listener>();

/** Appearance/equipment identity for the inspect model's async reload guard. */
export function inspectCharacterModelKey(character: CharacterInfo): string {
  return [
    character.guid,
    character.race,
    character.gender,
    character.skin,
    character.face,
    character.hairStyle,
    character.hairColor,
    character.facialHair,
    ...(character.equipment ?? []).map((item) => (
      `${item.slot ?? ''}:${item.displayInfoId}:${item.inventoryType}:${item.sheath ?? ''}`
    )),
  ].join(':');
}

/** Publish a resolved remote appearance without coupling the renderer to the inspect panel. */
export function publishRemoteCharacter(character: CharacterInfo) {
  for (const listener of listeners) listener(character);
}

export function onRemoteCharacter(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
