/** Asset conversion utility. */
import type { ReadGuid, Reader, WireCodec } from './wire';

export type { WireCodec };

/** One row of an SMSG_AUCTION_*_LIST_RESULT, in BuildAuctionInfo field order. */
export type AuctionEntryInfo = {
  auctionId: number;
  itemEntry: number;
  enchantId: number;
  randomPropertyId: number;
  suffixFactor: number;
  count: number;
  spellCharges: number;
  ownerGuid: string;
  /** `startbid` — the seller's opening price, NOT what it costs to bid right now. */
  startBid: number;
  /** GetAuctionOutBid(), the minimum increment over `currentBid`. Zero until someone bids. */
  minIncrement: number;
  buyout: number;
  timeLeftMs: number;
  bidderGuid: string;
  currentBid: number;
};

/**
 * The three vanilla AuctionFrame tabs (`AuctionFrameTab1..3`, AuctionFrame.xml:961/970/979):
 * BROWSE / BIDS / AUCTIONS. Each keeps its own page and result set because the server answers
 * each query with a different opcode and the client pages them independently.
 */
export type AuctionTab = 'browse' | 'bids' | 'auctions';

export type AuctionListPage = {
  entries: AuctionEntryInfo[];
  /** Trailing u32 of the list packet: how many rows match server-side across all pages. */
  totalCount: number;
  page: number;
};

export type AuctionState = {
  auctioneerGuid: string;
  houseId: number;
  browse: AuctionListPage;
  bids: AuctionListPage;
  auctions: AuctionListPage;
  pending?: AuctionTab;
  message?: string;
};

export type AuctionSearchFilters = {
  page?: number;
  name?: string;
  minLevel?: number;
  maxLevel?: number;
  inventoryType?: number;
  itemClass?: number;
  itemSubClass?: number;
  quality?: number;
  usableOnly?: boolean;
};

/**
 * `NUM_AUCTION_ITEMS_PER_PAGE` (AuctionFrame.lua:2) and the server's own `count < 50` page cap in
 * AuctionHouseClientQueryTask. Both must agree or paging silently drops rows.
 */
export const AUCTION_ITEMS_PER_PAGE = 50;

/**
 * The only three durations the server accepts, in MINUTES. AuctionHouseHandler.cpp:282-296 allows
 * exactly 1x, 4x and 12x of `MIN_AUCTION_TIME`, which AuctionHouseMgr.h defines as 2 hours.
 * Anything else is answered with AUCTION_ERR_DATABASE.
 */
export const AUCTION_DURATIONS_MINUTES: readonly number[] = [120, 480, 1440];

/** vanilla's "any" sentinel for the category and quality filter fields. */
const FILTER_ANY = 0xffffffff;

export const emptyAuctionPage = (): AuctionListPage => ({ entries: [], totalCount: 0, page: 0 });
export const emptyAuctionPages = () => ({
  browse: emptyAuctionPage(),
  bids: emptyAuctionPage(),
  auctions: emptyAuctionPage(),
});

/** `AUCTION_TIME_LEFT1..4` buckets, GlobalStrings.lua:60-67. */
export function auctionTimeLeftLabel(timeLeftMs: number): string {
  const minutes = timeLeftMs / 60_000;
  if (minutes < 30) return 'Short';
  if (minutes < 120) return 'Medium';
  if (minutes < 480) return 'Long';
  return 'Very Long';
}

/**
 * The amount that must be offered to take the lead. vMaNGOS validates
 * `price >= auction->bid + auction->GetAuctionOutBid()` once a bid exists and
 * `price >= auction->startbid` while it is unbid (AuctionHouseHandler.cpp:186-215).
 */
export function auctionMinimumBid(entry: AuctionEntryInfo): number {
  return entry.currentBid > 0 ? entry.currentBid + entry.minIncrement : entry.startBid;
}

/**
 * ERR_AUCTION_* strings, GlobalStrings.lua:1206-1223, keyed by vMaNGOS `AuctionError`
 * (AuctionHouseMgr.h:40-52). Codes 6, 8, 9, 11 and 12 are unused by the 1.12 server.
 */
export const AUCTION_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  1: 'Internal auction error.',                       // AUCTION_ERR_INVENTORY
  2: 'Internal auction error.',                       // ERR_AUCTION_DATABASE_ERROR
  3: "You don't have enough money.",                  // ERR_NOT_ENOUGH_MONEY
  4: 'Item not found.',                               // ERR_ITEM_NOT_FOUND
  5: 'There is already a higher bid on that item.',   // ERR_AUCTION_HIGHER_BID
  7: 'Your bid increment is too small.',              // ERR_AUCTION_BID_INCREMENT
  10: 'You cannot bid on your own auction.',          // ERR_AUCTION_BID_OWN
  13: 'Restricted account.',                          // ERR_RESTRICTED_ACCOUNT
};

/** `AuctionAction` success strings — ERR_AUCTION_STARTED / _REMOVED / _BID_PLACED. */
export const AUCTION_ACTION_MESSAGES: Readonly<Record<number, string>> = {
  0: 'Auction created.',
  1: 'Auction cancelled.',
  2: 'Bid accepted.',
};

