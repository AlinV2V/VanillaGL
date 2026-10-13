/** Asset conversion utility. */
import type { ItemInfo } from '../world';
import { drawMoney } from './money';
import { CanvasPanel, drawItemButton, type PanelHit } from './panel-kit';
import { itemTooltipLines } from './tooltip-content';

export type BankSlotView = { entry: number; count: number; displayInfoId?: number } | undefined;

export type BankView = {
  bankerGuid?: string;
  bankerName: string;
  slots: BankSlotView[];
  bags: BankSlotView[];
  purchasedBagSlots: number;
  nextSlotCost: number;
  playerMoney: number;
};

const SLOT_COLS = 6;
const SLOT_PITCH_X = 49;
const SLOT_PITCH_Y = 44;
const SLOTS_ORIGIN = { x: 40, y: 73 };
const BAGS_ORIGIN = { x: 40, y: 274 };

export class BankCanvasPanel extends CanvasPanel {
  private view?: BankView;
  private portraitGuid?: string;
  private portraitSource?: CanvasImageSource;

  constructor(private readonly host: HTMLElement, private readonly deps: {
    playUi: (name: string) => void;
    getItemInfo: (entry: number) => ItemInfo | undefined;
    itemIconUrl: (displayInfoId?: number, entry?: number) => string;
    getUnitPortraitSource?: (guid: string) => CanvasImageSource | undefined;
    onSlotClick?: (kind: 'slot' | 'bag', index: number) => void;
    onPurchaseSlot?: () => void;
    onClose?: () => void;
  }) {
    super(host, 384, 512, 'wow-native-panel-canvas', { playUi: deps.playUi });
  }

  show(view: BankView) {
    if (view.bankerGuid !== this.portraitGuid) {
      this.portraitGuid = view.bankerGuid;
      this.portraitSource = undefined;
    }
    this.view = view;
    this.host.classList.remove('is-hidden');
    this.playUi('igMainMenuOpen');
    this.updatePortrait();
    this.surface.requestRender();
  }

  updatePortrait() {
    const guid = this.view?.bankerGuid;
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
    s.fourSlice('/ui/Interface/BankFrame', ['UI-BankFrame-TopLeft', 'UI-BankFrame-TopRight', 'UI-BankFrame-BotLeft', 'UI-BankFrame-BotRight']);
    if (this.portraitSource) s.source(this.portraitSource, 12, 8, 58, 58, { circular: true });
    else s.image('/ui/Interface/CharacterFrame/TemporaryPortrait-Monster.png', 12, 8, 58, 58);
    const view = this.view;
    s.text(view ? `The Bank of ${view.bankerName}` : 'Bank', 198, 26, { size: 13, color: '#ffffff', align: 'center', baseline: 'middle', maxWidth: 250 });
    s.closeButton(324, 10, this.buttonState('close'));
    this.hit('close', { x: 324, y: 10, width: 32, height: 32 });
    s.text('Bank', 181, 64, { size: 12, align: 'center' });
    s.text('Bag Slots', 181, 264, { size: 12, align: 'center' });

    for (let index = 0; index < 24; index++) {
      const x = SLOTS_ORIGIN.x + (index % SLOT_COLS) * SLOT_PITCH_X;
      const y = SLOTS_ORIGIN.y + Math.floor(index / SLOT_COLS) * SLOT_PITCH_Y;
      this.paintSlot(`slot:${index}`, x, y, view?.slots[index]);
    }
    for (let index = 0; index < 6; index++) {
      const x = BAGS_ORIGIN.x + index * SLOT_PITCH_X;
      const locked = !!view && index >= view.purchasedBagSlots;
      this.paintSlot(`bag:${index}`, x, BAGS_ORIGIN.y, view?.bags[index], locked);
    }

    // Purchase info box (BankFramePurchaseInfo, centered at (-15,-105)).
    s.text('You can buy an additional bank bag slot.', 47, 346, { size: 12, color: '#ffffff' });
    const cost = view?.nextSlotCost ?? 0;
    const canBuy = !!view && view.purchasedBagSlots < 6;
    s.text('Costs:', 57, 374, { size: 12 });
    if (canBuy) {
      const affordable = (view?.playerMoney ?? 0) >= cost;
      drawMoney(s, 57 + s.measureText('Costs:', { size: 12 }) + 10, 370, cost, { align: 'left', color: affordable ? '#ffffff' : '#ff2020' });
    }
    const purchaseRect = { x: 183, y: 360, width: 124, height: 21 };
    s.panelButton('Purchase', purchaseRect, canBuy ? this.buttonState('purchase') : 'disabled');
    this.hit('purchase', purchaseRect, { disabled: !canBuy });

    drawMoney(s, 346, 407, view?.playerMoney ?? 0, { align: 'right' });
  }

  private paintSlot(id: string, x: number, y: number, slot: BankSlotView, locked = false) {
    const s = this.surface;
    const isBag = id.startsWith('bag:');
    const iconUrl = slot ? this.deps.itemIconUrl(slot.displayInfoId, slot.entry) || undefined : undefined;
    drawItemButton(s, x, y, 37, {
      iconUrl,
      emptyUrl: !slot && isBag ? '/ui/Interface/PaperDoll/UI-PaperDoll-Slot-Bag.png' : undefined,
      count: slot && slot.count > 1 ? slot.count : undefined,
      hover: this.state(id) === 'hover' && !locked,
      pushed: this.state(id) === 'down' && !locked,
    });
    if (locked) {
      const ctx = s.ctx;
      ctx.save();
      ctx.fillStyle = 'rgba(180, 20, 20, 0.4)';
      ctx.fillRect(x, y, 37, 37);
      ctx.restore();
    }
    this.hit(id, { x: x - 2, y: y - 2, width: 41, height: 41 }, {
      disabled: locked,
      tooltip: slot
        ? () => itemTooltipLines(this.deps.getItemInfo(slot.entry), slot.entry, { count: slot.count })
        : locked ? [{ text: 'Locked', color: '#e60b0b' }, { text: 'Purchase this bag slot to use it.', color: '#ffffff', wrap: true }] : undefined,
    });
  }

  private buttonState(id: string): 'normal' | 'hover' | 'down' {
    const state = this.state(id);
    return state === 'disabled' ? 'normal' : state;
  }

  protected activate(hit: PanelHit) {
    if (hit.id === 'close') {
      this.playUi('igMainMenuClose');
      this.hide();
      this.deps.onClose?.();
      return;
    }
    if (hit.id === 'purchase') {
      this.playUi('igMainMenuOption');
      this.deps.onPurchaseSlot?.();
      return;
    }
    const [kind, indexText] = hit.id.split(':');
    if (kind === 'slot' || kind === 'bag') this.deps.onSlotClick?.(kind, Number(indexText));
  }
}
