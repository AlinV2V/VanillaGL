/** Asset conversion utility. */
import type { GossipState, QuestListState } from '../world';
import { CanvasPanel, drawScrollBar, UI_INK, type PanelHit } from './panel-kit';

export type GossipPanelState =
  | { kind: 'gossip'; state: GossipState }
  | { kind: 'questList'; state: QuestListState };

/** vMaNGOS GossipOptionIcon -> Interface\GossipFrame\*GossipIcon art. */
const GOSSIP_ICON_FILES: Record<number, string> = {
  0: 'GossipGossipIcon', 1: 'VendorGossipIcon', 2: 'TaxiGossipIcon', 3: 'TrainerGossipIcon',
  4: 'HealerGossipIcon', 5: 'BinderGossipIcon', 6: 'BankerGossipIcon', 7: 'PetitionGossipIcon',
  8: 'TabardGossipIcon', 9: 'BattleMasterGossipIcon', 10: 'GossipGossipIcon',
};

const SCROLL_AREA = { x: 23, y: 81, width: 300, height: 334 };
const ROW_HEIGHT = 16;

export class GossipCanvasPanel extends CanvasPanel {
  private current?: GossipPanelState;
  private scroll = 0;
  private contentHeight = 0;
  private portraitGuid?: string;
  private portraitSource?: CanvasImageSource;

  constructor(private readonly host: HTMLElement, private readonly deps: {
    playUi: (name: string) => void;
    gossipSelect: (guid: string, index: number) => void;
    questQuery: (guid: string, questId: number) => void;
    questRequestReward: (guid: string, questId: number) => void;
    questText: (text: string) => string;
    getUnitName: (guid: string) => string | undefined;
    getUnitPortraitSource?: (guid: string) => CanvasImageSource | undefined;
    onClose: () => void;
  }) {
    super(host, 384, 512, 'wow-native-panel-canvas', { playUi: deps.playUi });
    this.onWheel = (direction) => {
      const max = Math.max(0, this.contentHeight - SCROLL_AREA.height);
      this.scroll = Math.max(0, Math.min(max, this.scroll + direction * 36));
      this.surface.requestRender();
    };
  }

  show(state: GossipPanelState) {
    if (state.state.guid !== this.portraitGuid) {
      this.portraitGuid = state.state.guid;
      this.portraitSource = undefined;
    }
    this.current = state;
    this.scroll = 0;
    this.host.classList.remove('is-hidden');
    this.updatePortrait();
    this.surface.requestRender();
  }

  update(state: GossipPanelState) {
    if (state.state.guid !== this.portraitGuid) {
      this.portraitGuid = state.state.guid;
      this.portraitSource = undefined;
    }
    this.current = state;
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
    s.fourSlice('/ui/Interface/QuestFrame', [
      'UI-QuestGreeting-TopLeft', 'UI-QuestGreeting-TopRight',
      'UI-QuestGreeting-BotLeft', 'UI-QuestGreeting-BotRight',
    ]);
    s.image('/ui/Interface/QuestFrame/UI-Quest-BotLeftPatch.png', 22, 380, 128, 64);
    if (this.portraitSource) s.source(this.portraitSource, 7, 6, 60, 60, { circular: true });
    else s.image('/ui/Interface/CharacterFrame/TemporaryPortrait-Monster.png', 7, 6, 60, 60);
    const guid = this.current?.state.guid;
    const name = (guid && this.deps.getUnitName(guid)) || 'Gossip';
    s.text(name, 192, 30, { size: 12, color: '#ffffff', align: 'center', baseline: 'middle', maxWidth: 290 });
    const closeState = this.state('close');
    s.closeButton(326, 14, closeState === 'disabled' ? 'normal' : closeState);
    this.hit('close', { x: 326, y: 14, width: 32, height: 32 });

    const goodbyeRect = { x: 268, y: 417, width: 77, height: 22 };
    const goodbyeState = this.state('goodbye');
    s.panelButton('Goodbye', goodbyeRect, goodbyeState === 'disabled' ? 'normal' : goodbyeState);
    this.hit('goodbye', goodbyeRect);

    if (this.current) {
      this.paintScrollContent();
      const maxScroll = Math.max(0, this.contentHeight - SCROLL_AREA.height);
      if (maxScroll > 0) drawScrollBar(this, 'scroll', 331, SCROLL_AREA.y, SCROLL_AREA.height, this.scroll, maxScroll);
    }
  }

