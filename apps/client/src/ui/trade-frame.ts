/** Asset conversion utility. */
import type { ItemInfo } from '../world';
import { drawMoney } from './money';
import { CanvasPanel, drawItemButton, qualityColor, type PanelHit } from './panel-kit';
import { itemTooltipLines } from './tooltip-content';

export type TradeSlotView = { entry: number; count: number; displayInfoId?: number } | undefined;

export type TradeView = {
  playerName: string;
  targetName: string;
  playerMoney: number;
  targetMoney: number;
  /** Slots 0-5 tradable, 6 = will-not-be-traded. */
  playerItems: TradeSlotView[];
  targetItems: TradeSlotView[];
  playerAccepted: boolean;
  targetAccepted: boolean;
};

const PLAYER_X = 26;
const TARGET_X = 195;
const ROW_START = 104;
const ROW_PITCH = 44;
const NO_TRADE_Y = 389;
const HIGHLIGHT_FILE = '/ui/Interface/TradeFrame/UI-TradeFrame-Highlight.png';

export class TradeCanvasPanel extends CanvasPanel {
  private view?: TradeView;
  private readonly moneyInputs: readonly [HTMLInputElement, HTMLInputElement, HTMLInputElement];
  private moneyValid = true;

  constructor(private readonly host: HTMLElement, private readonly deps: {
    playUi: (name: string) => void;
    getItemInfo: (entry: number) => ItemInfo | undefined;
    itemIconUrl: (displayInfoId?: number, entry?: number) => string;
    onSlotClick?: (side: 'player' | 'target', index: number) => void;
    getAvailableMoney?: () => number;
    onMoneyChange?: (copper: number) => void;
    onAccept?: () => void;
    onCancel?: () => void;
  }) {
    super(host, 384, 512, 'wow-native-panel-canvas', { playUi: deps.playUi });
    const moneyFrame = document.createElement('div');
    moneyFrame.className = 'wow-trade-money-inputs';
    const specs = [
      { name: 'gold', maxLength: 8 },
      { name: 'silver', maxLength: 2 },
      { name: 'copper', maxLength: 2 },
    ] as const;
    const inputs = specs.map(({ name, maxLength }) => {
      const input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'numeric';
      input.pattern = '[0-9]*';
      input.maxLength = maxLength;
      input.className = `wow-trade-money-input wow-trade-money-${name}`;
      input.setAttribute('aria-label', `Trade ${name}`);
      input.addEventListener('focus', () => input.select());
      input.addEventListener('input', () => {
        input.value = input.value.replace(/\D/g, '').slice(0, maxLength);
        this.updateOfferedMoney();
      });
      input.addEventListener('keydown', (event) => this.handleMoneyKey(event, name));
      moneyFrame.append(input);
      const icon = document.createElement('span');
      icon.className = `wow-trade-money-icon wow-trade-money-icon-${name}`;
      icon.setAttribute('aria-hidden', 'true');
      moneyFrame.append(icon);
      return input;
    });
    this.moneyInputs = inputs as unknown as readonly [HTMLInputElement, HTMLInputElement, HTMLInputElement];
    this.host.append(moneyFrame);
  }

  show(view: TradeView) {
    this.view = view;
    this.moneyValid = true;
    this.setMoneyInputs(view.playerMoney);
    this.host.classList.remove('is-hidden');
    this.surface.requestRender();
  }

  hide() {
    for (const input of this.moneyInputs) input.blur();
    this.setMoneyInputs(0);
    this.host.classList.add('is-hidden');
  }

  isOpen() {
    return !this.host.classList.contains('is-hidden');
  }

  protected paint() {
    const s = this.surface;
    s.clear();
    s.fourSlice('/ui/Interface/TradeFrame', ['UI-TradeFrame-TopLeft', 'UI-TradeFrame-TopRight', 'UI-TradeFrame-BotLeft', 'UI-TradeFrame-BotRight']);
    const view = this.view;
    s.image('/ui/Interface/CharacterFrame/TemporaryPortrait-Male-Human.png', 7, 6, 60, 60);
    s.image('/ui/Interface/CharacterFrame/TemporaryPortrait-Male-Human.png', 183, 6, 60, 60);
    s.text(view?.playerName ?? 'You', 125, 23, { size: 12, align: 'center', baseline: 'middle', maxWidth: 100 });
    s.text(view?.targetName ?? 'Player', 285, 23, { size: 12, align: 'center', baseline: 'middle', maxWidth: 80 });
    s.closeButton(327, 8, this.buttonState('close'));
    this.hit('close', { x: 327, y: 8, width: 32, height: 32 });

    if (view?.playerAccepted) this.paintColumnHighlight(19, 100);
    if (view?.targetAccepted) this.paintColumnHighlight(189, 100);

    // The player's offer is the overlaid compact MoneyInputFrameTemplate at (26, 73).
    drawMoney(s, 344, 87, view?.targetMoney ?? 0, { align: 'right' });

    for (let index = 0; index < 7; index++) {
      const y = index === 6 ? NO_TRADE_Y : ROW_START + index * ROW_PITCH;
      this.paintTradeSlot('player', index, PLAYER_X, y, view?.playerItems[index]);
      this.paintTradeSlot('target', index, TARGET_X, y, view?.targetItems[index]);
    }
    s.text('Will not be traded', PLAYER_X, 381, { size: 10, color: '#ffffff' });
    s.text('Will not be traded', TARGET_X + 1, 381, { size: 10, color: '#ffffff' });

    const tradeRect = { x: 186, y: 435, width: 85, height: 22 };
    const cancelRect = { x: 274, y: 435, width: 77, height: 22 };
    s.panelButton('Trade', tradeRect, view && this.moneyValid ? this.buttonState('trade') : 'disabled');
    s.panelButton('Cancel', cancelRect, this.buttonState('cancel'));
    this.hit('trade', tradeRect, { disabled: !view || !this.moneyValid });
    this.hit('cancel', cancelRect);
  }

