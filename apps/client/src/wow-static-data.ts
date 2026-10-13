export const RACES: Record<number, string> = { 1: 'Human', 2: 'Orc', 3: 'Dwarf', 4: 'Night Elf', 5: 'Undead', 6: 'Tauren', 7: 'Gnome', 8: 'Troll' };
export const CLASSES: Record<number, string> = { 1: 'Warrior', 2: 'Paladin', 3: 'Hunter', 4: 'Rogue', 5: 'Priest', 7: 'Shaman', 8: 'Mage', 9: 'Warlock', 11: 'Druid' };
export const MAP_NAMES: Record<number, string> = { 0: 'Eastern Kingdoms', 1: 'Kalimdor', 249: "Onyxia's Lair" };

// Build 5875 Map.dbc/vMaNGOS raid maps. Visible creatures in these staged encounters retain
// full-rate skeleton sampling even across large boss rooms.
export const VANILLA_RAID_MAP_IDS = new Set([249, 309, 409, 469, 509, 531, 533]);
export const isVanillaRaidMap = (mapId: number) => VANILLA_RAID_MAP_IDS.has(mapId);
