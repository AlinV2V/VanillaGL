import type { CharacterInfo, InventoryBag, InventorySnapshot, InventorySlot, WorldEntity } from '../world';
import type { InventoryCursorController } from './inventory-cursor';
import { attackSpeeds, damagePerSecond } from '../combat/attack-speed';
import { containerFrameSpecFor } from './container-frame-geometry';
import { inventoryBagForId } from './keyring-state';

type PaperdollSlotConfig = {
  label: string;
  inventoryIndex?: number;
  texture: string;
  left: number;
  top: number;
  size?: number;
};

const PLAYER_BAG = 255;

const PAPERDOLL_SLOT_CONFIGS: PaperdollSlotConfig[] = [
  { label: 'Head', inventoryIndex: 0, texture: 'UI-PaperDoll-Slot-Head', left: 21, top: 74 },
  { label: 'Neck', inventoryIndex: 1, texture: 'UI-PaperDoll-Slot-Neck', left: 21, top: 115 },
  { label: 'Shoulders', inventoryIndex: 2, texture: 'UI-PaperDoll-Slot-Shoulder', left: 21, top: 156 },
  { label: 'Back', inventoryIndex: 14, texture: 'UI-PaperDoll-Slot-Chest', left: 21, top: 197 },
  { label: 'Chest', inventoryIndex: 4, texture: 'UI-PaperDoll-Slot-Chest', left: 21, top: 238 },
  { label: 'Shirt', inventoryIndex: 3, texture: 'UI-PaperDoll-Slot-Shirt', left: 21, top: 279 },
  { label: 'Tabard', inventoryIndex: 18, texture: 'UI-PaperDoll-Slot-Tabard', left: 21, top: 320 },
  { label: 'Wrists', inventoryIndex: 8, texture: 'UI-PaperDoll-Slot-Wrists', left: 21, top: 361 },
  { label: 'Hands', inventoryIndex: 9, texture: 'UI-PaperDoll-Slot-Hands', left: 305, top: 74 },
  { label: 'Waist', inventoryIndex: 5, texture: 'UI-PaperDoll-Slot-Waist', left: 305, top: 115 },
  { label: 'Legs', inventoryIndex: 6, texture: 'UI-PaperDoll-Slot-Legs', left: 305, top: 156 },
  { label: 'Feet', inventoryIndex: 7, texture: 'UI-PaperDoll-Slot-Feet', left: 305, top: 197 },
  { label: 'Finger 1', inventoryIndex: 10, texture: 'UI-PaperDoll-Slot-Finger', left: 305, top: 238 },
  { label: 'Finger 2', inventoryIndex: 11, texture: 'UI-PaperDoll-Slot-Finger', left: 305, top: 279 },
  { label: 'Trinket 1', inventoryIndex: 12, texture: 'UI-PaperDoll-Slot-Trinket', left: 305, top: 320 },
  { label: 'Trinket 2', inventoryIndex: 13, texture: 'UI-PaperDoll-Slot-Trinket', left: 305, top: 361 },
  { label: 'Main Hand', inventoryIndex: 15, texture: 'UI-PaperDoll-Slot-MainHand', left: 122, top: 385 },
  { label: 'Off Hand', inventoryIndex: 16, texture: 'UI-PaperDoll-Slot-SecondaryHand', left: 164, top: 385 },
  { label: 'Ranged', inventoryIndex: 17, texture: 'UI-PaperDoll-Slot-Ranged', left: 206, top: 385 },
  { label: 'Ammo', texture: 'UI-PaperDoll-Slot-Ammo', left: 258, top: 390, size: 27 },
];

export type InventoryUiElements = {
  characterName: HTMLElement;
  characterSubtitle: HTMLElement;
  characterPortrait: HTMLElement;
  paperdollSlots: HTMLElement;
  characterStats: HTMLElement;
  containerLayer: HTMLElement;
  backpackButton: HTMLButtonElement;
  bagSlotButtons: HTMLButtonElement[];
};

