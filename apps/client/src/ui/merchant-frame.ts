/** MerchantFrame.xml canvas implementation. */
import type { BuybackItem, ItemInfo, VendorState } from '../world';
import { drawMoney } from './money';
import { CanvasPanel, drawItemButton, qualityColor, UI_GRAY, type PanelHit } from './panel-kit';
import { itemTooltipLines } from './tooltip-content';
import { maxVendorPurchaseCount } from './vendor-purchase';
import { stackSplitAnchorFromCanvas, type StackSplitAnchor } from './stack-split-frame';
import { merchantStackSplitIntent } from './stack-split-routing';
import { isBuiltInAddonEnabled, onBuiltInAddonSettings } from './builtin-addons';

// MerchantFrame.lua:1-2 defines 10 goods/page and 12 buybacks/page. MerchantItem1 sits at
// (24,-80); column 2 is +153+12. The 44px template stacks at -8 for goods and -15 for buyback.
const ITEMS_PER_PAGE = 10;
const COLUMN_X = [24, 189] as const;
const ROW_Y = [80, 132, 184, 236, 288] as const;
const BUYBACK_ROW_Y = [80, 139, 198, 257, 316, 375] as const;
// MerchantBuyBackItem anchors under MerchantItem10 (goods row five) at y=-53.
const BUYBACK_ROW = { x: COLUMN_X[1], y: ROW_Y[4] + 44 + 53 } as const;

export class MerchantCanvasPanel extends CanvasPanel {
  private current?: VendorState;
  private page = 0;
  private tab: 'merchant' | 'buyback' = 'merchant';
  private repairMode = false;
  private portraitGuid?: string;
  private portraitSource?: CanvasImageSource;

  constructor(private readonly host: HTMLElement, private readonly deps: {
    playUi: (name: string) => void;
    buyItem: (guid: string, entry: number, count: number) => void;
    getItemInfo: (entry: number) => ItemInfo | undefined;
    itemIconUrl: (displayInfoId?: number, entry?: number) => string;
    getItemName: (entry: number) => string | undefined;
    getUnitName: (guid: string) => string | undefined;
    getUnitPortraitSource?: (guid: string) => CanvasImageSource | undefined;
    getPlayerMoney: () => number;
    requestStackSplit: (maxStack: number, onSplit: (count: number) => void, anchor: StackSplitAnchor) => void;
    getBuybackItems: () => BuybackItem[];
    buybackItem: (vendorGuid: string, slot: number) => void;
    repairAll: (vendorGuid: string) => void;
    junkCount: () => number;
    sellJunk: (vendorGuid: string) => void;
    onClose: () => void;
  }) {
    super(host, 384, 512, 'wow-native-panel-canvas', { playUi: deps.playUi });
    this.surface.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    onBuiltInAddonSettings(() => this.surface.requestRender());
  }

  show(state: VendorState) {
    const wasOpen = this.isOpen();
    if (state.guid !== this.portraitGuid) {
      this.portraitGuid = state.guid;
      this.portraitSource = undefined;
    }
    this.current = state;
    this.page = 0;
    this.tab = 'merchant';
    this.repairMode = false;
    this.host.classList.remove('is-hidden');
    if (!wasOpen) this.playUi('igCharacterInfoOpen');
    this.updatePortrait();
    this.surface.requestRender();
  }

  updatePortrait() {
    const guid = this.current?.guid;
    if (!guid || !this.isOpen()) return;
    const source = this.deps.getUnitPortraitSource?.(guid);
    if (source && source !== this.portraitSource) {
      this.portraitSource = source;
      this.surface.requestRender();
    }
  }

  hide() {
    this.host.classList.add('is-hidden');
  }

  isOpen() {
    return !this.host.classList.contains('is-hidden');
  }

  guid() {
    return this.current?.guid;
  }

  repairGuid() {
    return this.isOpen() && this.repairMode ? this.current?.guid : undefined;
  }

  finishRepairMode() {
    if (!this.repairMode) return;
    this.repairMode = false;
    this.surface.requestRender();
  }

