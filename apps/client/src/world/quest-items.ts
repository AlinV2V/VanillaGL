/** Asset conversion utility. */
import type { ReadGuid, Reader, WireCodec } from './wire';

export const QUEST_ITEM_OPCODES = {
  CMSG_PAGE_TEXT_QUERY: 0x005a,
  SMSG_PAGE_TEXT_QUERY_RESPONSE: 0x005b,
  CMSG_OPEN_ITEM: 0x00ac,
  CMSG_READ_ITEM: 0x00ad,
  SMSG_READ_ITEM_OK: 0x00ae,
  SMSG_READ_ITEM_FAILED: 0x00af,
  SMSG_GAMEOBJECT_PAGETEXT: 0x01df,
  CMSG_QUEST_CONFIRM_ACCEPT: 0x019b,
  SMSG_QUEST_CONFIRM_ACCEPT: 0x019c,
  CMSG_PUSHQUESTTOPARTY: 0x019d,
  MSG_QUEST_PUSH_RESULT: 0x0276,
} as const;

export const QUEST_SHARE_RESULT = {
  SHARING: 0,
  INVALID: 1,
  ACCEPTED: 2,
  DECLINED: 3,
  TOO_FAR: 4,
  BUSY: 5,
  LOG_FULL: 6,
  ON_QUEST: 7,
  ALREADY_DONE: 8,
} as const;

export type QuestShareConfirm = { questId: number; title: string; senderGuid: string };
export type QuestShareResult = { playerGuid: string; result: number };
export type QuestRewardItem = { itemId: number; count: number; displayInfoId: number };
export type QuestQueryItem = { itemId: number; count: number };
export type ItemPrototypeMetadata = {
  requiredSkill?: number; requiredSkillRank?: number; requiredSpell?: number;
  requiredHonorRank?: number; requiredCityRank?: number;
  requiredReputationFaction?: number; requiredReputationRank?: number;
  bonding?: number; randomProperty?: number; block?: number; itemSet?: number;
  maxDurability?: number; area?: number; map?: number; bagFamily?: number;
};
export type ReadableItemPage = { pageId: number; text: string; nextPageId: number };
export type ReadableItemState = {
  itemGuid: string;
  itemEntry: number;
  title: string;
  material: PageMaterial;
  pages: ReadableItemPage[];
};
export type QuestItemEvent =
  | { kind: 'questShareConfirm'; state: QuestShareConfirm; message: string }
  | { kind: 'questShareResult'; message: string; playerGuid: string; result: number }
  | { kind: 'itemText'; state: ReadableItemState }
  | { kind: 'itemTextMessage'; message: string; reason?: number };

export type PageMaterial = 'Parchment' | 'Stone' | 'Marble' | 'Silver' | 'Bronze';

type ReadableGameObjectInfo = { name: string; type: number; rawData: number[] };

const MATERIALS: Record<number, PageMaterial> = {
  1: 'Parchment',
  2: 'Stone',
  3: 'Marble',
  4: 'Silver',
  5: 'Bronze',
};

export const pageMaterial = (id: number): PageMaterial => MATERIALS[id] ?? 'Parchment';

export function readRewardItems(r: Reader, count: number): QuestRewardItem[] {
  const items: QuestRewardItem[] = [];
  for (let i = 0; i < count && r.remaining >= 12; i++) {
    const itemId = r.u32();
    const itemCount = r.u32();
    const displayInfoId = r.u32();
    if (itemId) items.push({ itemId, count: itemCount, displayInfoId });
  }
  return items;
}

export function readQuestQueryItems(r: Reader, count: number): QuestQueryItem[] {
  const items: QuestQueryItem[] = [];
  for (let i = 0; i < count && r.remaining >= 8; i++) {
    const itemId = r.u32();
    const itemCount = r.u32();
    if (itemId) items.push({ itemId, count: itemCount });
  }
  return items;
}

