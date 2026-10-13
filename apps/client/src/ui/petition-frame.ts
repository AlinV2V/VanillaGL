/** Asset conversion utility. */
import type { PetitionState } from '../world';
import { CanvasPanel, drawInputBox, UI_GRAY, UI_INK, type PanelHit } from './panel-kit';

const FRAME_WIDTH = 384;
const FRAME_HEIGHT = 512;
/** MAX_PETITION_SIGNATURES, PetitionFrame.lua:1. */
const MAX_SIGNATURES = 9;

export type PetitionPanelDeps = {
  playUi: (name: string) => void;
  getPlayerName: (guid: string) => string | undefined;
  getPlayerGuid: () => string | undefined;
  sign: (itemGuid: string) => void;
  decline: (itemGuid: string) => void;
  turnIn: (itemGuid: string) => void;
  rename: (itemGuid: string, name: string) => void;
  onClose: () => void;
};

export class PetitionCanvasPanel extends CanvasPanel {
  private petition?: PetitionState;
  /** Non-undefined while the guild-name line is an editable InputBox. */
  private renaming?: string;

  constructor(private readonly host: HTMLElement, private readonly deps: PetitionPanelDeps) {
    super(host, FRAME_WIDTH, FRAME_HEIGHT, 'wow-native-panel-canvas', { playUi: deps.playUi });
  }

  show(state: PetitionState) {
    const opening = !this.isOpen();
    this.petition = state;
    if (opening) {
      this.host.classList.remove('is-hidden');
      this.playUi('igMainMenuOpen');
    }
    this.surface.requestRender();
  }

  update(state: PetitionState) {
    if (!this.isOpen()) return;
    this.petition = state;
    this.surface.requestRender();
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
    // GuildCharter-Icon 58x58 at TOPLEFT (10,-8), PetitionFrame.xml:22-27.
    s.image('/ui/Interface/PetitionFrame/GuildCharter-Icon.png', 10, 8, 58, 58);
    s.closeButton(FRAME_WIDTH - 39, 8, this.buttonState('close'));
    this.hit('close', { x: FRAME_WIDTH - 39, y: 8, width: 32, height: 32 });

    const petition = this.petition;
    // PetitionFrameNpcNameText (GameFontHighlight, so WHITE) inside PetitionNpcNameFrame, a
    // 300x14 strip anchored TOP (0,-23) => centred at (192,30). It renders
    // GUILD_CHARTER_TEMPLATE = "%s Guild Charter" (1708), i.e. the guild's own name plus the
    // words — and plain "Petition" for a non-charter petition (PetitionFrame.lua:20-24).
    s.text(petition?.name ? `${petition.name} Guild Charter` : 'Petition', 192, 30, {
      size: 12, color: '#ffffff', align: 'center', baseline: 'middle', maxWidth: 290,
    });

    // Label/value pairs on consecutive lines, exactly as the FontStrings chain:
    // CharterTitle (30,-95) -> CharterName -> MasterTitle (-5) -> MasterName -> MemberTitle (-5)
    // -> MemberName1..9 -> Instructions (-10). QuestFont is ~14px, and the stacked FontStrings
    // have no extra gap between them.
    const LINE = 15;
    let y = 95 + LINE;
    const line = (text: string, options: { title?: boolean; color?: string } = {}) => {
      s.text(text, 30, y, {
        size: options.title ? 14 : 13,
        color: options.color ?? UI_INK,
        maxWidth: 285,
      });
      y += LINE;
    };

    line('Guild Name', { title: true });              // GUILD_NAME, 1734
    if (this.renaming !== undefined) {
      drawInputBox(s, 30, y - 12, 240, this.renaming, { focused: this.focusedField === 'rename:name' });
      this.hit('rename:name', { x: 30, y: y - 12, width: 240, height: 20 });
      y += LINE;
    } else {
      line(petition?.name ?? '');
    }
    y += 5;
    line('Guild Master', { title: true });            // GUILD_RANK0_DESC, 1745
    line(petition ? this.deps.getPlayerName(petition.ownerGuid) ?? '' : '');
    y += 5;
    line('Members', { title: true });                 // MEMBERS, 2266

    const signatures = petition?.signatures ?? [];
    for (let index = 0; index < MAX_SIGNATURES; index++) {
      const guid = signatures[index];
      // NOT_YET_SIGNED = "<not yet signed>" (2365) — vanilla fills every empty slot with it.
      const name = guid ? this.deps.getPlayerName(guid) ?? 'Unknown' : '<not yet signed>';
      line(name, { color: guid ? UI_INK : UI_GRAY });
    }

    const isOwner = !!petition && petition.ownerGuid === this.deps.getPlayerGuid();
    const required = petition?.requiredSignatures ?? MAX_SIGNATURES;
    const enoughSignatures = signatures.length >= required;

    // GUILD_PETITION_LEADER_INSTRUCTIONS (1743) / _MEMBER_INSTRUCTIONS (1744), verbatim.
    y += 10;
    const instructions = isOwner
      ? 'Select a player you wish to invite and click <request signature>.   To create this guild, turn it in to the guild registrar when you have filled the charter.'
      : 'Click the <Sign Charter> button to become a charter member of this guild.';
    for (const wrapped of s.wrapText(instructions, 285, { size: 12 })) {
      s.text(wrapped, 30, y, { size: 12, color: UI_INK, maxWidth: 285 });
      y += 14;
    }

    // PetitionFrameSignButton 110x22 BOTTOMLEFT (22,72) and PetitionFrameRequestButton 140x22 at
    // the SAME spot — vanilla shows exactly one of them (PetitionFrame.lua:10-18).
    // PetitionFrameCancelButton 75x22 BOTTOMRIGHT (-40,72).
    const buttonY = FRAME_HEIGHT - 72 - 22;
    if (isOwner) {
      // The owner cannot sign their own charter (PETITION_SIGN_CANT_SIGN_OWN); they turn it in.
      const turnInRect = { x: 22, y: buttonY, width: 140, height: 22 };
      s.panelButton('Turn In Charter', turnInRect, enoughSignatures ? this.buttonState('turnin') : 'disabled');
      this.hit('turnin', turnInRect, { disabled: !enoughSignatures });
      const renameRect = { x: 170, y: buttonY, width: 90, height: 22 };
      s.panelButton('Rename', renameRect, this.buttonState('rename'));
      this.hit('rename', renameRect);
    } else {
      const signRect = { x: 22, y: buttonY, width: 110, height: 22 };
      s.panelButton('Sign Charter', signRect, this.buttonState('sign')); // SIGN_CHARTER, 2845
      this.hit('sign', signRect);
    }
    const closeRect = { x: FRAME_WIDTH - 40 - 75, y: buttonY, width: 75, height: 22 };
    s.panelButton('Close', closeRect, this.buttonState('cancel')); // CLOSE, 598
    this.hit('cancel', closeRect);
  }

