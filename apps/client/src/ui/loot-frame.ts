/** Asset conversion utility. */
import type { ItemInfo, LootState } from '../world';
import { formatMoneyText } from './money';
import { CanvasPanel, drawItemButton, qualityColor, type PanelHit } from './panel-kit';
import { itemTooltipLines } from './tooltip-content';

const SLOT_X = 24;
const SLOT_Y = 80;
const SLOT_PITCH = 41;

type LootRow =
  | { kind: 'money'; amount: number }
  | { kind: 'item'; slot: number; entry: number; count: number; displayInfoId: number; slotType: number };

export class LootCanvasPanel extends CanvasPanel {
  private current?: LootState;
  private page = 0;

  constructor(private readonly host: HTMLElement, private readonly deps: {
    playUi: (name: string) => void;
    lootItem: (slot: number) => void;
    lootMoney: () => void;
    releaseLoot: (guid: string) => void;
    getItemInfo: (entry: number) => ItemInfo | undefined;
    itemIconUrl: (displayInfoId?: number, entry?: number) => string;
    getItemName: (entry: number) => string | undefined;
    masterLootItem?: (lootGuid: string, slot: number, entry: number) => void;
  }) {
    super(host, 256, 256, 'wow-native-panel-canvas', { playUi: deps.playUi });
  }

  show(state: LootState) {
    const wasOpen = this.isOpen();
    this.current = state;
    if (!wasOpen) {
      this.page = 0;
      if (state.error === undefined) {
        const empty = state.money <= 0 && state.items.length === 0;
        this.deps.playUi(empty ? 'LOOTFRAMEOPENEMPTY' : 'LOOTFRAMEOPEN');
      }
    }
    this.host.classList.remove('is-hidden');
    this.surface.requestRender();
  }

  hide(release = false) {
    const wasOpen = this.isOpen();
    if (release && this.current) this.deps.releaseLoot(this.current.guid);
    this.current = undefined;
    this.host.classList.add('is-hidden');
    if (wasOpen) this.deps.playUi('LOOTFRAMECLOSE');
  }

  isOpen() {
    return !this.host.classList.contains('is-hidden');
  }

  private rows(): LootRow[] {
    const state = this.current;
    if (!state) return [];
    const rows: LootRow[] = [];
    if (state.money > 0) rows.push({ kind: 'money', amount: state.money });
    for (const item of state.items) {
      rows.push({ kind: 'item', slot: item.slot, entry: item.entry, count: item.count, displayInfoId: item.displayInfoId, slotType: item.slotType });
    }
    return rows;
  }

  private coinIcon(amount: number) {
    if (amount >= 10000) return '/ui/Interface/Icons/INV_Misc_Coin_01.png';
    if (amount >= 100) return '/ui/Interface/Icons/INV_Misc_Coin_03.png';
    return '/ui/Interface/Icons/INV_Misc_Coin_05.png';
  }