/** ItemHandler.cpp's ItemPrototype tail after the five item-spell records. */
export function readItemPrototypeTail(r: Reader) {
  const bonding = r.remaining >= 4 ? r.u32() : 0;
  const description = r.remaining > 0 ? r.cstring() : '';
  const pageText = r.remaining >= 4 ? r.u32() : 0;
  const languageId = r.remaining >= 4 ? r.u32() : 0;
  const pageMaterial = r.remaining >= 4 ? r.u32() : 0;
  const startQuest = r.remaining >= 4 ? r.u32() : 0;
  const lockId = r.remaining >= 4 ? r.u32() : 0;
  // Material drives impact audio through Material.dbc; Sheath selects the M2 stow attachment.
  const material = r.remaining >= 4 ? r.u32() : 0;
  const sheath = r.remaining >= 4 ? r.u32() : 0;
  const randomProperty = r.remaining >= 4 ? r.u32() : 0;
  const block = r.remaining >= 4 ? r.u32() : 0;
  const itemSet = r.remaining >= 4 ? r.u32() : 0;
  const maxDurability = r.remaining >= 4 ? r.u32() : 0;
  // Build 5875 sends all three conditional fields at the end of the item prototype response.
  const area = r.remaining >= 4 ? r.u32() : 0;
  const map = r.remaining >= 4 ? r.u32() : 0;
  const bagFamily = r.remaining >= 4 ? r.u32() : 0;
  return {
    description, pageText, languageId, pageMaterial, startQuest, lockId, material, sheath,
    bonding, randomProperty, block, itemSet, maxDurability, area, map, bagFamily,
  };
}

/** Seven Build-5875 usage requirements immediately following RequiredLevel. */
export function readItemPrototypeRequirements(r: Reader): ItemPrototypeMetadata {
  const read = () => r.remaining >= 4 ? r.u32() : 0;
  return {
    requiredSkill: read(), requiredSkillRank: read(), requiredSpell: read(),
    requiredHonorRank: read(), requiredCityRank: read(),
    requiredReputationFaction: read(), requiredReputationRank: read(),
  };
}

export function readQuestShareConfirm<R extends Reader>(r: R, readGuid: ReadGuid<R>): QuestShareConfirm {
  return { questId: r.u32(), title: r.cstring(), senderGuid: readGuid(r) };
}

export function readQuestShareResult<R extends Reader>(r: R, readGuid: ReadGuid<R>): QuestShareResult {
  return { playerGuid: readGuid(r), result: r.u8() };
}

export function readReadableItemOk<R extends Reader>(r: R, readGuid: ReadGuid<R>): string {
  const itemGuid = readGuid(r);
  const repeatedGuid = readGuid(r);
  if (repeatedGuid !== itemGuid) throw new Error('SMSG_READ_ITEM_OK repeated a different item guid');
  return itemGuid;
}

export function readReadableItemFailed<R extends Reader>(r: R, readGuid: ReadGuid<R>) {
  const itemGuid = readGuid(r);
  const reason = r.u8();
  const repeatedGuid = readGuid(r);
  if (repeatedGuid !== itemGuid) throw new Error('SMSG_READ_ITEM_FAILED repeated a different item guid');
  return { itemGuid, reason };
}

export function readPageText(r: Reader): ReadableItemPage {
  return { pageId: r.u32(), text: r.cstring(), nextPageId: r.u32() };
}

export function appendReadablePage(state: ReadableItemState, page: ReadableItemPage): ReadableItemState {
  const pages = state.pages.filter((existing) => existing.pageId !== page.pageId);
  const previousId = state.pages.find((candidate) => candidate.nextPageId === page.pageId)?.pageId;
  const previousIndex = previousId === undefined ? -1 : pages.findIndex((candidate) => candidate.pageId === previousId);
  if (previousIndex >= 0) pages.splice(previousIndex + 1, 0, page);
  else pages.push(page);
  return { ...state, pages };
}

export function buildQuestConfirmAccept(questId: number, codec: WireCodec) {
  return codec.u32(questId >>> 0);
}

export function buildQuestPushResult(senderGuid: string, result: number, codec: WireCodec) {
  return codec.concat(codec.guid(senderGuid), new Uint8Array([result & 0xff]));
}

export function buildPageTextQuery(pageId: number, codec: WireCodec) {
  return codec.u32(pageId >>> 0);
}

/** World PageText queries append the object's u64; item PageText queries contain only the id. */
export function buildGameObjectPageTextQuery(pageId: number, guid: string, codec: WireCodec) {
  return codec.concat(codec.u32(pageId >>> 0), codec.guid(guid));
}

