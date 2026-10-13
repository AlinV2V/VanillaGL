import { NAME_MAX_LENGTH } from './constants';

const NAMES_DB: Record<number, { prefixes: string[]; suffixes: string[] }> = {
  1: { // Human
    prefixes: ['Al', 'Ben', 'Dan', 'Ed', 'Fred', 'Gar', 'Hen', 'Jo', 'Ken', 'Leo', 'Mar', 'Ol', 'Phil', 'Ray', 'Sam', 'Tom', 'Val', 'Ad', 'Ro', 'Si', 'Ge'],
    suffixes: ['ald', 'ard', 'bert', 'dyn', 'gar', 'hard', 'land', 'mond', 'rick', 'son', 'ton', 'ward', 'ian', 'ius', 'us', 'an', 'el', 'ry'],
  },
  2: { // Orc
    prefixes: ['Gar', 'Grom', 'Kar', 'Mog', 'Naz', 'Org', 'Rax', 'Rok', 'Saur', 'Thr', 'Ugr', 'Var', 'Kro', 'Drek', 'Brox', 'Gol', 'Nazg', 'Thok'],
    suffixes: ['ak', 'ar', 'ok', 'osh', 'ogg', 'ug', 'ull', 'um', 'ur', 'gath', 'nak', 'rog', 'karr', 'gar'],
  },
  3: { // Dwarf
    prefixes: ['Bael', 'Bal', 'Dael', 'Dur', 'Gim', 'Glo', 'Khas', 'Mor', 'Mun', 'Thor', 'Thra', 'Harg', 'Brag', 'Furi', 'Karg', 'Thur', 'Grum'],
    suffixes: ['adin', 'brek', 'gar', 'grim', 'li', 'ni', 'or', 'ur', 'dred', 'mund', 'bold', 'drin', 'murd'],
  },
  4: { // Night Elf
    prefixes: ['Ala', 'Fela', 'Illi', 'Mala', 'Shala', 'Thala', 'Tyr', 'Vala', 'Ael', 'Cen', 'Kael', 'Sha', 'Tyl', 'Elu', 'Lys', 'Mal', 'Fand'],
    suffixes: ['an', 'and', 'andor', 'as', 'ath', 'il', 'is', 'on', 'or', 'aris', 'iel', 'ion', 'ore', 'aen', 'ara'],
  },
  5: { // Undead
    prefixes: ['Mor', 'Rot', 'Corp', 'Ske', 'Dea', 'Grin', 'Dust', 'Gloom', 'Crypt', 'Rave', 'Bone', 'Bli', 'Pla', 'Vile', 'Shad', 'Dread'],
    suffixes: ['idus', 'is', 'axt', 'or', 'ock', 'en', 'us', 'ard', 'gloom', 'rot', 'grave', 'chub', 'mort', 'stein'],
  },
  6: { // Tauren
    prefixes: ['Bov', 'Kar', 'Mul', 'Run', 'Sun', 'Thul', 'Tor', 'Ulu', 'Tahu', 'Hami', 'Kaa', 'Moo', 'Tag', 'Rin', 'Grom', 'Rah', 'Brav'],
    suffixes: ['hoof', 'horn', 'mane', 'runner', 'walker', 'wind', 'peak', 'hide', 'sky', 'totem', 'cloud', 'bull', 'horn'],
  },
  7: { // Gnome
    prefixes: ['Bin', 'Fiz', 'Glim', 'Link', 'Nip', 'Pip', 'Tink', 'Wrench', 'Sprock', 'Cog', 'Bolt', 'Gear', 'Giz', 'Pini', 'Mill', 'Tock'],
    suffixes: ['by', 'co', 'giz', 'lop', 'spink', 'sprocket', 'ton', 'well', 'spring', 'socket', 'plug', 'whirl', 'widget'],
  },
  8: { // Troll
    prefixes: ['Jin', 'Joju', 'Vol', 'Zek', 'Zul', 'Rasta', 'Sha', 'Taza', 'Sen', 'Rok', 'Ma', 'Jani', 'Zala', 'Taz', 'Zeb', 'Zab', 'Jak'],
    suffixes: ['jin', 'ji', 'kar', 'mo', 'ra', 'sa', 'fon', 'ziri', 'tah', 'kalar', 'zan', 'do', 'tul', 'mon'],
  },
};
/** Asset conversion utility. */
export function generateRandomName(race: number, _gender: number): string {
  const db = NAMES_DB[race] || NAMES_DB[1];
  const pre = db.prefixes[Math.floor(Math.random() * db.prefixes.length)];
  const suf = db.suffixes[Math.floor(Math.random() * db.suffixes.length)];

  const letters = (pre + suf).replace(/[^A-Za-z]/g, '').slice(0, NAME_MAX_LENGTH);
  return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase();
}
