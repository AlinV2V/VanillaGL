/** Asset conversion utility. */
import type {
  AuctionEntryInfo, AuctionState, AuctionTab, ItemInfo,
} from '../world';
import { auctionMinimumBid, auctionTimeLeftLabel } from '../world';
import { drawMoney, formatMoneyText, splitMoney } from './money';
import {
  CanvasPanel, drawInputBox, drawItemButton, drawMoneyInput, qualityColor,
  UI_GOLD, UI_GRAY, UI_WHITE, type PanelHit,
} from './panel-kit';
import { itemTooltipLines } from './tooltip-content';
import { activateAuctionCategory, clampAuctionCategoryScroll, paintAuctionCategories, type AuctionCategorySelection } from './auction-categories';

const FRAME_WIDTH = 832;
const FRAME_HEIGHT = 447;
const SUBFRAME_WIDTH = 758;
/**
 * The tabs anchor TOPLEFT@BOTTOMLEFT (15,11), i.e. they hang 21px BELOW the 447px frame — WoW
 * frames do not clip their children, but a canvas does. The surface is therefore taller than the
 * frame so the tab strip survives; every coordinate below stays frame-relative.
 */
const TAB_OVERHANG = 24;
const CANVAS_HEIGHT = FRAME_HEIGHT + TAB_OVERHANG;
/** NUM_AUCTION_ITEMS_PER_PAGE, AuctionFrame.lua:2 — the server pages 50 rows at a time too. */
const AUCTION_ITEMS_PER_PAGE = 50;

/** NUM_BROWSE_TO_DISPLAY / NUM_BIDS_TO_DISPLAY / NUM_AUCTIONS_TO_DISPLAY, AuctionFrame.lua:1-6. */
const ROWS_PER_TAB: Record<AuctionTab, number> = { browse: 8, bids: 9, auctions: 9 };
const ROW_PITCH = 37;
const ROW_ORIGIN: Record<AuctionTab, { x: number; y: number; width: number }> = {
  browse: { x: 195, y: 110, width: 597 },
  bids: { x: 27, y: 76, width: 793 },
  auctions: { x: 219, y: 76, width: 576 },
};
const SORT_ORIGIN: Record<AuctionTab, { x: number; y: number; widths: number[]; labels: string[] }> = {
  // Header text comes from GlobalStrings: RARITY, LEVEL, DURATION, HIGH_BIDDER (AUCTION_CREATOR
  // is "Seller"), CURRENT_BID, BUYOUT, STATUS, BID.
  browse: { x: 186, y: 82, widths: [214, 57, 91, 76, 163], labels: ['Rarity', 'Lvl', 'Duration', 'Seller', 'Current Bid'] },
  bids: { x: 65, y: 52, widths: [195, 65, 79, 162, 94, 169], labels: ['Rarity', 'Lvl', 'Duration', 'Buyout', 'Status', 'Bid'] },
  auctions: { x: 219, y: 51, widths: [185, 100, 108, 193], labels: ['Rarity', 'Duration', 'High Bidder', 'Bid'] },
};
/** The tab prefix inside Interface\AuctionFrame\UI-AuctionFrame-<prefix>-<corner>. */
const TAB_ART: Record<AuctionTab, string> = { browse: 'Browse', bids: 'Bid', auctions: 'Auction' };
const TAB_LABELS: Array<{ tab: AuctionTab; label: string }> = [
  { tab: 'browse', label: 'Browse' },
  { tab: 'bids', label: 'Bids' },
  { tab: 'auctions', label: 'Auctions' },
];

/**
 * AuctionsShortAuctionButton / Medium / Long. The minutes are what the wire wants and are the only
 * three vMaNGOS accepts (AuctionHouseHandler.cpp:282-296); the labels are the vanilla radio text.
 */
export const AUCTION_DURATION_CHOICES = [
  { minutes: 120, label: '2 Hours' },
  { minutes: 480, label: '8 Hours' },
  { minutes: 1440, label: '24 Hours' },
] as const;

export type AuctionSellDraft = {
  itemGuid?: string;
  itemEntry?: number;
  itemCount?: number;
  displayInfoId?: number;
  startPrice: number;
  buyoutPrice: number;
  durationMinutes: number;
};

