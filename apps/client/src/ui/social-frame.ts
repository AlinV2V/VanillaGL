import type { RealmWorldClient, SocialSnapshot } from '../world';
import { planRaidSubgroupDrop, type RaidSubgroupMember } from '../world/raid-coordination';
import { DEFAULT_GUILD_RANK_NAMES, formatGuildLastOnline, GUILD_RIGHTS, guildHasRight } from '../world/guild-administration';
import { GuildAdministrationController } from './guild-administration-frame';
import { containsPoint, DIALOG_EDGE, drawEdgedBox, ensureVanillaFonts, VanillaCanvas, type CanvasRect } from './vanilla-canvas';

type MainTab = 'friends' | 'who' | 'guild' | 'raid';
type ContactTab = 'friends' | 'ignore';
type Hit = { kind: 'close' | 'main' | 'contact' | 'add' | 'remove' | 'row' | 'whoRow' | 'whoRefresh' | 'whoAdd' | 'whoInvite' | 'scroll' | 'message' | 'invite' | 'guildRow' | 'guildToggle' | 'guildControl' | 'guildAdd' | 'guildInfo' | 'guildMotd' | 'convertRaid' | 'raidAdd' | 'readyCheck' | 'raidMember' | 'raidSlot'; rect: CanvasRect; value?: string; disabled?: boolean; subgroup?: number; slot?: number };

const MAIN_TABS: Array<[MainTab, string]> = [['friends', 'Friends'], ['who', 'Who'], ['guild', 'Guild'], ['raid', 'Raid']];
const CLASS_NAMES: Record<number, string> = { 1: 'Warrior', 2: 'Paladin', 3: 'Hunter', 4: 'Rogue', 5: 'Priest', 7: 'Shaman', 8: 'Mage', 9: 'Warlock', 11: 'Druid' };
// Priority-resolved Fonts.xml RAID_CLASS_COLORS; Vanilla uses the Paladin pink for Shaman too.
const RAID_CLASS_COLORS: Record<number, string> = { 1: '#c79c6e', 2: '#f58cba', 3: '#abd473', 4: '#fff569', 5: '#ffffff', 7: '#f58cba', 8: '#69ccf0', 9: '#9482c9', 11: '#ff7d0a' };
const RAID_DESCRIPTION = 'Raids are groups of more than 5 people and are typically used to defeat unique challenges at high levels.\n\n- Raid members cannot earn credit toward most non-raid quests. Specifically, they will not receive non-raid quest credit for killing creatures or collecting items.\n\n- Raids grant substantially less experience for defeating monsters than normal groups.\n\n- Raids allow you to overcome challenges that might otherwise be nearly impossible.';
type RaidViewMember = RaidSubgroupMember & { online: boolean; assistant: boolean; level: number; classId?: number };
type PromptConfig = { label: string; maxLength: number; allowEmpty: boolean; submit: (value: string) => void };

export class SocialFrameController {
  private openState = false;
  private mainTab: MainTab = 'friends';
  private contactTab: ContactTab = 'friends';
  private selectedGuid?: string;
  private selectedWhoName?: string;
  private snapshot: SocialSnapshot = { friends: [], ignored: [], who: [], whoOnline: 0, guild: [], guildMotd: '', guildInfoText: '', guildRankRights: [], guildName: '', guildRankNames: [], groupType: 0, group: [], raidTargets: Array(8).fill(undefined) };
  private unsubscribe?: () => void;
  private readonly surface = new VanillaCanvas(384, 512, 'wow-native-panel-canvas wow-social-canvas');
  private readonly promptSurface = new VanillaCanvas(320, 130, 'wow-social-prompt-canvas');
  private readonly promptInput = document.createElement('input');
  private readonly guildAdmin: GuildAdministrationController;
  private hits: Hit[] = [];
  private hover?: Hit;
  private pressed?: Hit;
  private prompt?: PromptConfig;
  private promptPressed?: 'ok' | 'cancel';
  private listScroll = 0;
  private listMaxScroll = 0;
  private guildPlayerStatus = true;
  private raidDrag?: { guid: string; x: number; y: number };

