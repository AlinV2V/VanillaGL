import { qaGlobals } from '../qa-globals.ts';
import { detectDeviceProfile } from '../platform/device-profile';
import { profileForDevice } from '../platform/performance-profile';
import { installMobileViewportLayout } from './mobile/mobile-viewport-layout';
import './mobile/mobile-hud.css';
// UI fidelity preview harness — renders in-world HUD panels with mock data, no login required.
// Invoked from main() when the URL has ?ui=<panel>. Mirrors the existing ?glue/?tile/?creature
// QA harnesses so every canvas panel can be screenshotted and compared to the extracted
// Vanilla 1.12 FrameXML without a live vMaNGOS session.
import { INGAME_HUD_TEMPLATE } from './ingame-hud-template';
import { BankCanvasPanel, type BankView } from './bank-frame';
import { getGameTooltip } from './game-tooltip';
import { createGameMenu } from './game-menu';
import { NpcInteractionController } from './npc-interactions';
import { QuestLogController } from './quest-log';
import { QuestWatchCanvasPanel } from './quest-tracker';
import { TalentFrameController } from './talent-frame';
import { StackSplitCanvasPanel } from './stack-split-frame';
import { TradeCanvasPanel, type TradeView } from './trade-frame';
import { itemTooltipLines } from './tooltip-content';
import { ensureVanillaFonts } from './vanilla-canvas';
import { MainMenuBarCanvas, type MainMenuMicroButton } from './main-menu-bar-canvas';
import { BagCanvasPanel } from './bag-canvas';
import { showKeyringPreview } from './ui-preview-keyring';
import { CHARACTER_EQUIPMENT_LAYOUT, CharacterFrameCanvasRenderer } from './character-frame-canvas';
import { SpellbookController } from './spellbook';
import { showSocialPreview } from './ui-preview-social';
import { UnitFrameController } from './unit-frames';
import { createWorldMapFrame } from './world-map';
import { PLAYER_EXPLORED_ZONE_WORDS } from './world-map-exploration';
import { createMinimap } from './minimap';
import { KeyBindingCanvasPanel, KeyBindingStore } from './keybinding-frame';
import { MacroSystem } from './macro-frame';
import { MailCanvasPanel } from './mail-frame';
import { AuctionCanvasPanel } from './auction-frame';
import { PetStableCanvasPanel } from './pet-stable-frame';
import { PetitionCanvasPanel } from './petition-frame';
import { showBeastTrainingPreview, showTradeSkillPreview } from './ui-preview-trade-skill';
import { showPlayerInteractionPreview } from './ui-preview-player-interactions';
import { installDraggableFrames } from './hud-window-interactions';
import * as THREE from 'three';
import type { InteractionEvent, ItemInfo, LootState, QuestLogSnapshot } from '../world';
import { loadBakedCharacterModel } from '../model-loader';
import { WorldEntityRenderer } from '../world-entity-renderer';
type MockItem = { name: string; quality: number; icon: string; itemLevel?: number; requiredLevel?: number; sellPrice?: number; inventoryType?: number; classId?: number; subclass?: number; containerSlots?: number };
// A small catalog of representative Vanilla items across the quality spectrum so previews exercise
// the quality-colour path and real icon art. Keyed by item entry; displayInfoId == entry here.
export const MOCK_ITEM_CATALOG: Record<number, MockItem> = {
  2589: { name: 'Linen Cloth', quality: 1, icon: 'INV_Fabric_Linen_01', itemLevel: 5, sellPrice: 19 },
  774: { name: 'Malachite', quality: 1, icon: 'INV_Misc_Gem_Variety_01', itemLevel: 7, sellPrice: 25 },
  4306: { name: 'Silk Cloth', quality: 1, icon: 'INV_Fabric_Silk_01', itemLevel: 20, sellPrice: 40 },
  1210: { name: 'Shadowgem', quality: 2, icon: 'INV_Misc_Gem_Emerald_01', itemLevel: 15, requiredLevel: 5, sellPrice: 375 },
  828: { name: "Hillman's Cloak", quality: 2, icon: 'INV_Misc_Cape_02', itemLevel: 12, requiredLevel: 7, sellPrice: 210, inventoryType: 16, classId: 4, subclass: 1 },
  6975: { name: 'Whirlwind Axe', quality: 3, icon: 'INV_Axe_09', itemLevel: 30, requiredLevel: 25, sellPrice: 4200, inventoryType: 17, classId: 2, subclass: 1 },
  942: { name: 'Freezing Band', quality: 3, icon: 'INV_Jewelry_Ring_13', itemLevel: 24, requiredLevel: 19, sellPrice: 1800, inventoryType: 11 },
  7073: { name: 'Arcanite Bar', quality: 4, icon: 'INV_Ingot_Mithril', itemLevel: 55, sellPrice: 0 },
  159: { name: 'Refreshing Spring Water', quality: 1, icon: 'INV_Drink_07', itemLevel: 5, sellPrice: 6 },
  2070: { name: 'Darnassian Bleu', quality: 1, icon: 'INV_Misc_Food_06', itemLevel: 5, sellPrice: 6 },
  6948: { name: 'Hearthstone', quality: 1, icon: 'INV_Misc_Rune_01', itemLevel: 1 },
  2361: { name: 'Battleworn Hammer', quality: 1, icon: 'INV_Hammer_16', itemLevel: 2, sellPrice: 15, inventoryType: 17, classId: 2, subclass: 5 },
  4498: { name: 'Brown Leather Satchel', quality: 1, icon: 'INV_Misc_Bag_09', itemLevel: 15, sellPrice: 250, inventoryType: 18, classId: 1, containerSlots: 8 },
  2592: { name: 'Wool Cloth', quality: 1, icon: 'INV_Fabric_Wool_01', itemLevel: 15, sellPrice: 38 },
  118: { name: 'Minor Healing Potion', quality: 1, icon: 'INV_Potion_49', itemLevel: 5, sellPrice: 25 },
  4540: { name: 'Tough Hunk of Bread', quality: 1, icon: 'INV_Misc_Food_11', itemLevel: 5, sellPrice: 6 },
  25: { name: 'Worn Shortsword', quality: 1, icon: 'INV_Sword_04', itemLevel: 2, sellPrice: 17, inventoryType: 21, classId: 2, subclass: 7 },
  2362: { name: 'Worn Wooden Shield', quality: 0, icon: 'INV_Shield_09', itemLevel: 1, sellPrice: 7, inventoryType: 14, classId: 4, subclass: 6 },
};