export type AuctionPanelDeps = {
  playUi: (name: string) => void;
  getItemInfo: (entry: number) => ItemInfo | undefined;
  itemIconUrl: (displayInfoId?: number, entry?: number) => string;
  getPlayerMoney: () => number;
  getPlayerName: (guid: string) => string | undefined;
  getUnitPortraitSource?: (guid: string) => CanvasImageSource | undefined;
  /** Pull the item currently on the cursor so it can be dropped into the sell slot. */
  heldItem: () => { itemGuid?: string; entry: number; count: number; displayInfoId?: number } | undefined;
  clearHeld: () => void;
  search: (filters: { name: string; minLevel: number; maxLevel: number; usableOnly: boolean; page: number; itemClass?: number; itemSubClass?: number }) => void;
  listOwn: (page: number) => void;
  listBids: (page: number) => void;
  placeBid: (auctionId: number, price: number) => void;
  cancelAuction: (auctionId: number) => void;
  sellItem: (itemGuid: string, bid: number, buyout: number, durationMinutes: number) => void;
  onClose: () => void;
};

export class AuctionCanvasPanel extends CanvasPanel {
  private auctionState?: AuctionState;
  private tab: AuctionTab = 'browse';
  private selected: Partial<Record<AuctionTab, number>> = {};
  private search = { name: '', minLevel: 0, maxLevel: 0, usableOnly: false };
  private category: AuctionCategorySelection = { scroll: 0 };
  private draft: AuctionSellDraft = { startPrice: 0, buyoutPrice: 0, durationMinutes: 120 };
  private notice = '';
  /** Manual override of the BrowseBidPrice money input; cleared when the selection changes. */
  private bidOverride?: number;
  private portraitGuid?: string;
  private portraitSource?: CanvasImageSource;

  constructor(private readonly host: HTMLElement, private readonly deps: AuctionPanelDeps) {
    super(host, FRAME_WIDTH, CANVAS_HEIGHT, 'wow-native-panel-canvas', { playUi: deps.playUi });
    this.onWheel = (direction, point) => {
      if (this.tab !== 'browse' || point.x > 180 || point.y < 100 || point.y > 415) return;
      this.category.scroll = clampAuctionCategoryScroll({ ...this.category, scroll: this.category.scroll + direction });
      this.surface.requestRender();
    };
  }

  show(state: AuctionState) {
    if (state.auctioneerGuid !== this.portraitGuid) {
      this.portraitGuid = state.auctioneerGuid;
      this.portraitSource = undefined;
    }
    const opening = !this.isOpen();
    this.auctionState = state;
    if (opening) {
      this.tab = 'browse';
      this.selected = {};
      this.notice = '';
      this.host.classList.remove('is-hidden');
      this.playUi('igMainMenuOpen');
      this.deps.search(this.browseFilters(0));
    }
    this.updatePortrait();
    this.surface.requestRender();
  }

  update(state: AuctionState) {
    if (!this.isOpen()) return;
    this.auctionState = state;
    this.updatePortrait();
    this.surface.requestRender();
  }

  updatePortrait() {
    const guid = this.auctionState?.auctioneerGuid;
    if (!guid || !this.isOpen()) return;
    const source = this.deps.getUnitPortraitSource?.(guid);
    if (source && source !== this.portraitSource) {
      this.portraitSource = source;
      this.surface.requestRender();
    }
  }

  setNotice(message: string) {
    this.notice = message;
    this.surface.requestRender();
  }

  hide() {
    this.host.classList.add('is-hidden');
  }

  isOpen() {
    return !this.host.classList.contains('is-hidden');
  }

  private page(): number {
    return this.auctionState?.[this.tab].page ?? 0;
  }

  private entries(): AuctionEntryInfo[] {
    return this.auctionState?.[this.tab].entries ?? [];
  }

  private totalCount(): number {
    return this.auctionState?.[this.tab].totalCount ?? 0;
  }

  protected paint() {
    const s = this.surface;
    s.clear();
    // Six textures, 256 + 320 + 256 across and two rows. The lower band clips at frame bottom.
    const art = `/ui/Interface/AuctionFrame/UI-AuctionFrame-${TAB_ART[this.tab]}`;
    for (const [suffix, x, y, width, height] of [
      ['TopLeft', 0, 0, 256, 256], ['Top', 256, 0, 320, 256], ['TopRight', 576, 0, 256, 256],
      ['BotLeft', 0, 256, 256, 256], ['Bot', 256, 256, 320, 256], ['BotRight', 576, 256, 256, 256],
    ] as Array<[string, number, number, number, number]>) {
      s.image(`${art}-${suffix}.png`, x, y, width, height);
    }
    if (this.portraitSource) s.source(this.portraitSource, 12, 8, 58, 58, { circular: true });
    else s.image('/ui/Interface/CharacterFrame/TemporaryPortrait-Monster.png', 12, 8, 58, 58);
    s.closeButton(FRAME_WIDTH + 3 - 32, 8, this.buttonState('close'));
    this.hit('close', { x: FRAME_WIDTH + 3 - 32, y: 8, width: 32, height: 32 });

    this.paintTabs();
    this.paintSortHeaders();
    this.paintRows();
    this.paintPager();
    if (this.tab === 'browse') this.paintBrowseFilters();
    if (this.tab === 'auctions') this.paintSellPane();
    this.paintFooter();
  }

