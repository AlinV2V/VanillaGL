import * as THREE from 'three';
import { CharacterPreview } from '../login/CharacterPreview';
import { effectivePreviewPixelRatio } from '../platform/mobile-render-policy';
import { renderAuxiliaryCanvas } from './auxiliary-renderer';
import type { CharacterInfo, WorldEntity } from '../world';

export type CharTab = 'character' | 'pet' | 'reputation' | 'skills' | 'honor';

export type IngameHudElementDeps = {
  renderer: THREE.WebGLRenderer;
  worldMap: { element: HTMLElement };
  getCurrentCharacter: () => CharacterInfo | undefined;
};

export const getIngameHudElements = (ingameHud: HTMLElement, deps: IngameHudElementDeps) => {
  const { renderer, worldMap, getCurrentCharacter } = deps;
  const hudEl = <T extends HTMLElement>(selector: string) => {
    const el = ingameHud.querySelector<T>(selector);
    if (!el) throw new Error(`missing HUD node ${selector}`);
    return el;
  };
  const playerFrame = hudEl<HTMLDivElement>('#wow-player-frame');
  const pfName = hudEl<HTMLElement>('[data-pf="name"]');
  const pfLevel = hudEl<HTMLElement>('[data-pf="level"]');
  const pfHp = hudEl<HTMLElement>('[data-pf="hp"]');
  const pfHpText = hudEl<HTMLElement>('[data-pf="hpText"]');
  const pfPower = hudEl<HTMLElement>('[data-pf="power"]');
  const pfPowerText = hudEl<HTMLElement>('[data-pf="powerText"]');
  const pfPvp = hudEl<HTMLElement>('[data-pf="pvp"]');
  const targetFrame = hudEl<HTMLDivElement>('#wow-target-frame');
  const tfName = hudEl<HTMLElement>('[data-tf="name"]');
  const tfLevel = hudEl<HTMLElement>('[data-tf="level"]');
  const tfHp = hudEl<HTMLElement>('[data-tf="hp"]');
  const tfHpText = hudEl<HTMLElement>('[data-tf="hpText"]');
  const tfPower = hudEl<HTMLElement>('[data-tf="power"]');
  const tfPowerText = hudEl<HTMLElement>('[data-tf="powerText"]');
  const tfPvp = hudEl<HTMLElement>('[data-tf="pvp"]');
  const tfSkull = hudEl<HTMLElement>('[data-tf="skull"]');
  const tfArt = targetFrame.querySelector<HTMLElement>('.wow-unit-art');
  const totFrame = hudEl<HTMLElement>('#wow-tot-frame');
  // PvP / FFA badge, mirroring vanilla TargetFrame.lua: FFA shows the skull badge,
  // otherwise the flagged unit's faction badge by team. Race->team per vMaNGOS.
  const UNIT_BYTE2_FLAG_PVP = 0x01;
  const UNIT_BYTE2_FLAG_FFA_PVP = 0x04;
  const ALLIANCE_RACES = new Set([1, 3, 4, 7]); // Human, Dwarf, Night Elf, Gnome
  const HORDE_RACES = new Set([2, 5, 6, 8]); // Orc, Undead, Tauren, Troll
  const PVP_ICON_BASE = '/ui/Interface/TargetingFrame/UI-PVP';
  // Name-background tint per 1.12 TargetFrame_CheckFaction / UnitReactionColor
  // (hostile red, neutral yellow, friendly green), darkened so white text reads.
  const TARGET_NAME_BG: Record<'hostile' | 'neutral' | 'friendly', string> = {
    hostile: 'rgba(170, 0, 0, 0.55)',
    neutral: 'rgba(168, 160, 0, 0.5)',
    friendly: 'rgba(0, 132, 0, 0.5)',
  };
  const TAPPED_NAME_BG = 'rgba(128, 128, 128, 0.5)';
  const applyPvpBadge = (el: HTMLElement, entity: WorldEntity) => {
    const flags = entity.pvpFlags ?? 0;
    let icon: string | undefined;
    if (flags & UNIT_BYTE2_FLAG_FFA_PVP) icon = `${PVP_ICON_BASE}-FFA.png`;
    else if (flags & UNIT_BYTE2_FLAG_PVP) {
      if (ALLIANCE_RACES.has(entity.race ?? -1)) icon = `${PVP_ICON_BASE}-Alliance.png`;
      else if (HORDE_RACES.has(entity.race ?? -1)) icon = `${PVP_ICON_BASE}-Horde.png`;
    }
    if (icon) {
      el.style.backgroundImage = `url('${icon}')`;
      el.classList.remove('is-hidden');
    } else {
      el.classList.add('is-hidden');
    }
  };
  // Vanilla CreatureEliteType -> target frame border art (real extracted assets).
  // 0 normal, 1 elite, 2 rare-elite, 3 world boss, 4 rare. Elite/rare-elite/boss
  // share the gold dragon frame; rare uses the silver frame.
  const TARGET_FRAME_ART = '/ui/Interface/TargetingFrame/UI-TargetingFrame.png';
  const ELITE_FRAME_ART: Record<number, string> = {
    1: '/ui/Interface/TargetingFrame/UI-TargetingFrame-Elite.png',
    2: '/ui/Interface/TargetingFrame/UI-TargetingFrame-Elite.png',
    3: '/ui/Interface/TargetingFrame/UI-TargetingFrame-Elite.png',
    4: '/ui/Interface/TargetingFrame/UI-TargetingFrame-Rare.png',
  };
  const buffsEl = hudEl<HTMLDivElement>('#wow-buffs');
  const castBar = hudEl<HTMLDivElement>('#wow-cast-bar');
  const castSpellName = hudEl<HTMLElement>('.wow-cast-spell-name');
  const castFill = hudEl<HTMLElement>('.wow-cast-fill');
  const questWatch = hudEl<HTMLDivElement>('#wow-quest-watch');
  const questProgress = hudEl<HTMLDivElement>('#wow-quest-progress');
  const chatBox = hudEl<HTMLDivElement>('#wow-chat-box');
  const chatMessages = hudEl<HTMLDivElement>('#wow-chat-messages');
  const chatInput = hudEl<HTMLInputElement>('#wow-chat-input');
  const mainMenuBar = hudEl<HTMLDivElement>('#wow-main-menu-bar');
  const actionBar = hudEl<HTMLDivElement>('#wow-action-bar');
  const characterFrame = hudEl<HTMLDivElement>('#wow-character-frame');
  const characterName = hudEl<HTMLElement>('#wow-character-name');
  const characterSubtitle = hudEl<HTMLElement>('#wow-character-subtitle');
  const characterPortrait = hudEl<HTMLDivElement>('#wow-character-portrait');
  const characterClose = hudEl<HTMLButtonElement>('#wow-character-close');
  const paperdollSlots = hudEl<HTMLDivElement>('#wow-paperdoll-slots');
  const characterStats = hudEl<HTMLDivElement>('#wow-character-stats');
  const characterModelEl = characterFrame.querySelector<HTMLElement>('.wow-character-model');
  // Live 3D paper-doll: reuses the login CharacterPreview, drawn into the model
  // box's screen rect each frame (the box is near-transparent so the canvas shows
  // through). A detached canvas is passed so its drag-rotate input can't fight the
  // world camera — the doll just slow-rotates.
  let paperdollPreview: CharacterPreview | null = null;
  let paperdollCanvas: HTMLCanvasElement | null = null;
  let paperdollLoadedFor: string | undefined;
  const ensurePaperdoll = () => {
    const currentCharacter = getCurrentCharacter();
    if (!currentCharacter || !characterModelEl) return;
    if (!paperdollPreview || !paperdollCanvas) {
      const canvas = characterModelEl.querySelector('canvas') as HTMLCanvasElement;
      paperdollCanvas = canvas;
      paperdollPreview = new CharacterPreview(canvas, renderer.capabilities.getMaxAnisotropy());
      paperdollPreview.setAutoRotate(false); // Vanilla paper-doll faces forward, static.
    }
    const key = String(currentCharacter.guid ?? currentCharacter.name);
    if (paperdollLoadedFor !== key) {
      paperdollLoadedFor = key;
      void paperdollPreview.loadCharacter(currentCharacter);
    }
  };
  const renderPaperdoll = (dt: number, visible: boolean) => {
    if (!visible || !paperdollPreview || !paperdollCanvas) return;
    paperdollPreview.update(dt);
    const rect = characterModelEl!.getBoundingClientRect(), ratio = effectivePreviewPixelRatio(window.devicePixelRatio);
    renderAuxiliaryCanvas(paperdollCanvas, (rect.width || 233) * ratio, (rect.height || 224) * ratio, 0, 0,
      (renderer, width, height) => paperdollPreview!.render(renderer, 0, 0, width, height));
  };
  const rotatePaperdoll = (direction: 'left' | 'right') => {
    ensurePaperdoll();
    if (!paperdollPreview) return;
    if (direction === 'left') paperdollPreview.rotateLeft(0.28);
    else paperdollPreview.rotateRight(0.28);
  };
  const characterTabButtons = Array.from(ingameHud.querySelectorAll<HTMLButtonElement>('.wow-character-tab'));
  const charPages: Record<CharTab, HTMLElement> = {
    character: hudEl<HTMLDivElement>('.wow-char-page--character'),
    pet: hudEl<HTMLDivElement>('#wow-char-page-pet'),
    reputation: hudEl<HTMLDivElement>('#wow-char-page-reputation'),
    skills: hudEl<HTMLDivElement>('#wow-char-page-skills'),
    honor: hudEl<HTMLDivElement>('#wow-char-page-honor'),
  };
  const microCharacter = hudEl<HTMLButtonElement>('.wow-micro-button--character');
  const microWorld = hudEl<HTMLButtonElement>('.wow-micro-button--world');
  worldMap.element.addEventListener('wow-world-map-toggle', (event) => {
    microWorld.classList.toggle('is-open', !!(event as CustomEvent<{ open: boolean }>).detail.open);
  });
  const containerLayer = hudEl<HTMLDivElement>('#wow-container-layer');
  const bagSlotButtons = Array.from(ingameHud.querySelectorAll<HTMLButtonElement>('.wow-bag-button'));
  const backpackButton = hudEl<HTMLButtonElement>('.wow-backpack-button');
  const lootFrame = hudEl<HTMLDivElement>('#wow-loot-frame');
  const questLogFrame = hudEl<HTMLDivElement>('#wow-quest-log-frame');
  const microQuest = hudEl<HTMLButtonElement>('.wow-micro-button--quest');
  const merchantFrame = hudEl<HTMLDivElement>('#wow-merchant-frame');
  const trainerFrame = hudEl<HTMLDivElement>('#wow-trainer-frame');
  const gossipFrame = hudEl<HTMLDivElement>('#wow-gossip-frame');
  const questFrame = hudEl<HTMLDivElement>('#wow-quest-frame');
  const talentFrame = hudEl<HTMLDivElement>('#wow-talent-frame');
  const taxiFrame = hudEl<HTMLDivElement>('#wow-taxi-frame');
  const bankFrame = hudEl<HTMLDivElement>('#wow-bank-frame');
  const tradeFrame = hudEl<HTMLDivElement>('#wow-trade-frame');
  const inspectFrame = hudEl<HTMLDivElement>('#wow-inspect-frame');
  const interactionPanel = hudEl<HTMLDivElement>('#wow-interaction-panel');
  const logoutPopup = hudEl<HTMLDivElement>('#wow-logout-popup');
  const gameTooltip = hudEl<HTMLDivElement>('#wow-game-tooltip');

  return {
    playerFrame,
    pfName,
    pfLevel,
    pfHp,
    pfHpText,
    pfPower,
    pfPowerText,
    pfPvp,
    targetFrame,
    tfName,
    tfLevel,
    tfHp,
    tfHpText,
    tfPower,
    tfPowerText,
    tfPvp,
    tfSkull,
    tfArt,
    totFrame,
    UNIT_BYTE2_FLAG_PVP,
    UNIT_BYTE2_FLAG_FFA_PVP,
    ALLIANCE_RACES,
    HORDE_RACES,
    PVP_ICON_BASE,
    TARGET_NAME_BG,
    TAPPED_NAME_BG,
    applyPvpBadge,
    TARGET_FRAME_ART,
    ELITE_FRAME_ART,
    buffsEl,
    castBar,
    castSpellName,
    castFill,
    questWatch,
    questProgress,
    chatBox,
    chatMessages,
    chatInput,
    mainMenuBar,
    actionBar,
    characterFrame,
    characterName,
    characterSubtitle,
    characterPortrait,
    characterClose,
    paperdollSlots,
    characterStats,
    characterModelEl,
    ensurePaperdoll,
    renderPaperdoll,
    rotatePaperdoll,
    characterTabButtons,
    charPages,
    microCharacter,
    microWorld,
    containerLayer,
    bagSlotButtons,
    backpackButton,
    lootFrame,
    questLogFrame,
    microQuest,
    merchantFrame,
    trainerFrame,
    gossipFrame,
    questFrame,
    talentFrame,
    taxiFrame,
    bankFrame,
    tradeFrame,
    inspectFrame,
    interactionPanel,
    logoutPopup,
    gameTooltip,
  };
};
