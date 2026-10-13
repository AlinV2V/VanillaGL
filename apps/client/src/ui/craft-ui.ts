/** Routes Vanilla's two profession surfaces: TradeSkillFrame and Beast Training CraftFrame. */
import type { CombatEvent, InventorySnapshot, ItemInfo, PetSnapshot, SkillSnapshot } from '../world';
import { BeastTrainingCanvasPanel } from './beast-training-frame';
import { TradeSkillCanvasPanel } from './trade-skill-frame';

type CraftUiDeps = {
  hud: HTMLElement;
  getKnownSpells: () => readonly number[];
  getSkills: () => SkillSnapshot | undefined;
  getInventory: () => InventorySnapshot | undefined;
  getPet: () => PetSnapshot | undefined;
  getItemInfo: (entry: number) => ItemInfo | undefined;
  requestItemInfo: (entry: number) => void;
  itemIconUrl: (displayInfoId?: number, entry?: number) => string;
  castTradeSpell: (spellId: number) => void;
  castTrainingSpell: (spellId: number) => void;
  getPlayerPortraitSource?: () => CanvasImageSource | undefined;
  playUi?: (name: string) => unknown;
};

export function createCraftUi(deps: CraftUiDeps) {
  const host = () => {
    const element = document.createElement('section');
    element.className = 'wow-tradeskill-frame is-hidden';
    deps.hud.appendChild(element);
    return element;
  };
  const tradeHost = host(), beastHost = host();
  const trade = new TradeSkillCanvasPanel(tradeHost, {
    getKnownSpells: deps.getKnownSpells, getSkills: deps.getSkills, getInventory: deps.getInventory,
    getItemInfo: deps.getItemInfo, requestItemInfo: deps.requestItemInfo, itemIconUrl: deps.itemIconUrl,
    castSpell: deps.castTradeSpell, playUi: deps.playUi,
  });
  const beast = new BeastTrainingCanvasPanel(beastHost, {
    getKnownSpells: deps.getKnownSpells, getPet: deps.getPet,
    castSpell: deps.castTrainingSpell, getPlayerPortraitSource: deps.getPlayerPortraitSource,
    playUi: deps.playUi,
  });
  return {
    hosts: [tradeHost, beastHost],
    initialize: () => Promise.all([trade.initialize(), beast.initialize()]).then(() => undefined),
    tryOpen: (spellId: number) => {
      if (beast.tryOpen(spellId)) { trade.close(); return true; }
      const opened = trade.tryOpen(spellId);
      if (opened) beast.close();
      return opened;
    },
    close: () => { trade.close(); beast.close(); },
    refresh: () => { trade.refresh(); beast.refresh(); },
    update: (playerMoving: boolean, inCombat: boolean) => trade.update(playerMoving, inCombat),
    handleCombatEvent: (event: CombatEvent, playerGuid?: string) => trade.handleCombatEvent(event, playerGuid),
  };
}