  /**
   * CharacterFrameTabButtonTemplate (CharacterFrame.xml:1-60): 115x32, three-sliced from
   * UI-Character-ActiveTab / UI-Character-InactiveTab as Left 20 / Middle 88 / Right 20.
   * The selected tab uses the *Disabled* textures — vanilla disables the current tab so it cannot
   * be re-clicked, which is why the "active" art is bound to the disabled state in the XML.
   * AuctionFrameTab1 sits at TOPLEFT@BOTTOMLEFT (15,11) and 2/3 chain with x=-8.
   */
  private paintTabs() {
    const s = this.surface;
    const width = 115;
    let x = 15;
    const y = FRAME_HEIGHT - 11;
    for (const { tab, label } of TAB_LABELS) {
      const active = tab === this.tab;
      const art = `/ui/Interface/PaperDollInfoFrame/UI-Character-${active ? 'ActiveTab' : 'InactiveTab'}.png`;
      s.sprite(art, 0, 0, 20, 32, x, y, 20, 32);
      s.sprite(art, 20, 0, 88, 32, x + 20, y, width - 40, 32);
      s.sprite(art, 108, 0, 20, 32, x + width - 20, y, 20, 32);
      if (!active && this.isHover(`tab:${tab}`)) {
        s.addImage('/ui/Interface/PaperDollInfoFrame/UI-Character-Tab-Highlight.png', x, y, width, 32, 0.6);
      }
      s.text(label, x + width / 2, y + 13, {
        size: 12, align: 'center', baseline: 'middle', color: active ? UI_GOLD : '#bfb6a5',
      });
      this.hit(`tab:${tab}`, { x: x + 6, y: y + 2, width: width - 12, height: 26 });
      x += width - 8;
    }
  }

  private paintSortHeaders() {
    const s = this.surface;
    const spec = SORT_ORIGIN[this.tab];
    let x = spec.x;
    spec.labels.forEach((label, index) => {
      const width = spec.widths[index] ?? 80;
      s.text(label, x + 6, spec.y + 13, { size: 11, color: UI_GOLD });
      x += width - 2;
    });
  }