  protected paint() {
    const s = this.surface;
    s.clear();
    s.fourSlice('/ui/Interface/MERCHANTFRAME', ['UI-Merchant-TopLeft', 'UI-Merchant-TopRight', 'UI-MERCHANT-BOTLEFT', 'UI-MERCHANT-BOTRIGHT']);
    if (this.portraitSource) s.source(this.portraitSource, 7, 6, 60, 60, { circular: true });
    else s.image('/ui/Interface/CharacterFrame/TemporaryPortrait-Monster.png', 7, 6, 60, 60);
    const state = this.current;
    const name = this.tab === 'buyback' ? 'Buyback' : (state && this.deps.getUnitName(state.guid)) || 'Merchant';
    if (this.tab === 'buyback') s.image('/ui/Interface/MERCHANTFRAME/UI-BuyBack-Icon.png', 7, 6, 60, 60);
    s.text(name, 192, 24, { size: 13, align: 'center', baseline: 'middle', maxWidth: 280 });
    s.closeButton(322, 8, this.hoverState('close'));
    this.hit('close', { x: 322, y: 8, width: 32, height: 32 });
    drawMoney(s, 344, 438, this.deps.getPlayerMoney(), { align: 'right' });

    // The buyback slot is part of the frame itself, not a separate view — it stays visible
    // alongside the goods, exactly as MerchantFrame_Update paints it.
    this.paintTabs();
    if (this.tab === 'buyback') {
      this.paintBuybackTab();
      return;
    }
    this.paintNewestBuybackRow();
    this.paintRepair();
    this.paintSellJunk();

    if (!state || state.error !== undefined || !state.items.length) {
      s.text('This vendor has nothing to sell.', 192, 200, { size: 12, align: 'center', color: UI_GRAY });
      return;
    }

    const totalPages = Math.max(1, Math.ceil(state.items.length / ITEMS_PER_PAGE));
    this.page = Math.max(0, Math.min(totalPages - 1, this.page));
    const pageItems = state.items.slice(this.page * ITEMS_PER_PAGE, this.page * ITEMS_PER_PAGE + ITEMS_PER_PAGE);

    pageItems.forEach((item, index) => {
      this.paintItemRow(`buy:${item.entry}`, COLUMN_X[index % 2], ROW_Y[Math.floor(index / 2)], {
        entry: item.entry,
        data: item.entry,
        iconUrl: this.deps.itemIconUrl(item.displayInfoId, item.entry) || undefined,
        stock: item.stock > 0 && item.stock < 0xffffffff ? item.stock : undefined,
        count: item.buyCount > 1 ? item.buyCount : undefined,
        tooltipCount: item.buyCount,
        price: item.price,
      });
    });

    if (totalPages > 1) {
      const prevRect = { x: 21, y: 340, width: 32, height: 32 };
      const nextRect = { x: 308, y: 340, width: 32, height: 32 };
      s.image(`/ui/Interface/Buttons/UI-SpellbookIcon-PrevPage-${this.page === 0 ? 'Disabled' : this.state('prev') === 'down' ? 'Down' : 'Up'}.png`, prevRect.x, prevRect.y, 32, 32);
      s.image(`/ui/Interface/Buttons/UI-SpellbookIcon-NextPage-${this.page >= totalPages - 1 ? 'Disabled' : this.state('next') === 'down' ? 'Down' : 'Up'}.png`, nextRect.x, nextRect.y, 32, 32);
      s.text('Prev', 58, 356, { size: 12, baseline: 'middle' });
      s.text('Next', 305, 356, { size: 12, align: 'right', baseline: 'middle' });
      s.text(`Page ${this.page + 1}`, 178, 362, { size: 12, align: 'center' });
      this.hit('prev', prevRect, { disabled: this.page === 0 });
      this.hit('next', nextRect, { disabled: this.page >= totalPages - 1 });
    }
  }

  /**
   * One MerchantItemTemplate row (153x44): UI-EmptySlot backing, ItemButton, UI-Merchant-LabelSlots
   * name plate and a SmallMoneyFrame price. Vanilla renders the buyback slot from this very
   * template, so both callers share it.
   */
  private paintItemRow(id: string, x: number, y: number, row: {
    entry: number;
    data: number;
    price: number;
    iconUrl?: string;
    stock?: number;
    count?: number;
    tooltipCount?: number;
  }) {
    const s = this.surface;
    const info = this.deps.getItemInfo(row.entry);
    s.image('/ui/Interface/Buttons/UI-EmptySlot.png', x - 13, y - 13, 64, 64);
    s.image('/ui/Interface/MERCHANTFRAME/UI-MERCHANT-LABELSLOTS.png', x + 42, y - 13, 128, 78);
    drawItemButton(s, x, y, 37, {
      iconUrl: row.iconUrl,
      hover: this.state(id) === 'hover',
      pushed: this.state(id) === 'down',
      stock: row.stock,
      count: row.count,
    });
    if (!row.iconUrl) {
      s.text((this.deps.getItemName(row.entry) ?? '??').slice(0, 2).toUpperCase(), x + 18, y + 23, { size: 12, align: 'center', color: '#ffffff' });
    }
    const itemName = info?.name ?? this.deps.getItemName(row.entry) ?? `Item #${row.entry}`;
    s.wrapText(itemName, 92, { size: 10 }).slice(0, 2).forEach((line, lineIndex) => {
      s.text(line, x + 46, y + 6 + lineIndex * 11, { size: 10, color: qualityColor(info?.quality), maxWidth: 94 });
    });
    const affordable = this.deps.getPlayerMoney() >= row.price;
    drawMoney(s, x + 46, y + 30, row.price, { align: 'left', color: affordable ? '#ffffff' : '#ff2020' });
    this.hit(id, { x: x - 4, y: y - 4, width: 150, height: 45 }, {
      data: row.data,
      tooltip: () => itemTooltipLines(info, row.entry, { count: row.tooltipCount, buyPrice: row.price }),
    });
  }

