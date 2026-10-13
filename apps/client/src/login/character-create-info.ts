import { CLASSES, RACES } from './constants';

type CharacterCreateInfo = {
  faction: 'alliance' | 'horde';
  factionName: string;
  factionText: string;
  raceText: string;
  abilities: string[];
};

const INFO: Record<number, CharacterCreateInfo> = {
  1: {
    faction: 'alliance',
    factionName: 'Alliance',
    factionText: 'The Alliance consists of four races: the noble humans, the adventurous dwarves, the enigmatic night elves, and the ingenious gnomes. Bound by a loathing for all things demonic, they fight to restore order in this war-torn world.',
    raceText: 'Humans are a young race, and thus highly versatile, mastering the arts of combat, craftsmanship, and magic with stunning efficiency. The humans’ valor and optimism have led them to build some of the world’s greatest kingdoms. In this troubled era, after generations of conflict, humanity seeks to rekindle its former glory and forge a shining new future.',
    abilities: ['Stealth detection increased.', 'Increased Spirit.', 'Bonus to reputation gains.', 'Skill with Swords and Maces increased.'],
  },
  2: {
    faction: 'horde',
    factionName: 'Horde',
    factionText: 'Four races comprise the Horde: the brutal orcs, the shadowy undead, the spiritual tauren, and the quick-witted trolls. Beset by enemies on all sides, these outcasts have forged a union they hope will ensure their mutual survival.',
    raceText: 'The orc race originated on the planet Draenor. A peaceful people with shamanic beliefs, they were enslaved by the Burning Legion and forced into war with the humans of Azeroth. Although it took many years, the orcs finally escaped the demons’ corruption and won their freedom. To this day they fight for honor in an alien world that hates and reviles them.',
    abilities: ['May enrage, increasing strength at the cost of health.', 'Resistant to stun and knockout effects.', 'Damage done by pets increased.', 'Skill with Axes increased.'],
  },
  3: {
    faction: 'alliance',
    factionName: 'Alliance',
    factionText: 'The Alliance consists of four races: the noble humans, the adventurous dwarves, the enigmatic night elves, and the ingenious gnomes. Bound by a loathing for all things demonic, they fight to restore order in this war-torn world.',
    raceText: 'In ages past the dwarves cared only for riches taken from the earth’s depths. Then records surfaced of a god-like race said to have given the dwarves life... and an enchanted birthright. Driven to learn more, the dwarves devoted themselves to the pursuit of lost artifacts and ancient knowledge. Today dwarven archaeologists are scattered throughout the globe.',
    abilities: ['May take on a stone form.', 'Skill with Guns increased.', 'Resistant to Frost.', 'Treasure finding.'],
  },
  4: {
    faction: 'alliance',
    factionName: 'Alliance',
    factionText: 'The Alliance consists of four races: the noble humans, the adventurous dwarves, the enigmatic night elves, and the ingenious gnomes. Bound by a loathing for all things demonic, they fight to restore order in this war-torn world.',
    raceText: 'Ten thousand years ago, the night elves founded a vast empire, but their reckless use of primal magic brought them to ruin. In grief, they withdrew to the forests and remained isolated there until the return of their ancient enemy, the Burning Legion. With no other choice, the night elves emerged at last from their seclusion to fight for their place in the new world.',
    abilities: ['May fade into the shadows.', 'Dodge chance increased.', 'Wisp form while dead.', 'Resistant to Nature damage.'],
  },
  5: {
    faction: 'horde',
    factionName: 'Horde',
    factionText: 'Four races comprise the Horde: the brutal orcs, the shadowy undead, the spiritual tauren, and the quick-witted trolls. Beset by enemies on all sides, these outcasts have forged a union they hope will ensure their mutual survival.',
    raceText: 'Free of the Lich King’s grasp, the Forsaken seek to overthrow his rule. Led by the banshee Sylvanas, they hunger for vengeance against the Scourge. Humans, too, have become the enemy, relentless in their drive to purge all undead from the land. The Forsaken care little even for their allies; to them the Horde is merely a tool that may further their dark schemes.',
    abilities: ['May become immune to fear, sleep, and charm.', 'May consume corpses to regain health.', 'Underwater breathing increased.', 'Resistant to Shadow damage.'],
  },
  6: {
    faction: 'horde',
    factionName: 'Horde',
    factionText: 'Four races comprise the Horde: the brutal orcs, the shadowy undead, the spiritual tauren, and the quick-witted trolls. Beset by enemies on all sides, these outcasts have forged a union they hope will ensure their mutual survival.',
    raceText: 'Always the tauren strive to preserve the balance of nature and heed the will of their goddess, the Earth Mother. Recently attacked by murderous centaur, the tauren would have been wiped out, save for a chance encounter with the orcs, who helped defeat the interlopers. To honor this blood-debt, the tauren joined the Horde, solidifying the two races’ friendship.',
    abilities: ['May stomp, stunning nearby opponents.', 'Maximum health increased.', 'Herbalism skill increased.', 'Resistant to Nature damage.'],
  },
  7: {
    faction: 'alliance',
    factionName: 'Alliance',
    factionText: 'The Alliance consists of four races: the noble humans, the adventurous dwarves, the enigmatic night elves, and the ingenious gnomes. Bound by a loathing for all things demonic, they fight to restore order in this war-torn world.',
    raceText: 'Though small in stature, the gnomes of Khaz Modan have used their great intellect to secure a place in history. Indeed, their subterranean kingdom, Gnomeregan, was once a marvel of steam-driven technology. Even so, due to a massive trogg invasion, the city was lost. Now its builders are vagabonds in the dwarven lands, aiding their allies as best they can.',
    abilities: ['May escape from speed altering effects.', 'Increased Intelligence.', 'Resistant to Arcane damage.', 'Engineering skill increased.'],
  },
  8: {
    faction: 'horde',
    factionName: 'Horde',
    factionText: 'Four races comprise the Horde: the brutal orcs, the shadowy undead, the spiritual tauren, and the quick-witted trolls. Beset by enemies on all sides, these outcasts have forged a union they hope will ensure their mutual survival.',
    raceText: 'Once at home in the jungles of Stranglethorn Vale, the fierce trolls of the Darkspear tribe were pushed out by warring factions. Eventually the trolls befriended the orcish Horde, and Thrall, the orcs’ young warchief, convinced the trolls to travel with him to Kalimdor. Though they cling to their shadowy heritage, the Darkspear trolls hold a place of honor in the Horde.',
    abilities: ['Berserk when wounded, increasing attack and casting speed.', 'Regeneration increased.', 'Damage increased versus beasts.', 'Throwing Weapon skill increased.'],
  },
};

