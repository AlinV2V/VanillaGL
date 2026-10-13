/** Asset conversion utility. */
import type { BuybackItem, InteractionEvent, ItemInfo } from '../world';
import { binderConfirmation } from '../world/player-services';
import { GossipCanvasPanel } from './gossip-frame';
import { ItemTextCanvasPanel } from './item-text-frame';
import { LootCanvasPanel } from './loot-frame';
import { MerchantCanvasPanel } from './merchant-frame';
import { QuestCanvasPanel } from './quest-frame';
import { StaticPopupPanel } from './static-popup';
import type { StackSplitAnchor } from './stack-split-frame';
import { TaxiCanvasPanel } from './taxi-frame';
import { TrainerCanvasPanel } from './trainer-frame';

export type NpcInteractionWorld = {
  getBuybackItems(): BuybackItem[];
  buybackItem(vendorGuid: string, slot: number): void;
  repairAllItems(vendorGuid: string): void;
  repairItem(vendorGuid: string, itemGuid: string): void;
  releaseLoot(guid: string): void;
  lootItem(slot: number): void;
  lootMoney(): void;
  questCancel(sharedByGuid?: string): void;
  confirmSharedQuest(questId: number): void;
  gossipSelect(guid: string, optionIndex: number, code?: string): void;
  questQuery(guid: string, questId: number): void;
  questRequestReward(guid: string, questId: number): void;
  questAccept(guid: string, questId: number): void;
  questComplete(guid: string, questId: number): void;
  questChooseReward(guid: string, questId: number, rewardIndex: number): void;
  buyVendorItem(guid: string, entry: number, count?: number): void;
  sellItem(vendorGuid: string, itemGuid: string, count?: number): void;
  buyTrainerSpell(guid: string, spellId: number): void;
  activateTaxi(guid: string, sourceNode: number, destinationNode: number): void;
  binderActivate(guid: string): void;
  confirmTalentWipe(trainerGuid: string): void;
  confirmPetUnlearn(petGuid: string): void;
};

export type NpcInteractionHosts = {
  gossipFrame: HTMLElement;
  questFrame: HTMLElement;
  merchantFrame: HTMLElement;
  trainerFrame: HTMLElement;
  taxiFrame: HTMLElement;
  lootFrame: HTMLElement;
  interactionPanel: HTMLElement;
};

export type NpcInteractionDeps = {
  hosts: NpcInteractionHosts;
  getWorld: () => NpcInteractionWorld | undefined;
  getItemInfo: (entry: number) => ItemInfo | undefined;
  itemIconUrl: (displayInfoId?: number, entry?: number) => string;
  getItemName: (entry: number) => string | undefined;
  getSpellName: (spellId: number) => string;
  getSpellIconUrl: (spellId: number) => string | undefined;
  getUnitName: (guid: string) => string | undefined;
  getUnitPortraitSource?: (guid: string) => CanvasImageSource | undefined;
  getPlayerMoney: () => number;
  requestStackSplit: (maxStack: number, onSplit: (count: number) => void, anchor: StackSplitAnchor) => void;
  questText: (text: string) => string;
  playUi?: (name: string) => boolean;
  masterLootItem?: (lootGuid: string, slot: number, entry: number) => void;
  junkCount?: () => number;
  sellJunk?: (vendorGuid: string) => void;
};

export class NpcInteractionController {
  private lastInteraction: InteractionEvent | undefined;
  private readonly gossip: GossipCanvasPanel;
  private readonly quest: QuestCanvasPanel;
  private readonly merchant: MerchantCanvasPanel;
  private readonly trainer: TrainerCanvasPanel;
  private readonly taxi: TaxiCanvasPanel;
  private readonly loot: LootCanvasPanel;
  private readonly itemText: ItemTextCanvasPanel;
  private readonly popup: StaticPopupPanel;