  /**
   * MerchantFrame_UpdateMerchantInfo shows the newest sale as a shortcut beneath the goods.
   * The frame's Buyback tab exposes the full 12-slot history through paintBuybackTab.
   *
   * The server does keep all 12 slots, and the newest is the one with the highest
   * BUYBACK_TIMESTAMP: Player::AddItemToBuyBackSlot stamps `now - loginTime + 30h` per sale and
   * evicts the lowest (Player.cpp:11601).
   */
  private paintNewestBuybackRow() {
    const items = this.deps.getBuybackItems();
    if (!items.length) return;
    const newest = items.reduce((a, b) => (b.soldAt > a.soldAt ? b : a));
    this.paintItemRow(`buyback:${newest.slot}`, BUYBACK_ROW.x, BUYBACK_ROW.y, {
      entry: newest.entry,
      data: newest.slot,
      iconUrl: this.deps.itemIconUrl(this.deps.getItemInfo(newest.entry)?.displayInfoId, newest.entry) || undefined,
      count: newest.count > 1 ? newest.count : undefined,
      tooltipCount: newest.count,
      price: newest.price,
    });
  }

  /** MerchantFrame_UpdateBuybackInfo: all 12 player buyback slots, two columns by six rows. */
  private paintBuybackTab() {
    const items = this.deps.getBuybackItems();
    if (!items.length) {
      this.surface.text('There are no items to buy back.', 192, 205, { size: 12, align: 'center', color: UI_GRAY });
      return;
    }
    items.slice(0, 12).forEach((item, index) => {
      this.paintItemRow(`buyback:${item.slot}`, COLUMN_X[index % 2], BUYBACK_ROW_Y[Math.floor(index / 2)], {
        entry: item.entry,
        data: item.slot,
        iconUrl: this.deps.itemIconUrl(this.deps.getItemInfo(item.entry)?.displayInfoId, item.entry) || undefined,
        count: item.count > 1 ? item.count : undefined,
        tooltipCount: item.count,
        price: item.price,
      });
    });
  }

  /** CharacterFrameTabButtonTemplate; MerchantFrame.xml anchors these along the bottom edge. */
  private paintTabs() {
    const width = 115;
    const y = 450;
    (['merchant', 'buyback'] as const).forEach((tab, index) => {
      const x = 3 + index * (width - 16);
      const active = this.tab === tab;
      const art = `/ui/Interface/PaperDollInfoFrame/UI-Character-${active ? 'ActiveTab' : 'InactiveTab'}.png`;
      this.surface.sprite(art, 0, 0, 20, 32, x, y, 20, 32);
      this.surface.sprite(art, 20, 0, 88, 32, x + 20, y, width - 40, 32);
      this.surface.sprite(art, 108, 0, 20, 32, x + width - 20, y, 20, 32);
      this.surface.text(tab === 'merchant' ? 'Merchant' : 'Buyback', x + width / 2, y + 13, {
        size: 12, align: 'center', baseline: 'middle', color: active ? '#ffd100' : '#bfb6a5',
      });
      this.hit(`tab:${tab}`, { x: x + 6, y: y + 2, width: width - 12, height: 26 }, { disabled: active });
    });
  }

  private paintSellJunk() {
    if (!isBuiltInAddonEnabled('itemTools')) return;
    const count = this.deps.junkCount();
    const rect = { x: 238, y: 452, width: 104, height: 22 };
    this.surface.panelButton(`Sell Junk (${count})`, rect, count ? this.state('sellJunk') : 'disabled');
    this.hit('sellJunk', rect, { disabled: count === 0, tooltip: [{ text: 'Sell all poor-quality items', color: '#ffffff' }] });
  }