const CLASS_TEXT: Record<number, string> = {
  1: 'Warriors train constantly and strive for perfection in armed combat. Though they come from all walks of life, they are united by their singular commitment to engage in glorious battle. Many warriors serve as mercenary soldiers, while others become adventurers and danger-seeking fortune hunters. A typical warrior is strong, tough, and exceptionally violent.',
  2: 'Paladins do battle to protect the world from the forces of shadow. Powerful warriors in their own right, they can also call upon the Light to heal wounds, create shields of force, and incinerate evil creatures. Although paladins were once exclusively human, a number of stout-hearted dwarves have recently been welcomed into the Order of the Silver Hand.',
  3: 'Hunters know the uncharted places of the world. Gifted with a deep empathy for all life, they have an uncanny knack for befriending wild animals and taming them as pets. In addition, hunters can use their finely honed senses to become master trackers. Wherever hunters go, they fight back the ravages of sickness, exploitation, and industrialization.',
  4: 'Rogues are most successful when their deeds never come to light. Fond of poisons and silent projectile weapons, rogues rely on a blend of stealth and minor mysticism. Usually in the employ of rich nobles or local governments, the rogue redistributes wealth or eliminates designated targets. A rogue’s allegiance lasts only as long as the latest contract.',
  5: 'Priests guide the spiritual destiny of their people. Through their unique insight into the mind, they are able to shape an individual’s beliefs, whether to inspire or terrify, soothe or dominate, heal or harm. Just as the heart can hold both darkness and light, priests wield powers of creation and devastation by channeling the potent forces underlying faith.',
  7: 'Shaman commune directly with the elements. Their combination of wisdom and resilience makes them ideal as tribal advisors and leaders. In battle the shaman use totems and spells to manipulate the elements and provoke other fighters to untold heights of rage and might. Shaman exemplify the primal bond between the savage races and their environment.',
  8: 'Magi are wizards of immense knowledge and skill. Their obvious physical frailty is deceptive, for they can call upon the cosmic energies of the Twisting Nether. Rarely do magi engage in melee combat. Instead, they prefer to attack from a distance, hurling powerful bolts of frost and flame at their unsuspecting enemies.',
  9: 'Warlocks are the bane of all life. Empowered by demonic blood, they can inflict great torment upon their foes. To replenish the dreadful energy their spells expend, warlocks drain vitality from their victims. The warlock can also summon and control terrifying demonic entities. Still, warlocks are feared above all else for their singular wickedness and cruelty.',
  11: 'Druids live in a state of unparalleled union with nature. Tightly bound to the plant and animal kingdoms, they are natural shapeshifters, and so they know firsthand the abuse visited on their wild brethren. In consequence, despite their numbers, druids tend to be wary, reclusive, and difficult to spot. Few outsiders have plumbed the depths of their secrets.',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function raceIconPosition(race: number, gender: number): string {
  const alliance = [1, 3, 7, 4];
  const horde = [6, 5, 8, 2];
  const factionRaces = alliance.includes(race) ? alliance : horde;
  const column = Math.max(0, factionRaces.indexOf(race));
  const row = alliance.includes(race) ? (gender ? 2 : 0) : (gender ? 3 : 1);
  return `${(column / 3) * 100}% ${(row / 3) * 100}%`;
}

function classIconPosition(classId: number): string {
  const positions: Record<number, [number, number]> = {
    1: [0, 0], 8: [1, 0], 4: [2, 0], 11: [3, 0],
    3: [0, 1], 7: [1, 1], 5: [2, 1], 9: [3, 1], 2: [0, 2],
  };
  const [column, row] = positions[classId] ?? [0, 0];
  return `${(column / 3) * 100}% ${(row / 3) * 100}%`;
}

function panel(title: string, body: string, iconClass: string, iconStyle: string, extra = ''): string {
  return `
    <section class="glue-create-info-panel ${extra}">
      <div class="glue-create-info-heading">
        <span class="glue-create-info-icon ${iconClass}" style="background-position:${iconStyle}" aria-hidden="true"></span>
        <h2>${escapeHtml(title)}</h2>
      </div>
      <div class="glue-create-info-body">${body}</div>
    </section>`;
}

/** Render the three tooltip panels shown by CharacterCreate.xml. */
export function renderCharacterCreateInfo(race: number, classId: number, gender: number): string {
  const info = INFO[race] ?? INFO[1];
  const raceName = RACES[race] ?? 'Human';
  const className = CLASSES[classId] ?? 'Warrior';
  const raceBody = `${escapeHtml(info.raceText)}<div class="glue-create-info-abilities">${info.abilities.map((ability) => `<div>- ${escapeHtml(ability)}</div>`).join('')}</div>`;
  const classBody = escapeHtml(CLASS_TEXT[classId] ?? CLASS_TEXT[1]);
  return `<aside class="glue-create-info-panels">
    ${panel(info.factionName, escapeHtml(info.factionText), 'glue-create-faction-icon', info.faction === 'alliance' ? '0% 0%' : '100% 0%', info.faction)}
    ${panel(raceName, raceBody, 'glue-create-race-info-icon', raceIconPosition(race, gender), 'race')}
    ${panel(className, classBody, 'glue-create-class-info-icon', classIconPosition(classId), 'class')}
  </aside>`;
}
