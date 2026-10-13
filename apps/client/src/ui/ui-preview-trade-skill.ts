import type { ItemInfo } from '../world';
import { TradeSkillCanvasPanel } from './trade-skill-frame';
export { showBeastTrainingPreview } from './ui-preview-beast-training';
/** Isolated mock-data entry point for visually checking the native TradeSkillFrame without a realm. */
export function showTradeSkillPreview(
  hud: HTMLElement,
  getItemInfo: (entry: number) => ItemInfo | undefined,
  itemIconUrl: (displayInfoId?: number, entry?: number) => string,
) {
  const host = document.createElement('section');
  host.className = 'wow-tradeskill-frame is-hidden';
  hud.appendChild(host);
  const knownCooking = [2538, 2539, 2540, 2541, 2542, 2543, 2544, 2545, 2546, 2547, 2548];
  const panel = new TradeSkillCanvasPanel(host, {
    getKnownSpells: () => knownCooking,
    getSkills: () => ({ skills: [{ slot: 0, skillId: 185, step: 1, value: 125, max: 150, tempBonus: 0, permBonus: 0 }] }),
    getInventory: () => undefined,
    getItemInfo,
    requestItemInfo: () => {},
    itemIconUrl,
    castSpell: () => {},
    playUi: () => {},
  });
  void panel.initialize().then(() => panel.tryOpen(2550));
  return true;
}