export const mockGetItemInfo = (entry: number): ItemInfo | undefined => {
  const item = MOCK_ITEM_CATALOG[entry];
  if (!item) return undefined;
  return {
    entry,
    classId: item.classId ?? 0,
    subclass: item.subclass ?? 0,
    material: 0,
    name: item.name,
    displayInfoId: entry,
    quality: item.quality,
    flags: 0,
    buyPrice: (item.sellPrice ?? 10) * 4,
    sellPrice: item.sellPrice ?? 0,
    inventoryType: item.inventoryType ?? 0,
    itemLevel: item.itemLevel ?? 1,
    requiredLevel: item.requiredLevel ?? 0,
    maxCount: 0,
    stackable: 20,
    containerSlots: item.containerSlots ?? 0,
    sheath: 0,
    // Demo combat stats so the tooltip preview exercises the damage/armor/stat lines.
    armor: item.classId === 4 && item.subclass !== 0 ? item.itemLevel ?? 0 : 0,
    damage: item.classId === 2 ? [{ min: (item.itemLevel ?? 2), max: (item.itemLevel ?? 2) * 2, type: 0 }] : [],
    stats: item.quality && item.quality >= 2 ? [{ type: 7, value: Math.max(1, Math.round((item.itemLevel ?? 1) / 5)) }] : [],
    resistances: [],
    delay: item.classId === 2 ? 2600 : 0,
    spells: [],
  } as ItemInfo;
};
export const mockItemIconUrl = (displayInfoId?: number, entry?: number) => {
  const item = MOCK_ITEM_CATALOG[displayInfoId ?? entry ?? 0];
  return item ? `/ui/Interface/Icons/${item.icon}.png` : '';
};

const lootItem = (slot: number, entry: number, count = 1) => ({ slot, entry, count, displayInfoId: entry, randomPropertyId: 0, slotType: 1 });

export const MOCK_LOOT: Record<string, LootState> = {
  loot: {
    guid: '0xF130000001', lootType: 1, money: 4523,
    items: [lootItem(0, 2589, 4), lootItem(1, 1210), lootItem(2, 6975), lootItem(3, 7073), lootItem(4, 828), lootItem(5, 774, 2)],
  },
  'loot-money': { guid: '0xF130000002', lootType: 1, money: 1875, items: [lootItem(0, 4306, 3)] },
  'loot-empty': { guid: '0xF130000003', lootType: 1, money: 0, items: [] },
};

export const MOCK_SPELL_NAMES: Record<number, string> = {
  100: 'Charge', 772: 'Rend', 6673: 'Battle Shout', 34428: 'Victory Rush', 1715: 'Hamstring',
  284: 'Heroic Strike (Rank 2)', 71: 'Defensive Stance', 7386: 'Sunder Armor', 72: 'Shield Bash', 355: 'Taunt', 1160: 'Demoralizing Shout',
};

const questReward = (itemId: number, count = 1) => ({ itemId, count, displayInfoId: itemId });

export const MOCK_EVENTS: Record<string, InteractionEvent> = {
  gossip: {
    kind: 'gossip',
    state: {
      guid: '0xF130000010',
      options: [
        { index: 0, icon: 0, coded: false, text: 'I need some supplies.' },
        { index: 1, icon: 1, coded: false, text: 'Let me browse your goods.' },
        { index: 2, icon: 3, coded: false, text: 'I seek training.' },
        { index: 3, icon: 6, coded: false, text: 'I would like to check my deposit box.' },
      ],
      quests: [
        { questId: 33, icon: 0, level: 5, title: 'Wolves Across the Border' },
        { questId: 62, icon: 4, level: 10, title: 'The Fargodeep Mine' },
      ],
    },
  } as InteractionEvent,
  'quest-greeting': {
    kind: 'questList',
    state: {
      guid: '0xF130000011',
      greeting: 'Ah, a fresh face! The Stonefield farm has been overrun and we need every able hand. Speak quickly, there is much to be done.',
      quests: [
        { questId: 85, icon: 3, level: 8, title: 'Lost Necklace' },
        { questId: 86, icon: 4, level: 9, title: 'Bernice Needs Help' },
        { questId: 88, icon: 0, level: 10, title: 'Princess Must Die!' },
      ],
    },
  } as InteractionEvent,
  'quest-detail': {
    kind: 'questDetails',
    state: {
      guid: '0xF130000012', questId: 62, title: 'The Fargodeep Mine',
      details: 'The Fargodeep Mine, southwest of here, was recently overrun by kobolds. Those grubby little rats now squat among its treasures!$B$BScout the mine and report back. And if you get a chance to swing a blade at a kobold along the way, then so much the better!',
      objectives: 'Scout through the Fargodeep Mine, then return to Marshal Dughan in Goldshire.',
      choiceRewards: [questReward(25), questReward(2362)],
      rewards: [questReward(118, 2)],
      money: 150,
    },
  } as InteractionEvent,
  'quest-progress': {
    kind: 'questRequestItems',
    state: {
      guid: '0xF130000013', questId: 33, title: 'Wolves Across the Border',
      text: 'Have you gathered the wolf meat I asked for? The soldiers grow hungry.',
      requiredMoney: 0,
      requiredItems: [questReward(2589, 8), questReward(774, 2)],
      complete: false,
    },
  } as InteractionEvent,
  'quest-reward': {
    kind: 'questOfferReward',
    state: {
      guid: '0xF130000014', questId: 88, title: 'Princess Must Die!',
      text: 'You have done Zone_01 a great service, hero. The Stonefields will sleep easier tonight. Choose your reward.',
      choiceRewards: [questReward(6975), questReward(942), questReward(828)],
      rewards: [],
      money: 850,
      questFlags: 0,
      rewardSpell: 0,
    },
  } as InteractionEvent,
  popup: { kind: 'questMessage', message: 'Your quest log is full.' } as InteractionEvent,
  'pet-unlearn': { kind: 'petUnlearnConfirm', petGuid: '0xF140000001', cost: 10000 } as InteractionEvent, 'instance-boot': { kind: 'questMessage', message: "You are not in this instance's group.  You will be teleported to Goldshire in 1 Minute." } as InteractionEvent,
};
export const MOCK_VENDOR: InteractionEvent = {
  kind: 'vendor',
  state: {
    guid: '0xF130000020',
    items: [
      { vendorSlot: 0, entry: 159, displayInfoId: 159, stock: -1, price: 25, maxDurability: 0, buyCount: 5 },
      { vendorSlot: 1, entry: 2070, displayInfoId: 2070, stock: -1, price: 25, maxDurability: 0, buyCount: 5 },
      { vendorSlot: 2, entry: 4540, displayInfoId: 4540, stock: -1, price: 25, maxDurability: 0, buyCount: 5 },
      { vendorSlot: 3, entry: 118, displayInfoId: 118, stock: -1, price: 100, maxDurability: 0, buyCount: 1 },
      { vendorSlot: 4, entry: 2361, displayInfoId: 2361, stock: 1, price: 63, maxDurability: 25, buyCount: 1 },
      { vendorSlot: 5, entry: 25, displayInfoId: 25, stock: 3, price: 71, maxDurability: 20, buyCount: 1 },
      { vendorSlot: 6, entry: 2362, displayInfoId: 2362, stock: -1, price: 31, maxDurability: 20, buyCount: 1 },
      { vendorSlot: 7, entry: 4498, displayInfoId: 4498, stock: 1, price: 1000, maxDurability: 0, buyCount: 1 },
      { vendorSlot: 8, entry: 2592, displayInfoId: 2592, stock: -1, price: 152, maxDurability: 0, buyCount: 1 },
      { vendorSlot: 9, entry: 6948, displayInfoId: 6948, stock: -1, price: 0, maxDurability: 0, buyCount: 1 },
      { vendorSlot: 10, entry: 1210, displayInfoId: 1210, stock: 2, price: 1500, maxDurability: 0, buyCount: 1 },
      { vendorSlot: 11, entry: 828, displayInfoId: 828, stock: 1, price: 840, maxDurability: 35, buyCount: 1 },
    ],
  },
} as InteractionEvent;