/**
 * All three SMSG_AUCTION_*_LIST_RESULT variants share one body: `u32 count`, `count` rows in
 * BuildAuctionInfo order, then a trailing `u32 totalCount` (AuctionHouseHandler.cpp:697-698).
 * The count prefix is back-patched by the server, so it is authoritative for how many rows follow;
 * `totalCount` is the unpaged match count the pager needs.
 */
export function readAuctionList<R extends Reader>(
  r: R,
  readGuid: ReadGuid<R>,
): { entries: AuctionEntryInfo[]; totalCount: number } {
  const count = r.u32();
  const entries: AuctionEntryInfo[] = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      auctionId: r.u32(),
      itemEntry: r.u32(),
      enchantId: r.u32(),
      randomPropertyId: r.u32(),
      suffixFactor: r.u32(),
      count: r.u32(),
      spellCharges: r.u32(),
      ownerGuid: readGuid(r),
      startBid: r.u32(),
      minIncrement: r.u32(),
      buyout: r.u32(),
      timeLeftMs: r.u32(),
      bidderGuid: readGuid(r),
      currentBid: r.u32(),
    });
  }
  return { entries, totalCount: r.u32() };
}

/**
 * CMSG_AUCTION_LIST_ITEMS (AuctionHouse.cpp:52-63):
 * u64 auctioneer, u32 listFrom, cstring name, u8 minLevel, u8 maxLevel, u32 auctionSlotID,
 * u32 mainCategory, u32 subCategory, u32 quality, u8 usable.
 *
 * `listFrom` is a ROW offset and the server pages 50 at a time, so page N asks for row N*50.
 */
export function buildAuctionListItems(
  codec: WireCodec,
  auctioneerGuid: string,
  filters: AuctionSearchFilters,
): Uint8Array {
  const page = Math.max(0, Math.floor(filters.page ?? 0));
  return codec.concat(
    codec.guid(auctioneerGuid),
    codec.u32(page * AUCTION_ITEMS_PER_PAGE),
    codec.cstring((filters.name ?? '').slice(0, 63)),
    new Uint8Array([Math.max(0, Math.min(255, filters.minLevel ?? 0))]),
    new Uint8Array([Math.max(0, Math.min(255, filters.maxLevel ?? 0))]),
    codec.u32(filters.inventoryType ?? FILTER_ANY),
    codec.u32(filters.itemClass ?? FILTER_ANY),
    codec.u32(filters.itemSubClass ?? FILTER_ANY),
    codec.u32(filters.quality ?? FILTER_ANY),
    new Uint8Array([filters.usableOnly ? 1 : 0]),
  );
}

/** CMSG_AUCTION_LIST_OWNER_ITEMS: u64 auctioneer + u32 listFrom. */
export function buildAuctionListOwner(codec: WireCodec, guid: string, page: number): Uint8Array {
  return codec.concat(codec.guid(guid), codec.u32(Math.max(0, page) * AUCTION_ITEMS_PER_PAGE));
}

/**
 * CMSG_AUCTION_LIST_BIDDER_ITEMS: u64 auctioneer + u32 listFrom + u32 refreshCount + u32[] ids.
 * The id array lets the client re-poll auctions it has bid on; an empty array is what vanilla
 * sends on a plain tab open.
 */
export function buildAuctionListBidder(
  codec: WireCodec, guid: string, page: number, refreshIds: readonly number[],
): Uint8Array {
  return codec.concat(
    codec.guid(guid),
    codec.u32(Math.max(0, page) * AUCTION_ITEMS_PER_PAGE),
    codec.u32(refreshIds.length),
    ...refreshIds.map((id) => codec.u32(id >>> 0)),
  );
}

/**
 * CMSG_AUCTION_SELL_ITEM: u64 auctioneer, u64 itemGuid, u32 bid, u32 buyout, u32 etimeMinutes.
 * Returns undefined when the duration is not one the server accepts, so the caller sends nothing
 * rather than eating an AUCTION_ERR_DATABASE.
 */
export function buildAuctionSellItem(
  codec: WireCodec,
  auctioneerGuid: string,
  itemGuid: string,
  bid: number,
  buyout: number,
  durationMinutes: number,
): Uint8Array | undefined {
  if (!AUCTION_DURATIONS_MINUTES.includes(durationMinutes) || bid <= 0) return undefined;
  return codec.concat(
    codec.guid(auctioneerGuid),
    codec.guid(itemGuid),
    codec.u32(Math.floor(bid)),
    codec.u32(Math.max(0, Math.floor(buyout))),
    codec.u32(durationMinutes),
  );
}

/**
 * CMSG_AUCTION_PLACE_BID: u64 auctioneer + u32 auctionId + u32 price. A price equal to the
 * auction's buyout is how vanilla buys out — there is no separate opcode.
 */
export function buildAuctionPlaceBid(
  codec: WireCodec, guid: string, auctionId: number, price: number,
): Uint8Array {
  return codec.concat(codec.guid(guid), codec.u32(auctionId >>> 0), codec.u32(Math.floor(price)));
}

/** CMSG_AUCTION_REMOVE_ITEM: u64 auctioneer + u32 auctionId. */
export function buildAuctionRemoveItem(codec: WireCodec, guid: string, auctionId: number): Uint8Array {
  return codec.concat(codec.guid(guid), codec.u32(auctionId >>> 0));
}
