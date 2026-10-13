/** Asset conversion utility. */
import type { CharacterInfo, ItemInfo, QuestLogEntry, QuestLogSnapshot } from '../world';
import { drawMoney } from './money';
import { CanvasPanel, drawQuestItemBanner, drawScrollBar, UI_INK, type PanelHit } from './panel-kit';
import { itemTooltipLines } from './tooltip-content';

export type QuestLogWorld = {
  getQuestLog(): QuestLogSnapshot;
  queryQuestInfo(questId: number): void;
  removeQuestLogSlot(slot: number): void;
  pushQuestToParty(questId: number): void;
};

export type QuestLogControllerDeps = {
  frame: HTMLElement;
  microButton: HTMLButtonElement;
  getWorld: () => QuestLogWorld | undefined;
  getCurrentCharacter: () => CharacterInfo | undefined;
  getPlayerLevel: () => number | undefined;
  getAreaName: (areaId: number) => string | undefined;
  getCurrentAreaName: () => string | undefined;
  questText: (text: string) => string;
  getItemInfo: (entry: number) => ItemInfo | undefined;
  itemIconUrl: (displayInfoId?: number, entry?: number) => string;
  getItemName: (entry: number) => string | undefined;
  confirmAbandon?: (message: string, onConfirm: () => void) => void;
  playUi?: (name: string) => boolean;
  onToggleWatch?: (entry: QuestLogEntry) => void;
};

const LIST = { x: 19, y: 75, width: 300, rowHeight: 16, rows: 6 };
const DETAIL = { x: 19, y: 175, width: 300, height: 261 };

type ListRow =
  | { kind: 'zone'; name: string; collapsed: boolean }
  | { kind: 'quest'; entry: QuestLogEntry };

export class QuestLogController extends CanvasPanel {
  private open = false;
  private selectedQuestSlot = -1;
  private listScroll = 0;
  private detailScroll = 0;
  private detailContentHeight = 0;
  private collapsedZones = new Set<string>();
  private snapshot?: QuestLogSnapshot;

  constructor(private readonly deps: QuestLogControllerDeps) {
    super(deps.frame, 384, 512, 'wow-native-panel-canvas');
    deps.microButton.addEventListener('click', () => {
      if (this.deps.getCurrentCharacter()) this.toggle();
    });
    this.onWheel = (direction, point) => {
      if (point.y < DETAIL.y) {
        const max = Math.max(0, this.buildRows().length - LIST.rows);
        this.listScroll = Math.max(0, Math.min(max, this.listScroll + direction));
      } else {
        const max = Math.max(0, this.detailContentHeight - DETAIL.height);
        this.detailScroll = Math.max(0, Math.min(max, this.detailScroll + direction * 36));
      }
      this.surface.requestRender();
    };
  }

  isOpen() {
    return this.open;
  }

  toggle() {
    this.setOpen(!this.open);
  }

  setOpen(open: boolean) {
    const changed = this.open !== open;
    this.open = open;
    this.deps.frame.classList.toggle('is-hidden', !open);
    this.deps.microButton.classList.toggle('is-open', open);
    if (open) this.render();
    if (changed) this.deps.playUi?.(open ? 'QUESTLOGOPEN' : 'QUESTLOGCLOSE');
  }

  render(snapshot = this.deps.getWorld()?.getQuestLog()) {
    this.snapshot = snapshot;
    for (const entry of snapshot?.entries ?? []) {
      if (!entry.info) this.deps.getWorld()?.queryQuestInfo(entry.questId);
    }
    const entries = snapshot?.entries ?? [];
    if (this.selectedQuestSlot < 0 || !entries.some((entry) => entry.slot === this.selectedQuestSlot)) {
      this.selectedQuestSlot = entries[0]?.slot ?? -1;
      this.detailScroll = 0;
    }
    this.surface.requestRender();
  }

  private zoneOf(entry: QuestLogEntry): string {
    const zoneOrSort = entry.info?.zoneOrSort ?? 0;
    if (zoneOrSort > 0) return this.deps.getAreaName(zoneOrSort) ?? 'Quests';
    return this.deps.getCurrentAreaName() || 'Quests';
  }

  private difficultyColor(questLevel: number) {
    const playerLevel = this.deps.getPlayerLevel() ?? this.deps.getCurrentCharacter()?.level ?? questLevel;
    const diff = questLevel - playerLevel;
    if (diff >= 5) return '#ff1a1a';
    if (diff >= 3) return '#ff8040';
    if (diff >= -2) return '#ffd100';
    if (questLevel <= playerLevel - 9) return '#9d9d9d';
    return '#40c040';
  }