  private paintScrollContent() {
    const s = this.surface;
    const ctx = s.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(SCROLL_AREA.x, SCROLL_AREA.y, SCROLL_AREA.width, SCROLL_AREA.height);
    ctx.clip();

    let y = SCROLL_AREA.y + 10 - this.scroll;
    const rowX = SCROLL_AREA.x;
    const registerRow = (id: string, rowY: number, extra: Omit<PanelHit, 'id' | 'rect'> = {}) => {
      if (rowY + ROW_HEIGHT < SCROLL_AREA.y || rowY > SCROLL_AREA.y + SCROLL_AREA.height) return;
      this.hit(id, { x: rowX, y: rowY - 1, width: 300, height: ROW_HEIGHT }, extra);
    };
    const drawRow = (
      id: string,
      iconPath: string,
      label: string,
      rowY: number,
      extra: Omit<PanelHit, 'id' | 'rect'> = {},
    ) => {
      if (this.state(id) === 'hover' || this.state(id) === 'down') {
        s.addImage('/ui/Interface/QuestFrame/UI-QuestTitleHighlight.png', rowX, rowY - 1, 300, ROW_HEIGHT, 0.8);
      }
      s.image(iconPath, rowX, rowY, 16, 16);
      s.text(label, rowX + 20, rowY + 12, { size: 13, color: UI_INK, shadow: false, maxWidth: 272 });
      registerRow(id, rowY, extra);
    };

    if (this.current?.kind === 'questList') {
      const state = this.current.state;
      if (state.greeting) {
        const lines = s.wrapText(state.greeting, 270, { size: 13 });
        for (const line of lines) {
          s.text(line, SCROLL_AREA.x + 10, y + 11, { size: 13, color: UI_INK, shadow: false });
          y += 17;
        }
        y += 10;
      }
      // vMaNGOS QuestGiverStatus: 2/3/4/7 are active, 5 is available.
      // Status 0 is retained as available for older mock/custom realms.
      const available = state.quests.filter((quest) => quest.icon === 0 || quest.icon === 1 || quest.icon === 5);
      const active = state.quests.filter((quest) => !available.includes(quest));
      const section = (title: string, quests: typeof state.quests, iconFile: string, action: 'query' | 'reward') => {
        if (!quests.length) return;
        s.text(title, SCROLL_AREA.x, y + 15, { size: 18, family: 'morpheus', color: '#000000' });
        y += 26;
        for (const quest of quests) {
          drawRow(`quest:${quest.questId}`, `/ui/Interface/GossipFrame/${iconFile}.png`, quest.title, y, { data: action });
          y += ROW_HEIGHT;
        }
        y += 4;
      };
      section('Current Quests', active, 'ActiveQuestIcon', 'reward');
      if (active.length && available.length) {
        s.image('/ui/Interface/QuestFrame/UI-HorizontalBreak.png', SCROLL_AREA.x - 1, y, 256, 32);
        y += 26;
      }
      section('Available Quests', available, 'AvailableQuestIcon', 'query');
    } else if (this.current?.kind === 'gossip') {
      const state = this.current.state;
      if (state.text) {
        for (const line of s.wrapText(this.deps.questText(state.text), 270, { size: 13, family: 'friz' })) {
          s.text(line, SCROLL_AREA.x + 10, y + 12, { size: 13, family: 'friz', color: '#000000', shadow: false });
          y += 18;
        }
        y += 8;
      }
      for (const quest of state.quests) {
        const available = quest.icon === 0 || quest.icon === 1 || quest.icon === 5;
        const icon = available ? 'AvailableQuestIcon' : 'ActiveQuestIcon';
        drawRow(`quest:${quest.questId}`, `/ui/Interface/GossipFrame/${icon}.png`, quest.title, y, { data: available ? 'query' : 'reward' });
        y += ROW_HEIGHT;
      }
      if (state.quests.length && state.options.length) y += 8;
      for (const option of state.options) {
        const icon = GOSSIP_ICON_FILES[option.icon] ?? 'GossipGossipIcon';
        drawRow(`option:${option.index}`, `/ui/Interface/GossipFrame/${icon}.png`, option.text, y);
        y += ROW_HEIGHT;
      }
      if (!state.text && !state.quests.length && !state.options.length) {
        s.text('Greetings, traveler.', SCROLL_AREA.x + 10, y + 11, { size: 13, color: UI_INK, shadow: false });
      }
    }
    this.contentHeight = y + this.scroll - SCROLL_AREA.y + 10;
    ctx.restore();
  }

  protected activate(hit: PanelHit) {
    const guid = this.current?.state.guid;
    if (hit.id === 'close' || hit.id === 'goodbye') {
      this.playUi('igQuestCancel');
      this.hide();
      this.deps.onClose();
      return;
    }
    if (!guid) return;
    if (hit.id === 'scroll:up') { this.scroll = Math.max(0, this.scroll - 36); this.surface.requestRender(); return; }
    if (hit.id === 'scroll:down') {
      this.scroll = Math.min(Math.max(0, this.contentHeight - SCROLL_AREA.height), this.scroll + 36);
      this.surface.requestRender();
      return;
    }
    if (hit.id.startsWith('quest:')) {
      this.playUi('igQuestListSelect');
      if (hit.data === 'reward') this.deps.questRequestReward(guid, Number(hit.id.slice(6)));
      else this.deps.questQuery(guid, Number(hit.id.slice(6)));
    } else if (hit.id.startsWith('option:')) {
      this.playUi('igMainMenuOption');
      this.deps.gossipSelect(guid, Number(hit.id.slice(7)));
    }
  }
}