export type InventoryUiControllerDeps = {
  elements: InventoryUiElements;
  cursor: InventoryCursorController;
  getInventory: () => InventorySnapshot | undefined;
  getCurrentCharacter: () => CharacterInfo | undefined;
  getPlayerEntity: () => WorldEntity | undefined;
  getDraggedFramePosition: (frameId: string) => { left: number; top: number } | undefined;
  setLastInventory: (snapshot: InventorySnapshot) => void;
  escapeHtml: (value: string) => string;
  itemIconStyle: (displayInfoId?: number, entry?: number) => string;
  itemName: (slot: InventorySlot) => string;
  portraitRaceName: (race: number) => string;
  raceName: (race: number) => string;
  className: (classId: number) => string;
  renderSmallMoneyFrame: (copper: number) => string;
  slotTooltipText: (slot: InventorySlot) => string;
  /** Mount the native canvas surfaces after the positioning hosts are rebuilt. */
  onBagFramesRendered?: (snapshot: InventorySnapshot | undefined, visibleBagIds: readonly number[]) => void;
};

export class InventoryUiController {
  private readonly openBagIds = new Set<number>();

  constructor(private readonly deps: InventoryUiControllerDeps) {}

  hasOpenBags() {
    return this.openBagIds.size > 0;
  }

  isBagOpen(bagId: number) { return this.openBagIds.has(bagId); }

  toggleBackpack(allBags: boolean) {
    if (!allBags) {
      if (this.openBagIds.has(0)) this.setAllBagsOpen(false);
      else this.setBagOpen(0, true);
      return;
    }
    const available = (this.deps.getInventory()?.bags ?? []).filter((bag) => bag.isBackpack || !!bag.itemGuid);
    this.setAllBagsOpen(!available.length || !available.every((bag) => this.openBagIds.has(bag.index)));
  }

  render(snapshot = this.deps.getInventory()) {
    if (!snapshot) return;
    this.deps.setLastInventory(snapshot);
    this.renderCharacterFrame(snapshot);
    this.renderOpenBags(snapshot);
  }

  renderCharacterFrame(snapshot = this.deps.getInventory()) {
    if (!snapshot) return;
    this.deps.setLastInventory(snapshot);
    const { characterName, characterSubtitle, characterPortrait, paperdollSlots, characterStats } = this.deps.elements;
    const currentCharacter = this.deps.getCurrentCharacter();
    const playerEntity = this.deps.getPlayerEntity();
    characterName.textContent = currentCharacter ? currentCharacter.name : 'Character';
    if (currentCharacter) {
      const genderName = currentCharacter.gender === 1 ? 'Female' : 'Male';
      characterPortrait.style.backgroundImage = `url('/ui/Interface/CharacterFrame/TemporaryPortrait-${genderName}-${this.deps.portraitRaceName(currentCharacter.race)}.png')`;
    }
    paperdollSlots.innerHTML = PAPERDOLL_SLOT_CONFIGS
      .map((config) => {
        const slot = config.inventoryIndex !== undefined ? snapshot.equipment[config.inventoryIndex] ?? this.emptySlot(config.label, config.inventoryIndex) : this.emptySlot(config.label);
        const size = config.size ?? 37;
        const style = `left:${config.left}px;top:${config.top}px;width:${size}px;height:${size}px;--slot-empty:url('/ui/Interface/PaperDoll/${config.texture}.png');`;
        return this.renderInventorySlot(slot, 'wow-paperdoll-slot', style);
      })
      .join('');
    if (currentCharacter) {
      const lvl = playerEntity?.level ?? currentCharacter.level;
      characterSubtitle.textContent = `Level ${lvl} ${this.deps.raceName(currentCharacter.race)} ${this.deps.className(currentCharacter.classId)}`;
    } else {
      characterSubtitle.textContent = '';
    }
    characterStats.innerHTML = currentCharacter ? this.renderCharacterStats(playerEntity) : '';
  }