  constructor(private readonly deps: NpcInteractionDeps) {
    const playUi = (name: string) => { deps.playUi?.(name); };
    const world = () => deps.getWorld();
    const shared = {
      getItemInfo: deps.getItemInfo,
      itemIconUrl: deps.itemIconUrl,
      getItemName: deps.getItemName,
    };
    this.gossip = new GossipCanvasPanel(deps.hosts.gossipFrame, {
      playUi,
      gossipSelect: (guid, index) => world()?.gossipSelect(guid, index),
      questQuery: (guid, questId) => world()?.questQuery(guid, questId),
      questRequestReward: (guid, questId) => world()?.questRequestReward(guid, questId),
      questText: deps.questText,
      getUnitName: deps.getUnitName,
      getUnitPortraitSource: deps.getUnitPortraitSource,
      onClose: () => {},
    });
    this.quest = new QuestCanvasPanel(deps.hosts.questFrame, {
      playUi,
      questAccept: (guid, questId) => world()?.questAccept(guid, questId),
      questRequestReward: (guid, questId) => world()?.questRequestReward(guid, questId),
      questChooseReward: (guid, questId, reward) => world()?.questChooseReward(guid, questId, reward),
      questCancel: (sharedByGuid) => world()?.questCancel(sharedByGuid),
      ...shared,
      questText: deps.questText,
      getUnitName: deps.getUnitName,
      getUnitPortraitSource: deps.getUnitPortraitSource,
    });
    this.merchant = new MerchantCanvasPanel(deps.hosts.merchantFrame, {
      playUi,
      buyItem: (guid, entry, count) => world()?.buyVendorItem(guid, entry, count),
      ...shared,
      getUnitName: deps.getUnitName,
      getUnitPortraitSource: deps.getUnitPortraitSource,
      getPlayerMoney: deps.getPlayerMoney,
      requestStackSplit: deps.requestStackSplit,
      getBuybackItems: () => world()?.getBuybackItems() ?? [],
      buybackItem: (vendorGuid, slot) => world()?.buybackItem(vendorGuid, slot),
      repairAll: (vendorGuid) => world()?.repairAllItems(vendorGuid),
      junkCount: () => deps.junkCount?.() ?? 0,
      sellJunk: (vendorGuid) => deps.sellJunk?.(vendorGuid),
      onClose: () => {},
    });
    this.trainer = new TrainerCanvasPanel(deps.hosts.trainerFrame, {
      playUi,
      buySpell: (guid, spellId) => world()?.buyTrainerSpell(guid, spellId),
      getSpellName: deps.getSpellName,
      getSpellIconUrl: deps.getSpellIconUrl,
      getPlayerMoney: deps.getPlayerMoney,
      getUnitPortraitSource: deps.getUnitPortraitSource,
      confirmPurchase: (spell, onConfirm) => this.popup.confirm(
        `Learning ${deps.getSpellName(spell.spellId)} will count as a primary profession. Are you sure?`,
        onConfirm,
      ),
      onClose: () => {},
    });
    this.taxi = new TaxiCanvasPanel(deps.hosts.taxiFrame, {
      playUi,
      activateTaxi: (guid, source, destination) => world()?.activateTaxi(guid, source, destination),
      getUnitName: deps.getUnitName,
    });
    this.loot = new LootCanvasPanel(deps.hosts.lootFrame, {
      playUi,
      lootItem: (slot) => world()?.lootItem(slot),
      lootMoney: () => world()?.lootMoney(),
      releaseLoot: (guid) => world()?.releaseLoot(guid),
      masterLootItem: deps.masterLootItem,
      ...shared,
    });
    const itemTextHost = deps.hosts.interactionPanel.parentElement?.querySelector<HTMLElement>('#wow-item-text-frame');
    if (!itemTextHost) throw new Error('missing HUD node #wow-item-text-frame');
    this.itemText = new ItemTextCanvasPanel(itemTextHost, { playUi });
    this.popup = new StaticPopupPanel(deps.hosts.interactionPanel, { playUi });
  }

  /** Merchant guid when the vendor window is open (bag right-click = sell). */
  activeMerchantGuid(): string | undefined {
    return this.merchant.isOpen() ? this.merchant.guid() : undefined;
  }

  /** Consume the merchant's single-item repair cursor on the next clicked inventory item. */
  repairInventoryItem(itemGuid: string): boolean {
    const vendorGuid = this.merchant.repairGuid();
    if (!vendorGuid) return false;
    this.deps.getWorld()?.repairItem(vendorGuid, itemGuid);
    this.merchant.finishRepairMode();
    return true;
  }

  /**
   * True while any face-to-face NPC dialogue window is open (gossip / quest / vendor / trainer).
   * Drives the player's looping talk emote — vanilla plays talk gestures on the player (and turns
   * the NPC toward you, see main.ts interaction handler) for the duration of the conversation.
   * Loot/taxi are excluded: they are not conversations.
   */
  isConversing(): boolean {
    return this.gossip.isOpen() || this.quest.isOpen() || this.merchant.isOpen() || this.trainer.isOpen();
  }

  confirm(message: string, callback: () => void) {
    this.popup.confirm(message, callback);
  }

  forceAction(message: string, label: string, callback: () => void, disabled = false) {
    this.hideNpcPanels();
    this.popup.forceAction(message, label, callback, disabled);
  }

  forceConfirm(
    message: string,
    onAccept: () => void,
    onDecline: () => void,
    acceptLabel = 'Accept',
    declineLabel = 'Decline',
    acceptDisabled = false,
    money?: number,
  ) {
    this.hideNpcPanels();
    this.popup.forceConfirm(message, onAccept, onDecline, acceptLabel, declineLabel, acceptDisabled, money);
  }

  forceNotice(message: string) {
    this.hideNpcPanels();
    this.popup.forceNotice(message);
  }

  setPopupMessage(message: string) {
    this.popup.setMessage(message);
  }

  setPopupPrimaryDisabled(disabled: boolean) {
    this.popup.setPrimaryDisabled(disabled);
  }

  hidePopup() {
    this.popup.hide();
  }