/** GameObjectInfo::raw indices from the Build-5875 GameObjectInfo union. */
export function gameObjectPageMetadata(info: ReadableGameObjectInfo) {
  const pageId = info.type === 9 ? info.rawData[0] : info.type === 10 ? info.rawData[7] : 0;
  const materialId = info.type === 9 ? info.rawData[2] : info.type === 10 ? info.rawData[9] : 0;
  return pageId ? { pageId, material: pageMaterial(materialId ?? 0) } : undefined;
}

/** Exact ERR_QUEST_PUSH_* wording from Vanilla GlobalStrings.lua. */
export function questShareResultMessage(result: number, playerName: string) {
  switch (result) {
    case QUEST_SHARE_RESULT.SHARING: return `Sharing quest with ${playerName}...`;
    case QUEST_SHARE_RESULT.INVALID: return `${playerName} is not eligible for that quest`;
    case QUEST_SHARE_RESULT.ACCEPTED: return `${playerName} has accepted your quest`;
    case QUEST_SHARE_RESULT.DECLINED: return `${playerName} has declined your quest`;
    case QUEST_SHARE_RESULT.TOO_FAR: return `${playerName} is too far away to receive your quest`;
    case QUEST_SHARE_RESULT.BUSY: return `${playerName} is busy`;
    case QUEST_SHARE_RESULT.LOG_FULL: return `${playerName}'s quest log is full`;
    case QUEST_SHARE_RESULT.ON_QUEST: return `${playerName} is already on that quest`;
    case QUEST_SHARE_RESULT.ALREADY_DONE: return `${playerName} has completed that quest`;
    default: return `Quest sharing with ${playerName} failed (${result})`;
  }
}

type ItemMetadata = { name: string; pageText?: number; pageMaterial?: number };
type QuestItemProtocolDeps<R extends Reader> = {
  reader(body: Uint8Array): R;
  readGuid: ReadGuid<R>;
  codec: WireCodec;
  send(opcode: number, body: Uint8Array): void;
  itemEntry(itemGuid: string): number | undefined;
  itemInfo(entry: number): ItemMetadata | undefined;
  gameObjectEntry(guid: string): number | undefined;
  gameObjectInfo(entry: number): ReadableGameObjectInfo | undefined;
  queryGameObject(entry: number, guid: string): void;
  playerName(guid: string): string | undefined;
  queryPlayerName(guid: string): void;
  emit(event: QuestItemEvent): void;
  progress(message: string): void;
};

/** Owns the multi-packet item-page session and keeps packet branching out of world.ts. */
export class QuestItemProtocol<R extends Reader> {
  private readableItem: ReadableItemState | undefined;
  private readableRootPage = 0;
  private pendingGameObjectGuid?: string;
  private readonly deps: QuestItemProtocolDeps<R>;

  constructor(deps: QuestItemProtocolDeps<R>) { this.deps = deps; }

  reset() { this.readableItem = undefined; this.readableRootPage = 0; this.pendingGameObjectGuid = undefined; }

  /** Type-9 text objects are opened from their cached template; goobers arrive through SMSG. */
  openGameObject(guid: string): boolean {
    const entry = this.deps.gameObjectEntry(guid) ?? 0;
    if (!entry) return false;
    const info = this.deps.gameObjectInfo(entry);
    if (!info) {
      this.pendingGameObjectGuid = guid;
      this.deps.queryGameObject(entry, guid);
      return true;
    }
    const page = gameObjectPageMetadata(info);
    if (!page) return false;
    this.pendingGameObjectGuid = undefined;
    this.readableRootPage = page.pageId;
    this.readableItem = { itemGuid: guid, itemEntry: entry, title: info.name, material: page.material, pages: [] };
    this.deps.emit({ kind: 'itemText', state: this.readableItem });
    this.deps.send(QUEST_ITEM_OPCODES.CMSG_PAGE_TEXT_QUERY, buildGameObjectPageTextQuery(page.pageId, guid, this.deps.codec));
    return true;
  }

  gameObjectMetadataArrived(entry: number) {
    const guid = this.pendingGameObjectGuid;
    if (guid && this.deps.gameObjectEntry(guid) === entry) this.openGameObject(guid);
  }