  renderOpenBags(snapshot = this.deps.getInventory()) {
    const { containerLayer } = this.deps.elements;
    if (!snapshot) {
      containerLayer.innerHTML = '';
      this.refreshBagButtons(undefined);
      this.deps.onBagFramesRendered?.(undefined, []);
      return;
    }
    this.deps.setLastInventory(snapshot);
    const visibleIds = [...this.openBagIds]
      .sort((a, b) => a - b)
      .filter((id) => {
        const bag = inventoryBagForId(snapshot, id);
        return !!bag && (bag.isBackpack || bag.isKeyring || !!bag.itemGuid);
      });
    containerLayer.innerHTML = visibleIds.map((id, frameIndex) => this.renderContainerFrame(inventoryBagForId(snapshot, id)!, frameIndex, snapshot.money)).join('');
    this.refreshBagButtons(snapshot);
    this.deps.onBagFramesRendered?.(snapshot, visibleIds);
  }

  setBagOpen(bagId: number, open: boolean) {
    const snapshot = this.deps.getInventory();
    const bag = snapshot ? inventoryBagForId(snapshot, bagId) : undefined;
    if (open && (!bag || (!bag.isBackpack && !bag.isKeyring && !bag.itemGuid))) return;
    if (open) this.openBagIds.add(bagId);
    else this.openBagIds.delete(bagId);
    this.renderOpenBags(snapshot);
  }

  toggleBag(bagId: number) {
    this.setBagOpen(bagId, !this.openBagIds.has(bagId));
  }

  setAllBagsOpen(open: boolean) {
    const snapshot = this.deps.getInventory();
    this.openBagIds.clear();
    if (open && snapshot) {
      for (const bag of snapshot.bags) {
        if (bag.isBackpack || bag.itemGuid) this.openBagIds.add(bag.index);
      }
    }
    this.renderOpenBags(snapshot);
  }

  refreshBagButtons(snapshot = this.deps.getInventory()) {
    const { backpackButton, bagSlotButtons } = this.deps.elements;
    backpackButton.classList.toggle('is-open', this.openBagIds.has(0));
    backpackButton.title = 'Backpack';
    for (const [index, button] of bagSlotButtons.entries()) {
      const bagId = index + 1;
      const bag = snapshot?.bags[bagId];
      const hasBag = !!bag?.itemGuid;
      const iconStyle = hasBag ? this.deps.itemIconStyle(bag?.item?.info?.displayInfoId, bag?.item?.entry) : '';
      button.classList.toggle('is-open', this.openBagIds.has(bagId));
      button.classList.toggle('has-bag', hasBag);
      button.classList.toggle('has-icon', !!iconStyle);
      if (iconStyle) button.setAttribute('style', iconStyle.replace('--item-icon', '--bag-icon'));
      else button.removeAttribute('style');
      button.title = hasBag && bag ? this.bagDisplayName(bag) : `Bag Slot ${bagId}`;
    }
    this.deps.cursor.refreshHeldSourceMarks();
  }

  private emptySlot(label: string, index = -1): InventorySlot {
    return {
      container: 'equipment',
      index,
      protocolBag: PLAYER_BAG,
      protocolSlot: 0,
      label,
    };
  }

  private renderInventorySlot(slot: InventorySlot, extraClass = '', style = '') {
    const item = slot.item;
    const info = item?.info;
    const quality = Math.max(0, Math.min(6, info?.quality ?? 1));
    const name = this.deps.itemName(slot);
    const glyphSource = name || slot.label;
    const glyph = item ? this.deps.escapeHtml(glyphSource.trim().slice(0, 2).toUpperCase() || '?') : '';
    const count = item && item.count > 1 ? `<span class="wow-inventory-count">${item.count}</span>` : '';
    const iconStyle = item ? this.deps.itemIconStyle(info?.displayInfoId, item.entry) : '';
    const styleAttr = style || iconStyle ? ` style="${style}${iconStyle}"` : '';
    const details = this.deps.slotTooltipText(slot);
    const heldClass = this.deps.cursor.heldSourceMatches(slot) ? ' is-held-source' : '';
    const actionAttrs =
      ` data-item-container="${slot.container}" data-item-index="${slot.index}" data-item-bag="${slot.protocolBag}" data-item-slot="${slot.protocolSlot}"` +
      (item?.entry ? ` data-item-entry="${item.entry}" data-item-guid="${this.deps.escapeHtml(item.guid)}"` : '');
    return (
      `<button class="wow-inventory-slot wow-item-slot ${extraClass} ${item ? 'has-item' : 'is-empty'} ${iconStyle ? 'has-icon' : ''} quality-${quality}${heldClass}" type="button"${styleAttr}${actionAttrs} aria-label="${this.deps.escapeHtml(details)}" data-tooltip="${this.deps.escapeHtml(details)}">` +
        `<span class="wow-inventory-glyph">${glyph}</span>${count}` +
      `</button>`
    );
  }

