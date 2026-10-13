/** Asset conversion utility. */
import type { InteractionEvent, ItemInfo } from '../world';
import { drawMoney } from './money';
import { CanvasPanel, drawQuestItemBanner, drawScrollBar, UI_INK, type PanelHit } from './panel-kit';
import { itemTooltipLines } from './tooltip-content';

export type QuestPanelEvent = Extract<InteractionEvent, { kind: 'questDetails' | 'questRequestItems' | 'questOfferReward' }>;

const SCROLL_AREA = { x: 23, y: 81, width: 300, height: 334 };
type QuestRewardItem = { itemId: number; count: number; displayInfoId?: number };

export class QuestCanvasPanel extends CanvasPanel {
  private current?: QuestPanelEvent;
  private scroll = 0;
  private contentHeight = 0;
  private selectedReward = -1;
  private portraitGuid?: string;
  private portraitSource?: CanvasImageSource;

  constructor(private readonly host: HTMLElement, private readonly deps: {
    playUi: (name: string) => void;
    questAccept: (guid: string, questId: number) => void;
    questRequestReward: (guid: string, questId: number) => void;
    questChooseReward: (guid: string, questId: number, rewardIndex: number) => void;
    questCancel: (sharedByGuid?: string) => void;
    getItemInfo: (entry: number) => ItemInfo | undefined;
    itemIconUrl: (displayInfoId?: number, entry?: number) => string;
    getItemName: (entry: number) => string | undefined;
    questText: (text: string) => string;
    getUnitName: (guid: string) => string | undefined;
    getUnitPortraitSource?: (guid: string) => CanvasImageSource | undefined;
  }) {
    super(host, 384, 512, 'wow-native-panel-canvas', { playUi: deps.playUi });
    this.onWheel = (direction) => {
      const max = Math.max(0, this.contentHeight - SCROLL_AREA.height);
      this.scroll = Math.max(0, Math.min(max, this.scroll + direction * 36));
      this.surface.requestRender();
    };
  }

  show(event: QuestPanelEvent) {
    if (event.state.guid !== this.portraitGuid) {
      this.portraitGuid = event.state.guid;
      this.portraitSource = undefined;
    }
    this.current = event;
    this.scroll = 0;
    this.selectedReward = -1;
    this.host.classList.remove('is-hidden');
    this.updatePortrait();
    this.surface.requestRender();
  }