  /**
   * MerchantRepairAllButton (MerchantFrame.xml:315) + MerchantRepairText (line 195). Shown only
   * when CanMerchantRepair() — for us, when the vendor also carries UNIT_NPC_FLAG_REPAIR.
   *
   * The 128x64 UI-Merchant-RepairIcons atlas holds two 36x36 anvils: the "repair all" icon at
   * TexCoords 0.28125..0.5625 (texels 36..72). Vanilla anchors the button's BOTTOMRIGHT to the
   * frame's BOTTOMLEFT at (172,91), i.e. canvas top-left (136,385) for a 384x512 frame.
   *
   * The neighbouring single-item button toggles repair mode. The next inventory item click sends
   * its authoritative GUID to CMSG_REPAIR_ITEM through the interaction controller.
   */
  private paintRepair() {
    const state = this.current;
    if (!state?.canRepair) return;
    const s = this.surface;
    const itemRect = { x: 98, y: 385, width: 36, height: 36 };
    const rect = { x: 136, y: 385, width: 36, height: 36 };
    s.sprite('/ui/Interface/MERCHANTFRAME/UI-Merchant-RepairIcons.png', 0, 0, 36, 36, itemRect.x, itemRect.y, itemRect.width, itemRect.height);
    s.sprite('/ui/Interface/MERCHANTFRAME/UI-Merchant-RepairIcons.png', 36, 0, 36, 36, rect.x, rect.y, rect.width, rect.height);
    if (this.repairMode || this.state('repairItem') === 'hover' || this.state('repairItem') === 'down') {
      s.image('/ui/Interface/Buttons/ButtonHilight-Square.png', itemRect.x, itemRect.y, itemRect.width, itemRect.height);
    }
    const btnState = this.state('repairAll');
    if (btnState === 'hover' || btnState === 'down') {
      s.image('/ui/Interface/Buttons/ButtonHilight-Square.png', rect.x, rect.y, rect.width, rect.height);
    }
    // MerchantRepairText BOTTOMLEFT (26,103) → canvas bottom-left (26,409).
    s.text('Repair Items', 26, 407, { size: 10, color: '#f1eee5' });
    this.hit('repairItem', itemRect, { tooltip: () => [{ text: this.repairMode ? 'Cancel Item Repair' : 'Repair an Item', color: '#ffffff' }] });
    this.hit('repairAll', rect, { tooltip: () => [{ text: 'Repair All Items', color: '#ffffff' }] });
  }

  private hoverState(id: string): 'normal' | 'hover' | 'down' {
    const state = this.state(id);
    return state === 'disabled' ? 'normal' : state;
  }

  protected acceptsPointerButton(button: number): boolean { return button === 0 || button === 2; }

  protected activate(hit: PanelHit, event?: PointerEvent) {
    const state = this.current;
    if (hit.id === 'close') {
      this.playUi('igCharacterInfoClose');
      this.hide();
      this.deps.onClose();
      return;
    }
    if (!state) return;
    if (hit.id === 'tab:merchant' || hit.id === 'tab:buyback') {
      this.tab = hit.id === 'tab:buyback' ? 'buyback' : 'merchant';
      this.page = 0;
      this.repairMode = false;
      this.playUi('igMainMenuOptionCheckBoxOn');
      this.surface.requestRender();
      return;
    }
    if (hit.id === 'repairItem') {
      this.repairMode = !this.repairMode;
      this.playUi('igMainMenuOptionCheckBoxOn');
      this.surface.requestRender();
      return;
    }
    if (hit.id === 'repairAll') {
      // igMainMenuOptionCheckBoxOn is the anvil/repair click in vanilla.
      this.playUi('igMainMenuOptionCheckBoxOn');
      this.deps.repairAll(state.guid);
      return;
    }
    if (hit.id === 'sellJunk') {
      this.playUi('igCharacterBuy');
      this.deps.sellJunk(state.guid);
      return;
    }
    if (hit.id.startsWith('buyback:')) {
      this.playUi('igCharacterBuy');
      this.deps.buybackItem(state.guid, Number(hit.data));
      return;
    }
    if (hit.id === 'prev') {
      this.page--;
      this.playUi('igAbiliityPageTurn');
      this.surface.requestRender();
    } else if (hit.id === 'next') {
      this.page++;
      this.playUi('igAbiliityPageTurn');
      this.surface.requestRender();
    } else if (hit.id.startsWith('buy:')) {
      const entry = Number(hit.data);
      const item = state.items.find((candidate) => candidate.entry === entry);
      if (!item) return;
      const buy = (count: number) => { this.playUi('igCharacterBuy'); this.deps.buyItem(state.guid, entry, count); };
      const intent = merchantStackSplitIntent({
        button: event?.button ?? 0,
        shiftKey: event?.shiftKey ?? false,
        ctrlKey: event?.ctrlKey ?? false,
      });
      if (intent === 'suppress') return;
      if (intent === 'split') {
        const max = maxVendorPurchaseCount(item, this.deps.getItemInfo(entry)?.stackable, this.deps.getPlayerMoney());
        if (max > 1) this.deps.requestStackSplit(max, buy,
          stackSplitAnchorFromCanvas(this.surface.canvas.getBoundingClientRect(), this.surface.width, this.surface.height, hit.rect, 'left'));
        else buy(1);
      } else buy(1);
    }
  }
}
