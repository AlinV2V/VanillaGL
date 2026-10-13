import type { CharacterInfo, HonorSnapshot, PetSnapshot, RealmWorldClient, ReputationSnapshot, SkillSnapshot } from '../world';
import { FACTIONS_BY_REPUTATION_INDEX } from '../data/factions';
import { SKILL_CATEGORIES, SKILL_LINES } from '../data/skill-lines';
import type { CharTab } from './ingame-hud-elements';
import type { CharacterFrameCanvasViewModel, CharacterSubpageView } from './character-frame-canvas';

const ALLIANCE_HONOR_RANKS = [
  'No Rank', 'Private', 'Corporal', 'Sergeant', 'Master Sergeant', 'Sergeant Major', 'Knight',
  'Knight-Lieutenant', 'Knight-Captain', 'Knight-Champion', 'Lieutenant Commander', 'Commander',
  'Marshal', 'Field Marshal', 'Grand Marshal',
];

const HORDE_HONOR_RANKS = [
  'No Rank', 'Scout', 'Grunt', 'Sergeant', 'Senior Sergeant', 'First Sergeant', 'Stone Guard',
  'Blood Guard', 'Legionnaire', 'Centurion', 'Champion', 'Lieutenant General', 'General',
  'Warlord', 'High Warlord',
];

const petHappinessName = (level?: number) => ({ 1: 'Unhappy', 2: 'Content', 3: 'Happy' })[level ?? 0] ?? 'Unknown';
const petReactName = (state?: number) => ({ 0: 'Passive', 1: 'Defensive', 2: 'Aggressive' })[state ?? -1] ?? `React ${state ?? 0}`;
const petCommandName = (state?: number) => ({ 0: 'Stay', 1: 'Follow', 2: 'Attack', 3: 'Dismiss' })[state ?? -1] ?? `Command ${state ?? 0}`;

const CHAR_TABS: CharTab[] = ['character', 'pet', 'reputation', 'skills', 'honor'];

export class CharacterTabsController {
  private currentTab: CharTab = 'character';

