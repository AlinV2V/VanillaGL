import type { GuildMember, RealmWorldClient, SocialSnapshot } from '../world';
import {
  DEFAULT_GUILD_RANK_NAMES, GUILD_RANK_MAX_COUNT, GUILD_RANK_MIN_COUNT,
  formatGuildLastOnline, GUILD_RIGHT_EMPTY, GUILD_RIGHT_OPTIONS, GUILD_RIGHTS, guildHasRight,
} from '../world/guild-administration';
import { containsPoint, DIALOG_EDGE, drawEdgedBox, TOOLTIP_EDGE, VanillaCanvas, type CanvasRect } from './vanilla-canvas';

type Mode = 'member' | 'control' | 'info';
type Hit = { kind: 'close' | 'accept' | 'cancel' | 'rankMenu' | 'rank' | 'addRank' | 'deleteRank' | 'right' | 'publicNote' | 'officerNote' | 'promote' | 'demote' | 'remove' | 'invite'; rect: CanvasRect; value?: number; disabled?: boolean };
type Player = { guid: string; name: string };

const CLASS_NAMES: Record<number, string> = { 1: 'Warrior', 2: 'Paladin', 3: 'Hunter', 4: 'Rogue', 5: 'Priest', 7: 'Shaman', 8: 'Mage', 9: 'Warlock', 11: 'Druid' };
const fieldStyle = {
  position: 'absolute', zIndex: '14', boxSizing: 'border-box', border: '0', outline: '0',
  color: '#ffffff', background: 'rgba(0,0,0,.72)', font: "12px 'Friz Quadrata', Georgia, serif",
  textShadow: '1px 1px 0 rgba(0,0,0,.95)', display: 'none',
} as const;

/** Native side frames for Guild Control, Guild Information, and selected-member details. */
export class GuildAdministrationController {
  private readonly surface = new VanillaCanvas(297, 298, 'wow-native-panel-canvas wow-guild-admin-canvas');
  private readonly rankInput = document.createElement('input');
  private readonly infoInput = document.createElement('textarea');
  private mode?: Mode;
  private memberGuid?: string;
  private hits: Hit[] = [];
  private hover?: Hit;
  private pressed?: Hit;
  private rankMenuOpen = false;
  private selectedRank = 0;
  private editedRights = GUILD_RIGHT_EMPTY;
  private dirty = false;
  private promptOpen = false;

