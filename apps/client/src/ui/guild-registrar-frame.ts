/** Asset conversion utility. */
import type { PetitionCharterOffer } from '../world';
import { drawMoney } from './money';
import { CanvasPanel, drawInputBox, UI_GRAY, UI_INK, type PanelHit } from './panel-kit';

const FRAME_WIDTH = 384;
const FRAME_HEIGHT = 512;
/** ObjectMgr guild-name validation caps at 24 characters. */
const MAX_GUILD_NAME = 24;

export type GuildRegistrarDeps = {
  playUi: (name: string) => void;
  getUnitName: (guid: string) => string | undefined;
  getUnitPortraitSource?: (guid: string) => CanvasImageSource | undefined;
  getPlayerMoney: () => number;
  buyCharter: (npcGuid: string, name: string, index: number) => void;
  onClose: () => void;
};

export class GuildRegistrarCanvasPanel extends CanvasPanel {
  private guid?: string;
  private portraitGuid?: string;
  private portraitSource?: CanvasImageSource;
  private offers: PetitionCharterOffer[] = [];
  /** 'greeting' lists services; 'purchase' collects the guild name. GuildRegistrarFrame.lua:1-12. */
  private pane: 'greeting' | 'purchase' = 'greeting';
  private guildName = '';

  constructor(private readonly host: HTMLElement, private readonly deps: GuildRegistrarDeps) {
    super(host, FRAME_WIDTH, FRAME_HEIGHT, 'wow-native-panel-canvas', { playUi: deps.playUi });
  }

  show(guid: string, offers: PetitionCharterOffer[]) {
    if (guid !== this.portraitGuid) {
      this.portraitGuid = guid;
      this.portraitSource = undefined;
    }
    const opening = !this.isOpen();
    this.guid = guid;
    this.offers = offers;
    if (opening) {
      this.pane = 'greeting';
      this.guildName = '';
      this.host.classList.remove('is-hidden');
      this.playUi('igMainMenuOpen');
    }
    this.updatePortrait();
    this.surface.requestRender();
  }

  updatePortrait() {
    if (!this.guid || !this.isOpen()) return;
    const source = this.deps.getUnitPortraitSource?.(this.guid);
    if (source && source !== this.portraitSource) {
      this.portraitSource = source;
      this.surface.requestRender();
    }
  }

  hide() {
    this.host.classList.add('is-hidden');
    this.focusField(undefined);
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
    if (this.portraitSource) s.source(this.portraitSource, 10, 8, 58, 58, { circular: true });
    else s.image('/ui/Interface/CharacterFrame/TemporaryPortrait-Monster.png', 10, 8, 58, 58);
    s.closeButton(FRAME_WIDTH - 39, 8, this.buttonState('close'));
    this.hit('close', { x: FRAME_WIDTH - 39, y: 8, width: 32, height: 32 });
    // GuildRegistrarFrameNpcNameText, GameFontHighlight, centred like every NpcNameFrame.
    s.text(this.guid ? this.deps.getUnitName(this.guid) ?? 'Guild Registrar' : 'Guild Registrar', 192, 30, {
      size: 12, color: '#ffffff', align: 'center', baseline: 'middle', maxWidth: 290,
    });

    if (this.pane === 'greeting') this.paintGreeting();
    else this.paintPurchase();
  }

  private paintGreeting() {
    const s = this.surface;
    // AvailableServicesText at (35,-100), then the service buttons below it.
    s.text('Available Services', 35, 112, { size: 14, color: UI_INK }); // AVAILABLE_SERVICES, 86
    const services: Array<{ id: string; label: string; enabled: boolean }> = [
      // GUILD_CHARTER_PURCHASE, 1706 / GUILD_CHARTER_REGISTER, 1707 / GUILD_CREST_DESIGN, 1710.
      { id: 'service:purchase', label: 'Purchase a Guild Charter', enabled: this.offers.length > 0 },
      { id: 'service:register', label: 'Register a Guild Charter', enabled: true },
      { id: 'service:crest', label: 'Design a Guild Crest', enabled: false },
    ];
    services.forEach((service, index) => {
      const y = 138 + index * 26;
      const hovered = this.isHover(service.id) && service.enabled;
      if (hovered) s.image('/ui/Interface/QuestFrame/UI-QuestTitleHighlight.png', 30, y - 4, 300, 24, 0.5);
      s.text(service.label, 45, y + 12, {
        size: 13, color: service.enabled ? UI_INK : UI_GRAY, shadow: false, maxWidth: 280,
      });
      this.hit(service.id, { x: 30, y: y - 4, width: 300, height: 24 }, { disabled: !service.enabled });
    });

    // GuildRegistrarFrameGoodbyeButton 75x22 BOTTOMRIGHT (-40,72), CANCEL = "Cancel".
    const goodbyeRect = { x: FRAME_WIDTH - 40 - 75, y: FRAME_HEIGHT - 72 - 22, width: 75, height: 22 };
    s.panelButton('Cancel', goodbyeRect, this.buttonState('goodbye'));
    this.hit('goodbye', goodbyeRect);
  }