  constructor(private readonly deps: {
    characterFrame: HTMLElement;
    characterTabButtons: HTMLButtonElement[];
    charPages: Record<CharTab, HTMLElement>;
    getWorld: () => RealmWorldClient | undefined;
    getCurrentCharacter: () => CharacterInfo | undefined;
    getPet: () => PetSnapshot | undefined;
    getReputation: () => ReputationSnapshot | undefined;
    getSkills: () => SkillSnapshot | undefined;
    getHonor: () => HonorSnapshot | undefined;
    escapeHtml: (value: string) => string;
    onTabRequested?: (tab: CharTab) => void;
  }) {
    for (const button of deps.characterTabButtons) {
      button.addEventListener('click', () => {
        const tab = (button.dataset.charTab as CharTab) ?? 'character';
        if (deps.onTabRequested) deps.onTabRequested(tab);
        else this.setTab(tab);
      });
    }
    deps.charPages.reputation.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-rep-action][data-rep-id]');
      const world = deps.getWorld();
      if (!button || !world) return;
      const reputationListId = Number(button.dataset.repId);
      if (!Number.isFinite(reputationListId)) return;
      const faction = (deps.getReputation() ?? world.getReputation()).factions.find((row) => row.reputationListId === reputationListId);
      if (button.dataset.repAction === 'watch') world.setWatchedFaction(faction?.watched ? null : reputationListId);
      else if (button.dataset.repAction === 'war') world.setFactionAtWar(reputationListId, !faction?.atWar);
      else if (button.dataset.repAction === 'inactive') world.setFactionInactive(reputationListId, !faction?.inactive);
    });
    this.renderAll();
  }

  getCurrentTab() {
    return this.currentTab;
  }

  setTab(tab: CharTab) {
    this.currentTab = tab;
    for (const button of this.deps.characterTabButtons) button.classList.toggle('is-active', button.dataset.charTab === tab);
    for (const name of CHAR_TABS) this.deps.charPages[name].classList.toggle('is-active', name === tab);
    for (const name of CHAR_TABS) this.deps.characterFrame.classList.toggle(`tab-${name}`, name === tab);
  }

  renderAll() {
    this.renderPet();
    this.renderReputation();
    this.renderSkills();
    this.renderHonor();
  }

  renderPet(snapshot = this.deps.getPet()) {
    this.deps.charPages.pet.innerHTML = this.renderPetPage(snapshot);
  }

  renderReputation(snapshot = this.deps.getReputation()) {
    this.deps.charPages.reputation.innerHTML = this.renderReputationPage(snapshot);
  }

  renderSkills(snapshot = this.deps.getSkills()) {
    this.deps.charPages.skills.innerHTML = this.renderSkillsPage(snapshot);
  }

  renderHonor(snapshot = this.deps.getHonor()) {
    this.deps.charPages.honor.innerHTML = this.renderHonorPage(snapshot);
  }

  /** Data-only representation consumed by the native canvas CharacterFrame. */
  getCanvasPages(): CharacterFrameCanvasViewModel['pages'] {
    const pet = this.deps.getPet();
    const reputation = this.deps.getReputation();
    const skills = this.deps.getSkills();
    const honor = this.deps.getHonor();

    const petPage: CharacterSubpageView = !pet?.guid ? {
      heading: 'Pet', emptyText: 'You do not have a pet.',
    } : {
      heading: 'Pet',
      sections: [
        {
          rows: [
            { label: 'Name', value: pet.name ?? (pet.petNumber ? `Pet #${pet.petNumber}` : 'Loading') },
            { label: 'Level', value: pet.level ?? '?' },
            { label: 'Health', value: `${pet.health ?? 0}/${pet.maxHealth ?? 0}` },
            { label: 'Happiness', value: petHappinessName(pet.happinessLevel) },
            { label: 'Loyalty', value: pet.loyaltyName ?? 'N/A' },
            { label: 'Experience', value: `${pet.experience ?? 0}/${Math.max(1, pet.nextLevelExperience ?? 0)}` },
            { label: 'Reaction', value: petReactName(pet.spellState?.reactState) },
            { label: 'Command', value: petCommandName(pet.spellState?.commandState) },
          ],
        },
        {
          title: 'Pet Action Bar',
          rows: (pet.spellState?.actions ?? [])
            .filter((action) => action.packed !== 0 && action.action !== 0)
            .map((action) => ({ label: `Slot ${action.slot + 1}`, value: `${action.action} / 0x${action.activeState.toString(16)}` })),
        },
      ],
    };

    const reputationPage: CharacterSubpageView = !reputation?.factions.length ? {
      heading: 'Reputation', emptyText: 'No reputation data to display.',
    } : {
      heading: 'Reputation',
      sections: reputation.factions.map((faction) => ({
        title: `${FACTIONS_BY_REPUTATION_INDEX[faction.reputationListId]?.name ?? `Faction ${faction.reputationListId}`}${faction.watched ? ' *' : ''}`,
        rows: [
          { label: faction.rankName, value: `${faction.valueInRank}/${faction.pointsInRank}` },
          { label: 'Standing', value: faction.standing },
          { label: 'Status', value: [faction.atWar ? 'At War' : '', faction.inactive ? 'Inactive' : ''].filter(Boolean).join(', ') || 'Active' },
        ],
      })),
    };

    const skillRows = [...(skills?.skills ?? [])]
      .sort((a, b) => {
        const ma = SKILL_LINES[a.skillId];
        const mb = SKILL_LINES[b.skillId];
        return (ma?.categoryId ?? 99) - (mb?.categoryId ?? 99) || (ma?.name ?? '').localeCompare(mb?.name ?? '') || a.skillId - b.skillId;
      })
      .map((skill) => {
        const meta = SKILL_LINES[skill.skillId];
        const bonus = skill.tempBonus + skill.permBonus;
        return {
          label: `${SKILL_CATEGORIES[meta?.categoryId ?? 0] ?? 'Skills'} - ${meta?.name ?? `Skill ${skill.skillId}`}`,
          value: `${skill.value + bonus}/${skill.max}${bonus ? ` (${skill.value}${bonus > 0 ? '+' : ''}${bonus})` : ''}`,
        };
      });
    const skillsPage: CharacterSubpageView = skillRows.length
      ? { heading: 'Skills', sections: [{ rows: skillRows }] }
      : { heading: 'Skills', emptyText: 'No skills known.' };

    const honorPage: CharacterSubpageView = honor ? {
      heading: 'Honor',
      sections: [{ rows: [
        { label: 'Rank', value: this.honorRankName(honor.highestRank) },
        { label: 'Rank Progress', value: `${honor.rankProgress}/255` },
        { label: 'Today - Honorable Kills', value: honor.sessionHonorableKills },
        { label: 'Today - Dishonorable Kills', value: honor.sessionDishonorableKills },
        { label: 'Yesterday - Honorable Kills', value: honor.yesterdayHonorableKills },
        { label: 'Yesterday - Honor', value: honor.yesterdayContribution },
        { label: 'This Week - Honorable Kills', value: honor.thisWeekHonorableKills },
        { label: 'This Week - Honor', value: honor.thisWeekContribution },
        { label: 'Last Week - Honorable Kills', value: honor.lastWeekHonorableKills },
        { label: 'Last Week - Honor', value: honor.lastWeekContribution },
        { label: 'Last Week - Standing', value: honor.lastWeekRank },
        { label: 'Lifetime Honorable Kills', value: honor.lifetimeHonorableKills },
        { label: 'Lifetime Dishonorable Kills', value: honor.lifetimeDishonorableKills },
      ] }],
    } : { heading: 'Honor', emptyText: 'No honor data to display.' };

    return { pet: petPage, reputation: reputationPage, skills: skillsPage, honor: honorPage };
  }

  private honorRankName(rank: number) {
    const character = this.deps.getCurrentCharacter();
    const ranks = character && [2, 5, 6, 8].includes(character.race) ? HORDE_HONOR_RANKS : ALLIANCE_HONOR_RANKS;
    return ranks[Math.max(0, Math.min(ranks.length - 1, rank))] ?? `Rank ${rank}`;
  }

  private renderPetPage(snapshot = this.deps.getPet()) {
    const pet = snapshot ?? {};
    if (!pet.guid) return `<div class="wow-char-empty">You do not have a pet.</div>`;
    const xpMax = Math.max(1, pet.nextLevelExperience ?? 0);
    const xp = Math.max(0, Math.min(xpMax, pet.experience ?? 0));
    const happinessMax = Math.max(1, pet.maxHappiness ?? 1000000);
    const happiness = Math.max(0, Math.min(happinessMax, pet.happiness ?? 0));
    const state = pet.spellState;
    const actionRows = (state?.actions ?? [])
      .filter((action) => action.packed !== 0 && action.action !== 0)
      .map((action) => `<div><span>Slot ${action.slot + 1}</span><strong>${action.action} / 0x${action.activeState.toString(16)}</strong></div>`)
      .join('');
    const rows: [string, string][] = [
      ['Name', pet.name ?? (pet.petNumber ? `Pet #${pet.petNumber}` : 'Loading')],
      ['Level', String(pet.level ?? '?')],
      ['Health', `${pet.health ?? 0}/${pet.maxHealth ?? 0}`],
      ['Happiness', `${petHappinessName(pet.happinessLevel)} (${happiness}/${happinessMax})`],
      ['Loyalty', pet.loyaltyName ? `${pet.loyaltyName} (${pet.loyalty})` : 'N/A'],
      ['Experience', `${xp}/${xpMax}`],
      ['Reaction', petReactName(state?.reactState)],
      ['Command', petCommandName(state?.commandState)],
    ];
    return (
      `<div class="wow-char-list-title">Pet</div>` +
      `<div class="wow-char-honor">` +
      rows.map(([label, value]) => `<div><span>${this.deps.escapeHtml(label)}</span><strong>${this.deps.escapeHtml(value)}</strong></div>`).join('') +
      (actionRows ? `<h3 class="wow-pet-subtitle">Pet Action Bar</h3>${actionRows}` : '') +
      `</div>`
    );
  }

  private renderReputationPage(snapshot = this.deps.getReputation()) {
    const factions = snapshot?.factions ?? [];
    if (!factions.length) {
      return `<div class="wow-char-list-title">Reputation</div><div class="wow-char-list"><div class="wow-char-empty">No reputation data to display.</div></div>`;
    }
    const rows = factions
      .map((faction) => {
        const meta = FACTIONS_BY_REPUTATION_INDEX[faction.reputationListId];
        const pct = Math.max(0, Math.min(100, Math.round((faction.valueInRank / Math.max(1, faction.pointsInRank)) * 100)));
        const title = meta?.name ?? `Faction ${faction.reputationListId}`;
        const details = `${title}\n${faction.rankName}: ${faction.valueInRank}/${faction.pointsInRank}\nStanding: ${faction.standing}`;
        return (
          `<div class="wow-reputation-row ${faction.inactive ? 'is-inactive' : ''}" data-tooltip="${this.deps.escapeHtml(details)}">` +
            `<div class="wow-reputation-name">${this.deps.escapeHtml(title)}${faction.watched ? ' *' : ''}</div>` +
            `<div class="wow-reputation-rank">${this.deps.escapeHtml(faction.rankName)}</div>` +
            `<div class="wow-reputation-bar"><span style="width:${pct}%"></span><em>${faction.valueInRank}/${faction.pointsInRank}</em></div>` +
            `<button type="button" data-rep-action="watch" data-rep-id="${faction.reputationListId}">${faction.watched ? 'Unwatch' : 'Watch'}</button>` +
            `<button type="button" data-rep-action="war" data-rep-id="${faction.reputationListId}" ${faction.peaceForced ? 'disabled' : ''}>${faction.atWar ? 'Peace' : 'At War'}</button>` +
            `<button type="button" data-rep-action="inactive" data-rep-id="${faction.reputationListId}">${faction.inactive ? 'Active' : 'Inactive'}</button>` +
          `</div>`
        );
      })
      .join('');
    return `<div class="wow-char-list-title">Reputation</div><div class="wow-char-list wow-reputation-list">${rows}</div>`;
  }

  private renderSkillsPage(snapshot = this.deps.getSkills()) {
    const skills = snapshot?.skills ?? [];
    if (!skills.length) {
      return `<div class="wow-char-list-title">Skills</div><div class="wow-char-list"><div class="wow-char-empty">No skills known.</div></div>`;
    }
    const rows = [...skills]
      .sort((a, b) => {
        const ma = SKILL_LINES[a.skillId];
        const mb = SKILL_LINES[b.skillId];
        return (ma?.categoryId ?? 99) - (mb?.categoryId ?? 99) || (ma?.name ?? '').localeCompare(mb?.name ?? '') || a.skillId - b.skillId;
      })
      .map((skill) => {
        const meta = SKILL_LINES[skill.skillId];
        const category = SKILL_CATEGORIES[meta?.categoryId ?? 0] ?? 'Skills';
        const bonus = skill.tempBonus + skill.permBonus;
        const current = skill.value + bonus;
        const value = `${current}/${skill.max}${bonus ? ` (${skill.value}${bonus > 0 ? '+' : ''}${bonus})` : ''}`;
        return `<div><span>${this.deps.escapeHtml(category)} - ${this.deps.escapeHtml(meta?.name ?? `Skill ${skill.skillId}`)}</span><strong>${this.deps.escapeHtml(value)}</strong></div>`;
      })
      .join('');
    return `<div class="wow-char-list-title">Skills</div><div class="wow-char-list">${rows}</div>`;
  }

  private renderHonorPage(snapshot = this.deps.getHonor()) {
    const honor = snapshot ?? {
      highestRank: 0,
      rankProgress: 0,
      sessionHonorableKills: 0,
      sessionDishonorableKills: 0,
      yesterdayHonorableKills: 0,
      yesterdayDishonorableKills: 0,
      lastWeekHonorableKills: 0,
      lastWeekDishonorableKills: 0,
      thisWeekHonorableKills: 0,
      thisWeekDishonorableKills: 0,
      thisWeekContribution: 0,
      lifetimeHonorableKills: 0,
      lifetimeDishonorableKills: 0,
      yesterdayContribution: 0,
      lastWeekContribution: 0,
      lastWeekRank: 0,
    };
    const rows: [string, string][] = [
      ['Rank', this.honorRankName(honor.highestRank)],
      ['Rank Progress', `${honor.rankProgress}/255`],
      ['Today - Honorable Kills', String(honor.sessionHonorableKills)],
      ['Today - Dishonorable Kills', String(honor.sessionDishonorableKills)],
      ['Yesterday - Honorable Kills', String(honor.yesterdayHonorableKills)],
      ['Yesterday - Honor', String(honor.yesterdayContribution)],
      ['This Week - Honorable Kills', String(honor.thisWeekHonorableKills)],
      ['This Week - Honor', String(honor.thisWeekContribution)],
      ['Last Week - Honorable Kills', String(honor.lastWeekHonorableKills)],
      ['Last Week - Honor', String(honor.lastWeekContribution)],
      ['Last Week - Standing', String(honor.lastWeekRank)],
      ['Lifetime Honorable Kills', String(honor.lifetimeHonorableKills)],
      ['Lifetime Dishonorable Kills', String(honor.lifetimeDishonorableKills)],
    ];
    return (
      `<div class="wow-char-list-title">Honor</div>` +
      `<div class="wow-char-honor">` +
      rows.map(([label, value]) => `<div><span>${this.deps.escapeHtml(label)}</span><strong>${this.deps.escapeHtml(value)}</strong></div>`).join('') +
      `</div>`
    );
  }
}
