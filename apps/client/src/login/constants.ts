export const RACES: Record<number, string> = {
  1: 'Human',
  2: 'Orc',
  3: 'Dwarf',
  4: 'Night Elf',
  5: 'Undead',
  6: 'Tauren',
  7: 'Gnome',
  8: 'Troll',
};

export const CLASSES: Record<number, string> = {
  1: 'Warrior',
  2: 'Paladin',
  3: 'Hunter',
  4: 'Rogue',
  5: 'Priest',
  7: 'Shaman',
  8: 'Mage',
  9: 'Warlock',
  11: 'Druid',
};

export const MAP_NAMES: Record<number, string> = {
  0: 'Eastern Kingdoms',
  1: 'Kalimdor',
};

// Vanilla WoW 1.12.1 exact playable combos
export const RACE_CLASS_MATRIX: Record<number, number[]> = {
  1: [1, 2, 4, 5, 8, 9],     // Human: Warrior, Paladin, Rogue, Priest, Mage, Warlock
  2: [1, 3, 4, 7, 9],        // Orc: Warrior, Hunter, Rogue, Shaman, Warlock
  3: [1, 2, 3, 4, 5],        // Dwarf: Warrior, Paladin, Hunter, Rogue, Priest
  4: [1, 3, 4, 5, 11],       // Night Elf: Warrior, Hunter, Rogue, Priest, Druid
  5: [1, 4, 5, 8, 9],        // Undead: Warrior, Rogue, Priest, Mage, Warlock
  6: [1, 3, 7, 11],          // Tauren: Warrior, Hunter, Shaman, Druid
  7: [1, 4, 8, 9],           // Gnome: Warrior, Rogue, Mage, Warlock
  8: [1, 3, 4, 5, 7, 8],     // Troll: Warrior, Hunter, Rogue, Priest, Shaman, Mage
};

export type CustomizationConfig = {
  skin: number;
  face: number;
  hairStyle: number;
  hairColor: number;
  facialHair: number;
  facialHairName: string;
};

// Variation counts derived from OUR client's baked CharSections/CharHairGeosets/
// CharacterFacialHairStyles data (public/characters/<race>_<gender>/model.json appearance block) —
// not hand-copied from docs. Every race/gender has a 5th selector in vanilla; the female ones are
// geoset-only jewelry/tusks (no texture overlay), which the renderer already supports.
export const CUSTOMIZATION_SLOTS: Record<string, CustomizationConfig> = {
  '1_0': { skin: 10, face: 12, hairStyle: 12, hairColor: 10, facialHair: 9, facialHairName: 'Facial Hair' },
  '1_1': { skin: 10, face: 15, hairStyle: 19, hairColor: 10, facialHair: 7, facialHairName: 'Piercings' },
  '2_0': { skin: 9, face: 9, hairStyle: 7, hairColor: 8, facialHair: 11, facialHairName: 'Facial Hair' },
  '2_1': { skin: 9, face: 9, hairStyle: 7, hairColor: 8, facialHair: 7, facialHairName: 'Piercings' },
  '3_0': { skin: 10, face: 10, hairStyle: 11, hairColor: 10, facialHair: 11, facialHairName: 'Beard' },
  '3_1': { skin: 9, face: 10, hairStyle: 14, hairColor: 10, facialHair: 6, facialHairName: 'Piercings' },
  '4_0': { skin: 9, face: 9, hairStyle: 7, hairColor: 8, facialHair: 6, facialHairName: 'Facial Hair' },
  '4_1': { skin: 9, face: 9, hairStyle: 7, hairColor: 8, facialHair: 10, facialHairName: 'Markings' },
  '5_0': { skin: 6, face: 10, hairStyle: 10, hairColor: 10, facialHair: 17, facialHairName: 'Features' },
  '5_1': { skin: 6, face: 10, hairStyle: 10, hairColor: 10, facialHair: 8, facialHairName: 'Features' },
  '6_0': { skin: 19, face: 5, hairStyle: 8, hairColor: 3, facialHair: 7, facialHairName: 'Facial Feature' },
  '6_1': { skin: 11, face: 4, hairStyle: 7, hairColor: 3, facialHair: 5, facialHairName: 'Horns' },
  '7_0': { skin: 5, face: 7, hairStyle: 7, hairColor: 9, facialHair: 8, facialHairName: 'Facial Hair' },
  '7_1': { skin: 5, face: 7, hairStyle: 7, hairColor: 9, facialHair: 7, facialHairName: 'Earrings' },
  '8_0': { skin: 9, face: 5, hairStyle: 6, hairColor: 10, facialHair: 11, facialHairName: 'Tusks' },
  '8_1': { skin: 9, face: 6, hairStyle: 5, hairColor: 10, facialHair: 6, facialHairName: 'Tusks' },
};

export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 12;
export const NAME_PATTERN = /^[A-Z][a-z]+$/; // Capitalized, alphabetic only

export function validateCharacterName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < NAME_MIN_LENGTH) return 'Name is too short.';
  if (trimmed.length > NAME_MAX_LENGTH) return 'Name is too long.';
  if (!NAME_PATTERN.test(trimmed)) {
    return 'Name must start with a capital letter and contain only letters.';
  }
  return null;
}