  private paintPurchase() {
    const s = this.surface;
    // GUILD_REGISTRAR_PURCHASE_TEXT, GlobalStrings.lua:1750 — verbatim, including its double space.
    const text = 'To create a guild you must purchase this charter, get 9 unique player signatures, '
      + 'and return the charter to me.  Please enter the desired name for your guild.';
    let y = 108;
    for (const wrapped of s.wrapText(text, 270, { size: 13 })) {
      s.text(wrapped, 35, y, { size: 13, color: UI_INK, shadow: false, maxWidth: 270 });
      y += 16;
    }

    // COSTS_LABEL = "Cost:" with the charter price beside it, then the name EditBox below.
    y += 12;
    s.text('Cost:', 35, y, { size: 13, color: UI_INK, shadow: false });
    const cost = this.offers[0]?.cost ?? 0;
    const affordable = this.deps.getPlayerMoney() >= cost;
    drawMoney(s, 80, y - 5, cost, { align: 'left', color: affordable ? '#000000' : '#7a2020' });

    y += 18;
    drawInputBox(s, 35, y, 220, this.guildName, {
      focused: this.focusedField === 'name',
      placeholder: 'Guild name',
    });
    this.hit('name', { x: 35, y, width: 220, height: 20 });

    const buttonY = FRAME_HEIGHT - 72 - 22;
    const canBuy = this.guildName.trim().length > 0 && affordable;
    const purchaseRect = { x: 22, y: buttonY, width: 85, height: 22 };
    s.panelButton('Purchase', purchaseRect, canBuy ? this.buttonState('purchase') : 'disabled');
    this.hit('purchase', purchaseRect, { disabled: !canBuy });
    const cancelRect = { x: FRAME_WIDTH - 40 - 75, y: buttonY, width: 75, height: 22 };
    s.panelButton('Cancel', cancelRect, this.buttonState('cancel'));
    this.hit('cancel', cancelRect);
  }

  private buttonState(id: string): 'normal' | 'hover' | 'down' {
    const state = this.state(id);
    return state === 'disabled' ? 'normal' : state;
  }

  protected onFieldKey = (
    field: string,
    key: 'char' | 'backspace' | 'enter' | 'escape' | 'tab',
    char?: string,
  ) => {
    if (field !== 'name') return;
    if (key === 'escape' || key === 'tab') { this.focusField(undefined); return; }
    if (key === 'enter') { this.submit(); return; }
    this.guildName = key === 'backspace'
      ? this.guildName.slice(0, -1)
      : `${this.guildName}${char ?? ''}`.slice(0, MAX_GUILD_NAME);
  };

  private submit() {
    const name = this.guildName.trim();
    const offer = this.offers[0];
    if (!this.guid || !offer || !name) return;
    this.deps.buyCharter(this.guid, name, offer.index);
    this.focusField(undefined);
    this.deps.onClose();
    this.hide();
  }

  protected activate(hit: PanelHit) {
    if (hit.id === 'close' || hit.id === 'goodbye' || hit.id === 'cancel') {
      if (hit.id === 'cancel' && this.pane === 'purchase') {
        // GuildRegistrarFrameCancelButton returns to the greeting pane, it does not close.
        this.pane = 'greeting';
        this.focusField(undefined);
        this.surface.requestRender();
        return;
      }
      this.playUi('igMainMenuClose');
      this.deps.onClose();
      this.hide();
      return;
    }
    if (hit.id === 'service:purchase') {
      this.pane = 'purchase';
      this.guildName = '';
      this.playUi('igMainMenuOptionCheckBoxOn');
      this.focusField('name');
      return;
    }
    if (hit.id === 'service:register') {
      // "Register a Guild Charter" is the turn-in; the charter item itself drives it, so the
      // registrar just points the player at their bags.
      this.playUi('igMainMenuOptionCheckBoxOn');
      return;
    }
    if (hit.id === 'name') { this.focusField('name'); return; }
    if (hit.id === 'purchase') this.submit();
  }
}