  constructor(private readonly deps: {
    root: HTMLElement;
    getWorld: () => RealmWorldClient | undefined;
    playUi: (name: string) => void;
    getPlayer?: () => { guid: string; name: string; level: number; classId: number } | undefined;
    getAreaName?: (areaId: number) => string | undefined;
    /** Offline fixture routing; production always opens on the Friends tab like FrameXML. */
    initialTab?: MainTab;
    /** Opens the chat input seeded with a whisper to this player (FriendsFrameSendMessageButton). */
    startWhisper?: (name: string) => void;
    /** Mirrors StaticPopupDialogs[REMOVE_GUILDMEMBER] for irreversible roster actions. */
    confirm: (message: string, accept: () => void) => void;
  }) {
    if (deps.initialTab) this.mainTab = deps.initialTab;
    this.promptInput.type = 'text';
    this.promptInput.maxLength = 48;
    this.promptInput.autocomplete = 'off';
    this.promptInput.spellcheck = false;
    this.promptInput.setAttribute('aria-label', 'Player name');
    Object.assign(this.promptInput.style, {
      position: 'absolute', left: '62px', top: '224px', zIndex: '12', width: '248px', height: '20px',
      boxSizing: 'border-box', border: '0', outline: '0', padding: '1px 5px', display: 'none',
      color: '#ffffff', background: 'transparent', font: "12px 'Friz Quadrata', Georgia, serif",
      textShadow: '1px 1px 0 rgba(0,0,0,.95)',
    });
    Object.assign(this.promptSurface.canvas.style, {
      position: 'absolute', left: '32px', top: '170px', zIndex: '11', display: 'none',
    });
    deps.root.replaceChildren(this.surface.canvas, this.promptSurface.canvas, this.promptInput);
    this.guildAdmin = new GuildAdministrationController({
      root: deps.root, getWorld: deps.getWorld, getSnapshot: () => this.snapshot,
      getPlayer: () => deps.getPlayer?.(), getAreaName: deps.getAreaName, playUi: deps.playUi,
      prompt: (label, value, maxLength, submit, allowEmpty) => this.openTextPrompt(label, value, maxLength, submit, allowEmpty),
      confirm: deps.confirm,
    });
    this.surface.onRender(() => this.paint());
    this.promptSurface.onRender(() => this.paintPrompt());
    this.surface.canvas.addEventListener('pointermove', (event) => this.onMove(event));
    this.surface.canvas.addEventListener('pointerleave', () => { this.hover = undefined; this.surface.requestRender(); });
    this.surface.canvas.addEventListener('pointerdown', (event) => this.onDown(event));
    this.surface.canvas.addEventListener('pointerup', (event) => this.onUp(event));
    this.surface.canvas.addEventListener('pointercancel', () => { this.raidDrag = undefined; this.pressed = undefined; this.surface.requestRender(); });
    this.surface.canvas.addEventListener('wheel', (event) => {
      if (!this.listMaxScroll) return;
      event.preventDefault();
      event.stopPropagation();
      this.listScroll = Math.max(0, Math.min(this.listMaxScroll, this.listScroll + (event.deltaY > 0 ? 1 : -1)));
      this.surface.requestRender();
    }, { passive: false });
    this.promptSurface.canvas.addEventListener('pointerdown', (event) => this.onPromptDown(event));
    this.promptSurface.canvas.addEventListener('pointerup', (event) => this.onPromptUp(event));
    this.promptInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); this.submitContactPrompt(); }
      else if (event.key === 'Escape') { event.preventDefault(); this.closeContactPrompt(); }
    });
    void ensureVanillaFonts().then(() => this.surface.requestRender());
  }

  toggle() { this.setOpen(!this.openState); }
  openAddContactPrompt(tab: ContactTab = this.contactTab) {
    this.contactTab = tab;
    this.addContact();
  }
  /** Offline gallery routing for side-frame interaction QA. */
  showGuildPreview(which: 'control' | 'member' | 'info') { this.mainTab = 'guild'; if (which === 'control') this.guildAdmin.toggleControl(); else if (which === 'info') this.guildAdmin.toggleInfo(); else { const member = this.snapshot.guild.find((entry) => entry.guid !== this.deps.getPlayer?.()?.guid); if (member) this.guildAdmin.showMember(member.guid); } this.surface.requestRender(); }
  setOpen(value: boolean) {
    if (this.openState === value) return;
    this.openState = value;
    this.deps.root.classList.toggle('is-hidden', !value);
    this.deps.playUi(value ? 'MAINMENUOPEN' : 'MAINMENUCLOSE');
    if (value) {
      const world = this.deps.getWorld();
      this.unsubscribe?.();
      this.unsubscribe = world?.onSocial((snapshot) => { this.snapshot = snapshot; this.guildAdmin.sync(); this.surface.requestRender(); });
      this.snapshot = world?.getSocial() ?? this.snapshot;
      world?.requestSocialLists();
      this.guildAdmin.sync();
      this.surface.requestRender();
    } else {
      this.closeContactPrompt();
      this.guildAdmin.hide();
      this.unsubscribe?.();
      this.unsubscribe = undefined;
    }
  }

  private paint() {
    const s = this.surface;
    s.clear();
    // FriendsFrame.lua:80-123 swaps all four textures for Friends/Ignore/Who/Guild/Raid.
    const quadrants = this.mainTab === 'who' ? [
      '/ui/Interface/ClassTrainerFrame/UI-ClassTrainer-TopLeft.png', '/ui/Interface/ClassTrainerFrame/UI-ClassTrainer-TopRight.png',
      '/ui/Interface/FriendsFrame/WhoFrame-BotLeft.png', '/ui/Interface/FriendsFrame/WhoFrame-BotRight.png',
    ] : this.mainTab === 'guild' ? [
      '/ui/Interface/ClassTrainerFrame/UI-ClassTrainer-TopLeft.png', '/ui/Interface/ClassTrainerFrame/UI-ClassTrainer-TopRight.png',
      '/ui/Interface/FriendsFrame/GuildFrame-BotLeft.png', '/ui/Interface/FriendsFrame/GuildFrame-BotRight.png',
    ] : this.mainTab === 'raid' ? [
      '/ui/Interface/PaperDollInfoFrame/UI-Character-General-TopLeft.png', '/ui/Interface/PaperDollInfoFrame/UI-Character-General-TopRight.png',
      '/ui/Interface/PaperDollInfoFrame/UI-Character-General-BottomLeft.png', '/ui/Interface/PaperDollInfoFrame/UI-Character-General-BottomRight.png',
    ] : this.contactTab === 'ignore' ? [
      '/ui/Interface/PaperDollInfoFrame/UI-Character-General-TopLeft.png', '/ui/Interface/PaperDollInfoFrame/UI-Character-General-TopRight.png',
      '/ui/Interface/FriendsFrame/UI-IgnoreFrame-BotLeft.png', '/ui/Interface/FriendsFrame/UI-IgnoreFrame-BotRight.png',
    ] : [
      '/ui/Interface/PaperDollInfoFrame/UI-Character-General-TopLeft.png', '/ui/Interface/PaperDollInfoFrame/UI-Character-General-TopRight.png',
      '/ui/Interface/FriendsFrame/UI-FriendsFrame-BotLeft.png', '/ui/Interface/FriendsFrame/UI-FriendsFrame-BotRight.png',
    ];
    s.image(quadrants[0], 0, 0, 256, 256); s.image(quadrants[1], 256, 0, 128, 256);
    s.image(quadrants[2], 0, 256, 256, 256); s.image(quadrants[3], 256, 256, 128, 256);
    s.image('/ui/Interface/FriendsFrame/FriendsFrameScrollIcon.png', 7, 6, 60, 60);
    const title = this.mainTab === 'friends' ? 'Friends List' : this.mainTab === 'who' ? `Who List (${this.snapshot.whoOnline})` : this.mainTab === 'guild' ? this.snapshot.guildName || 'Guild' : 'Raid';
    s.text(title, 192, 21, { size: 14, align: 'center', baseline: 'middle' });
    s.closeButton(324, 9, this.stateFor('close'));
    this.hits = [{ kind: 'close', rect: { x: 324, y: 9, width: 32, height: 32 } }];

    if (this.mainTab === 'friends') this.paintContacts();
    else if (this.mainTab === 'who') this.paintWho();
    else if (this.mainTab === 'guild') this.paintGuild();
    else this.paintRaid();
    this.paintMainTabs();
  }

  private paintContacts() {
    const s = this.surface;
    this.paintTopTab('friends', 'Friends', 70, this.contactTab === 'friends');
    this.paintTopTab('ignore', 'Ignore', 143, this.contactTab === 'ignore');
    const world = this.deps.getWorld();
    const rows = this.contactTab === 'friends'
      ? this.snapshot.friends.map((friend) => ({ guid: friend.guid, name: world?.getPlayerName(friend.guid)?.name ?? 'Retrieving character...', online: !!friend.status, detail: friend.status ? `Level ${friend.level} ${CLASS_NAMES[friend.classId] ?? ''}` : 'Offline' }))
      : this.snapshot.ignored.map((guid) => ({ guid, name: world?.getPlayerName(guid)?.name ?? 'Retrieving character...', online: false, detail: 'Ignored' }));
    this.prepareScroll(rows.length, 10);
    rows.slice(this.listScroll, this.listScroll + 10).forEach((row, index) => {
      const y = 81 + index * 30;
      const rect = { x: 31, y, width: 298, height: 29 };
      if (row.guid === this.selectedGuid || this.hover?.kind === 'row' && this.hover.value === row.guid) {
        s.image('/ui/Interface/FriendsFrame/UI-FriendsFrame-HighlightBar.png', rect.x, rect.y, rect.width, rect.height);
      }
      s.text(row.name, 41, y + 12, { size: 12, color: row.online ? '#ffd100' : '#888888' });
      s.text(row.detail, 41, y + 25, { size: 10, color: '#f1eee5' });
      this.hits.push({ kind: 'row', value: row.guid, rect });
    });
    if (!rows.length) s.text(this.contactTab === 'friends' ? 'You have no friends in your list.' : 'Your ignore list is empty.', 180, 238, { align: 'center', color: '#9a927f', size: 12 });
    const addRect = { x: 17, y: 384, width: 131, height: 21 };
    const removeRect = { x: 17, y: 410, width: 131, height: 21 };
    s.panelButton(this.contactTab === 'friends' ? 'Add Friend' : 'Ignore Player', addRect, this.buttonState('add'));
    s.panelButton(this.contactTab === 'friends' ? 'Remove Friend' : 'Stop Ignoring', removeRect, this.selectedGuid ? this.buttonState('remove') : 'disabled');
    this.hits.push({ kind: 'add', rect: addRect }, { kind: 'remove', rect: removeRect, disabled: !this.selectedGuid });
    // FriendsFrame.lua:138-145 enables both buttons only when the selected friend is CONNECTED,
    // and disables them entirely when the list is empty. The ignore list has no one to message.
    const selected = this.contactTab === 'friends' ? rows.find((row) => row.guid === this.selectedGuid) : undefined;
    const canContact = !!selected?.online;
    const targetName = canContact ? selected?.name : undefined;
    const messageRect = { x: 220, y: 384, width: 131, height: 21 };
    const inviteRect = { x: 220, y: 410, width: 131, height: 21 };
    s.panelButton('Send Message', messageRect, canContact ? this.buttonState('message') : 'disabled');
    s.panelButton('Group Invite', inviteRect, canContact ? this.buttonState('invite') : 'disabled');
    this.hits.push(
      { kind: 'message', rect: messageRect, value: targetName, disabled: !canContact },
      { kind: 'invite', rect: inviteRect, value: targetName, disabled: !canContact },
    );
    this.paintScrollBar();
  }

  private paintWho() {
    const s = this.surface;
    s.text('Name', 42, 67, { size: 11 });
    s.text('Level', 245, 67, { size: 11, align: 'center' });
    s.text('Class', 282, 67, { size: 11 });
    this.prepareScroll(this.snapshot.who.length, 17);
    this.snapshot.who.slice(this.listScroll, this.listScroll + 17).forEach((player, index) => {
      const y = 84 + index * 16;
      const rect = { x: 31, y: y - 12, width: 298, height: 16 };
      if (player.name === this.selectedWhoName || this.hover?.kind === 'whoRow' && this.hover.value === player.name) {
        s.image('/ui/Interface/FriendsFrame/UI-FriendsFrame-HighlightBar.png', rect.x, rect.y, rect.width, rect.height);
      }
      s.text(player.name, 41, y, { size: 11 });
      s.text(String(player.level), 245, y, { size: 11, color: '#fff', align: 'center' });
      s.text(CLASS_NAMES[player.classId] ?? '', 282, y, { size: 10, color: '#fff' });
      this.hits.push({ kind: 'whoRow', value: player.name, rect });
    });
    if (!this.snapshot.who.length) s.text('Searching for players...', 180, 238, { align: 'center', color: '#9a927f', size: 12 });
    const refreshRect = { x: 19, y: 408, width: 85, height: 22 };
    const addRect = { x: 104, y: 408, width: 120, height: 22 };
    const inviteRect = { x: 224, y: 408, width: 120, height: 22 };
    s.panelButton('Refresh', refreshRect, this.buttonState('whoRefresh'));
    s.panelButton('Add Friend', addRect, this.selectedWhoName ? this.buttonState('whoAdd') : 'disabled');
    s.panelButton('Group Invite', inviteRect, this.selectedWhoName ? this.buttonState('whoInvite') : 'disabled');
    this.hits.push(
      { kind: 'whoRefresh', rect: refreshRect },
      { kind: 'whoAdd', rect: addRect, value: this.selectedWhoName, disabled: !this.selectedWhoName },
      { kind: 'whoInvite', rect: inviteRect, value: this.selectedWhoName, disabled: !this.selectedWhoName },
    );
    this.paintScrollBar();
  }

  private paintGuild() {
    const s = this.surface;
    const members = this.snapshot.guild; this.prepareScroll(members.length, 13);
    if (!members.length) { s.text('You are not in a guild.', 180, 238, { align: 'center', color: '#9a927f', size: 12 }); this.paintScrollBar(); return; }
    const headers = this.guildPlayerStatus ? [['Name', 20, 83], ['Zone', 101, 105], ['Level', 204, 32], ['Class', 234, 92]] as const : [['Name', 20, 83], ['Rank', 101, 75], ['Note', 174, 75], ['Last Online', 247, 75]] as const;
    for (const [label, x, width] of headers) { s.sprite('/ui/Interface/FriendsFrame/WhoFrame-ColumnTabs.png', 0, 0, 64, 24, x, 70, width, 24); s.text(label, x + 8, 82, { size: 10, color: '#ffffff', baseline: 'middle', maxWidth: width - 10 }); }
    const rankNames = this.snapshot.guildRankNames; const visible = members.slice(this.listScroll, this.listScroll + 13);
    visible.forEach((member, index) => {
      const y = 95 + index * 16; const rect = { x: 15, y, width: 298, height: 16 }; const color = member.online ? '#ffffff' : '#777777';
      if (this.hover?.kind === 'guildRow' && this.hover.value === member.guid) s.image('/ui/Interface/FriendsFrame/UI-FriendsFrame-HighlightBar.png', rect.x, rect.y, rect.width, rect.height);
      s.text(member.name, 29, y + 9, { size: 10, color: member.online ? '#ffd100' : '#777777', maxWidth: this.guildPlayerStatus ? 78 : 70 });
      if (this.guildPlayerStatus) { s.text(this.deps.getAreaName?.(member.zoneId) ?? `Area ${member.zoneId}`, 110, y + 9, { size: 9, color, maxWidth: 92 }); s.text(String(member.level), 220, y + 9, { size: 9, color, align: 'center' }); s.text(CLASS_NAMES[member.classId] ?? '', 246, y + 9, { size: 9, color, maxWidth: 75 }); }
      else { s.text(rankNames[member.rankId] ?? DEFAULT_GUILD_RANK_NAMES[member.rankId] ?? `Rank ${member.rankId + 1}`, 109, y + 9, { size: 9, color, maxWidth: 62 }); s.text(member.note, 185, y + 9, { size: 9, color, maxWidth: 65 }); s.text(member.online ? 'Online' : formatGuildLastOnline(member.lastOnlineDays), 257, y + 9, { size: 9, color, maxWidth: 64 }); }
      this.hits.push({ kind: 'guildRow', rect, value: member.guid });
    });
    const online = members.filter((member) => member.online).length; s.text(`${members.length} Guild Member${members.length === 1 ? '' : 's'}  (${online} Online)`, 70, 331, { size: 10 });
    s.text('Message of the Day:', 23, 344, { size: 10 }); let motdY = 361; s.wrapText(this.snapshot.guildMotd || 'Click here to set a Guild Message.', 315, { size: 10 }).slice(0, 3).forEach((line) => { s.text(line, 23, motdY, { size: 10, color: '#ffffff' }); motdY += 13; });
    const self = members.find((member) => member.guid === this.deps.getPlayer?.()?.guid); const rights = self === undefined ? 0 : this.snapshot.guildRankRights[self.rankId] ?? 0;
    const canInvite = guildHasRight(rights, GUILD_RIGHTS.invite); const canMotd = guildHasRight(rights, GUILD_RIGHTS.setMotd); const canControl = self?.rankId === 0;
    const infoRect = { x: 16, y: 408, width: 123, height: 22 }; const addRect = { x: 141, y: 408, width: 98, height: 22 }; const controlRect = { x: 241, y: 408, width: 104, height: 22 };
    s.panelButton('Guild Information', infoRect, this.buttonState('guildInfo')); s.panelButton('Add Member', addRect, canInvite ? this.buttonState('guildAdd') : 'disabled'); s.panelButton('Guild Control', controlRect, canControl ? this.buttonState('guildControl') : 'disabled');
    this.hits.push({ kind: 'guildInfo', rect: infoRect }, { kind: 'guildAdd', rect: addRect, disabled: !canInvite }, { kind: 'guildControl', rect: controlRect, disabled: !canControl }, { kind: 'guildMotd', rect: { x: 23, y: 357, width: 315, height: 40 }, disabled: !canMotd });
    const toggleRect = { x: 245, y: 307, width: 100, height: 28 }; s.text(this.guildPlayerStatus ? 'Show Guild Status' : 'Show Player Status', 303, 321, { size: 9, align: 'right', baseline: 'middle', maxWidth: 95 }); s.image('/ui/Interface/Buttons/UI-SpellbookIcon-NextPage-Up.png', 313, 305, 32, 32); this.hits.push({ kind: 'guildToggle', rect: toggleRect });
    this.paintScrollBar();
  }

  private paintRaid() {
    const s = this.surface;
    const raid = (this.snapshot.groupType & 0x01) !== 0;
    this.listScroll = 0;
    this.listMaxScroll = 0;
    const world = this.deps.getWorld();
    if (!raid) {
      const rect = { x: 72, y: 37, width: 115, height: 21 };
      const enabled = !!world?.canConvertToRaid();
      s.panelButton('Convert To Raid', rect, enabled ? this.buttonState('convertRaid') : 'disabled');
      this.hits.push({ kind: 'convertRaid', rect, disabled: !enabled });
      let y = 85;
      RAID_DESCRIPTION.split('\n').forEach((paragraph, paragraphIndex) => {
        if (!paragraph) { y += 14; return; }
        s.wrapText(paragraph, 300, { size: 12 }).forEach((line) => {
          s.text(line, 29, y, { size: 12, color: paragraphIndex === 0 ? '#ffd100' : '#ffffff' }); y += 14;
        });
      });
      return;
    }

    const addRect = { x: 71, y: 37, width: 90, height: 21 };
    const canInvite = !!world?.canSetRaidTarget(); // UnitPopup.lua: leader or assistant.
    s.panelButton('Add Member', addRect, canInvite ? this.buttonState('raidAdd') : 'disabled');
    this.hits.push({ kind: 'raidAdd', rect: addRect, disabled: !canInvite });
    if (world?.canStartReadyCheck()) {
      const rect = { x: 163, y: 37, width: 90, height: 21 };
      s.panelButton('Ready Check', rect, this.buttonState('readyCheck'));
      this.hits.push({ kind: 'readyCheck', rect });
    }

    const members = this.raidMembers();
    const art = '/ui/Interface/RaidFrame';
    for (let subgroup = 0; subgroup < 8; subgroup++) {
      const x = 16 + (subgroup % 2) * 165;
      const y = 70 + Math.floor(subgroup / 2) * 94;
      s.sprite(`${art}/UI-RaidFrame-GroupOutline.png`, 0, 0, 170, 80, x, y, 162, 80);
      s.text(`Group ${subgroup + 1}`, x + 81, y - 7, { size: 11, align: 'center', baseline: 'middle' });
      const group = members.filter((member) => member.subgroup === subgroup).slice(0, 5);
      for (let slot = 0; slot < 5; slot++) {
        const rect = { x: x + 3, y: y + 3 + slot * 15, width: 156, height: 14 };
        const member = group[slot];
        const dragging = member?.guid === this.raidDrag?.guid;
        const pointed = this.hover?.subgroup === subgroup && this.hover?.slot === slot;
        if (member && !dragging) {
          s.sprite(`${art}/UI-RaidFrame-GroupButton.png`, 0, 0, 164, 14, rect.x, rect.y, rect.width, rect.height);
          if (pointed) s.sprite(`${art}/UI-RaidFrame-GroupButton.png`, 0, 15, 164, 14, rect.x, rect.y, rect.width, rect.height, { blend: 'lighter' });
          const color = member.online ? RAID_CLASS_COLORS[member.classId ?? 0] ?? '#ffd100' : '#777777';
          const rank = member.guid === this.snapshot.groupLeaderGuid ? '(L)' : member.assistant ? '(A)' : '';
          s.text(rank, rect.x + 1, rect.y + 8, { size: 10, color });
          s.text(member.name, rect.x + 21, rect.y + 8, { size: 10, color, maxWidth: 60 });
          s.text(member.level > 0 ? String(member.level) : '', rect.x + 98, rect.y + 8, { size: 10, color, align: 'center' });
          s.text(member.classId ? CLASS_NAMES[member.classId] ?? '' : '', rect.x + 110, rect.y + 8, { size: 10, color, maxWidth: 50 });
          this.hits.push({ kind: 'raidMember', rect, value: member.guid, subgroup, slot });
        } else {
          if (pointed && this.raidDrag) s.sprite(`${art}/UI-RaidFrame-GroupButton.png`, 0, 15, 164, 14, rect.x, rect.y, rect.width, rect.height, { blend: 'lighter' });
          s.text('Empty', rect.x + rect.width / 2, rect.y + 8, { size: 10, color: '#4b4b4b', align: 'center' });
          this.hits.push({ kind: 'raidSlot', rect, subgroup, slot });
        }
      }
    }
    this.paintRaidDrag(members);
  }

  private raidMembers(): RaidViewMember[] {
    const world = this.deps.getWorld();
    const members = this.snapshot.group.map((member): RaidViewMember => {
      const info = world?.getPlayerName(member.guid);
      const entity = world?.getEntity(member.guid);
      return { ...member, level: entity?.level ?? world?.getPartyVitals(member.guid)?.level ?? 0, classId: info?.classId ?? entity?.classId };
    });
    const self = this.deps.getPlayer?.();
    if (self && !members.some((member) => member.guid === self.guid)) {
      members.push({ ...self, online: true, subgroup: this.snapshot.ownSubgroup ?? 0, assistant: !!this.snapshot.ownAssistant });
    }
    return members;
  }

  private paintRaidDrag(members: readonly RaidViewMember[]) {
    if (!this.raidDrag) return;
    const member = members.find((entry) => entry.guid === this.raidDrag?.guid);
    if (!member) return;
    const x = Math.max(0, Math.min(this.surface.width - 156, this.raidDrag.x - 78));
    const y = Math.max(0, Math.min(this.surface.height - 14, this.raidDrag.y - 7));
    this.surface.sprite('/ui/Interface/RaidFrame/UI-RaidFrame-GroupButton.png', 0, 0, 164, 14, x, y, 156, 14, { alpha: 0.9 });
    this.surface.text(member.name, x + 21, y + 8, { size: 10, color: RAID_CLASS_COLORS[member.classId ?? 0] ?? '#ffd100', maxWidth: 100 });
  }

  private prepareScroll(total: number, visible: number) {
    this.listMaxScroll = Math.max(0, total - visible);
    this.listScroll = Math.max(0, Math.min(this.listMaxScroll, this.listScroll));
  }

  private paintScrollBar() {
    if (!this.listMaxScroll) return;
    const s = this.surface;
    const buttons = '/ui/Interface/Buttons';
    const upDisabled = this.listScroll <= 0;
    const downDisabled = this.listScroll >= this.listMaxScroll;
    s.image(`${buttons}/UI-ScrollBar-ScrollUpButton-${upDisabled ? 'Disabled' : this.pressed?.kind === 'scroll' && this.pressed.value === 'up' ? 'Down' : 'Up'}.png`, 326, 70, 32, 32);
    s.image(`${buttons}/UI-ScrollBar-ScrollDownButton-${downDisabled ? 'Disabled' : this.pressed?.kind === 'scroll' && this.pressed.value === 'down' ? 'Down' : 'Up'}.png`, 326, 342, 32, 32);
    const knobY = 106 + 218 * this.listScroll / Math.max(1, this.listMaxScroll);
    s.sprite(`${buttons}/UI-ScrollBar-Knob.png`, 8, 6, 16, 20, 334, knobY, 16, 24);
    this.hits.push(
      { kind: 'scroll', value: 'up', rect: { x: 330, y: 74, width: 24, height: 24 }, disabled: upDisabled },
      { kind: 'scroll', value: 'down', rect: { x: 330, y: 346, width: 24, height: 24 }, disabled: downDisabled },
    );
  }

  private paintTopTab(value: ContactTab, label: string, x: number, selected: boolean) {
    const rect = { x, y: 39, width: 73, height: 30 };
    this.surface.image(`/ui/Interface/FriendsFrame/${selected ? 'UI-FriendsFrameTab' : 'UI-FriendsFrameTab-InactiveTab'}.png`, rect.x, rect.y, rect.width, rect.height);
    this.surface.text(label, rect.x + rect.width / 2, rect.y + 16, { size: 12, align: 'center', baseline: 'middle' });
    this.hits.push({ kind: 'contact', value, rect });
  }

  private paintMainTabs() {
    MAIN_TABS.forEach(([value, label], index) => {
      const rect = { x: 15 + index * 76, y: 450, width: 83, height: 32 };
      this.surface.image(`/ui/Interface/PaperDollInfoFrame/UI-Character-${this.mainTab === value ? 'Active' : 'Inactive'}Tab.png`, rect.x, rect.y, rect.width, rect.height);
      this.surface.text(label, rect.x + rect.width / 2, rect.y + 17, { size: 10, align: 'center', baseline: 'middle' });
      this.hits.push({ kind: 'main', value, rect });
    });
  }

  private stateFor(kind: Hit['kind']): 'normal' | 'hover' | 'down' {
    if (this.pressed?.kind === kind) return 'down';
    if (this.hover?.kind === kind) return 'hover';
    return 'normal';
  }

  private buttonState(kind: Hit['kind']): 'normal' | 'hover' | 'down' { return this.stateFor(kind); }
  private hitAt(event: PointerEvent) { const p = this.surface.point(event); return this.hits.find((hit) => containsPoint(hit.rect, p)); }
  private onMove(event: PointerEvent) {
    this.hover = this.hitAt(event);
    if (this.raidDrag) { const point = this.surface.point(event); this.raidDrag = { ...this.raidDrag, x: point.x, y: point.y }; }
    this.surface.requestRender();
  }
  private onDown(event: PointerEvent) {
    if (event.button !== 0) return;
    this.pressed = this.hitAt(event);
    if (this.pressed?.kind === 'raidMember' && this.pressed.value && this.deps.getWorld()?.canManageRaidSubgroups()) {
      const point = this.surface.point(event);
      this.raidDrag = { guid: this.pressed.value, x: point.x, y: point.y };
      this.surface.canvas.setPointerCapture(event.pointerId);
    }
    // Only swallow presses on interactive hits; empty frame areas must bubble
    // to the host so installDraggableFrames can move the panel.
    if (this.pressed) {
      event.preventDefault();
      event.stopPropagation();
    }
    this.surface.requestRender();
  }
  private onUp(event: PointerEvent) {
    const hit = this.hitAt(event);
    const pressed = this.pressed;
    this.pressed = undefined;
    const drag = this.raidDrag;
    this.raidDrag = undefined;
    if (drag) {
      if (this.surface.canvas.hasPointerCapture(event.pointerId)) this.surface.canvas.releasePointerCapture(event.pointerId);
      const action = hit?.subgroup === undefined || hit.slot === undefined
        ? undefined : planRaidSubgroupDrop(this.raidMembers(), drag.guid, hit.subgroup, hit.slot);
      if (action?.kind === 'move') this.deps.getWorld()?.changeRaidSubgroup(action.name, action.subgroup);
      else if (action?.kind === 'swap') this.deps.getWorld()?.swapRaidSubgroups(action.name, action.swapWith);
      event.preventDefault(); event.stopPropagation(); this.surface.requestRender(); return;
    }
    if (!hit || !pressed || hit.kind !== pressed.kind || hit.value !== pressed.value || hit.disabled) { this.surface.requestRender(); return; }
    event.preventDefault();
    event.stopPropagation();
    if (hit.kind === 'close') this.setOpen(false);
    else if (hit.kind === 'contact') { this.contactTab = hit.value as ContactTab; this.selectedGuid = undefined; this.listScroll = 0; this.surface.requestRender(); }
    else if (hit.kind === 'main') {
      this.mainTab = hit.value as MainTab;
      this.guildAdmin.hide();
      this.listScroll = 0;
      this.selectedWhoName = undefined;
      if (this.mainTab === 'who') this.deps.getWorld()?.requestWho();
      if (this.mainTab === 'guild') this.deps.getWorld()?.requestGuildRoster();
      this.surface.requestRender();
    } else if (hit.kind === 'row') { this.selectedGuid = hit.value; this.surface.requestRender(); }
    else if (hit.kind === 'whoRow') { this.selectedWhoName = hit.value; this.surface.requestRender(); }
    else if (hit.kind === 'whoRefresh') this.deps.getWorld()?.requestWho();
    else if (hit.kind === 'whoAdd') { if (hit.value) this.deps.getWorld()?.addFriend(hit.value); }
    else if (hit.kind === 'whoInvite') { if (hit.value) this.deps.getWorld()?.inviteToParty(hit.value); }
    else if (hit.kind === 'add') this.addContact();
    else if (hit.kind === 'remove') this.removeContact();
    else if (hit.kind === 'message') { if (hit.value) this.deps.startWhisper?.(hit.value); }
    else if (hit.kind === 'invite') { if (hit.value) this.deps.getWorld()?.inviteToParty(hit.value); }
    else if (hit.kind === 'guildRow' && hit.value) this.guildAdmin.showMember(hit.value);
    else if (hit.kind === 'guildToggle') { this.guildPlayerStatus = !this.guildPlayerStatus; this.surface.requestRender(); }
    else if (hit.kind === 'guildControl') this.guildAdmin.toggleControl();
    else if (hit.kind === 'guildInfo') this.guildAdmin.toggleInfo();
    else if (hit.kind === 'guildAdd') this.openTextPrompt('Enter player name to invite', '', 48, (name) => this.deps.getWorld()?.guildInvite(name));
    else if (hit.kind === 'guildMotd') this.openTextPrompt('Set Guild Message of the Day:', this.snapshot.guildMotd, 128, (motd) => this.deps.getWorld()?.guildSetMotd(motd), true);
    else if (hit.kind === 'convertRaid') this.deps.getWorld()?.convertToRaid();
    else if (hit.kind === 'raidAdd') this.openNamePrompt('raid');
    else if (hit.kind === 'readyCheck') this.deps.getWorld()?.startReadyCheck();
    else if (hit.kind === 'scroll') {
      this.listScroll = Math.max(0, Math.min(this.listMaxScroll, this.listScroll + (hit.value === 'down' ? 1 : -1)));
      this.surface.requestRender();
    }
  }

  private addContact() {
    this.openNamePrompt(this.contactTab);
  }

  private openNamePrompt(kind: ContactTab | 'raid') {
    const label = kind === 'friends' ? 'Enter friend name' : kind === 'raid' ? 'Enter player name to invite' : 'Enter player name to ignore';
    this.openTextPrompt(label, '', 48, (name) => {
      if (kind === 'raid') this.deps.getWorld()?.inviteToParty(name);
      else if (kind === 'friends') this.deps.getWorld()?.addFriend(name);
      else this.deps.getWorld()?.addIgnore(name);
    });
  }

  private openTextPrompt(label: string, value: string, maxLength: number, submit: (value: string) => void, allowEmpty = false) {
    this.prompt = { label, maxLength, allowEmpty, submit };
    this.promptPressed = undefined;
    this.promptInput.maxLength = maxLength;
    this.promptInput.value = value;
    this.promptSurface.canvas.style.display = 'block';
    this.promptInput.style.display = 'block';
    this.surface.canvas.style.pointerEvents = 'none';
    this.guildAdmin.setPromptOpen(true);
    this.promptSurface.requestRender();
    requestAnimationFrame(() => { this.promptInput.focus(); this.promptInput.select(); });
  }

  private submitContactPrompt() {
    const value = this.promptInput.value;
    if (!this.prompt || !this.prompt.allowEmpty && !value.trim()) return;
    this.prompt.submit(value);
    this.deps.playUi('igMainMenuOptionCheckBoxOn');
    this.closeContactPrompt();
  }

  private closeContactPrompt() {
    if (!this.prompt) return;
    this.prompt = undefined;
    this.promptPressed = undefined;
    this.promptSurface.canvas.style.display = 'none';
    this.promptInput.style.display = 'none';
    this.surface.canvas.style.pointerEvents = 'auto';
    this.guildAdmin.setPromptOpen(false);
    this.surface.requestRender();
  }

  private paintPrompt() {
    const s = this.promptSurface;
    s.clear();
    drawEdgedBox(s, { x: 0, y: 0, width: 320, height: 130 }, DIALOG_EDGE);
    s.text(this.prompt?.label ?? '', 160, 29, {
      size: 12, color: '#ffffff', align: 'center', baseline: 'middle', maxWidth: 270,
    });
    const ctx = s.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.86)';
    ctx.fillRect(28, 51, 264, 26);
    ctx.strokeStyle = '#8c713f';
    ctx.strokeRect(28.5, 51.5, 263, 25);
    ctx.restore();
    s.panelButton('Okay', { x: 68, y: 91, width: 78, height: 22 }, this.promptPressed === 'ok' ? 'down' : 'normal');
    s.panelButton('Cancel', { x: 174, y: 91, width: 78, height: 22 }, this.promptPressed === 'cancel' ? 'down' : 'normal');
  }

  private promptHit(event: PointerEvent): 'ok' | 'cancel' | undefined {
    const point = this.promptSurface.point(event);
    if (containsPoint({ x: 68, y: 91, width: 78, height: 22 }, point)) return 'ok';
    if (containsPoint({ x: 174, y: 91, width: 78, height: 22 }, point)) return 'cancel';
    return undefined;
  }

  private onPromptDown(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.promptPressed = this.promptHit(event);
    this.promptSurface.requestRender();
  }

  private onPromptUp(event: PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    const hit = this.promptHit(event);
    const pressed = this.promptPressed;
    this.promptPressed = undefined;
    this.promptSurface.requestRender();
    if (!hit || hit !== pressed) return;
    if (hit === 'ok') this.submitContactPrompt();
    else {
      this.deps.playUi('igMainMenuOptionCheckBoxOff');
      this.closeContactPrompt();
    }
  }

  private removeContact() {
    if (!this.selectedGuid) return;
    if (this.contactTab === 'friends') this.deps.getWorld()?.removeFriend(this.selectedGuid);
    else this.deps.getWorld()?.removeIgnore(this.selectedGuid);
    this.selectedGuid = undefined;
    this.surface.requestRender();
  }
}