  private paintRows() {
    const s = this.surface;
    const origin = ROW_ORIGIN[this.tab];
    const rows = ROWS_PER_TAB[this.tab];
    const entries = this.entries();
    const selected = this.selected[this.tab];
    for (let row = 0; row < rows; row++) {
      const entry = entries[row];
      const y = origin.y + row * ROW_PITCH;
      if (!entry) continue;
      const id = `row:${entry.auctionId}`;
      const hovered = this.isHover(id);
      if (selected === entry.auctionId) {
        s.image('/ui/Interface/QuestFrame/UI-QuestTitleHighlight.png', origin.x, y, origin.width, ROW_PITCH, 0.5);
      } else if (hovered) {
        s.image('/ui/Interface/QuestFrame/UI-QuestTitleHighlight.png', origin.x, y, origin.width, ROW_PITCH, 0.28);
      }

      const info = this.deps.getItemInfo(entry.itemEntry);
      drawItemButton(s, origin.x + 3, y + 1, 34, {
        iconUrl: this.deps.itemIconUrl(info?.displayInfoId, entry.itemEntry),
        count: entry.count,
      });
      // $parentName is 167 wide at x=43 within the row template.
      const name = info?.name ?? `Item ${entry.itemEntry}`;
      s.text(name, origin.x + 43, y + 15, {
        size: 12, color: qualityColor(info?.quality), maxWidth: 160,
      });
      const level = info?.requiredLevel ?? 0;
      s.text(level > 0 ? String(level) : '', origin.x + 218, y + 15, { size: 11, color: UI_WHITE });
      s.text(auctionTimeLeftLabel(entry.timeLeftMs), origin.x + 250, y + 15, { size: 11, color: UI_WHITE });

      const bidderName = entry.bidderGuid && !/^0+$/.test(entry.bidderGuid)
        ? this.deps.getPlayerName(entry.bidderGuid) ?? 'Unknown'
        : '';
      const sellerName = this.deps.getPlayerName(entry.ownerGuid) ?? '';
      s.text(this.tab === 'auctions' ? bidderName : bidderName || sellerName, origin.x + 322, y + 15, {
        size: 11, color: UI_WHITE, maxWidth: 78,
      });

      // "Current Bid" column shows what you would have to pay, which is NOT startbid once someone
      // has bid — see auctionMinimumBid / GetAuctionOutBid.
      const askingPrice = auctionMinimumBid(entry);
      drawMoney(s, origin.x + origin.width - 12, y + 8, askingPrice, { align: 'right' });
      if (entry.buyout > 0) {
        s.text(`Buyout ${formatMoneyText(entry.buyout)}`, origin.x + origin.width - 12, y + 30, {
          size: 10, align: 'right', color: UI_GRAY,
        });
      }

      this.hit(id, { x: origin.x, y, width: origin.width, height: ROW_PITCH }, {
        data: entry.auctionId,
        tooltip: () => itemTooltipLines(this.deps.getItemInfo(entry.itemEntry), entry.itemEntry, { count: entry.count }),
      });
    }
    if (!entries.length) {
      // BrowseNoResultsText uses BROWSE_SEARCH_TEXT (GlobalStrings.lua:296), verbatim including
      // the embedded quotes around Search.
      const message = this.auctionState?.pending === this.tab
        ? 'Searching...'
        : 'Choose search criteria and press "Search"';
      s.text(message, origin.x + origin.width / 2, origin.y + 60, { size: 13, align: 'center', color: UI_GRAY });
    }
  }

  /** BrowsePrevPageButton / BrowseNextPageButton, anchored to the LAST row of each tab. */
  private paintPager() {
    const s = this.surface;
    const origin = ROW_ORIGIN[this.tab];
    const lastRowY = origin.y + (ROWS_PER_TAB[this.tab] - 1) * ROW_PITCH;
    const page = this.page();
    const total = this.totalCount();
    const entriesOnPage = this.entries().length;
    const pageCount = Math.max(1, Math.ceil(total / AUCTION_ITEMS_PER_PAGE));
    if (pageCount <= 1) return;
    const prevRect = { x: origin.x + 5, y: lastRowY + 3, width: 32, height: 32 };
    const nextRect = { x: origin.x + origin.width - 34, y: lastRowY + 3, width: 32, height: 32 };
    const arrows = '/ui/Interface/Buttons';
    s.image(`${arrows}/UI-SpellbookIcon-PrevPage-${page > 0 ? (this.buttonState('page:prev') === 'down' ? 'Down' : 'Up') : 'Disabled'}.png`, prevRect.x, prevRect.y, 32, 32);
    s.image(`${arrows}/UI-SpellbookIcon-NextPage-${page < pageCount - 1 ? (this.buttonState('page:next') === 'down' ? 'Down' : 'Up') : 'Disabled'}.png`, nextRect.x, nextRect.y, 32, 32);
    this.hit('page:prev', prevRect, { disabled: page <= 0 });
    this.hit('page:next', nextRect, { disabled: page >= pageCount - 1 });
    // SearchCountText anchors to the 758px tab-frame bottom at +80 / -10 / +90 respectively.
    const first = page * AUCTION_ITEMS_PER_PAGE + 1;
    const last = Math.min(total, first + entriesOnPage - 1);
    const searchCountX = SUBFRAME_WIDTH / 2 + ({ browse: 80, bids: -10, auctions: 90 }[this.tab]);
    s.text(`Items ${first} - ${last}  ( ${total} total )`, searchCountX, FRAME_HEIGHT - 53, {
      size: 11, align: 'center', color: UI_WHITE,
    });
  }