  private paintColumnHighlight(x: number, y: number) {
    const s = this.surface;
    const width = 161;
    const height = 266;
    s.sprite(HIGHLIGHT_FILE, 0, 0, 161, 16, x, y, width, 16);
    s.sprite(HIGHLIGHT_FILE, 0, 16, 161, 224, x, y + 16, width, height - 32);
    s.sprite(HIGHLIGHT_FILE, 0, 240, 161, 16, x, y + height - 16, width, 16);
  }

  private paintTradeSlot(side: 'player' | 'target', index: number, x: number, y: number, slot: TradeSlotView) {
    const s = this.surface;
    const id = `${side}:${index}`;
    if (index === 6) s.image('/ui/Interface/TradeFrame/UI-TradeFrame-EnchantIcon.png', x - 13, y - 13, 62, 62);
    s.image('/ui/Interface/Buttons/UI-EmptySlot.png', x - 13, y - 13, 64, 64);
    s.image('/ui/Interface/QuestFrame/UI-QuestItemNameFrame.png', x + 31, y - 13, 124, 64);
    const iconUrl = slot ? this.deps.itemIconUrl(slot.displayInfoId, slot.entry) || undefined : undefined;
    drawItemButton(s, x, y, 37, {
      iconUrl,
      count: slot && slot.count > 1 ? slot.count : undefined,
      hover: this.state(id) === 'hover',
      pushed: this.state(id) === 'down',
    });
    if (slot) {
      const info = this.deps.getItemInfo(slot.entry);
      const name = info?.name ?? `Item #${slot.entry}`;
      const lines = s.wrapText(name, 88, { size: 10 });
      const textY = lines.length > 1 ? y + 12 : y + 22;
      lines.slice(0, 2).forEach((line, lineIndex) => {
        s.text(line, x + 46, textY + lineIndex * 11, { size: 10, color: qualityColor(info?.quality), maxWidth: 90 });
      });
    }
    this.hit(id, { x: x - 2, y: y - 2, width: 155, height: 41 }, {
      data: index,
      tooltip: slot ? () => itemTooltipLines(this.deps.getItemInfo(slot.entry), slot.entry, { count: slot.count }) : undefined,
    });
  }

  private buttonState(id: string): 'normal' | 'hover' | 'down' {
    const state = this.state(id);
    return state === 'disabled' ? 'normal' : state;
  }

  private setMoneyInputs(copper: number) {
    const amount = Math.max(0, Math.min(0xffffffff, Math.floor(Number.isFinite(copper) ? copper : 0)));
    const gold = Math.floor(amount / 10_000);
    const silver = Math.floor((amount % 10_000) / 100);
    const remainder = amount % 100;
    this.moneyInputs[0].value = String(gold);
    this.moneyInputs[1].value = String(silver);
    this.moneyInputs[2].value = String(remainder);
  }

  private updateOfferedMoney() {
    const [gold, silver, copper] = this.moneyInputs.map((input) => Number(input.value) || 0);
    const desired = Math.min(0xffffffff, gold * 10_000 + silver * 100 + copper);
    const available = Math.max(0, Math.floor(this.deps.getAvailableMoney?.() ?? 0xffffffff));
    if (desired > available) {
      // TradeFrame_UpdateMoney restores GetPlayerTradeMoney(), not the wallet maximum, when the
      // typed value exceeds GetMoney(). Preserve the existing offer and disable acceptance.
      const current = this.view?.playerMoney ?? 0;
      this.moneyValid = false;
      this.setMoneyInputs(current);
      this.deps.onMoneyChange?.(current);
    } else {
      this.moneyValid = true;
      if (this.view) this.view.playerMoney = desired;
      this.deps.onMoneyChange?.(desired);
    }
    this.surface.requestRender();
  }

  private handleMoneyKey(event: KeyboardEvent, denomination: 'gold' | 'silver' | 'copper') {
    if (event.key === 'Escape') {
      event.preventDefault();
      (event.currentTarget as HTMLInputElement).blur();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (denomination === 'gold') this.moneyInputs[1].focus();
    else if (denomination === 'silver') this.moneyInputs[2].focus();
    else this.moneyInputs[2].blur();
  }

  protected activate(hit: PanelHit) {
    if (hit.id === 'close' || hit.id === 'cancel') {
      this.playUi('igMainMenuClose');
      this.deps.onCancel?.();
      this.hide();
      return;
    }
    if (hit.id === 'trade') {
      this.playUi('igMainMenuOption');
      this.deps.onAccept?.();
      return;
    }
    const [side, indexText] = hit.id.split(':');
    if (side === 'player' || side === 'target') this.deps.onSlotClick?.(side, Number(indexText));
  }
}