  constructor(private readonly deps: {
    root: HTMLElement;
    getWorld: () => RealmWorldClient | undefined;
    getSnapshot: () => SocialSnapshot;
    getPlayer: () => Player | undefined;
    getAreaName?: (areaId: number) => string | undefined;
    prompt: (label: string, value: string, maxLength: number, submit: (value: string) => void, allowEmpty?: boolean) => void;
    confirm: (message: string, accept: () => void) => void;
    playUi: (name: string) => void;
  }) {
    Object.assign(this.surface.canvas.style, { position: 'absolute', left: '349px', top: '65px', zIndex: '12', display: 'none' });
    this.rankInput.type = 'text'; this.rankInput.maxLength = 15; this.rankInput.autocomplete = 'off'; this.rankInput.spellcheck = false;
    Object.assign(this.rankInput.style, fieldStyle, { left: '467px', top: '133px', width: '130px', height: '24px', padding: '1px 5px' });
    this.infoInput.maxLength = 500; this.infoInput.spellcheck = true;
    Object.assign(this.infoInput.style, fieldStyle, { left: '365px', top: '104px', width: '240px', height: '218px', padding: '4px', resize: 'none' });
    deps.root.append(this.surface.canvas, this.rankInput, this.infoInput);
    this.surface.onRender(() => this.paint());
    this.surface.canvas.addEventListener('pointermove', (event) => { this.hover = this.hitAt(event); this.surface.requestRender(); });
    this.surface.canvas.addEventListener('pointerleave', () => { this.hover = undefined; this.surface.requestRender(); });
    this.surface.canvas.addEventListener('pointerdown', (event) => this.onDown(event));
    this.surface.canvas.addEventListener('pointerup', (event) => this.onUp(event));
    for (const input of [this.rankInput, this.infoInput]) {
      input.addEventListener('pointerdown', (event) => event.stopPropagation());
      input.addEventListener('input', () => { this.dirty = true; this.surface.requestRender(); });
      input.addEventListener('keydown', (event) => { if ((event as KeyboardEvent).key === 'Escape') input.blur(); });
    }
    this.rankInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); this.rankInput.blur(); } });
  }

  setPromptOpen(value: boolean) {
    this.promptOpen = value;
    this.surface.canvas.style.pointerEvents = value ? 'none' : 'auto';
    if (value) { this.rankInput.style.display = 'none'; this.infoInput.style.display = 'none'; }
    else this.syncInputs();
  }

  sync() {
    const snapshot = this.deps.getSnapshot();
    if (this.mode && !snapshot.guild.length) { this.hide(); return; }
    if (this.mode === 'member' && !snapshot.guild.some((member) => member.guid === this.memberGuid)) this.hide();
    if (this.selectedRank >= snapshot.guildRankRights.length) { this.selectedRank = Math.max(0, snapshot.guildRankRights.length - 1); this.dirty = false; }
    if (!this.dirty && this.mode === 'control') this.loadRank();
    if (!this.dirty && this.mode === 'info') this.infoInput.value = snapshot.guildInfoText;
    this.syncInputs();
    this.surface.requestRender();
  }

  showMember(guid: string) { this.mode = 'member'; this.memberGuid = guid; this.dirty = false; this.show(); }
  toggleControl() {
    if (this.mode === 'control') { this.hide(); return; }
    if (!this.deps.getWorld()?.canManageGuildRanks()) return;
    this.mode = 'control'; this.selectedRank = 0; this.dirty = false; this.rankMenuOpen = false; this.loadRank(); this.show();
  }
  toggleInfo() { if (this.mode === 'info') { this.hide(); return; } this.mode = 'info'; this.dirty = false; this.infoInput.value = this.deps.getSnapshot().guildInfoText; this.show(); }
  hide() { this.mode = undefined; this.memberGuid = undefined; this.rankMenuOpen = false; this.surface.canvas.style.display = 'none'; this.rankInput.style.display = 'none'; this.infoInput.style.display = 'none'; }

  private show() {
    const detail = this.mode === 'member';
    Object.assign(this.surface.canvas.style, { display: 'block', left: detail ? '351px' : '349px', top: detail ? '28px' : '65px' });
    this.syncInputs(); this.surface.requestRender();
  }

  private syncInputs() {
    if (this.promptOpen) return;
    this.rankInput.style.display = this.mode === 'control' && !this.rankMenuOpen ? 'block' : 'none';
    this.infoInput.style.display = this.mode === 'info' ? 'block' : 'none';
    if (this.mode === 'info') {
      const editable = this.can(GUILD_RIGHTS.modifyGuildInfo);
      this.infoInput.readOnly = !editable;
      this.infoInput.style.color = editable ? '#ffffff' : '#a6a6a6';
    }
  }

  private rankNames() {
    const snapshot = this.deps.getSnapshot();
    return Array.from({ length: snapshot.guildRankRights.length }, (_, index) => snapshot.guildRankNames[index] ?? DEFAULT_GUILD_RANK_NAMES[index] ?? `Rank ${index + 1}`);
  }
  private ownRank() { const player = this.deps.getPlayer(); return this.deps.getSnapshot().guild.find((member) => member.guid === player?.guid)?.rankId; }
  private ownRights() { const rank = this.ownRank(); return rank === undefined ? 0 : this.deps.getSnapshot().guildRankRights[rank] ?? 0; }
  private can(right: number) { return guildHasRight(this.ownRights(), right); }
  private loadRank() {
    const snapshot = this.deps.getSnapshot();
    this.rankInput.value = this.rankNames()[this.selectedRank] ?? '';
    this.editedRights = snapshot.guildRankRights[this.selectedRank] ?? GUILD_RIGHT_EMPTY;
  }

  private paint() {
    this.surface.clear(); this.hits = [];
    if (this.mode === 'control') this.paintControl();
    else if (this.mode === 'info') this.paintInfo();
    else if (this.mode === 'member') this.paintMember();
  }

  private paintControl() {
    const s = this.surface; const art = '/ui/Interface/MacroFrame';
    s.image(`${art}/MacroPopup-TopLeft.png`, 0, 0, 256, 256); s.image(`${art}/MacroPopup-TopRight.png`, 256, 0, 64, 256);
    s.image(`${art}/MacroPopup-BotLeft.png`, 0, 256, 256, 64); s.image(`${art}/MacroPopup-BotRight.png`, 256, 256, 64, 64);
    s.text('Select guild rank to modify:', 148, 15, { size: 12, align: 'center', baseline: 'middle' });
    s.text('Allow this rank to:', 148, 106, { size: 11, color: '#ffffff', align: 'center', baseline: 'middle' });
    const selector = { x: 50, y: 28, width: 166, height: 27 };
    this.darkBox(selector); s.text(this.rankNames()[this.selectedRank] ?? '', 62, 43, { size: 11, color: '#ffffff', baseline: 'middle', maxWidth: 135 });
    s.text('▼', 205, 43, { size: 10, color: '#ffd100', align: 'center', baseline: 'middle' });
    this.hits.push({ kind: 'rankMenu', rect: selector });
    const canAdd = this.deps.getSnapshot().guildRankRights.length < GUILD_RANK_MAX_COUNT;
    const canDelete = this.canDeleteRank();
    s.image(`/ui/Interface/Buttons/UI-PlusButton-${canAdd ? 'Up' : 'Disabled'}.png`, 218, 34, 16, 16);
    s.image(`/ui/Interface/Buttons/UI-MinusButton-${canDelete ? 'Up' : 'Disabled'}.png`, 232, 34, 16, 16);
    this.hits.push({ kind: 'addRank', rect: { x: 218, y: 34, width: 16, height: 16 }, disabled: !canAdd }, { kind: 'deleteRank', rect: { x: 232, y: 34, width: 16, height: 16 }, disabled: !canDelete });
    s.text('Rank Label:', 106, 80, { size: 11, align: 'right', baseline: 'middle' });
    for (let index = 0; index < GUILD_RIGHT_OPTIONS.length; index++) {
      const [label, right] = GUILD_RIGHT_OPTIONS[index]; const column = index % 2; const row = Math.floor(index / 2);
      const rect = { x: 25 + column * 140, y: 121 + row * 20, width: 20, height: 20 };
      s.image('/ui/Interface/Buttons/UI-CheckBox-Up.png', rect.x, rect.y, 20, 20);
      if ((this.editedRights & (right & ~GUILD_RIGHT_EMPTY)) !== 0) s.image('/ui/Interface/Buttons/UI-CheckBox-Check.png', rect.x, rect.y, 20, 20);
      s.text(label, rect.x + 21, rect.y + 11, { size: 9, baseline: 'middle', maxWidth: 116 });
      this.hits.push({ kind: 'right', rect: { x: rect.x, y: rect.y, width: 136, height: 20 }, value: index });
    }
    const accept = { x: 128, y: 263, width: 78, height: 22 }; const cancel = { x: 208, y: 263, width: 78, height: 22 };
    s.panelButton('Accept', accept, this.dirty ? this.buttonState('accept') : 'disabled'); s.panelButton('Cancel', cancel, this.buttonState('cancel'));
    this.hits.push({ kind: 'accept', rect: accept, disabled: !this.dirty }, { kind: 'cancel', rect: cancel });
    if (this.rankMenuOpen) this.paintRankMenu(selector);
  }

  private paintRankMenu(selector: CanvasRect) {
    const names = this.rankNames(); const height = names.length * 19 + 6; const rect = { x: selector.x, y: selector.y + selector.height, width: selector.width, height };
    drawEdgedBox(this.surface, rect, TOOLTIP_EDGE);
    names.forEach((name, index) => { const row = { x: rect.x + 3, y: rect.y + 3 + index * 19, width: rect.width - 6, height: 19 }; if (this.hover?.kind === 'rank' && this.hover.value === index) this.highlight(row); this.surface.text(name, row.x + 7, row.y + 10, { size: 10, baseline: 'middle', maxWidth: row.width - 14 }); this.hits.push({ kind: 'rank', rect: row, value: index }); });
  }

  private canDeleteRank() {
    const snapshot = this.deps.getSnapshot(); const count = snapshot.guildRankRights.length;
    return count > GUILD_RANK_MIN_COUNT && this.selectedRank === count - 1 && !snapshot.guild.some((member) => member.rankId === this.selectedRank);
  }

  private paintInfo() {
    const s = this.surface; drawEdgedBox(s, { x: 0, y: 0, width: 297, height: 298 }, DIALOG_EDGE);
    s.text('Guild Information', 17, 17, { size: 12, baseline: 'middle' }); drawEdgedBox(s, { x: 11, y: 32, width: 276, height: 230 }, TOOLTIP_EDGE);
    const editable = this.can(GUILD_RIGHTS.modifyGuildInfo); const accept = { x: 10, y: 264, width: 139, height: 22 }; const close = { x: 149, y: 264, width: 139, height: 22 };
    s.panelButton('Accept', accept, editable ? this.buttonState('accept') : 'disabled'); s.panelButton('Close', close, this.buttonState('cancel'));
    this.hits.push({ kind: 'accept', rect: accept, disabled: !editable }, { kind: 'cancel', rect: close });
  }

  private paintMember() {
    const member = this.deps.getSnapshot().guild.find((entry) => entry.guid === this.memberGuid); if (!member) return;
    const canViewOfficer = this.can(GUILD_RIGHTS.viewOfficerNote); const height = canViewOfficer ? 255 : 195; const s = this.surface;
    drawEdgedBox(s, { x: 0, y: 0, width: 212, height }, DIALOG_EDGE); s.closeButton(177, 3, this.buttonState('close')); this.hits.push({ kind: 'close', rect: { x: 177, y: 3, width: 32, height: 32 } });
    s.text(member.name, 17, 18, { size: 12, baseline: 'middle', maxWidth: 155 }); s.text(`Level ${member.level} ${CLASS_NAMES[member.classId] ?? ''}`, 17, 35, { size: 10, color: '#ffffff' });
    this.detailLine('Zone:', this.deps.getAreaName?.(member.zoneId) ?? `Area ${member.zoneId}`, 58); this.detailLine('Rank:', this.rankNames()[member.rankId] ?? `Rank ${member.rankId + 1}`, 78); this.detailLine('Last Online:', member.online ? 'Online' : formatGuildLastOnline(member.lastOnlineDays), 98);
    s.text('Note:', 17, 117, { size: 10 }); const publicRect = { x: 15, y: 123, width: 181, height: 40 }; drawEdgedBox(s, publicRect, TOOLTIP_EDGE); s.text(member.note || (this.can(GUILD_RIGHTS.editPublicNote) ? 'Click here to set a Public Note.' : ''), 24, 138, { size: 9, color: this.can(GUILD_RIGHTS.editPublicNote) ? '#ffffff' : '#a6a6a6', maxWidth: 163 }); this.hits.push({ kind: 'publicNote', rect: publicRect, disabled: !this.can(GUILD_RIGHTS.editPublicNote) });
    if (canViewOfficer) { s.text("Officer's Note:", 17, 177, { size: 10 }); const rect = { x: 15, y: 183, width: 181, height: 40 }; drawEdgedBox(s, rect, TOOLTIP_EDGE); s.text(member.officerNote || (this.can(GUILD_RIGHTS.editOfficerNote) ? "Click here to set an Officer's Note." : ''), 24, 198, { size: 9, color: this.can(GUILD_RIGHTS.editOfficerNote) ? '#ffffff' : '#a6a6a6', maxWidth: 163 }); this.hits.push({ kind: 'officerNote', rect, disabled: !this.can(GUILD_RIGHTS.editOfficerNote) }); }
    const player = this.deps.getPlayer(); const selfRank = this.ownRank() ?? 99; const lastRank = this.deps.getSnapshot().guildRankRights.length - 1;
    const canPromote = this.can(GUILD_RIGHTS.promote) && member.rankId > 1 && member.rankId > selfRank + 1;
    const canDemote = this.can(GUILD_RIGHTS.demote) && member.rankId >= 1 && member.rankId > selfRank && member.rankId !== lastRank;
    const canRemove = this.can(GUILD_RIGHTS.remove) && member.rankId >= 1 && member.rankId > selfRank;
    const canInvite = member.guid !== player?.guid && member.online;
    const arrowsY = height - 66; this.iconButton('promote', '/ui/Interface/MainMenuBar/UI-MainMenu-ScrollUpButton-', 152, arrowsY, canPromote); this.iconButton('demote', '/ui/Interface/MainMenuBar/UI-MainMenu-ScrollDownButton-', 172, arrowsY, canDemote);
    const remove = { x: 10, y: height - 34, width: 96, height: 22 }; const invite = { x: 107, y: height - 34, width: 96, height: 22 };
    s.panelButton('Remove', remove, canRemove ? this.buttonState('remove') : 'disabled'); s.panelButton('Group Invite', invite, canInvite ? this.buttonState('invite') : 'disabled'); this.hits.push({ kind: 'remove', rect: remove, disabled: !canRemove }, { kind: 'invite', rect: invite, disabled: !canInvite });
  }

  private detailLine(label: string, value: string, y: number) { this.surface.text(label, 17, y, { size: 10 }); this.surface.text(value, label === 'Last Online:' ? 78 : 52, y, { size: 10, color: '#ffffff', maxWidth: label === 'Last Online:' ? 115 : 145 }); }
  private iconButton(kind: 'promote' | 'demote', path: string, x: number, y: number, enabled: boolean) { this.surface.image(`${path}${enabled ? 'Up' : 'Disabled'}.png`, x, y, 28, 28); this.hits.push({ kind, rect: { x: x + 6, y: y + 7, width: 16, height: 14 }, disabled: !enabled }); }
  private darkBox(rect: CanvasRect) { const c = this.surface.ctx; c.save(); c.fillStyle = 'rgba(0,0,0,.84)'; c.fillRect(rect.x, rect.y, rect.width, rect.height); c.strokeStyle = '#8c713f'; c.strokeRect(rect.x + .5, rect.y + .5, rect.width - 1, rect.height - 1); c.restore(); }
  private highlight(rect: CanvasRect) { const c = this.surface.ctx; c.save(); c.fillStyle = 'rgba(255,209,0,.18)'; c.fillRect(rect.x, rect.y, rect.width, rect.height); c.restore(); }
  private buttonState(kind: Hit['kind']): 'normal' | 'hover' | 'down' { if (this.pressed?.kind === kind) return 'down'; if (this.hover?.kind === kind) return 'hover'; return 'normal'; }
  private hitAt(event: PointerEvent) { const point = this.surface.point(event); for (let i = this.hits.length - 1; i >= 0; i--) if (containsPoint(this.hits[i].rect, point)) return this.hits[i]; return undefined; }
  private onDown(event: PointerEvent) { if (event.button !== 0) return; this.pressed = this.hitAt(event); if (this.pressed) { event.preventDefault(); event.stopPropagation(); } this.surface.requestRender(); }
  private onUp(event: PointerEvent) {
    const hit = this.hitAt(event); const pressed = this.pressed; this.pressed = undefined;
    if (!hit || !pressed || hit.kind !== pressed.kind || hit.value !== pressed.value || hit.disabled) { this.surface.requestRender(); return; }
    event.preventDefault(); event.stopPropagation(); const world = this.deps.getWorld(); const member = this.deps.getSnapshot().guild.find((entry) => entry.guid === this.memberGuid);
    if (hit.kind === 'close' || hit.kind === 'cancel') this.hide();
    else if (hit.kind === 'rankMenu') { this.rankMenuOpen = !this.rankMenuOpen; this.syncInputs(); }
    else if (hit.kind === 'rank' && hit.value !== undefined) { this.selectedRank = hit.value; this.rankMenuOpen = false; this.dirty = false; this.loadRank(); this.syncInputs(); }
    else if (hit.kind === 'right' && hit.value !== undefined) { const bit = GUILD_RIGHT_OPTIONS[hit.value][1] & ~GUILD_RIGHT_EMPTY; this.editedRights = (this.editedRights ^ bit) | GUILD_RIGHT_EMPTY; this.dirty = true; }
    else if (hit.kind === 'accept' && this.mode === 'control') { world?.guildSaveRank(this.selectedRank, this.editedRights, this.rankInput.value); this.hide(); }
    else if (hit.kind === 'accept' && this.mode === 'info') { world?.guildSetInfoText(this.infoInput.value); this.hide(); }
    else if (hit.kind === 'addRank') this.deps.prompt('Add Guild Rank:', '', 15, (value) => world?.guildAddRank(value));
    else if (hit.kind === 'deleteRank') {
      // FriendsFrame.lua resets GuildControlSetRank/selected dropdown ID to 1 immediately.
      this.selectedRank = 0; this.dirty = false; world?.guildDeleteLowestRank(); this.loadRank();
    }
    else if (hit.kind === 'publicNote' && member) this.deps.prompt('Set Player Note:', member.note, 31, (value) => world?.guildSetPublicNote(member.name, value), true);
    else if (hit.kind === 'officerNote' && member) this.deps.prompt('Set Officer Note:', member.officerNote, 31, (value) => world?.guildSetOfficerNote(member.name, value), true);
    else if (hit.kind === 'promote' && member) world?.guildPromote(member.name);
    else if (hit.kind === 'demote' && member) world?.guildDemote(member.name);
    else if (hit.kind === 'remove' && member) this.deps.confirm(`Are you sure you want to remove ${member.name} from the guild?`, () => world?.guildRemove(member.name));
    else if (hit.kind === 'invite' && member) world?.inviteToParty(member.name);
    this.deps.playUi('igMainMenuOptionCheckBoxOn'); this.surface.requestRender();
  }
}