  render(event = this.lastInteraction) {
    if (!event) return;
    const previous = this.lastInteraction;
    this.lastInteraction = event;
    switch (event.kind) {
      case 'lootClose':
        this.loot.hide(false);
        if (previous?.kind === 'loot') this.lastInteraction = undefined;
        return;
      case 'gossipClose':
        this.gossip.hide();
        this.lastInteraction = undefined;
        return;
      case 'loot':
        this.loot.show(event.state);
        return;
      case 'gossip':
        if (previous?.kind === 'gossip' && previous.state.guid === event.state.guid && this.gossip.isOpen()) {
          this.gossip.update({ kind: 'gossip', state: event.state });
          return;
        }
        this.hideNpcPanels();
        this.gossip.show({ kind: 'gossip', state: event.state });
        return;
      case 'questList':
        this.hideNpcPanels();
        this.gossip.show({ kind: 'questList', state: event.state });
        return;
      case 'questDetails':
      case 'questRequestItems':
      case 'questOfferReward':
        this.hideNpcPanels();
        this.quest.show(event);
        return;
      case 'questShareConfirm':
        this.hideNpcPanels();
        this.popup.forceConfirm(
          event.message,
          () => this.deps.getWorld()?.confirmSharedQuest(event.state.questId),
          () => this.deps.getWorld()?.questCancel(event.state.senderGuid),
          'Yes',
          'No',
        );
        return;
      case 'itemText':
        this.itemText.show(event.state);
        return;
      case 'itemTextMessage':
      case 'questShareResult':
        this.popup.show(event.message);
        return;
      case 'vendor':
        this.hideNpcPanels();
        this.merchant.show(event.state);
        return;
      case 'trainer':
        this.hideNpcPanels();
        this.trainer.show(event.state);
        return;
      case 'taxi':
        this.hideNpcPanels();
        this.taxi.show(event.state);
        return;
      case 'bank':
      case 'trade':
      case 'tradeRequest':
      case 'masterLootList':
      case 'mail':
      case 'auction':
      case 'stable':
      case 'petition':
      case 'petitionVendor':
      case 'openContainer':
      case 'uiError':
      case 'gossipPoi':
        // Owned by their dedicated canvases in main.ts.
        return;
      case 'bindPointUpdate':
      case 'questMessage':
      case 'trainerMessage':
      case 'auctionMessage':
      case 'stableMessage':
      case 'petitionMessage':
        // Informational; main.ts routes these to the chat log, not to a modal popup.
        return;
      case 'binderConfirm': {
        // UIParent.lua passes the CONFIRM_BINDER event's arg1 into this GlobalStrings template.
        // SMSG_BINDER_CONFIRM carries only the binder guid, so use its resolved unit name and keep
        // a grammatical fallback while the creature query is still in flight.
        const guid = event.guid;
        const location = this.deps.getUnitName(guid) ?? 'this inn';
        this.hideNpcPanels();
        this.popup.forceConfirm(
          binderConfirmation(location),
          () => this.deps.getWorld()?.binderActivate(guid),
          () => {},
          'Accept',
          'Cancel',
        );
        return;
      }
      case 'petUnlearnConfirm': {
        this.hideNpcPanels();
        this.popup.forceConfirm(
          "Do you want to unlearn all of your pet's skills? The cost will increase each time you do it.",
          () => this.deps.getWorld()?.confirmPetUnlearn(event.petGuid),
          () => {},
          'Accept',
          'Cancel',
          false,
          event.cost,
        );
        return;
      }
      case 'talentWipeConfirm': {
        // CONFIRM_TALENT_WIPE, GlobalStrings.lua:653 — verbatim, including its double space.
        const guid = event.guid;
        this.hideNpcPanels();
        this.popup.forceConfirm(
          'Do you want to unlearn all of your talents?  The cost will increase each time you do it.',
          () => this.deps.getWorld()?.confirmTalentWipe(guid),
          () => {},
          'Accept',
          'Cancel',
          false,
          event.cost,
        );
        return;
      }
      case 'tradeClose':
        if (event.message) this.popup.show(event.message);
        return;
      case 'readyCheckRequest':
      case 'readyCheckResponse':
        return;
      default:
        this.popup.show(event.message);
    }
  }

  rerender() {
    // Asset/name arrivals should repaint in-place, never replay show() and reset
    // pagination/scroll state or resurrect a panel the user already closed.
    this.updatePortraits();
    this.gossip.surface.requestRender();
    this.quest.surface.requestRender();
    this.merchant.surface.requestRender();
    this.trainer.surface.requestRender();
    this.taxi.surface.requestRender();
    this.loot.surface.requestRender();
    this.itemText.surface.requestRender();
    this.popup.surface.requestRender();
  }

  updatePortraits() {
    this.gossip.updatePortrait();
    this.quest.updatePortrait();
    this.merchant.updatePortrait();
    this.trainer.updatePortrait();
  }

  closeAll() {
    this.hideNpcPanels();
    this.loot.hide(true);
    this.itemText.hide();
    this.popup.hide();
    this.lastInteraction = undefined;
  }

  private hideNpcPanels() {
    this.gossip.hide();
    this.quest.hide();
    this.merchant.hide();
    this.trainer.hide();
    this.taxi.hide();
    this.popup.hide();
  }
}