  /**
   * BrowseNameText (80,-41) / BrowseLevelText (230,-41) with their edit boxes on the line below,
   * IsUsableCheckButton 24x24, and BrowseSearchButton 80x22 ten pixels to its right.
   */
  private paintBrowseFilters() {
    const s = this.surface;
    // BrowseName is 140x16 anchored under BrowseNameText (+3,-2); the level boxes are 30 wide and
    // chain LEFT@BrowseMinLevel.RIGHT. All three are InputBoxTemplate EditBoxes.
    s.text('Name', 80, 52, { size: 11, color: UI_WHITE });
    drawInputBox(s, 83, 56, 140, this.search.name, { focused: this.focusedField === 'filter:name' });
    this.hit('filter:name', { x: 83, y: 56, width: 140, height: 20 });
    s.text('Level Range', 230, 52, { size: 11, color: UI_WHITE });
    drawInputBox(s, 233, 56, 32, this.search.minLevel ? String(this.search.minLevel) : '', {
      focused: this.focusedField === 'filter:minLevel',
    });
    this.hit('filter:minLevel', { x: 233, y: 56, width: 32, height: 20 });
    drawInputBox(s, 267, 56, 32, this.search.maxLevel ? String(this.search.maxLevel) : '', {
      focused: this.focusedField === 'filter:maxLevel',
    });
    this.hit('filter:maxLevel', { x: 267, y: 56, width: 32, height: 20 });

    const checkRect = { x: 330, y: 56, width: 24, height: 24 };
    s.image(`/ui/Interface/Buttons/UI-CheckBox-Up.png`, checkRect.x, checkRect.y, 24, 24);
    if (this.search.usableOnly) s.image('/ui/Interface/Buttons/UI-CheckBox-Check.png', checkRect.x, checkRect.y, 24, 24);
    s.text('Usable Items', checkRect.x + 28, checkRect.y + 16, { size: 11, color: UI_WHITE });
    this.hit('filter:usable', checkRect);

    const searchRect = { x: 440, y: 57, width: 80, height: 22 };
    s.panelButton('Search', searchRect, this.buttonState('filter:search'));
    this.hit('filter:search', searchRect);

    paintAuctionCategories(s, this.category, (id, rect) => this.hit(id, rect), (id) => this.isHover(id));
  }

  /** The Auctions tab's create pane: AuctionsItemButton 37x37 at (28,-98) plus price rows. */
  private paintSellPane() {
    const s = this.surface;
    const draft = this.draft;
    const info = draft.itemEntry ? this.deps.getItemInfo(draft.itemEntry) : undefined;
    drawItemButton(s, 28, 98, 37, {
      iconUrl: draft.itemEntry ? this.deps.itemIconUrl(draft.displayInfoId, draft.itemEntry) : undefined,
      count: draft.itemCount,
      hover: this.isHover('sell:slot'),
    });
    this.hit('sell:slot', { x: 28, y: 98, width: 37, height: 37 }, {
      tooltip: () => (draft.itemEntry ? itemTooltipLines(info, draft.itemEntry, { count: draft.itemCount }) : undefined),
    });
    // AUCTION_ITEM_TEXT = "Drag an item here to auction it" (GlobalStrings.lua:57).
    if (!draft.itemEntry) {
      s.text('Drag an item here', 72, 112, { size: 11, color: UI_GRAY, maxWidth: 124 });
      s.text('to auction it', 72, 126, { size: 11, color: UI_GRAY, maxWidth: 124 });
    } else {
      s.text(info?.name ?? `Item ${draft.itemEntry}`, 72, 118, {
        size: 12, color: qualityColor(info?.quality), maxWidth: 124,
      });
    }

    // AuctionsPriceText / AuctionsBuyoutText each sit above a MoneyInputFrameTemplate (176x18,
    // gold 68 / silver 30 / copper 30 — MoneyInputFrame.xml).
    s.text('Starting Price', 28, 158, { size: 11, color: UI_WHITE });
    drawMoneyInput(this, 'sell:start', 28, 164, splitMoney(draft.startPrice), this.focusedField);
    s.text('Buyout Price', 28, 202, { size: 11, color: UI_WHITE });
    drawMoneyInput(this, 'sell:buyout', 28, 208, splitMoney(draft.buyoutPrice), this.focusedField);

    s.text('Auction Duration', 28, 246, { size: 11, color: UI_WHITE });
    AUCTION_DURATION_CHOICES.forEach((choice, index) => {
      const y = 254 + index * 22;
      const on = draft.durationMinutes === choice.minutes;
      // UI-RadioButton.png is a 64x16 strip of four 16x16 cells. MailFrame.xml:26-34 binds
      // Normal = 0..0.25, Highlight = 0.5..0.75 (ADD), Checked = 0.25..0.5 — so the CHECKED
      // frame is the second cell, not the third.
      const RADIO = '/ui/Interface/Buttons/UI-RadioButton.png';
      s.sprite(RADIO, 0, 0, 16, 16, 31, y, 16, 16);
      if (on) s.sprite(RADIO, 16, 0, 16, 16, 31, y, 16, 16);
      if (this.isHover(`sell:duration:${choice.minutes}`)) {
        s.sprite(RADIO, 32, 0, 16, 16, 31, y, 16, 16, { blend: 'lighter' });
      }
      s.text(choice.label, 52, y + 12, { size: 11, color: on ? UI_GOLD : UI_WHITE });
      this.hit(`sell:duration:${choice.minutes}`, { x: 28, y, width: 130, height: 18 });
    });

    // AuctionsCreateAuctionButton 191x20 at BOTTOMLEFT (18,39).
    const createRect = { x: 18, y: FRAME_HEIGHT - 39 - 20, width: 191, height: 20 };
    const canCreate = !!draft.itemGuid && draft.startPrice > 0;
    s.panelButton('Create Auction', createRect, canCreate ? this.buttonState('sell:create') : 'disabled');
    this.hit('sell:create', createRect, { disabled: !canCreate });
  }