  confirmQuest(questId: number) {
    const cleanQuestId = questId >>> 0;
    if (cleanQuestId) this.deps.send(QUEST_ITEM_OPCODES.CMSG_QUEST_CONFIRM_ACCEPT, buildQuestConfirmAccept(cleanQuestId, this.deps.codec));
  }

  declineQuest(senderGuid: string) {
    this.deps.send(
      QUEST_ITEM_OPCODES.MSG_QUEST_PUSH_RESULT,
      buildQuestPushResult(senderGuid, QUEST_SHARE_RESULT.DECLINED, this.deps.codec),
    );
  }

  handle(opcode: number, body: Uint8Array): boolean {
    switch (opcode) {
      case QUEST_ITEM_OPCODES.SMSG_READ_ITEM_OK:
        return this.guard('readable item', () => {
          const itemGuid = readReadableItemOk(this.deps.reader(body), this.deps.readGuid);
          const itemEntry = this.deps.itemEntry(itemGuid) ?? 0;
          const info = this.deps.itemInfo(itemEntry);
          if (!itemEntry || !info?.pageText) throw new Error(`item ${itemGuid} has no PageText metadata`);
          this.readableItem = {
            itemGuid, itemEntry, title: info.name, material: pageMaterial(info.pageMaterial ?? 0), pages: [],
          };
          this.readableRootPage = info.pageText;
          this.deps.emit({ kind: 'itemText', state: this.readableItem });
          this.deps.send(QUEST_ITEM_OPCODES.CMSG_PAGE_TEXT_QUERY, buildPageTextQuery(info.pageText, this.deps.codec));
        });
      case QUEST_ITEM_OPCODES.SMSG_READ_ITEM_FAILED:
        return this.guard('readable item failure', () => {
          const { reason } = readReadableItemFailed(this.deps.reader(body), this.deps.readGuid);
          this.deps.emit({ kind: 'itemTextMessage', reason, message: 'You cannot read that item.' });
        });
      case QUEST_ITEM_OPCODES.SMSG_GAMEOBJECT_PAGETEXT:
        return this.guard('gameobject page text', () => {
          const r = this.deps.reader(body);
          const guid = this.deps.readGuid(r);
          if (r.remaining !== 0) throw new Error(`gameobject page text left ${r.remaining} unread bytes`);
          if (!this.openGameObject(guid)) throw new Error(`gameobject ${guid} has no PageText metadata`);
        });
      case QUEST_ITEM_OPCODES.SMSG_PAGE_TEXT_QUERY_RESPONSE:
        return this.guard('page text', () => {
          const page = readPageText(this.deps.reader(body));
          const state = this.readableItem;
          const expected = state && (page.pageId === this.readableRootPage || state.pages.some((known) => known.nextPageId === page.pageId));
          if (state && expected) {
            this.readableItem = appendReadablePage(state, page);
            this.deps.emit({ kind: 'itemText', state: this.readableItem });
          }
        });
      case QUEST_ITEM_OPCODES.SMSG_QUEST_CONFIRM_ACCEPT:
        return this.guard('quest share confirmation', () => {
          const state = readQuestShareConfirm(this.deps.reader(body), this.deps.readGuid);
          this.deps.queryPlayerName(state.senderGuid);
          const name = this.deps.playerName(state.senderGuid) ?? 'A party member';
          this.deps.emit({
            kind: 'questShareConfirm', state,
            message: `${name} is starting ${state.title}\nWould you like to as well?`,
          });
        });
      case QUEST_ITEM_OPCODES.MSG_QUEST_PUSH_RESULT:
        return this.guard('quest share result', () => {
          const { playerGuid, result } = readQuestShareResult(this.deps.reader(body), this.deps.readGuid);
          this.deps.queryPlayerName(playerGuid);
          const name = this.deps.playerName(playerGuid) ?? 'A party member';
          this.deps.emit({ kind: 'questShareResult', playerGuid, result, message: questShareResultMessage(result, name) });
        });
      default:
        return false;
    }
  }

  private guard(label: string, action: () => void) {
    try { action(); }
    catch (error) { this.deps.progress(`world: ${label} parse skipped (${(error as Error).message})`); }
    return true;
  }
}