  private buildRows(): ListRow[] {
    const groups = new Map<string, QuestLogEntry[]>();
    for (const entry of this.snapshot?.entries ?? []) {
      const zone = this.zoneOf(entry);
      (groups.get(zone) ?? groups.set(zone, []).get(zone)!).push(entry);
    }
    const rows: ListRow[] = [];
    for (const [zone, zoneEntries] of groups) {
      const collapsed = this.collapsedZones.has(zone);
      rows.push({ kind: 'zone', name: zone, collapsed });
      if (!collapsed) for (const entry of zoneEntries) rows.push({ kind: 'quest', entry });
    }
    return rows;
  }

  protected paint() {
    const s = this.surface;
    s.clear();
    const entries = this.snapshot?.entries ?? [];
    s.fourSlice('/ui/Interface/QuestFrame', ['UI-QuestLog-TopLeft', 'UI-QuestLog-TopRight', 'UI-QuestLog-BotLeft', 'UI-QuestLog-BotRight']);
    s.image('/ui/Interface/QuestFrame/UI-QuestLog-BookIcon.png', 4, 4, 64, 64);
    s.text('Quest Log', 192, 22, { size: 13, color: '#ffffff', align: 'center', baseline: 'middle' });
    s.closeButton(323, 8, this.buttonState('close'));
    this.hit('close', { x: 323, y: 8, width: 32, height: 32 });

    // Quest count plate (Common-Input-Border 3-slice, 116x20 at top right).
    const plate = { x: 384 - 47 - 116, y: 41, width: 116, height: 20 };
    const border = '/ui/Interface/Common/Common-Input-Border.png';
    s.sprite(border, 0, 0, 8, 20, plate.x, plate.y, 8, plate.height);
    s.sprite(border, 8, 0, 112, 20, plate.x + 8, plate.y, plate.width - 16, plate.height);
    s.sprite(border, 120, 0, 8, 20, plate.x + plate.width - 8, plate.y, 8, plate.height);
    s.text(`Quests: ${entries.length}/${this.snapshot?.capacity ?? 20}`, plate.x + plate.width - 8, plate.y + 14, { size: 10, align: 'right', color: '#ffd100' });

    if (!entries.length) {
      s.image('/ui/Interface/QuestFrame/UI-QuestLog-Empty-TopLeft.png', 19, 73, 256, 256);
      s.image('/ui/Interface/QuestFrame/UI-QuestLog-Empty-TopRight.png', 275, 73, 64, 256);
      s.image('/ui/Interface/QuestFrame/UI-QuestLog-Empty-BotLeft.png', 19, 329, 256, 128);
      s.image('/ui/Interface/QuestFrame/UI-QuestLog-Empty-BotRight.png', 275, 329, 64, 128);
      s.text('You have no quests.', 192, 150, { size: 13, color: '#ffffff', align: 'center' });
    } else {
      this.paintList();
      this.paintDetail();
    }

    const selected = entries.find((entry) => entry.slot === this.selectedQuestSlot);
    const abandonRect = { x: 17, y: 437, width: 125, height: 21 };
    const shareRect = { x: 141, y: 437, width: 123, height: 21 };
    const exitRect = { x: 264, y: 437, width: 77, height: 21 };
    s.panelButton('Abandon Quest', abandonRect, selected ? this.buttonState('abandon') : 'disabled');
    s.panelButton('Share Quest', shareRect, selected ? this.buttonState('share') : 'disabled');
    s.panelButton('Exit', exitRect, this.buttonState('exit'));
    this.hit('abandon', abandonRect, { disabled: !selected });
    this.hit('share', shareRect, { disabled: !selected });
    this.hit('exit', exitRect);
  }