export const MOCK_TRAINER: InteractionEvent = {
  kind: 'trainer',
  state: {
    guid: '0xF130000030', trainerType: 0, title: 'Llane Beshere',
    spells: [
      // Normal class spells carry 0/0 in the two primary-profession fields.
      { spellId: 284, state: 0, cost: 200, primaryProfessionConfirm: false, primaryProfessionAllowed: false, requiredLevel: 0, requiredSkill: 0, requiredSkillValue: 0, requiredSpell1: 0, requiredSpell2: 0 },
      { spellId: 100, state: 0, cost: 100, primaryProfessionConfirm: false, primaryProfessionAllowed: true, requiredLevel: 4, requiredSkill: 0, requiredSkillValue: 0, requiredSpell1: 0, requiredSpell2: 0 },
      { spellId: 772, state: 1, cost: 300, primaryProfessionConfirm: false, primaryProfessionAllowed: true, requiredLevel: 8, requiredSkill: 0, requiredSkillValue: 0, requiredSpell1: 0, requiredSpell2: 0 },
      { spellId: 6673, state: 2, cost: 100, primaryProfessionConfirm: false, primaryProfessionAllowed: true, requiredLevel: 1, requiredSkill: 0, requiredSkillValue: 0, requiredSpell1: 0, requiredSpell2: 0 },
      { spellId: 1715, state: 1, cost: 900, primaryProfessionConfirm: false, primaryProfessionAllowed: true, requiredLevel: 8, requiredSkill: 0, requiredSkillValue: 0, requiredSpell1: 0, requiredSpell2: 0 },
      { spellId: 71, state: 1, cost: 1000, primaryProfessionConfirm: false, primaryProfessionAllowed: true, requiredLevel: 10, requiredSkill: 0, requiredSkillValue: 0, requiredSpell1: 0, requiredSpell2: 0 },
      { spellId: 7386, state: 1, cost: 950, primaryProfessionConfirm: false, primaryProfessionAllowed: true, requiredLevel: 10, requiredSkill: 0, requiredSkillValue: 0, requiredSpell1: 0, requiredSpell2: 0 },
      { spellId: 72, state: 1, cost: 1200, primaryProfessionConfirm: false, primaryProfessionAllowed: true, requiredLevel: 12, requiredSkill: 0, requiredSkillValue: 0, requiredSpell1: 0, requiredSpell2: 0 },
      { spellId: 355, state: 1, cost: 1500, primaryProfessionConfirm: false, primaryProfessionAllowed: true, requiredLevel: 10, requiredSkill: 0, requiredSkillValue: 0, requiredSpell1: 0, requiredSpell2: 0 },
      { spellId: 1160, state: 1, cost: 1600, primaryProfessionConfirm: false, primaryProfessionAllowed: true, requiredLevel: 14, requiredSkill: 0, requiredSkillValue: 0, requiredSpell1: 0, requiredSpell2: 0 },
    ],
  },
} as InteractionEvent;

export const MOCK_BANK: BankView = {
  bankerName: 'John Burnside',
  slots: [
    { entry: 6975, count: 1, displayInfoId: 6975 }, { entry: 7073, count: 12, displayInfoId: 7073 },
    { entry: 2589, count: 20, displayInfoId: 2589 }, { entry: 2592, count: 14, displayInfoId: 2592 },
    { entry: 828, count: 1, displayInfoId: 828 }, undefined, { entry: 1210, count: 3, displayInfoId: 1210 },
    ...new Array<undefined>(17).fill(undefined),
  ],
  bags: [{ entry: 4498, count: 1, displayInfoId: 4498 }, undefined, undefined, undefined, undefined, undefined],
  purchasedBagSlots: 2,
  nextSlotCost: 10000,
  playerMoney: 35251,
};

export const MOCK_TRADE: TradeView = {
  playerName: 'Thonk',
  targetName: 'Melindra',
  playerMoney: 12550,
  targetMoney: 0,
  playerItems: [{ entry: 6975, count: 1, displayInfoId: 6975 }, { entry: 2589, count: 20, displayInfoId: 2589 }, undefined, undefined, undefined, undefined, { entry: 6948, count: 1, displayInfoId: 6948 }],
  targetItems: [{ entry: 942, count: 1, displayInfoId: 942 }, undefined, undefined, undefined, undefined, undefined, undefined],
  playerAccepted: false,
  targetAccepted: true,
};