  private buttonState(id: string): 'normal' | 'hover' | 'down' {
    const state = this.state(id);
    return state === 'disabled' ? 'normal' : state;
  }

  protected activate(hit: PanelHit) {
    const petition = this.petition;
    if (hit.id === 'close') {
      this.playUi('igMainMenuClose');
      this.deps.onClose();
      this.hide();
      return;
    }
    if (!petition) return;
    if (hit.id === 'sign') { this.deps.sign(petition.itemGuid); return; }
    if (hit.id === 'cancel') {
      // PetitionFrameCancelButton is CLOSE, and vanilla's OnClick calls ClosePetition(), which
      // sends MSG_PETITION_DECLINE only when you are not the originator.
      if (petition.ownerGuid !== this.deps.getPlayerGuid()) this.deps.decline(petition.itemGuid);
      this.deps.onClose();
      this.hide();
      return;
    }
    if (hit.id === 'turnin') { this.deps.turnIn(petition.itemGuid); return; }
    if (hit.id === 'rename') {
      // MSG_PETITION_RENAME is driven by a StaticPopup with hasEditBox in vanilla; here the
      // charter's own name line becomes an InputBoxTemplate EditBox in place.
      this.renaming = petition.name ?? '';
      this.focusField('rename:name');
      return;
    }
    if (hit.id === 'rename:name') { this.focusField('rename:name'); }
  }

  protected onFieldKey = (
    field: string,
    key: 'char' | 'backspace' | 'enter' | 'escape' | 'tab',
    char?: string,
  ) => {
    if (field !== 'rename:name' || this.renaming === undefined) return;
    if (key === 'escape' || key === 'tab') { this.renaming = undefined; this.focusField(undefined); return; }
    if (key === 'enter') {
      const name = this.renaming.trim();
      const petition = this.petition;
      // Guild names are capped at 24 characters server-side (ObjectMgr::IsValidGuildName).
      if (petition && name) this.deps.rename(petition.itemGuid, name.slice(0, 24));
      this.renaming = undefined;
      this.focusField(undefined);
      return;
    }
    this.renaming = key === 'backspace'
      ? this.renaming.slice(0, -1)
      : `${this.renaming}${char ?? ''}`.slice(0, 24);
  };
}