  private paintList() {
    const s = this.surface;
    const rows = this.buildRows();
    const maxScroll = Math.max(0, rows.length - LIST.rows);
    this.listScroll = Math.max(0, Math.min(maxScroll, this.listScroll));
    rows.slice(this.listScroll, this.listScroll + LIST.rows).forEach((row, index) => {
      const y = LIST.y + index * LIST.rowHeight;
      if (row.kind === 'zone') {
        const id = `zone:${row.name}`;
        s.image(`/ui/Interface/Buttons/UI-${row.collapsed ? 'Plus' : 'Minus'}Button-${this.state(id) === 'down' ? 'Down' : 'Up'}.png`, LIST.x + 3, y, 16, 16);
        s.text(row.name, LIST.x + 23, y + 12, { size: 12, color: '#ffd100' });
        this.hit(id, { x: LIST.x, y, width: LIST.width, height: LIST.rowHeight }, { data: row.name });
        return;
      }
      const entry = row.entry;
      const id = `quest:${entry.slot}`;
      const info = entry.info;
      const level = info?.level ?? 0;
      const color = this.difficultyColor(level);
      if (entry.slot === this.selectedQuestSlot) {
        s.addImage('/ui/Interface/QuestFrame/UI-QuestLogTitleHighlight.png', LIST.x, y, 293, LIST.rowHeight, 0.9);
      } else if (this.state(id) === 'hover') {
        s.addImage('/ui/Interface/QuestFrame/UI-QuestLogTitleHighlight.png', LIST.x, y, 293, LIST.rowHeight, 0.45);
      }
      const title = info?.title ?? `Quest #${entry.questId}`;
      s.text(title, LIST.x + 23, y + 12, { size: 12, color, maxWidth: 195 });
      const tag = entry.complete ? '(Complete)' : entry.failed ? '(Failed)' : '';
      if (tag) s.text(tag, LIST.x + LIST.width - 6, y + 12, { size: 11, align: 'right', color });
      this.hit(id, { x: LIST.x, y, width: LIST.width, height: LIST.rowHeight }, { data: entry.slot });
    });
    if (rows.length > LIST.rows) {
      drawScrollBar(this, 'list-scroll', LIST.x + LIST.width + 5, LIST.y, LIST.rows * LIST.rowHeight, this.listScroll, maxScroll);
    }
  }

  private paintDetail() {
    const s = this.surface;
    const entry = this.snapshot?.entries.find((candidate) => candidate.slot === this.selectedQuestSlot);
    if (!entry) return;
    const info = entry.info;
    const ctx = s.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(DETAIL.x, DETAIL.y, DETAIL.width + 10, DETAIL.height);
    ctx.clip();
    let y = DETAIL.y + 5 - this.detailScroll;
    const left = DETAIL.x + 5;

    const morpheus = (text: string) => {
      for (const line of s.wrapText(text, 285, { size: 17, family: 'morpheus' })) {
        s.text(line, left, y + 14, { size: 17, family: 'morpheus', color: UI_INK, shadow: false });
        y += 20;
      }
      y += 3;
    };
    const body = (text: string, color = UI_INK, size = 13) => {
      for (const line of s.wrapText(this.deps.questText(text), 272, { size })) {
        s.text(line, left, y + 11, { size, color, shadow: false });
        y += size + 3;
      }
      y += 4;
    };

    if (!info) {
      s.text('Retrieving quest information...', left, y + 20, { size: 12, color: UI_INK, shadow: false });
      ctx.restore();
      return;
    }
    morpheus(info.title || `Quest #${entry.questId}`);
    if (info.objectives) body(info.objectives);
    const objectives = info.requiredObjectives ?? [];
    objectives.forEach((objective, index) => {
      const have = entry.objectiveCounts[index] ?? 0;
      const need = objective.creatureOrGoCount || objective.itemCount || 0;
      const label = objective.text
        || (objective.itemId ? this.deps.getItemName(objective.itemId) ?? `Item #${objective.itemId}` : `Objective ${index + 1}`);
      const done = need > 0 && have >= need;
      const progress = need ? `: ${Math.min(have, need)}/${need}` : '';
      body(` - ${label}${progress}${done ? ' (Complete)' : ''}`, done ? '#808080' : '#3f3323', 11);
      y -= 4;
    });
    if (objectives.length) y += 6;
    if (entry.complete) body('Quest complete - return to the quest giver.', '#207020', 12);
    if (info.details) {
      morpheus('Description');
      body(info.details);
    }
    if (info.choiceRewards.length || info.rewards.length || info.rewardOrRequiredMoney > 0) {
      morpheus('Rewards');
      // Vanilla labels the two reward kinds separately (GlobalStrings.lua): choice rewards get
      // REWARD_CHOICES, and guaranteed items get REWARD_ITEMS ("You will also receive:") when a
      // choice list precedes them, or REWARD_ITEMS_ONLY ("You will receive:") when it does not.
      // Rendering both lists under one bare "Rewards" header hid which items the player has to
      // pick between and which are always granted.
      const drawRewardList = (items: typeof info.rewards, keyPrefix: string) => {
        items.forEach((item, index) => {
          const column = index % 2;
          const row = Math.floor(index / 2);
          const x = left - 3 + column * 149;
          const rowY = y + row * 44;
          const itemInfo = this.deps.getItemInfo(item.itemId);
          drawQuestItemBanner(s, x, rowY, {
            iconUrl: this.deps.itemIconUrl(undefined, item.itemId) || undefined,
            name: itemInfo?.name ?? this.deps.getItemName(item.itemId) ?? `Item #${item.itemId}`,
            count: item.count,
            quality: itemInfo?.quality,
            fallback: (this.deps.getItemName(item.itemId) ?? '??').slice(0, 2).toUpperCase(),
          });
          this.hit(`${keyPrefix}:${index}`, { x, y: rowY, width: 147, height: 41 }, {
            disabled: true,
            tooltip: () => itemTooltipLines(itemInfo, item.itemId, { count: item.count }),
          });
        });
        y += Math.ceil(items.length / 2) * 44 + 4;
      };
      const rewardHeader = (text: string) => {
        s.text(text, left, y + 11, { size: 12, color: UI_INK, shadow: false });
        y += 18;
      };

      if (info.choiceRewards.length) {
        rewardHeader('You will be able to choose one of these rewards:');
        drawRewardList(info.choiceRewards, 'choice');
      }
      if (info.rewards.length) {
        rewardHeader(info.choiceRewards.length ? 'You will also receive:' : 'You will receive:');
        drawRewardList(info.rewards, 'reward');
      }
      if (info.rewardOrRequiredMoney > 0) {
        s.text('You will receive:', left, y + 11, { size: 12, color: UI_INK, shadow: false });
        drawMoney(s, left + s.measureText('You will receive:', { size: 12 }) + 8, y + 6, info.rewardOrRequiredMoney, { align: 'left' });
        y += 20;
      }
    }
    this.detailContentHeight = y + this.detailScroll - DETAIL.y + 10;
    ctx.restore();
    if (this.detailContentHeight > DETAIL.height) {
      drawScrollBar(this, 'detail-scroll', DETAIL.x + DETAIL.width + 5, DETAIL.y, DETAIL.height, this.detailScroll, Math.max(1, this.detailContentHeight - DETAIL.height));
    }
  }