export const MOCK_QUEST_LOG: QuestLogSnapshot = {
  capacity: 20,
  entries: [
    {
      slot: 0, questId: 62, countState: 0, objectiveCounts: [1, 0, 0, 0], state: 1, complete: true, failed: false, timer: 0,
      info: {
        questId: 62, title: 'The Fargodeep Mine', level: 7, zoneOrSort: 12,
        objectives: 'Scout through the Fargodeep Mine, then return to Marshal Dughan in Goldshire.',
        details: 'The Fargodeep Mine was recently overrun by kobolds.$B$BScout the mine and report back.',
        requiredObjectives: [{ text: 'Scout the Fargodeep Mine', creatureOrGoId: 0, creatureOrGoCount: 1, itemId: 0, itemCount: 0 }],
        choiceRewards: [], rewards: [{ itemId: 118, count: 2 }], rewardOrRequiredMoney: 150,
      } as never,
    },
    {
      slot: 1, questId: 88, countState: 0, objectiveCounts: [4, 0, 0, 0], state: 0, complete: false, failed: false, timer: 0,
      info: {
        questId: 88, title: 'Princess Must Die!', level: 9, zoneOrSort: 12,
        objectives: 'Kill Princess and bring her collar back to Ma Stonefield.',
        details: 'That foul pig Princess has been rooting through our crops again!',
        requiredObjectives: [
          { text: '', creatureOrGoId: 330, creatureOrGoCount: 1, itemId: 0, itemCount: 0 },
          { text: '', creatureOrGoId: 0, creatureOrGoCount: 0, itemId: 2589, itemCount: 8 },
        ],
        choiceRewards: [{ itemId: 828, count: 1 }, { itemId: 942, count: 1 }], rewards: [], rewardOrRequiredMoney: 400,
      } as never,
    },
    {
      slot: 2, questId: 33, countState: 0, objectiveCounts: [0, 0, 0, 0], state: 0, complete: false, failed: false, timer: 0,
      info: {
        questId: 33, title: 'Wolves Across the Border', level: 11, zoneOrSort: 40,
        objectives: 'Bring 8 pieces of wolf meat to the Zone_04 militia.',
        details: 'The soldiers grow hungry and the wolves grow bold.',
        requiredObjectives: [{ text: '', creatureOrGoId: 0, creatureOrGoCount: 0, itemId: 2589, itemCount: 8 }],
        choiceRewards: [], rewards: [], rewardOrRequiredMoney: 0,
      } as never,
    },
  ],
};