  private paintFooter() {
    const s = this.surface;
    // Bottom-right buttons chain leftward from the close button, 80x22 each.
    const closeRect = { x: SUBFRAME_WIDTH + 66 - 80, y: FRAME_HEIGHT - 14 - 22, width: 80, height: 22 };
    s.panelButton('Close', closeRect, this.buttonState('footer:close'));
    this.hit('footer:close', closeRect);

    const selected = this.selectedEntry();
    if (this.tab === 'auctions') {
      // AuctionsCancelAuctionButton is 126x22, not 80.
      const cancelRect = { x: closeRect.x - 126 - 2, y: closeRect.y, width: 126, height: 22 };
      s.panelButton('Cancel Auction', cancelRect, selected ? this.buttonState('footer:cancel') : 'disabled');
      this.hit('footer:cancel', cancelRect, { disabled: !selected });
    } else {
      const buyoutRect = { x: closeRect.x - 80, y: closeRect.y, width: 80, height: 22 };
      const bidRect = { x: buyoutRect.x - 80, y: closeRect.y, width: 80, height: 22 };
      const canBuyout = !!selected && selected.buyout > 0 && this.deps.getPlayerMoney() >= selected.buyout;
      const canBid = !!selected && this.deps.getPlayerMoney() >= auctionMinimumBid(selected);
      s.panelButton('Buyout', buyoutRect, canBuyout ? this.buttonState('footer:buyout') : 'disabled');
      s.panelButton('Bid', bidRect, canBid ? this.buttonState('footer:bid') : 'disabled');
      this.hit('footer:buyout', buyoutRect, { disabled: !canBuyout });
      this.hit('footer:bid', bidRect, { disabled: !canBid });
    }

    // BrowseBidPrice / BidBidPrice: 176x18, centred in the 758px tab frame at +25 / -15.
    if (this.tab !== 'auctions') {
      const bidY = FRAME_HEIGHT - 18 - 20;
      if (selected) {
        const bidX = SUBFRAME_WIDTH / 2 + (this.tab === 'browse' ? 25 : -15) - 88;
        drawMoneyInput(this, 'bid', bidX, bidY, splitMoney(this.bidAmount(selected)), this.focusedField);
      }
    }

    if (this.notice) {
      s.text(this.notice, FRAME_WIDTH / 2, FRAME_HEIGHT - 46, { size: 12, align: 'center', color: UI_GOLD });
    }
    // AuctionFrameMoneyFrame: BOTTOMRIGHT@BOTTOMLEFT (181,18).
    drawMoney(s, 181, FRAME_HEIGHT - 18 - 12, this.deps.getPlayerMoney(), { align: 'right' });
  }