  updatePortrait() {
    const guid = this.current?.state.guid;
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

  protected paint() {
    const s = this.surface;
    s.clear();
    // QuestFramePanelTemplate uses the parchment QuestGreeting quadrants for
    // details, progress and rewards. UI-Quest-* is the dark overlay kit and
    // makes the native black QuestFont unreadable when used as the base.
    s.fourSlice('/ui/Interface/QuestFrame', ['UI-QuestGreeting-TopLeft', 'UI-QuestGreeting-TopRight', 'UI-QuestGreeting-BotLeft', 'UI-QuestGreeting-BotRight']);
    if (this.portraitSource) s.source(this.portraitSource, 7, 6, 60, 60, { circular: true });
    else s.image('/ui/Interface/CharacterFrame/TemporaryPortrait-Monster.png', 7, 6, 60, 60);
    const event = this.current;
    if (!event) return;
    const npcName = this.deps.getUnitName(event.state.guid) ?? event.state.title;
    s.text(npcName, 192, 30, { size: 13, color: '#ffffff', align: 'center', baseline: 'middle', maxWidth: 290 });
    s.closeButton(326, 14, this.state('close') !== 'disabled' ? this.state('close') as 'normal' | 'hover' | 'down' : 'normal');
    this.hit('close', { x: 326, y: 14, width: 32, height: 32 });

    if (event.kind === 'questDetails') {
      this.paintButtons('Accept', { x: 23, y: 418, width: 77, height: 22 }, 'accept', 'Decline', { x: 267, y: 418, width: 78, height: 22 }, 'decline', false);
    } else if (event.kind === 'questRequestItems') {
      this.paintButtons('Continue', { x: 22, y: 418, width: 120, height: 22 }, 'complete', 'Cancel', { x: 269, y: 418, width: 75, height: 22 }, 'decline', !event.state.complete);
    } else {
      const needsChoice = event.state.choiceRewards.length > 1 && this.selectedReward < 0;
      this.paintButtons('Complete Quest', { x: 22, y: 418, width: 120, height: 22 }, 'reward', 'Cancel', { x: 270, y: 418, width: 75, height: 22 }, 'decline', needsChoice);
    }
    this.paintScrollContent(event);
    const maxScroll = Math.max(0, this.contentHeight - SCROLL_AREA.height);
    if (maxScroll > 0) drawScrollBar(this, 'scroll', 331, SCROLL_AREA.y, SCROLL_AREA.height, this.scroll, maxScroll);
  }

  private paintButtons(
    primaryLabel: string, primaryRect: PanelHit['rect'], primaryId: string,
    secondaryLabel: string, secondaryRect: PanelHit['rect'], secondaryId: string,
    primaryDisabled: boolean,
  ) {
    const s = this.surface;
    s.panelButton(primaryLabel, primaryRect, primaryDisabled ? 'disabled' : this.buttonState(primaryId));
    s.panelButton(secondaryLabel, secondaryRect, this.buttonState(secondaryId));
    this.hit(primaryId, primaryRect, { disabled: primaryDisabled });
    this.hit(secondaryId, secondaryRect);
  }

  private buttonState(id: string): 'normal' | 'hover' | 'down' {
    const state = this.state(id);
    return state === 'disabled' ? 'normal' : state;
  }

  private paintScrollContent(event: QuestPanelEvent) {
    const s = this.surface;
    const ctx = s.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(SCROLL_AREA.x, SCROLL_AREA.y, SCROLL_AREA.width, SCROLL_AREA.height + 6);
    ctx.clip();
    let y = SCROLL_AREA.y + 10 - this.scroll;
    const left = SCROLL_AREA.x + 5;

    const title = (text: string) => {
      for (const line of s.wrapText(text, 285, { size: 17, family: 'morpheus' })) {
        s.text(line, left, y + 14, { size: 17, family: 'morpheus', color: UI_INK, shadow: false });
        y += 20;
      }
      y += 5;
    };
    const body = (text: string) => {
      for (const line of s.wrapText(this.deps.questText(text), 270, { size: 13 })) {
        s.text(line, left, y + 11, { size: 13, color: UI_INK, shadow: false });
        y += 16;
      }
      y += 5;
    };
    const banners = (items: QuestRewardItem[], idPrefix: string, selectable: boolean) => {
      items.forEach((item, index) => {
        const column = index % 2;
        const row = Math.floor(index / 2);
        const x = left - 3 + column * 149;
        const rowY = y + row * 44;
        if (rowY + 41 > SCROLL_AREA.y - 4 && rowY < SCROLL_AREA.y + SCROLL_AREA.height) {
          const info = this.deps.getItemInfo(item.itemId);
          const id = `${idPrefix}:${index}`;
          if (selectable && this.selectedReward === index) {
            s.addImage('/ui/Interface/QuestFrame/UI-QuestItemHighlight.png', x - 5, rowY - 8, 256, 64, 0.9);
          }
          drawQuestItemBanner(s, x, rowY, {
            iconUrl: this.deps.itemIconUrl(item.displayInfoId, item.itemId) || undefined,
            name: info?.name ?? this.deps.getItemName(item.itemId) ?? `Item #${item.itemId}`,
            count: item.count,
            quality: info?.quality,
            hover: this.state(id) === 'hover',
            fallback: (this.deps.getItemName(item.itemId) ?? '??').slice(0, 2).toUpperCase(),
          });
          this.hit(id, { x, y: rowY, width: 147, height: 41 }, {
            disabled: !selectable,
            tooltip: () => itemTooltipLines(info, item.itemId, { count: item.count }),
          });
        }
      });
      y += Math.ceil(items.length / 2) * 44 + 4;
    };
    const moneyLine = (label: string, amount: number) => {
      s.text(label, left, y + 11, { size: 13, color: UI_INK, shadow: false });
      drawMoney(s, left + s.measureText(label, { size: 13 }) + 10, y + 6, amount, { align: 'left' });
      y += 22;
    };

    if (event.kind === 'questDetails') {
      const state = event.state;
      title(state.title);
      body(state.details);
      if (state.objectives) {
        title('Quest Objectives');
        body(state.objectives);
      }
      if (state.choiceRewards.length || state.rewards.length || state.money) {
        title('Rewards');
        if (state.choiceRewards.length) {
          body('You will be able to choose one of these rewards:');
          banners(state.choiceRewards, 'choice-preview', false);
        }
        if (state.rewards.length) {
          body('You will also receive:');
          banners(state.rewards, 'reward-preview', false);
        }
        if (state.money) moneyLine('You will also receive:', state.money);
      }
    } else if (event.kind === 'questRequestItems') {
      const state = event.state;
      title(state.title);
      body(state.text);
      if (state.requiredItems.length || state.requiredMoney) {
        title('Required Items:');
        if (state.requiredMoney) moneyLine('Required Money:', state.requiredMoney);
        banners(state.requiredItems, 'required', false);
      }
    } else {
      const state = event.state;
      title(state.title);
      body(state.text);
      title('Rewards');
      if (state.choiceRewards.length > 1) {
        body('Choose your reward:');
        banners(state.choiceRewards, 'choice', true);
      } else if (state.choiceRewards.length === 1) {
        body('You will receive:');
        banners(state.choiceRewards, 'choice', false);
      }
      if (state.rewards.length) {
        body('You will also receive:');
        banners(state.rewards, 'reward-static', false);
      }
      if (state.money) moneyLine('You will also receive:', state.money);
    }
    this.contentHeight = y + this.scroll - SCROLL_AREA.y + 10;
    ctx.restore();
  }

  protected activate(hit: PanelHit) {
    const event = this.current;
    if (!event) return;
    const { guid, questId } = event.state;
    if (hit.id === 'close' || hit.id === 'decline') {
      this.playUi('igQuestCancel');
      this.deps.questCancel(event.kind === 'questDetails' && event.state.shared ? guid : undefined);
      this.hide();
      return;
    }
    if (hit.id === 'accept') {
      this.playUi('igQuestAccept');
      this.deps.questAccept(guid, questId);
      this.hide();
      return;
    }
    if (hit.id === 'complete') {
      this.playUi('igQuestComplete');
      this.deps.questRequestReward(guid, questId);
      return;
    }
    if (hit.id === 'reward' && event.kind === 'questOfferReward') {
      this.playUi('igQuestComplete');
      const rewardIndex = event.state.choiceRewards.length > 1 ? this.selectedReward : 0;
      this.deps.questChooseReward(guid, questId, Math.max(0, rewardIndex));
      this.hide();
      return;
    }
    if (hit.id.startsWith('choice:')) {
      this.playUi('igMainMenuOptionCheckBoxOn');
      this.selectedReward = Number(hit.id.slice(7));
      this.surface.requestRender();
      return;
    }
    if (hit.id === 'scroll:up') { this.scroll = Math.max(0, this.scroll - 36); this.surface.requestRender(); return; }
    if (hit.id === 'scroll:down') {
      this.scroll = Math.min(Math.max(0, this.contentHeight - SCROLL_AREA.height), this.scroll + 36);
      this.surface.requestRender();
    }
  }
}