  private renderCharacterStats(entity: WorldEntity | undefined) {
    const stat = (v?: number) => (v === undefined ? '-' : String(v));
    const dmg = (lo?: number, hi?: number) =>
      lo === undefined || hi === undefined ? 'N/A' : `${Math.round(lo)} - ${Math.round(hi)}`;
    const row = (label: string, value: string) => `<div><span>${label}</span><strong>${this.deps.escapeHtml(value)}</strong></div>`;
    const hasRanged = !!entity?.rangedAttackPower;
    // UNIT_FIELD_BASEATTACKTIME / _RANGEDATTACKTIME are the only place haste is visible: Flurry,
    // Windfury and Slice and Dice all move these and nothing else on screen. Vanilla prints the
    // main-hand speed to one decimal (PaperDollFrame.lua:486) and derives DPS from it (:378).
    const speeds = attackSpeeds(entity);
    const speed = (seconds?: number) => (seconds === undefined ? 'N/A' : seconds.toFixed(1));
    const dps = (lo?: number, hi?: number, seconds?: number) => {
      const value = damagePerSecond(lo, hi, seconds);
      return value === undefined ? 'N/A' : value.toFixed(1);
    };
    // Label text, transcribed rather than remembered:
    //   attributes  — PaperDollFrame.lua:182 does `SetText(SPELL_STATn_NAME .. ":")`, so the
    //                 five attribute rows carry a colon even though SPELL_STATn_NAME does not.
    //   Armor/Power/Damage — PaperDollFrame.lua:7-13 uses ARMOR_COLON "Armor:",
    //                 ATTACK_POWER_COLON "Power:", DAMAGE_COLON "Damage:".
    //   Melee Attack / Ranged Attack — MELEE_ATTACK / RANGED_ATTACK, genuinely colonless.
    // Speed and DPS have no vanilla counterpart: PaperDollFrame.xml defines only Armor, Attack,
    // AttackPower, Damage, RangedAttack, RangedAttackPower and RangedDamage. Left unlabelled-style
    // pending a decision on whether those four extra rows should exist at all.
    return (
      `<div class="wow-char-stat-col">` +
        row('Strength:', stat(entity?.strength)) +
        row('Agility:', stat(entity?.agility)) +
        row('Stamina:', stat(entity?.stamina)) +
        row('Intellect:', stat(entity?.intellect)) +
        row('Spirit:', stat(entity?.spirit)) +
        row('Armor:', stat(entity?.armor)) +
      `</div><div class="wow-char-stat-col">` +
        row('Melee Attack', '-') +
        row('Power:', stat(entity?.attackPower)) +
        row('Damage:', dmg(entity?.minDamage, entity?.maxDamage)) +
        row('Speed', speed(speeds.mainHand)) +
        row('DPS', dps(entity?.minDamage, entity?.maxDamage, speeds.mainHand)) +
        row('Ranged Attack', hasRanged ? '-' : 'N/A') +
        row('Power:', hasRanged ? stat(entity?.rangedAttackPower) : 'N/A') +
        row('Damage:', hasRanged ? dmg(entity?.minRangedDamage, entity?.maxRangedDamage) : 'N/A') +
        row('Speed', hasRanged ? speed(speeds.ranged) : 'N/A') +
        row('DPS', hasRanged ? dps(entity?.minRangedDamage, entity?.maxRangedDamage, speeds.ranged) : 'N/A') +
      `</div>`
    );
  }