  /**
   * Keystrokes for whichever EditBox has focus. The money fields are `numeric="true"` in
   * MoneyInputFrame.xml, so they take digits only; gold is `letters="8"` and silver/copper are
   * `letters="2"`, which is also what stops a silver field from holding 300.
   */
  protected onFieldKey = (
    field: string,
    key: 'char' | 'backspace' | 'enter' | 'escape' | 'tab',
    char?: string,
  ) => {
    if (key === 'escape') { this.focusField(undefined); return; }
    if (key === 'enter') {
      this.focusField(undefined);
      if (field.startsWith('filter:')) this.deps.search(this.browseFilters(0));
      return;
    }
    if (key === 'tab') { this.focusField(this.nextField(field)); return; }

    if (field === 'filter:name') {
      const current = this.search.name;
      const next = key === 'backspace' ? current.slice(0, -1) : `${current}${char ?? ''}`.slice(0, 63);
      this.search = { ...this.search, name: next };
      return;
    }
    if (field === 'filter:minLevel' || field === 'filter:maxLevel') {
      if (key === 'char' && !/^\d$/.test(char ?? '')) return;
      const prop = field === 'filter:minLevel' ? 'minLevel' : 'maxLevel';
      const current = this.search[prop] ? String(this.search[prop]) : '';
      const next = key === 'backspace' ? current.slice(0, -1) : `${current}${char}`.slice(0, 3);
      this.search = { ...this.search, [prop]: Math.min(255, Number(next) || 0) };
      return;
    }
    const bid = /^bid:(gold|silver|copper)$/.exec(field);
    if (bid) {
      if (key === 'char' && !/^\d$/.test(char ?? '')) return;
      const entry = this.selectedEntry();
      if (!entry) return;
      const denom = bid[1] as 'gold' | 'silver' | 'copper';
      const parts = splitMoney(this.bidAmount(entry));
      const maxLetters = denom === 'gold' ? 8 : 2;
      const current = parts[denom] ? String(parts[denom]) : '';
      const next = key === 'backspace' ? current.slice(0, -1) : `${current}${char}`.slice(0, maxLetters);
      const updated = { ...parts, [denom]: Number(next) || 0 };
      this.bidOverride = updated.gold * 10_000 + updated.silver * 100 + updated.copper;
      return;
    }
    const money = /^sell:(start|buyout):(gold|silver|copper)$/.exec(field);
    if (money) {
      if (key === 'char' && !/^\d$/.test(char ?? '')) return;
      const which = money[1] === 'start' ? 'startPrice' : 'buyoutPrice';
      const denom = money[2] as 'gold' | 'silver' | 'copper';
      const parts = splitMoney(this.draft[which]);
      const maxLetters = denom === 'gold' ? 8 : 2;
      const current = parts[denom] ? String(parts[denom]) : '';
      const next = key === 'backspace' ? current.slice(0, -1) : `${current}${char}`.slice(0, maxLetters);
      const updated = { ...parts, [denom]: Number(next) || 0 };
      this.draft = {
        ...this.draft,
        [which]: updated.gold * 10_000 + updated.silver * 100 + updated.copper,
      };
    }
  };

  /**
   * What the bid money input currently holds. It seeds to the auction's minimum and is reset
   * whenever the selection changes, which is what vanilla's `MoneyInputFrame_SetCopper` does on
   * `AuctionFrameBrowse_Update`.
   */
  private bidAmount(entry: AuctionEntryInfo): number {
    return this.bidOverride ?? auctionMinimumBid(entry);
  }

  /** Tab order within the pane that owns the focused field. */
  private nextField(field: string): string | undefined {
    const order = field.startsWith('filter:')
      ? ['filter:name', 'filter:minLevel', 'filter:maxLevel']
      : [
        'sell:start:gold', 'sell:start:silver', 'sell:start:copper',
        'sell:buyout:gold', 'sell:buyout:silver', 'sell:buyout:copper',
      ];
    const index = order.indexOf(field);
    return index < 0 ? undefined : order[(index + 1) % order.length];
  }

  private selectedEntry(): AuctionEntryInfo | undefined {
    const id = this.selected[this.tab];
    return id === undefined ? undefined : this.entries().find((entry) => entry.auctionId === id);
  }

  private browseFilters(page: number) {
    return { ...this.search, itemClass: this.category.itemClass, itemSubClass: this.category.itemSubClass, page };
  }

  /** Panel art has no disabled skin for these, so a disabled hit falls back to the normal one. */
  private buttonState(id: string): 'normal' | 'hover' | 'down' {
    const state = this.state(id);
    return state === 'disabled' ? 'normal' : state;
  }