function mountHud(): HTMLElement {
  const hud = document.createElement('div');
  hud.className = 'wow-ingame-hud';
  hud.innerHTML = INGAME_HUD_TEMPLATE;
  document.body.appendChild(hud);
  // The harness returns before the app's render loop starts, leaving the page fully idle — some
  // screenshot/CDP capture paths then wait forever for a compositor frame that never gets scheduled.
  // A no-op rAF keepalive keeps frames ticking so previews stay screenshot-able.
  const tick = () => requestAnimationFrame(tick);
  requestAnimationFrame(tick);
  return hud;
}
export function runUiPreview(which: string): boolean {
  const hud = mountHud();
  const detected = detectDeviceProfile();
  const forcePhone = new URLSearchParams(location.search).get('mobile') === '1' && Math.min(innerWidth, innerHeight) < 700;
  installMobileViewportLayout(profileForDevice(forcePhone ? { ...detected, mobile: true, kind: 'phone' } : detected));
  void ensureVanillaFonts();
  if (showPlayerInteractionPreview(which, hud)) return true;
  const query = <T extends HTMLElement>(selector: string) => hud.querySelector<T>(selector)!;
  installDraggableFrames({
    ingameHud: hud,
    panels: Array.from(hud.querySelectorAll<HTMLElement>('[data-frame-id]')),
    containerLayer: query('#wow-container-layer'),
    draggedFramePositions: new Map(),
  });

  if (which === 'nameplates') {
    document.body.style.background = 'linear-gradient(#39532c, #1e341b)';
    const layer = document.createElement('div');
    layer.className = 'wow-nameplate-layer';
    layer.innerHTML =
      '<div class="wow-nameplate is-overhead is-friendly is-player" style="--wow-unit-name-size:34px;transform:translate(50vw,72vh) translate(-50%,-100%)"><div class="wow-nameplate-name">Electrodus</div></div>' +
      '<div class="wow-nameplate is-overhead is-friendly is-creature" style="--wow-unit-name-size:21px;transform:translate(18vw,68vh) translate(-50%,-100%)"><div class="wow-nameplate-name">Godric Rothgar</div></div>' +
      '<div class="wow-nameplate is-overhead is-neutral is-creature" style="--wow-unit-name-size:12px;transform:translate(25vw,30vh) translate(-50%,-100%)"><div class="wow-nameplate-name">Timber Wolf</div></div>' +
      '<div class="wow-nameplate is-healthplate is-neutral is-creature" style="transform:translate(47vw,32vh) translate(-50%,-100%)"><div class="wow-nameplate-name">Timber Wolf</div><div class="wow-nameplate-health"><span class="wow-nameplate-health-fill" style="width:82px"></span><span class="wow-nameplate-level con-yellow">2</span></div></div>' +
      '<div class="wow-nameplate is-healthplate is-neutral is-creature is-selected" style="transform:translate(70vw,43vh) translate(-50%,-100%)"><div class="wow-nameplate-name">Young Wolf</div><div class="wow-nameplate-health"><span class="wow-nameplate-health-fill" style="width:102px"></span><span class="wow-nameplate-level con-green">1</span></div></div>';
    document.body.appendChild(layer);
    return true;
  }

  if (which === 'keybindings') {
    const layer = document.createElement('div');
    layer.className = 'wow-keybinding-layer';
    hud.appendChild(layer);
    new KeyBindingCanvasPanel(layer, new KeyBindingStore()).open();
    return true;
  }

  if (which === 'macros') {
    const layer = document.createElement('div');
    layer.className = 'wow-macro-layer';
    hud.appendChild(layer);
    const panel = new MacroSystem(layer, {
      getCharacterGuid: () => 'preview-character',
      getKnownSpells: () => [6603, 78, 100, 772, 6673, 1715, 2457],
      executeLine: () => {}, assignMacro: () => {},
    });
    void panel.open();
    return true;
  }

  if (which === 'mail') {
    const host = document.createElement('section');
    host.className = 'wow-mail-frame';
    hud.appendChild(host);
    const panel = new MailCanvasPanel(host, {
      closeMailbox: () => {}, sendMail: () => {}, takeMoney: () => {}, takeItem: () => {},
      markRead: () => {}, returnMail: () => {}, deleteMail: () => {}, queryBody: () => {},
      senderName: (guid, entry) => guid ? 'Marshal Dughan' : `Auction House ${entry ?? ''}`,
      getItemInfo: mockGetItemInfo, itemIconUrl: mockItemIconUrl,
      heldItem: () => undefined, clearHeld: () => {},
    });
    panel.show({ mailboxGuid: 'mailbox-preview', messages: [
      { id: 1, messageType: 0, senderGuid: 'marshal', subject: 'A Call to Arms', itemTextId: 1, stationery: 41, itemEntry: 118, itemCount: 3, money: 1250, cod: 0, checked: 0, daysLeft: 29.7, body: 'StartingZone_01 needs every able hand.' },
      { id: 2, messageType: 2, senderEntry: 0, subject: 'Auction successful: Linen Cloth', itemTextId: 0, stationery: 62, itemEntry: 0, itemCount: 0, money: 842, cod: 0, checked: 1, daysLeft: 28.4 },
    ] });
    return true;
  }

  if (which === 'auction') {
    const host = document.createElement('section');
    host.className = 'wow-auction-frame';
    hud.appendChild(host);
    const panel = new AuctionCanvasPanel(host, {
      playUi: () => {}, getItemInfo: mockGetItemInfo, itemIconUrl: mockItemIconUrl,
      getPlayerMoney: () => 184_235,
      getPlayerName: (guid) => (guid.startsWith('0') ? undefined : `Bidder${guid.slice(-2)}`),
      heldItem: () => undefined, clearHeld: () => {},
      search: () => {}, listOwn: () => {}, listBids: () => {},
      placeBid: () => {}, cancelAuction: () => {}, sellItem: () => {},
      onClose: () => {},
    });
    // A full page of 8 rows so the row pitch, the column stops and the pager can all be measured
    // against AuctionFrame.xml in one screenshot.
    const row = (index: number) => ({
      auctionId: 100 + index,
      itemEntry: [2589, 2592, 774, 818, 1210, 4306, 2318, 3371][index % 8],
      enchantId: 0, randomPropertyId: 0, suffixFactor: 0,
      count: index % 3 === 0 ? 20 : 1,
      spellCharges: 0,
      ownerGuid: `seller${index}`,
      startBid: 1200 * (index + 1),
      minIncrement: index % 2 === 0 ? 0 : 60 * (index + 1),
      buyout: index % 4 === 3 ? 0 : 9000 * (index + 1),
      timeLeftMs: [1_500_000, 25 * 60_000, 3 * 3_600_000, 20 * 3_600_000][index % 4],
      bidderGuid: index % 2 === 0 ? '0000000000000000' : `bidder${index}`,
      currentBid: index % 2 === 0 ? 0 : 1200 * (index + 1),
    });
    const entries = Array.from({ length: 8 }, (_, index) => row(index));
    panel.show({
      auctioneerGuid: 'auctioneer-preview',
      houseId: 1,
      browse: { entries, totalCount: 137, page: 0 },
      bids: { entries: entries.slice(0, 3), totalCount: 3, page: 0 },
      auctions: { entries: entries.slice(0, 2), totalCount: 2, page: 0 },
    });
    return true;
  }
  if (which === 'tradeskill') return showTradeSkillPreview(hud, mockGetItemInfo, mockItemIconUrl);
  if (which === 'beasttraining') return showBeastTrainingPreview(hud);

  if (which === 'petstable') {
    const host = document.createElement('section');
    host.className = 'wow-pet-stable-frame';
    hud.appendChild(host);
    const panel = new PetStableCanvasPanel(host, {
      playUi: () => {}, creatureIconUrl: () => undefined,
      getPlayerMoney: () => 184_235,
      stableCurrentPet: () => {}, unstablePet: () => {}, swapPet: () => {}, buySlot: () => {},
      onClose: () => {},
    });
    // One purchased slot, so the second renders locked — the state PetStable.lua:112 tints red.
    panel.show({
      guid: 'stablemaster-preview',
      stableSlots: 1,
      pets: [
        { slot: 1, petNumber: 11, entry: 299, level: 22, name: 'Snarl', loyalty: 5 },
        { slot: 2, petNumber: 12, entry: 883, level: 18, name: 'Bristle', loyalty: 4 },
      ],
    });
    return true;
  }

  if (which === 'petition') {
    const host = document.createElement('section');
    host.className = 'wow-petition-frame';
    hud.appendChild(host);
    const names: Record<string, string> = {
      owner: 'Electrodus', s1: 'Godric', s2: 'Marla', s3: 'Thistlebrew', s4: 'Vayne', s5: 'Orin',
    };
    const panel = new PetitionCanvasPanel(host, {
      playUi: () => {},
      getPlayerName: (guid) => names[guid],
      getPlayerGuid: () => 'owner',
      sign: () => {}, decline: () => {}, turnIn: () => {}, rename: () => {}, onClose: () => {},
    });
    // Five of nine signatures, viewed as the OWNER — so Rename/Turn In show, and Turn In is
    // disabled with the ERR_PETITION_NOT_ENOUGH_SIGNATURES line under it.
    panel.show({
      itemGuid: 'charter-item', ownerGuid: 'owner', petitionGuid: 7,
      name: 'Sons of StartingZone_01',
      signatures: ['s1', 's2', 's3', 's4', 's5'],
      requiredSignatures: 9,
    });
    return true;
  }

  if (which === 'unitframes') {
    const playerFrame = query('#wow-player-frame');
    const targetFrame = query('#wow-target-frame');
    const playerEntity = {
      guid: 'player', typeId: 4, race: 1, gender: 0, classId: 1, level: 12,
      health: 487, maxHealth: 612, powerType: 1, powers: [0, 41], maxPowers: [0, 100], faction: 1,
    } as never;
    const targetEntity = {
      guid: 'target', typeId: 3, entry: 448, displayId: 11415, level: 15,
      health: 821, maxHealth: 1130, powerType: 0, powers: [260], maxPowers: [300], faction: 14,
      typeName: 'Unit', x: 0, y: 0, z: 0, o: 0, updatedAt: performance.now(), fields: new Map(),
    } as never;
    const previewEntityRenderer = new WorldEntityRenderer({
      scene: new THREE.Scene(),
      worldToLocal: (x, y) => ({ x, y }),
      sampleHeight: () => 0,
    });
    previewEntityRenderer.upsert(targetEntity);
    let previewPlayerModel: THREE.Group | undefined;
    const controller = new UnitFrameController({
      elements: {
        playerFrame, pfName: query('[data-pf="name"]'), pfLevel: query('[data-pf="level"]'),
        pfHp: query('[data-pf="hp"]'), pfHpText: query('[data-pf="hpText"]'),
        pfPower: query('[data-pf="power"]'), pfPowerText: query('[data-pf="powerText"]'), pfPvp: query('[data-pf="pvp"]'),
        targetFrame, tfName: query('[data-tf="name"]'), tfLevel: query('[data-tf="level"]'),
        tfHp: query('[data-tf="hp"]'), tfHpText: query('[data-tf="hpText"]'),
        tfPower: query('[data-tf="power"]'), tfPowerText: query('[data-tf="powerText"]'), tfPvp: query('[data-tf="pvp"]'),
        tfSkull: query('[data-tf="skull"]'), tfArt: targetFrame.querySelector<HTMLElement>('.wow-unit-art'),
      },
      camera: new THREE.PerspectiveCamera(),
      getEntityRenderer: () => previewEntityRenderer,
      getWorld: () => ({ queryCreature: () => {}, queryGameObject: () => {}, queryPlayerName: () => {}, getCreatureName: () => ({ name: 'Young Wolf', rank: 0 }), getGameObjectName: () => undefined, getPlayerName: () => undefined }),
      getPlayerGuid: () => 'player', getPlayerModelGroup: () => previewPlayerModel, getPlayerOverheadPosition: () => undefined,
      getCurrentCharacter: () => ({ name: 'Thonk', race: 1, gender: 0, classId: 1, level: 12 } as never),
      getPlayerEntity: () => playerEntity, getSelectedTargetGuid: () => 'target', getPlayerLocalPosition: () => ({ x: 0, y: 0, z: 0 }), isNameplateBlockedByWmo: () => false,
      applyPvpBadge: (element) => element.classList.add('is-hidden'),
      escapeHtml: (value) => value, raceName: () => 'Human', className: () => 'Warrior',
      targetNameBg: { hostile: 'rgba(170,0,0,.55)', neutral: 'rgba(168,160,0,.5)', friendly: 'rgba(0,132,0,.5)' },
      tappedNameBg: 'rgba(128,128,128,.5)',
      targetFrameArt: '/ui/Interface/TargetingFrame/UI-TargetingFrame.png',
      eliteFrameArt: { 1: '/ui/Interface/TargetingFrame/UI-TargetingFrame-Elite.png' },
    });
    controller.refreshPlayerFrame();
    controller.refreshTargetFrame();
    const portraitPoll = window.setInterval(() => controller.updatePortraits(), 100);
    window.setTimeout(() => window.clearInterval(portraitPoll), 5000);
    void loadBakedCharacterModel({
      name: 'Thonk', race: 1, gender: 0, classId: 1, level: 12,
      skin: 0, face: 0, hairStyle: 1, hairColor: 1, facialHair: 1, equipment: [],
    } as never).then((model) => {
      model.animator?.update(0, 'stand', undefined, model.group);
      previewPlayerModel = model.group;
      controller.updatePortraits(Number.POSITIVE_INFINITY);
    });
    return true;
  }

  if (which === 'questwatch') {
    const tracker = new QuestWatchCanvasPanel(query('#wow-quest-watch'), query('#wow-quest-progress'), {
      characterKey: () => 'preview-warrior', playerLevel: () => 12,
      itemName: (entry) => entry === 2589 ? 'Linen Cloth' : undefined,
      creatureName: (entry) => entry === 6 ? 'Kobold Vermin' : undefined,
      playUi: () => true, announceError: () => {},
    });
    const entries = [{
      slot: 0, questId: 33, countState: 0, objectiveCounts: [3, 8, 0, 0], state: 0,
      complete: false, failed: false, timer: 0,
      info: {
        questId: 33, method: 2, level: 10, zoneOrSort: 12, type: 0,
        repObjectiveFaction: 0, repObjectiveValue: 0, requiredOppositeRepFaction: 0, requiredOppositeRepValue: 0,
        nextQuestInChain: 0, rewardOrRequiredMoney: 0, rewardMoneyMaxLevel: 0, rewardSpell: 0, sourceItemId: 0,
        questFlags: 0, rewards: [], choiceRewards: [], pointMapId: 0, pointX: 0, pointY: 0, pointOpt: 0,
        title: 'Wolves Across the Border', objectives: '', details: '', endText: '',
        requiredObjectives: [
          { creatureOrGoId: 6, isGameObject: false, creatureOrGoCount: 5, itemId: 0, itemCount: 0, text: 'Kobold Vermin Slain' },
          { creatureOrGoId: 0, isGameObject: false, creatureOrGoCount: 0, itemId: 2589, itemCount: 8, text: 'Linen Cloth' },
        ],
      },
    }] as QuestLogSnapshot['entries'];
    tracker.setSnapshot({ capacity: 20, entries });
    tracker.toggle(entries[0]);
    tracker.showAnnouncement('Kobold Vermin slain: 3/5', '#ffd100', 60_000);
    return true;
  }

  if (which === 'worldmap') {
    const worldMap = createWorldMapFrame();
    hud.appendChild(worldMap.element);
    worldMap.setExploredZones(new Array(PLAYER_EXPLORED_ZONE_WORDS).fill(0xffffffff));
    worldMap.setCurrentWorld({ mapId: 0, x: -8949, y: -132, heading: 4.1, areaId: 12 });
    worldMap.open();
    return true;
  }

  if (which === 'minimap') {
    const minimap = createMinimap();
    hud.appendChild(minimap.element);
    minimap.setMap('Azeroth');
    minimap.setZone('Zone_01');
    minimap.setTimeOfDay(1440);
    minimap.setPerf(60, 16.7);
    minimap.update(-8949, -132, 4.1);
    minimap.setBlips([
      { guid: 'party', worldX: -8931, worldY: -148, heading: 2.4, kind: 'party' },
      { guid: 'hostile', worldX: -8962, worldY: -110, kind: 'hostile' },
      { guid: 'friendly', worldX: -8917, worldY: -103, kind: 'friendly' },
      { guid: 'quest', worldX: -8975, worldY: -155, kind: 'quest' },
    ]);
    minimap.show();
    return true;
  }

  if (which === 'mainbar') {
    const host = query('#wow-main-menu-bar');
    host.classList.remove('is-hidden');
    host.classList.add('has-canvas-ui');
    const microIds: MainMenuMicroButton[] = ['character', 'spellbook', 'talents', 'quest', 'socials', 'world', 'mainmenu', 'help'];
    const bar = new MainMenuBarCanvas();
    host.appendChild(bar.canvas);
    bar.setViewModel({
      skin: 'human', showEndCaps: true,
      experience: { current: 1475, maximum: 2800, restedBonus: 900, displayText: '1,475 / 2,800  (900 rested)' },
      actionPage: 1, actionPageCount: 6,
      actions: [
        { slot: 0, iconUrl: '/ui/Interface/Icons/Ability_MeleeDamage.png', hotkey: '1', activeAttack: true },
        { slot: 1, iconUrl: '/ui/Interface/Icons/Ability_Rogue_Ambush.png', hotkey: '2', queued: true },
        { slot: 2, iconUrl: '/ui/Interface/Icons/Ability_Warrior_Charge.png', hotkey: '3', cooldown: { remainingMs: 5700, durationMs: 15000 } },
        { slot: 3, iconUrl: '/ui/Interface/Icons/Spell_Nature_ThunderClap.png', hotkey: '4', outOfRange: true },
        { slot: 4, iconUrl: mockItemIconUrl(118, 118), hotkey: '5', count: 4 },
        ...Array.from({ length: 7 }, (_, index) => ({ slot: index + 5, hotkey: ['6', '7', '8', '9', '0', '-', '='][index] })),
      ],
      microButtons: microIds.map((id) => ({ id, enabled: id !== 'help', open: id === 'character' })),
      bags: [
        { bagId: 0, isBackpack: true, hasBag: true, enabled: true, open: true },
        { bagId: 1, iconUrl: mockItemIconUrl(4498, 4498), hasBag: true, enabled: true },
        { bagId: 2, iconUrl: mockItemIconUrl(4498, 4498), hasBag: true, enabled: true },
        { bagId: 3, hasBag: false, enabled: false },
        { bagId: 4, hasBag: false, enabled: false },
      ],
      keyring: { visible: true, open: true },
    });
    return true;
  }

  if (which === 'bag') {
    const layer = query('#wow-container-layer'); const host = document.createElement('section');
    host.className = 'wow-container-frame has-canvas-ui'; host.style.cssText = 'right:40px;bottom:70px;width:192px;height:239px;';
    layer.appendChild(host); const stackSplit = new StackSplitCanvasPanel(hud, { playUi: () => {} });
    new BagCanvasPanel(host, {
      bagId: 0, name: 'Backpack', slotCount: 16, isBackpack: true, money: 35251,
      items: [2589, 1210, 6975, 7073, 828, 774, 118, 6948].map((entry, slot) => ({
        slot, iconUrl: mockItemIconUrl(entry, entry), count: slot === 0 ? 12 : 1,
        tooltip: () => itemTooltipLines(mockGetItemInfo(entry), entry, { count: slot === 0 ? 12 : 1, sellPrice: true }),
      })),
    }, { onSlotActivate: (action) => {
      if (action.button === 'left' && action.shiftKey && !action.ctrlKey && (action.item?.count ?? 0) > 1) stackSplit.show(action.item!.count!, () => {}, action.anchor);
    } });
    return true;
  }
  if (which === 'keyring') return showKeyringPreview(hud);
  if (which === 'character') {
    const honorPreview = new URLSearchParams(location.search).get('tab') === 'honor';
    const frame = query('#wow-character-frame');
    frame.classList.remove('is-hidden');
    frame.classList.add('has-canvas-ui');
    frame.querySelector<HTMLElement>('.wow-character-model')?.style.setProperty('display', 'none');
    const canvas = query<HTMLCanvasElement>('.wow-character-native-background');
    const renderer = new CharacterFrameCanvasRenderer(canvas);
    const equipmentEntries: Record<number, number> = { 0: 2361, 2: 828, 4: 6975, 15: 25, 16: 2362 };
    renderer.render(honorPreview ? 'honor' : 'character', {
      title: 'Thonk',
      subtitle: 'Level 12 Human Warrior',
      portraitUrl: '/ui/Interface/CharacterFrame/TemporaryPortrait-Male-Human.png',
      equipment: CHARACTER_EQUIPMENT_LAYOUT.map((layout) => {
        const entry = layout.inventoryIndex === undefined ? undefined : equipmentEntries[layout.inventoryIndex];
        return {
          id: layout.id, label: layout.label, disabled: layout.inventoryIndex === undefined,
          iconUrl: entry ? mockItemIconUrl(entry, entry) : undefined,
          quality: entry ? mockGetItemInfo(entry)?.quality : undefined,
          durability: entry ? 18 : undefined, maxDurability: entry ? 25 : undefined,
        };
      }),
      statColumns: [[
        { label: 'Strength', value: 32 }, { label: 'Agility', value: 24 }, { label: 'Stamina', value: 31 },
        { label: 'Intellect', value: 20 }, { label: 'Spirit', value: 23 }, { label: 'Armor', value: 684 },
      ], [
        { label: 'Melee Attack', value: 61 }, { label: 'Power', value: 96 }, { label: 'Damage', value: '19 - 28' },
        { label: 'Ranged Attack', value: 'N/A' }, { label: 'Power', value: 'N/A' }, { label: 'Damage', value: 'N/A' },
      ]],
      pages: honorPreview ? { honor: { heading: 'Honor', sections: [{ rows: [{ label: 'Rank', value: 'Private' }, { label: 'Rank Progress', value: '96/255' }, { label: 'Session HK', value: 4 }, { label: 'Session DK', value: 0 }, { label: 'Yesterday HK', value: 12 }, { label: 'Yesterday Honor', value: 387 }, { label: 'Week HK', value: 48 }, { label: 'Week Honor', value: 1432 }, { label: 'Last Week HK', value: 81 }, { label: 'Last Week Honor', value: 2650 }, { label: 'Standing', value: 214 }, { label: 'Lifetime HK', value: 614 }, { label: 'Lifetime DK', value: 2 }] }] } } : undefined,
    });
    return true;
  }
  if (which === 'spellbook') {
    const root = query('#wow-spellbook-frame');
    const controller = new SpellbookController({
      root,
      getWorld: () => ({ getKnownSpells: () => [6603, 78, 100, 772, 6673, 1715, 2457] } as never),
      getPlayer: () => ({ classId: 1, race: 1 } as never),
      actionCombat: () => ({ pickupSpellbookSpell: () => Promise.resolve() } as never),
      playUi: () => {},
    });
    controller.setOpen(true);
    return true;
  }

  if (showSocialPreview(which, query('#wow-social-frame'))) return true;

  if (which === 'menu' || which === 'video-options' || which === 'sound-options' || which === 'interface-options') {
    const menu = createGameMenu({
      onApplyVideo: () => {},
      onApplyInterface: () => {},
      onApplySound: () => {},
      getSoundSettings: () => ({ masterVolume: 1, sfxVolume: 0.8, musicVolume: 0.65, soundEnabled: true, musicEnabled: true }),
      playUi: () => false,
    });
    if (which === 'video-options') menu.openVideoOptions();
    else if (which === 'sound-options') menu.openSoundOptions();
    else if (which === 'interface-options') menu.openInterfaceOptions();
    else menu.openMenu();
    return true;
  }

  if (which === 'bank') {
    new BankCanvasPanel(query('#wow-bank-frame'), {
      playUi: () => {},
      getItemInfo: mockGetItemInfo,
      itemIconUrl: mockItemIconUrl,
    }).show(MOCK_BANK);
    return true;
  }
  if (which === 'trade') {
    new TradeCanvasPanel(query('#wow-trade-frame'), {
      playUi: () => {},
      getItemInfo: mockGetItemInfo,
      itemIconUrl: mockItemIconUrl,
      getAvailableMoney: () => 35_251,
      onMoneyChange: (copper) => { qaGlobals.__wowPreviewTradeMoney = copper; },
    }).show(MOCK_TRADE);
    return true;
  }
  if (which === 'questlog' || which === 'questlog-empty') {
    const controller = new QuestLogController({
      frame: query('#wow-quest-log-frame'),
      microButton: query<HTMLButtonElement>('.wow-micro-button--quest'),
      getWorld: () => ({
        getQuestLog: () => (which === 'questlog' ? MOCK_QUEST_LOG : { capacity: 20, entries: [] }),
        queryQuestInfo: () => {},
        removeQuestLogSlot: () => {},
        pushQuestToParty: () => {},
      }),
      getCurrentCharacter: () => ({ name: 'Thonk', level: 8 } as never),
      getPlayerLevel: () => 8,
      getAreaName: (areaId) => ({ 12: 'Zone_01', 40: 'Zone_04' })[areaId],
      getCurrentAreaName: () => 'Zone_01',
      questText: (text) => text.replace(/\$[Bb]/g, '\n'),
      getItemInfo: mockGetItemInfo,
      itemIconUrl: mockItemIconUrl,
      getItemName: (entry) => mockGetItemInfo(entry)?.name,
      confirmAbandon: (_message, onConfirm) => onConfirm(),
    });
    controller.setOpen(true);
    return true;
  }
  if (which === 'talents') {
    const controller = new TalentFrameController(query('#wow-talent-frame'), {
      playUi: () => {},
      getClassId: () => 1,
      getKnownSpells: () => [12282, 12285, 100, 284],
      getUnspentPoints: () => 12,
      learnTalent: () => {},
      getSpellName: (spellId) => MOCK_SPELL_NAMES[spellId] ?? `Talent Spell #${spellId}`,
      getSpellIconUrl: () => '/ui/Interface/Icons/INV_Sword_04.png',
    });
    controller.setOpen(true);
    return true;
  }
  if (which === 'tooltip') {
    const info = mockGetItemInfo(6975);
    getGameTooltip().show(itemTooltipLines(info, 6975, { count: 1, sellPrice: true }), 220, 180);
    return true;
  }

  const event = which === 'merchant' ? MOCK_VENDOR
    : which === 'trainer' ? MOCK_TRAINER
    : which === 'taxi' ? ({
      kind: 'taxi',
      // City_01 current node; word 0 bits mark a handful of Eastern Kingdoms
      // routes as discovered (Sentinel Hill 4, Lakeshire 5, City_03 6, ...).
      state: { guid: '0xF130000040', currentNode: 2, knownMask: [(1 << 2) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 12) | (1 << 14), 0, 0, 0, 0, 0, 0, 0] },
    } as InteractionEvent)
    : MOCK_LOOT[which] ? ({ kind: 'loot', state: MOCK_LOOT[which] } as InteractionEvent)
    : MOCK_EVENTS[which];
  if (!event) {
    // eslint-disable-next-line no-console
    console.warn(`[ui-preview] unknown panel "${which}". Try ?ui=loot|gossip|quest-greeting|quest-detail|quest-progress|quest-reward|merchant|trainer|tradeskill|beasttraining|bank|trade|questlog|popup|pet-unlearn|instance-boot|tooltip|menu|video-options|sound-options|keybindings|macros|mail`);
    return false;
  }

  const previewNpcPortrait = new Image();
  if (which === 'trainer' || which === 'merchant') previewNpcPortrait.src = '/ui/Interface/CharacterFrame/TemporaryPortrait-Male-Human.png';
  const stackSplit = new StackSplitCanvasPanel(hud, { playUi: () => {} });
  let npc: NpcInteractionController;
  previewNpcPortrait.addEventListener('load', () => npc?.rerender(), { once: true });
  npc = new NpcInteractionController({
    hosts: {
      gossipFrame: query('#wow-gossip-frame'),
      questFrame: query('#wow-quest-frame'),
      merchantFrame: query('#wow-merchant-frame'),
      trainerFrame: query('#wow-trainer-frame'),
      taxiFrame: query('#wow-taxi-frame'),
      lootFrame: query('#wow-loot-frame'),
      interactionPanel: query('#wow-interaction-panel'),
    },
    getWorld: () => ({
      releaseLoot: () => {}, lootItem: () => {}, lootMoney: () => {}, questCancel: () => {}, confirmSharedQuest: () => {},
      gossipSelect: () => {}, questQuery: () => {}, questRequestReward: () => {}, questAccept: () => {}, questComplete: () => {},
      questChooseReward: () => {}, buyVendorItem: () => {}, sellItem: () => {}, buyTrainerSpell: () => {}, activateTaxi: () => {},
      getBuybackItems: () => [], buybackItem: () => {}, repairAllItems: () => {}, repairItem: () => {},
      binderActivate: () => {}, confirmTalentWipe: () => {}, confirmPetUnlearn: () => {},
    }),
    getItemInfo: mockGetItemInfo,
    itemIconUrl: mockItemIconUrl,
    getItemName: (entry) => mockGetItemInfo(entry)?.name,
    getSpellName: (spellId) => MOCK_SPELL_NAMES[spellId] ?? `Spell #${spellId}`,
    getSpellIconUrl: () => '/ui/Interface/Icons/INV_Sword_04.png',
    getUnitName: () => ({
      gossip: 'Marshal Dughan', 'quest-greeting': 'Ma Stonefield', 'quest-detail': 'Marshal Dughan',
      'quest-progress': 'Sergeant Willem', 'quest-reward': 'Ma Stonefield', merchant: 'Corina Steele',
    })[which] ?? 'Zone_01 Villager',
    getUnitPortraitSource: () => previewNpcPortrait.complete && previewNpcPortrait.naturalWidth ? previewNpcPortrait : undefined,
    getPlayerMoney: () => 35251, requestStackSplit: (max, onSplit, anchor) => stackSplit.show(max, onSplit, anchor),
    questText: (text) => text.replace(/\$[Bb]/g, '\n'),
  });
  if (which === 'instance-boot') npc.forceNotice("You are not in this instance's group.  You will be teleported to Goldshire in 1 Minute."); else npc.render(event);
  return true;
}