  /** Host geometry follows the same Build-5875 component-atlas formula as BagCanvasPanel. */
  private containerFrameSettings(bag: InventoryBag): { texture: string; height: number } {
    const spec = containerFrameSpecFor(bag.size, bag.isBackpack);
    return { texture: bag.isBackpack ? 'UI-BackpackBackground' : `UI-Bag-Components${bag.isKeyring ? '-Keyring' : ''}`, height: spec.frameHeight };
  }

  private bagFrameHeight(bag: InventoryBag) {
    return this.containerFrameSettings(bag).height;
  }

  private bagDisplayName(bag: InventoryBag) {
    return bag.isKeyring ? 'Keyring' : bag.isBackpack ? 'Backpack' : bag.item?.info?.name ?? (bag.itemGuid ? 'Loading Bag' : bag.label);
  }

  private bagBackgroundName(bag: InventoryBag) {
    return this.containerFrameSettings(bag).texture;
  }

  private renderContainerFrame(bag: InventoryBag, frameIndex: number, money = 0) {
    const width = 192;
    const height = this.bagFrameHeight(bag);
    const bottom = 70;
    const right = frameIndex * 192;
    const frameId = `bag-${bag.index}`;
    const dragged = this.deps.getDraggedFramePosition(frameId);
    const bottomInset = bag.isBackpack ? 30 : 9;
    const items = bag.slots.map((slot, slotIndex) => {
      const cell = bag.slots.length - 1 - slotIndex;
      const col = cell % 4;
      const row = Math.floor(cell / 4);
      const left = width - 12 - 37 - col * 42;
      const top = height - bottomInset - 37 - row * 41;
      return this.renderInventorySlot(slot, 'wow-container-slot', `left:${left}px;top:${top}px;--slot-empty:url('/ui/Interface/PaperDoll/UI-Backpack-EmptySlot.png');`);
    }).join('');
    const emptyBody = !bag.isBackpack && bag.size === 0 ? '<div class="wow-container-empty">Empty</div>' : '';
    const placement = dragged ? `left:${dragged.left}px;top:${dragged.top}px;` : `right:${right}px;bottom:${bottom}px;`;
    const backgroundPath = `/ui/Interface/ContainerFrame/${this.bagBackgroundName(bag)}.png`;
    const style = `${placement}width:${width}px;height:${height}px;`;
    const portraitStyle = bag.isBackpack
      ? "--bag-portrait:url('/ui/Interface/Buttons/Button-Backpack-Up.png');"
      : bag.isKeyring ? "--bag-portrait:url('/ui/Interface/ContainerFrame/KeyRing-Bag-Icon.png');" : this.deps.itemIconStyle(bag.item?.info?.displayInfoId, bag.item?.entry);
    const moneyFrame = bag.isBackpack ? this.deps.renderSmallMoneyFrame(money) : '';
    return (
      `<section class="wow-container-frame ${bag.isBackpack ? 'is-backpack' : ''} ${bag.isKeyring ? 'is-keyring' : ''}" data-frame-id="${frameId}" data-bag-id="${bag.index}" style="${style}">` +
        `<canvas class="wow-container-native-background" width="${width}" height="${height}" data-background="${backgroundPath}" aria-hidden="true"></canvas>` +
        `<div class="wow-container-portrait ${portraitStyle ? 'has-icon' : ''}"${portraitStyle ? ` style="${portraitStyle}"` : ''}></div>` +
        `<div class="wow-container-title">${this.deps.escapeHtml(this.bagDisplayName(bag))}</div>` +
        `<button class="wow-frame-close wow-container-close" type="button" data-bag-close="${bag.index}">x</button>` +
        `${items}${emptyBody}${moneyFrame}` +
      `</section>`
    );
  }

}