  protected activate(hit: PanelHit) {
    const deps = this.deps;
    if (hit.id === 'close' || hit.id === 'footer:close') {
      this.playUi('igMainMenuClose');
      deps.onClose();
      this.hide();
      return;
    }
    if (hit.id.startsWith('tab:')) {
      const tab = hit.id.slice(4) as AuctionTab;
      if (tab === this.tab) return;
      this.tab = tab;
      this.notice = '';
      this.playUi('igCharacterInfoTab');
      if (tab === 'browse') deps.search(this.browseFilters(0));
      else if (tab === 'bids') deps.listBids(0);
      else deps.listOwn(0);
      this.surface.requestRender();
      return;
    }
    if (hit.id.startsWith('row:')) {
      this.selected = { ...this.selected, [this.tab]: hit.data as number };
      // MoneyInputFrame_SetCopper reseeds the bid box on every selection change.
      this.bidOverride = undefined;
      this.focusField(undefined);
      this.playUi('igMainMenuOptionCheckBoxOn');
      this.surface.requestRender();
      return;
    }
    if (hit.id === 'page:prev' || hit.id === 'page:next') {
      const page = Math.max(0, this.page() + (hit.id === 'page:next' ? 1 : -1));
      if (this.tab === 'browse') deps.search(this.browseFilters(page));
      else if (this.tab === 'bids') deps.listBids(page);
      else deps.listOwn(page);
      return;
    }
    if (hit.id === 'filter:usable') {
      this.search = { ...this.search, usableOnly: !this.search.usableOnly };
      this.playUi('igMainMenuOptionCheckBoxOn');
      this.surface.requestRender();
      return;
    }
    if (hit.id === 'filter:search') {
      this.selected = { ...this.selected, browse: undefined };
      deps.search(this.browseFilters(0));
      return;
    }
    if (hit.id.startsWith('category:')) {
      this.category = activateAuctionCategory(this.category, hit.id);
      this.playUi('igMainMenuOptionCheckBoxOn');
      this.surface.requestRender();
      return;
    }
    // Clicking any EditBox just gives it the keyboard, exactly like a vanilla EditBox.
    if (hit.id.startsWith('filter:name') || hit.id.startsWith('filter:minLevel')
      || hit.id.startsWith('filter:maxLevel') || hit.id.startsWith('sell:start:')
      || hit.id.startsWith('sell:buyout:')) {
      this.focusField(hit.id);
      return;
    }
    if (hit.id.startsWith('bid:')) { this.focusField(hit.id); return; }
    if (hit.id === 'footer:bid' || hit.id === 'footer:buyout') {
      const entry = this.selectedEntry();
      if (!entry) return;
      // Buyout is not a separate opcode — it is CMSG_AUCTION_PLACE_BID at exactly the buyout price
      // (AuctionHouseHandler.cpp). A bid uses whatever the BrowseBidPrice money input holds, which
      // seeds to the minimum, and the server rejects anything under it anyway.
      const price = hit.id === 'footer:buyout' ? entry.buyout : this.bidAmount(entry);
      if (price < (hit.id === 'footer:buyout' ? entry.buyout : auctionMinimumBid(entry))) return;
      deps.placeBid(entry.auctionId, price);
      this.playUi('igMainMenuOptionCheckBoxOn');
      return;
    }
    if (hit.id === 'footer:cancel') {
      const entry = this.selectedEntry();
      if (entry) deps.cancelAuction(entry.auctionId);
      return;
    }
    if (hit.id === 'sell:slot') {
      const held = deps.heldItem();
      if (held?.itemGuid) {
        this.draft = {
          ...this.draft,
          itemGuid: held.itemGuid,
          itemEntry: held.entry,
          itemCount: held.count,
          displayInfoId: held.displayInfoId,
        };
        deps.clearHeld();
      } else if (this.draft.itemGuid) {
        this.draft = { ...this.draft, itemGuid: undefined, itemEntry: undefined, itemCount: undefined, displayInfoId: undefined };
      }
      this.playUi('igMainMenuOptionCheckBoxOn');
      this.surface.requestRender();
      return;
    }
    if (hit.id.startsWith('sell:duration:')) {
      this.draft = { ...this.draft, durationMinutes: Number(hit.id.split(':')[2]) };
      this.playUi('igMainMenuOptionCheckBoxOn');
      this.surface.requestRender();
      return;
    }
    if (hit.id === 'sell:create') {
      const draft = this.draft;
      if (!draft.itemGuid || draft.startPrice <= 0) return;
      // AUCTION_BUYOUT_ERROR = "(Must be >= the start price)" (GlobalStrings.lua:51).
      if (draft.buyoutPrice > 0 && draft.buyoutPrice < draft.startPrice) {
        this.setNotice('(Must be >= the start price)');
        return;
      }
      deps.sellItem(draft.itemGuid, draft.startPrice, draft.buyoutPrice, draft.durationMinutes);
      this.draft = { startPrice: 0, buyoutPrice: 0, durationMinutes: draft.durationMinutes };
      this.surface.requestRender();
    }
  }
}