  private buttonState(id: string): 'normal' | 'hover' | 'down' {
    const state = this.state(id);
    return state === 'disabled' ? 'normal' : state;
  }

  protected activate(hit: PanelHit, event?: PointerEvent) {
    if (hit.id === 'close' || hit.id === 'exit') {
      this.setOpen(false);
      return;
    }
    if (hit.id === 'abandon') {
      if (this.selectedQuestSlot >= 0) {
        const slot = this.selectedQuestSlot;
        const entry = this.snapshot?.entries.find((candidate) => candidate.slot === slot);
        const abandon = () => {
          this.deps.playUi?.('igQuestLogAbandonQuest');
          this.deps.getWorld()?.removeQuestLogSlot(slot);
          this.selectedQuestSlot = -1; // server pushes an updated quest log via emitQuestLog
        };
        const message = `Abandon ${entry?.info?.title ?? 'this quest'}?`;
        if (this.deps.confirmAbandon) this.deps.confirmAbandon(message, abandon);
        else abandon();
      }
      return;
    }
    if (hit.id === 'share') {
      const entry = this.snapshot?.entries.find((candidate) => candidate.slot === this.selectedQuestSlot);
      if (entry) this.deps.getWorld()?.pushQuestToParty(entry.questId);
      return;
    }
    if (hit.id.startsWith('zone:')) {
      const zone = hit.data as string;
      if (this.collapsedZones.has(zone)) this.collapsedZones.delete(zone);
      else this.collapsedZones.add(zone);
      this.deps.playUi?.('igMainMenuOptionCheckBoxOn');
      this.surface.requestRender();
      return;
    }
    if (hit.id.startsWith('quest:')) {
      const slot = Number(hit.data);
      const entry = this.snapshot?.entries.find((candidate) => candidate.slot === slot);
      if (event?.shiftKey && entry) {
        this.deps.onToggleWatch?.(entry);
        this.deps.playUi?.('igMainMenuOptionCheckBoxOn');
        return;
      }
      this.selectedQuestSlot = slot;
      this.detailScroll = 0;
      this.deps.playUi?.('igQuestListSelect');
      this.surface.requestRender();
      return;
    }
    if (hit.id === 'list-scroll:up') { this.listScroll--; this.surface.requestRender(); return; }
    if (hit.id === 'list-scroll:down') { this.listScroll++; this.surface.requestRender(); return; }
    if (hit.id === 'detail-scroll:up') { this.detailScroll = Math.max(0, this.detailScroll - 36); this.surface.requestRender(); return; }
    if (hit.id === 'detail-scroll:down') { this.detailScroll += 36; this.surface.requestRender(); }
  }
}