  protected paint() {
    const s = this.surface;
    s.clear();
    s.image('/ui/Interface/LootFrame/UI-LootPanel.png', 0, 0, 256, 256);
    s.image('/ui/Interface/TargetingFrame/TargetDead.png', 10, 8, 58, 58);
    s.text('Items', 116, 26, { size: 12, align: 'center', baseline: 'middle' });
    s.closeButton(159, 10, this.buttonState('close'));
    this.hit('close', { x: 159, y: 10, width: 32, height: 32 });

    const state = this.current;
    if (!state) return;
    if (state.error !== undefined) {
      s.text('You are too far away!', 96, 130, { size: 12, align: 'center', color: '#e60b0b' });
      return;
    }
    const rows = this.rows();
    const paginated = rows.length > 4;
    const capacity = paginated ? 3 : 4;
    const totalPages = Math.max(1, Math.ceil(rows.length / capacity));
    this.page = Math.max(0, Math.min(totalPages - 1, this.page));
    if (!rows.length) {
      s.text('The corpse is empty.', 96, 130, { size: 12, align: 'center', color: '#c8b878' });
    }

    rows.slice(this.page * capacity, this.page * capacity + capacity).forEach((row, index) => {
      const y = SLOT_Y + index * SLOT_PITCH;
      const id = row.kind === 'money' ? 'money' : `slot:${row.slot}`;
      s.image('/ui/Interface/QuestFrame/UI-QuestItemNameFrame.png', SLOT_X + 30, y - 12, 130, 62);
      const iconUrl = row.kind === 'money' ? this.coinIcon(row.amount) : this.deps.itemIconUrl(row.displayInfoId, row.entry) || undefined;
      drawItemButton(s, SLOT_X, y, 37, {
        iconUrl,
        count: row.kind === 'item' && row.count > 1 ? row.count : undefined,
        hover: this.state(id) === 'hover',
        pushed: this.state(id) === 'down',
      });
      if (row.kind === 'money') {
        const lines = s.wrapText(formatMoneyText(row.amount), 93, { size: 12 });
        const textY = lines.length > 1 ? y + 12 : y + 23;
        lines.slice(0, 2).forEach((line, lineIndex) => {
          s.text(line, SLOT_X + 45, textY + lineIndex * 13, { size: 12, color: '#ffffff', maxWidth: 95 });
        });
        this.hit(id, { x: SLOT_X - 2, y: y - 2, width: 160, height: 41 });
      } else {
        const info = this.deps.getItemInfo(row.entry);
        const name = info?.name ?? this.deps.getItemName(row.entry) ?? `Item #${row.entry}`;
        const lines = s.wrapText(name, 93, { size: 12 });
        const textY = lines.length > 1 ? y + 12 : y + 23;
        lines.slice(0, 2).forEach((line, lineIndex) => {
          s.text(line, SLOT_X + 45, textY + lineIndex * 13, { size: 12, color: qualityColor(info?.quality), maxWidth: 95 });
        });
        this.hit(id, { x: SLOT_X - 2, y: y - 2, width: 160, height: 41 }, {
          data: row.slot,
          tooltip: () => itemTooltipLines(info, row.entry, { count: row.count }),
        });
      }
    });

    if (paginated) {
      const upDisabled = this.page === 0;
      const downDisabled = this.page >= totalPages - 1;
      const upSuffix = upDisabled ? 'Disabled' : this.state('page-up') === 'down' ? 'Down' : 'Up';
      const downSuffix = downDisabled ? 'Disabled' : this.state('page-down') === 'down' ? 'Down' : 'Up';
      s.image(`/ui/Interface/ChatFrame/UI-ChatIcon-ScrollUp-${upSuffix}.png`, 25, 208, 32, 32);
      s.image(`/ui/Interface/ChatFrame/UI-ChatIcon-ScrollDown-${downSuffix}.png`, 143, 208, 32, 32);
      if (this.state('page-up') === 'hover' && !upDisabled) s.addImage('/ui/Interface/Buttons/UI-Common-MouseHilight.png', 25, 208, 32, 32);
      if (this.state('page-down') === 'hover' && !downDisabled) s.addImage('/ui/Interface/Buttons/UI-Common-MouseHilight.png', 143, 208, 32, 32);
      s.text('Prev', 60, 224, { size: 12, baseline: 'middle' });
      s.text('Next', 178, 224, { size: 12, baseline: 'middle' });
      this.hit('page-up', { x: 25, y: 208, width: 32, height: 32 }, { disabled: upDisabled });
      this.hit('page-down', { x: 143, y: 208, width: 32, height: 32 }, { disabled: downDisabled });
    }
  }

  private buttonState(id: string): 'normal' | 'hover' | 'down' {
    const state = this.state(id);
    return state === 'disabled' ? 'normal' : state;
  }

  protected activate(hit: PanelHit) {
    if (hit.id === 'close') {
      this.hide(true);
      return;
    }
    if (hit.id === 'money') {
      this.playUi('LOOTFRAMECOINSOUND');
      this.deps.lootMoney();
      return;
    }
    if (hit.id === 'page-up') { this.page--; this.surface.requestRender(); return; }
    if (hit.id === 'page-down') { this.page++; this.surface.requestRender(); return; }
    if (hit.id.startsWith('slot:')) {
      this.playUi('LOOTFRAMEITEMSOUND');
      const slot = Number(hit.data);
      const item = this.current?.items.find((candidate) => candidate.slot === slot);
      if (item?.slotType === 2 && this.current) this.deps.masterLootItem?.(this.current.guid, slot, item.entry);
      else this.deps.lootItem(slot);
    }
  }
}
