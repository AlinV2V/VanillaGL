import { TEXT_EMOTES } from '../data/emotes';
import { CHANNEL_STRINGS, CHAT_NOTICE, channelNotice } from '../data/chat-channels';
import type { ChannelNotifyEvent, CharacterInfo, ChatEvent } from '../world';
import { applyProfanityFilter } from './profanity-filter';
import {
  CHAT_MAX_LINES, CHAT_MENU_HEIGHT, CHAT_MENU_ITEMS, ChatFrameCanvas, ChatMenuCanvas,
  type ChatFrameTab, type ChatLine,
} from './chat-frame-canvas';

// Values verified against vMaNGOS SharedDefines.h (1.12.1): PARTY 0x01, RAID 0x02, GUILD 0x03,
// OFFICER 0x04, EMOTE 0x08, RAID_LEADER 0x57, RAID_WARNING 0x58.
const CHAT_TYPE = {
  SAY: 0x00,
  PARTY: 0x01,
  RAID: 0x02,
  GUILD: 0x03,
  OFFICER: 0x04,
  YELL: 0x05,
  WHISPER: 0x06,
  WHISPER_INFORM: 0x07,
  EMOTE: 0x08,
  SYSTEM: 0x0a,
  MONSTER_SAY: 0x0b,
  MONSTER_YELL: 0x0c,
  MONSTER_EMOTE: 0x0d,
  CHANNEL: 0x0e,
  RAID_WARNING: 0x58,
} as const;
/** Asset conversion utility. */
const CHANNEL_COMMANDS: Record<string, { type: number; whisper?: boolean }> = {
  s: { type: CHAT_TYPE.SAY }, say: { type: CHAT_TYPE.SAY },
  y: { type: CHAT_TYPE.YELL }, yell: { type: CHAT_TYPE.YELL },
  p: { type: CHAT_TYPE.PARTY }, party: { type: CHAT_TYPE.PARTY },
  ra: { type: CHAT_TYPE.RAID }, raid: { type: CHAT_TYPE.RAID },
  rw: { type: CHAT_TYPE.RAID_WARNING }, raidwarning: { type: CHAT_TYPE.RAID_WARNING },
  g: { type: CHAT_TYPE.GUILD }, guild: { type: CHAT_TYPE.GUILD },
  o: { type: CHAT_TYPE.OFFICER }, officer: { type: CHAT_TYPE.OFFICER },
  e: { type: CHAT_TYPE.EMOTE }, me: { type: CHAT_TYPE.EMOTE }, emote: { type: CHAT_TYPE.EMOTE },
  w: { type: CHAT_TYPE.WHISPER, whisper: true },
  whisper: { type: CHAT_TYPE.WHISPER, whisper: true },
  t: { type: CHAT_TYPE.WHISPER, whisper: true },
  tell: { type: CHAT_TYPE.WHISPER, whisper: true },
  send: { type: CHAT_TYPE.WHISPER, whisper: true },
};

/** SLASH_JOIN1..7 and SLASH_LEAVE1..7, GlobalStrings.lua:3043-3056. */
const JOIN_COMMANDS = new Set(['join', 'channel', 'chan']);
const LEAVE_COMMANDS = new Set(['leave', 'chatleave', 'chatexit']);
/** SLASH_CHANNEL1..4, GlobalStrings.lua:2879-2882 — `/c <channel> <text>`. */
const CHANNEL_SEND_COMMANDS = new Set(['c', 'csay']);

/**
 * Vanilla strips the zone suffix before printing a channel line:
 * `arg4 = gsub(arg4, "%s%-%s.*", "")` (ChatFrame.lua:1369-1372), so
 * "1. General - Zone_01" renders as "[1. General]". The pattern is
 * space-dash-space and everything after it, which is exactly what this regex reproduces.
 */
const stripZoneSuffix = (name: string) => name.replace(/\s-\s.*$/, '');

export type ChatUiElements = {
  chatBox: HTMLElement;
  chatMessages: HTMLElement;
  chatInput: HTMLInputElement;
};

export type ChatUiWorld = {
  getPlayerName(guid: string): { name: string } | undefined;
  sendChat(message: string, type?: number, targetOrChannel?: string): void;
  textEmote(textEmoteId: number, targetGuid?: string): void;
  initiateTrade(guid: string): void;
  inviteToParty(name: string): void;
  uninviteFromPartyByName(name: string): void;
  /** False when the name is not in our party, so the caller can print vanilla's error. */
  setPartyLeaderByName(name: string): boolean;
  guildInvite(name: string): void;
  guildPromote(name: string): void;
  guildDemote(name: string): void;
  guildRemove(name: string): void;
  guildLeave(): void;
  guildSetMotd(motd: string): void;
  guildInfo(): void;
  challengeDuel(targetGuid: string): void;
  cancelDuel(): void;
  inspect(targetGuid: string): void;
  joinChannel(name: string, password?: string): void;
  leaveChannel(name: string): void;
  /** 1-based slot for a channel name, 0 when not joined. */
  channelSlotFor(name: string): number;
  /** The channel in a 1-based slot — how `/1` resolves its target. */
  channelNameForSlot(slot: number): string | undefined;
  getJoinedChannels(): { slot: number; name: string }[];
  listChannel(name: string): void;
  randomRoll(minimum: number, maximum: number): void;
  requestPlayedTime(): void;
  togglePvp(enable?: boolean): void;
  startReadyCheck?(): void;
};

export type ChatUiDeps = {
  elements: ChatUiElements;
  getWorld: () => ChatUiWorld | undefined;
  getCurrentCharacter: () => CharacterInfo | undefined;
  getPlayerGuid: () => string | undefined;
  getSelectedTargetGuid?: () => string | undefined;
  /** Current target's name, used by /invite, /uninvite and /promote when given no argument. */
  getSelectedTargetName?: () => string | undefined;
};

/**
 * Vanilla `SlashCmdList` party commands and every alias GlobalStrings.lua ships for them:
 * INVITE /i /inv /invite, UNINVITE /u /un /uninvite /kick, PROMOTE /pr /promote.
 */
const PARTY_COMMANDS: Record<string, 'invite' | 'uninvite' | 'promote'> = {
  i: 'invite', inv: 'invite', invite: 'invite',
  u: 'uninvite', un: 'uninvite', uninvite: 'uninvite', kick: 'uninvite',
  pr: 'promote', promote: 'promote',
};

/**
 * Guild management aliases from GlobalStrings SLASH_GUILD_INVITE/PROMOTE/DEMOTE/UNINVITE/LEAVE/MOTD.
 * Note /g /gc /gu /guild are guild *chat* (handled by CHANNEL_COMMANDS); these are longer prefixes.
 */
const GUILD_COMMANDS: Record<string, 'invite' | 'promote' | 'demote' | 'remove' | 'leave' | 'motd' | 'info'> = {
  ginvite: 'invite', guildinvite: 'invite',
  gpromote: 'promote', guildpromote: 'promote',
  gdemote: 'demote', guilddemote: 'demote',
  gremove: 'remove', guildremove: 'remove',
  gquit: 'leave', guildquit: 'leave',
  gmotd: 'motd', guildmotd: 'motd',
  ginfo: 'info', guildinfo: 'info',
};

/** ChatFrame1 and ChatFrame2 are the two docked windows a fresh 1.12 profile starts with. */
const CHAT_TABS: ChatFrameTab[] = [{ id: 1, name: 'General' }, { id: 2, name: 'Combat Log' }];

/**
 * Per-channel text colour, mirroring the `.wow-chat-line--*` rules in `ingame-hud.css` so the canvas
 * and the (now hidden) DOM log cannot drift apart. These are the vanilla ChatTypeInfo colours.
 */
const CHAT_LINE_COLORS: Record<string, string> = {
  'wow-chat-line--say': '#ffffff',
  'wow-chat-line--channel': '#ffffff',
  'wow-chat-line--normal': '#ffffff',
  'wow-chat-line--yell': '#ff5050',
  'wow-chat-line--party': '#aaaaff',
  'wow-chat-line--whisper': '#ff80ff',
  'wow-chat-line--guild': '#40ff40',
  'wow-chat-line--officer': '#40c040',
  'wow-chat-line--raid': '#ff7f00',
  'wow-chat-line--raid-warning': '#ff4800',
  'wow-chat-line--emote': '#ff8040',
  'wow-chat-line--monster': '#ffff00',
  'wow-chat-line--system': '#ffff00',
};
/** Which tab a line lands on. Combat text is routed to ChatFrame2, everything else to ChatFrame1. */
const COMBAT_LINE_CLASSES = new Set(['wow-chat-line--combat', 'wow-chat-line--loot']);

export class ChatUiController {
  /** Last player whispered to or by, so `/r` can reply without retyping the name. */
  private lastWhisperTarget?: string;
  private readonly frame: ChatFrameCanvas;
  private readonly menu: ChatMenuCanvas;
  private lines: ChatLine[] = [];
  private activeTab = 1;
  private scrollOffset = 0;
  private editHeader = 'Say';
  /** Hidden routing prefix for a pre-addressed whisper; the canvas draws a friendly header instead. */
  private editCommandPrefix = '';
  /** Player chat packets wait here for the already-issued CMSG_NAME_QUERY response. */
  private readonly pendingNamedEvents = new Map<string, ChatEvent[]>();
  /** The frame is hidden outside the world; UIParent is not up on the glue screens. */
  private shown = false;

  constructor(private readonly deps: ChatUiDeps) {
    const { chatInput, chatBox, chatMessages } = deps.elements;

    this.frame = new ChatFrameCanvas({
      onActivate: (target) => {
        if (target.kind === 'tab') { this.activeTab = target.id; this.scrollOffset = 0; }
        else if (target.kind === 'scroll') this.scroll(target.direction);
        else if (target.kind === 'menu') this.toggleMenu();
        else if (target.kind === 'messages' || target.kind === 'edit') this.openInput();
        this.renderFrame();
      },
      onScrollWheel: (delta) => { this.scrollBy(delta * 3); },
    });
    chatBox.classList.add('has-canvas-ui');
    chatBox.appendChild(this.frame.canvas);

    this.menu = new ChatMenuCanvas((index) => this.pickChatType(index));
    chatBox.appendChild(this.menu.canvas);
    // ChatMenu is anchored BOTTOMLEFT@ChatFrameMenuButton TOPRIGHT (FloatingChatFrame.xml:772-774):
    // it rises from the bubble button's top-right corner.
    this.menu.canvas.style.left = '32px';
    this.menu.canvas.style.top = `${-CHAT_MENU_HEIGHT}px`;
    // Any click that is not on the menu closes it, as UIMenu does.
    document.addEventListener('pointerdown', (event) => {
      if (this.menu.open && event.target !== this.menu.canvas) this.menu.setOpen(false);
    }, true);
    // The invisible DOM input owns keyboard focus while the canvas draws the edit box. A world/UI
    // click outside ChatFrame must end that edit session; otherwise movement and action keys keep
    // appending to the hidden input even though the player plainly clicked back into the game.
    document.addEventListener('pointerdown', (event) => {
      const target = event.target;
      if (this.isInputOpen() && target instanceof Node && !chatBox.contains(target)) this.closeInput();
    }, true);
    // The DOM log is superseded by the canvas but stays in the tree: other code still queries it,
    // and `handleEvent` keeps writing to it so anything reading the log text is unaffected.
    chatMessages.style.display = 'none';
    // Keep the real <input> for keystrokes — it owns focus, IME and selection — but make it
    // invisible, because the canvas draws the text. `display:none` cannot hold focus, so it is
    // moved off-screen instead of hidden.
    chatInput.style.cssText = 'position:absolute;opacity:0;width:1px;height:1px;pointer-events:none;';

    chatInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.submitInput();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.closeInput();
      }
      requestAnimationFrame(() => this.renderFrame());
    });
    chatInput.addEventListener('input', () => this.renderFrame());
    // Heartbeat: blinks the caret while typing, and notices world entry/exit when no chat line has
    // arrived to trigger a render. `syncVisibility` returns true only on an actual change, so this
    // does not repaint four times a second for nothing.
    setInterval(() => {
      const changed = this.syncVisibility();
      if (changed || (this.shown && !chatInput.classList.contains('is-hidden'))) this.renderFrame();
    }, 250);
    this.frame.canvas.style.display = 'none';
    this.renderFrame();
  }

  private toggleMenu() {
    this.menu.setOpen(!this.menu.open);
  }

  /**
   * ChatMenu_SetChatType (ChatFrame.lua:2245-2251): open the edit box if it is closed, then set the
   * channel it will send to and refresh the header. Seeding the slash command does exactly that
   * through the parser `submitInput` already has, so `/p hello` and picking "Party Chat" agree.
   */
  private pickChatType(index: number) {
    const item = CHAT_MENU_ITEMS[index];
    this.menu.setOpen(false);
    if (!item || item.submenu || !item.slash) return;
    if (item.type === 'REPLY') {
      this.openInput(this.lastWhisperTarget ? `/w ${this.lastWhisperTarget} ` : '/r ');
      return;
    }
    this.openInput(item.type === 'SAY' ? '' : `${item.slash} `);
  }

  private scroll(direction: 'up' | 'down' | 'bottom') {
    if (direction === 'bottom') this.scrollOffset = 0;
    else this.scrollBy(direction === 'up' ? 1 : -1);
  }

  private scrollBy(delta: number) {
    const visible = this.frame.visibleLineCount();
    // Rendered rows, not messages: one long line can wrap to several, and clamping on the message
    // count would refuse to scroll to the top of a wrapped alert.
    const total = this.frame.wrappedRowCount(this.lines, this.activeTab);
    this.scrollOffset = Math.max(0, Math.min(Math.max(0, total - visible), this.scrollOffset + delta));
    this.renderFrame();
  }

  /**
   * The chat window belongs to UIParent, which does not exist on the glue screens — vanilla shows
   * no chat frame at the login or character-select screen. Presence of a world connection AND a
   * selected character is the equivalent test here.
   */
  private syncVisibility() {
    const inWorld = !!this.deps.getWorld() && !!this.deps.getCurrentCharacter();
    if (inWorld === this.shown) return false;
    this.shown = inWorld;
    this.frame.canvas.style.display = inWorld ? 'block' : 'none';
    if (!inWorld) this.menu.setOpen(false);
    return true;
  }

  private renderFrame() {
    const { chatInput } = this.deps.elements;
    this.syncVisibility();
    if (!this.shown) return;
    const editing = !chatInput.classList.contains('is-hidden');
    this.frame.setView({
      tabs: CHAT_TABS,
      activeTab: this.activeTab,
      lines: this.lines,
      scrollOffset: this.scrollOffset,
      editing,
      controlsVisible: editing,
      editText: chatInput.value,
      editHeader: this.editHeader,
      backgroundAlpha: editing ? 0.4 : 0,
    });
  }

  /**
   * SMSG_CHANNEL_NOTIFY. Vanilla renders these through `CHAT_<arg1>_NOTICE` with the channel name
   * as the single argument (ChatFrame.lua:1336-1338), and the strings themselves come from
   * GlobalStrings.lua. Notices with no vanilla string — join/leave announcements for other
   * players, moderation traffic — are dropped rather than invented, which is also what the stock
   * UI does for built-in channels: `m_announce = false` on every DBC channel
   * (vMaNGOS Chat/Channel.cpp:38), so they never arrive in the first place.
   */
  handleChannelNotify(event: ChannelNotifyEvent) {
    const line = (template: string) => channelNotice(template, event.channelName);
    switch (event.notice) {
      case CHAT_NOTICE.YOU_JOINED:
        this.appendLine(line(CHANNEL_STRINGS.YOU_JOINED), 'wow-chat-line--system');
        break;
      case CHAT_NOTICE.YOU_LEFT:
        this.appendLine(line(CHANNEL_STRINGS.YOU_LEFT), 'wow-chat-line--system');
        break;
      case CHAT_NOTICE.WRONG_PASSWORD:
        this.appendLine(line(CHANNEL_STRINGS.WRONG_PASSWORD), 'wow-chat-line--system');
        break;
      case CHAT_NOTICE.NOT_MEMBER:
        this.appendLine(line(CHANNEL_STRINGS.NOT_MEMBER), 'wow-chat-line--system');
        break;
      case CHAT_NOTICE.INVALID_NAME:
        this.appendLine(CHANNEL_STRINGS.INVALID_NAME, 'wow-chat-line--system');
        break;
      default:
        break;
    }
  }

  handleEvent(rawEvent: ChatEvent) {
    const senderGuid = rawEvent.senderGuid;
    const localName = senderGuid === this.deps.getPlayerGuid() ? this.deps.getCurrentCharacter()?.name : undefined;
    const knownName = rawEvent.senderName ?? localName
      ?? (senderGuid ? this.deps.getWorld()?.getPlayerName(senderGuid)?.name : undefined);
    if (senderGuid && senderGuid !== '0000000000000000' && !knownName) {
      const pending = this.pendingNamedEvents.get(senderGuid) ?? [];
      if (pending.length >= 32) pending.shift();
      pending.push(rawEvent);
      this.pendingNamedEvents.set(senderGuid, pending);
      return;
    }
    // Masked once here rather than at each per-channel appendLine below, so a new channel
    // case cannot accidentally bypass the filter.
    const event = applyProfanityFilter(knownName && !rawEvent.senderName ? { ...rawEvent, senderName: knownName } : rawEvent);
    const sender = this.nameFor(event);
    switch (event.type) {
      case CHAT_TYPE.SAY:
        this.appendLine(`${sender}: ${event.message}`, 'wow-chat-line--say');
        break;
      case CHAT_TYPE.YELL:
        this.appendLine(`${sender} yells: ${event.message}`, 'wow-chat-line--yell');
        break;
      case CHAT_TYPE.PARTY:
        this.appendLine(`[Party] ${sender}: ${event.message}`, 'wow-chat-line--party');
        break;
      case CHAT_TYPE.WHISPER:
        // Vanilla points /r at the most recent inbound whisper.
        if (sender) this.lastWhisperTarget = sender;
        this.appendLine(`${sender} whispers: ${event.message}`, 'wow-chat-line--whisper');
        break;
      case CHAT_TYPE.WHISPER_INFORM:
        this.appendLine(`To ${sender}: ${event.message}`, 'wow-chat-line--whisper');
        break;
      case CHAT_TYPE.GUILD:
        this.appendLine(`[Guild] ${sender}: ${event.message}`, 'wow-chat-line--guild');
        break;
      case CHAT_TYPE.OFFICER:
        this.appendLine(`[Officer] ${sender}: ${event.message}`, 'wow-chat-line--officer');
        break;
      case CHAT_TYPE.RAID:
        this.appendLine(`[Raid] ${sender}: ${event.message}`, 'wow-chat-line--raid');
        break;
      case CHAT_TYPE.RAID_WARNING:
        this.appendLine(`[Raid Warning] ${sender}: ${event.message}`, 'wow-chat-line--raid-warning');
        break;
      case CHAT_TYPE.EMOTE:
        // Custom /me emotes read as "Name does something" with no colon.
        this.appendLine(`${sender} ${event.message}`, 'wow-chat-line--emote');
        break;
      case CHAT_TYPE.CHANNEL: {
        // Vanilla builds "[N. Short] Sender: text" — the slot number comes from the client's own
        // channel list and the " - Zone" suffix is stripped (ChatFrame.lua:1369-1372). Printing
        // the raw wire name would show "[General - Zone_01]", which is not what the game
        // displays and gets unreadable in a city where every channel carries a long zone name.
        const wireName = event.channelName ?? '';
        const slot = wireName ? (this.deps.getWorld()?.channelSlotFor(wireName) ?? 0) : 0;
        const label = wireName ? stripZoneSuffix(wireName) : 'Channel';
        const prefix = slot > 0 ? `[${slot}. ${label}]` : `[${label}]`;
        this.appendLine(`${prefix} ${sender}: ${event.message}`, 'wow-chat-line--channel');
        break;
      }
      case CHAT_TYPE.MONSTER_SAY:
        this.appendLine(`${sender}: ${event.message}`, 'wow-chat-line--monster');
        break;
      case CHAT_TYPE.MONSTER_YELL:
        this.appendLine(`${sender} yells: ${event.message}`, 'wow-chat-line--monster');
        break;
      case CHAT_TYPE.MONSTER_EMOTE:
        this.appendLine(`${sender} ${event.message}`, 'wow-chat-line--monster');
        break;
      case CHAT_TYPE.SYSTEM:
        this.appendLine(event.message, 'wow-chat-line--system');
        break;
      default:
        this.appendLine(sender ? `${sender}: ${event.message}` : event.message);
        break;
    }
  }

  /** Push a system/notice line (guild events, errors) into the chat log. */
  system(text: string, className = 'wow-chat-line--system') {
    this.appendLine(text, className);
  }

  /** Flush chat packets that arrived before their asynchronous player-name response. */
  resolvePlayerName(guid: string, name: string) {
    const pending = this.pendingNamedEvents.get(guid);
    if (!pending?.length) return;
    this.pendingNamedEvents.delete(guid);
    for (const event of pending) this.handleEvent({ ...event, senderName: name });
  }

  openInput(seed = '') {
    const { chatInput } = this.deps.elements;
    const whisper = seed.match(/^\/w\s+(\S+)(?:\s+(.*))?$/i);
    this.editCommandPrefix = whisper ? `/w ${whisper[1]} ` : '';
    chatInput.value = whisper ? whisper[2] ?? '' : seed;
    chatInput.classList.remove('is-hidden');
    chatInput.focus();
    chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
    // ChatFrame.xml:61-68 — $parentHeader names the channel the message will go to.
    this.editHeader = whisper ? `To ${whisper[1]}` : seed.startsWith('/') ? '' : 'Say';
    this.renderFrame();
  }

  isInputOpen() {
    return !this.deps.elements.chatInput.classList.contains('is-hidden');
  }

  /** ChatFrameEditBox:Insert equivalent used by Shift-click item links. */
  insertInputText(text: string) {
    const input = this.deps.elements.chatInput;
    if (!text || !this.isInputOpen()) return false;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.setRangeText(text, start, end, 'end');
    this.renderFrame();
    return true;
  }

  closeInput() {
    const { chatInput } = this.deps.elements;
    chatInput.value = '';
    chatInput.classList.add('is-hidden');
    chatInput.blur();
    this.editHeader = 'Say';
    this.editCommandPrefix = '';
    this.renderFrame();
  }

  private nameFor(event: ChatEvent) {
    if (event.senderName) return event.senderName;
    if (event.senderGuid === this.deps.getPlayerGuid() && this.deps.getCurrentCharacter()) return this.deps.getCurrentCharacter()!.name;
    if (event.senderGuid) return this.deps.getWorld()?.getPlayerName(event.senderGuid)?.name ?? `Player-${event.senderGuid.slice(-4)}`;
    return '';
  }

  private appendLine(text: string, className = 'wow-chat-line--normal') {
    const { chatBox, chatMessages } = this.deps.elements;
    const line = document.createElement('div');
    line.className = `wow-chat-line ${className}`;
    line.textContent = text;
    chatMessages.appendChild(line);
    while (chatMessages.childElementCount > 80) chatMessages.firstElementChild?.remove();
    chatMessages.scrollTop = chatMessages.scrollHeight;
    chatBox.classList.add('has-lines');

    // ChatFrame.xml:4 — the ScrollingMessageFrame keeps 128 lines.
    this.lines.push({
      text,
      color: CHAT_LINE_COLORS[className] ?? '#ffffff',
      tab: COMBAT_LINE_CLASSES.has(className) ? 2 : 1,
    });
    if (this.lines.length > CHAT_MAX_LINES) this.lines.shift();
    // A new line while scrolled back must not yank the view to the bottom, matching vanilla.
    if (this.scrollOffset > 0) this.scrollOffset++;
    this.renderFrame();
  }

  private submitInput() {
    const raw = `${this.editCommandPrefix}${this.deps.elements.chatInput.value}`.trim();
    this.closeInput();
    const world = this.deps.getWorld();
    if (!raw || !world) return;
    if (raw.startsWith('/')) {
      const command = raw.slice(1).split(/\s+/, 1)[0].toLowerCase();
      const rest = raw.slice(1 + command.length).trim();

      // Chat channels. Vanilla dispatches these before the per-type prefixes because `/leave` is
      // a CHANNEL command here, not "leave party", and because `/1`..`/9` are parsed as a channel
      // number rather than as a slash name at all (ChatFrame.lua:1943-1953).
      if (JOIN_COMMANDS.has(command)) {
        const [name, password] = rest.split(/\s+/, 2);
        if (!name) {
          this.appendLine(`Usage: /${command} <channel> [password]`, 'wow-chat-line--system');
          return;
        }
        world.joinChannel(name, password ?? '');
        return;
      }
      if (LEAVE_COMMANDS.has(command)) {
        // `/leave 2` is as valid as `/leave General`; resolve a bare number through the slot list.
        const token = rest.split(/\s+/)[0] ?? '';
        const name = /^\d+$/.test(token) ? world.channelNameForSlot(Number(token)) : token;
        if (!name) {
          this.appendLine(`Usage: /${command} <channel>`, 'wow-chat-line--system');
          return;
        }
        world.leaveChannel(name);
        return;
      }
      if (command === 'chatlist' || command === 'chatwho' || command === 'chatinfo') {
        const token = rest.split(/\s+/)[0] ?? '';
        if (token) {
          const name = /^\d+$/.test(token) ? world.channelNameForSlot(Number(token)) : token;
          if (name) world.listChannel(name);
          else this.appendLine(channelNotice(CHANNEL_STRINGS.NOT_MEMBER, token), 'wow-chat-line--system');
          return;
        }
        const joined = world.getJoinedChannels();
        if (!joined.length) this.appendLine('You are not in any channels.', 'wow-chat-line--system');
        for (const entry of joined) {
          this.appendLine(`${entry.slot}. ${entry.name}`, 'wow-chat-line--system');
        }
        return;
      }
      // Blizzard_RaidUI's /readycheck calls DoReadyCheck(); the world layer enforces raid-leader
      // visibility/permission before sending the empty MSG_RAID_READY_CHECK request.
      if (command === 'readycheck') { world.startReadyCheck?.(); return; }
      if (CHANNEL_SEND_COMMANDS.has(command)) {
        const match = rest.match(/^(\S+)\s+([\s\S]+)$/);
        if (!match) {
          this.appendLine(`Usage: /${command} <channel> <message>`, 'wow-chat-line--system');
          return;
        }
        const target = /^\d+$/.test(match[1]) ? world.channelNameForSlot(Number(match[1])) : match[1];
        if (!target) {
          this.appendLine(channelNotice(CHANNEL_STRINGS.NOT_MEMBER, match[1]), 'wow-chat-line--system');
          return;
        }
        world.sendChat(match[2], CHAT_TYPE.CHANNEL, target);
        return;
      }
      if (/^\d+$/.test(command)) {
        const target = world.channelNameForSlot(Number(command));
        if (!target) {
          this.appendLine(channelNotice(CHANNEL_STRINGS.NOT_MEMBER, command), 'wow-chat-line--system');
          return;
        }
        if (!rest) return;
        world.sendChat(rest, CHAT_TYPE.CHANNEL, target);
        return;
      }

      // Channel prefixes (/p, /g, /o, /ra, /rw, /w, /e ...). Previously only /s and /y existed,
      // so party and whisper — the two the game is unplayable in a group without — fell through
      // to the emote lookup and printed "Unknown command".
      const channel = CHANNEL_COMMANDS[command];
      if (channel) {
        if (channel.whisper) {
          const match = rest.match(/^(\S+)\s+([\s\S]+)$/);
          if (!match) {
            this.appendLine(`Usage: /${command} <player> <message>`, 'wow-chat-line--system');
            return;
          }
          this.lastWhisperTarget = match[1];
          world.sendChat(match[2], CHAT_TYPE.WHISPER, match[1]);
          return;
        }
        if (!rest) return;
        world.sendChat(rest, channel.type);
        return;
      }

      // Party management (ChatFrame.lua:630-646). Note vanilla's /leave is a CHAT CHANNEL
      // command, not "leave party" — there is no party-leave slash command in 1.12.
      const partyCommand = PARTY_COMMANDS[command];
      if (partyCommand) {
        // GetSlashCmdTarget (ChatFrame.lua:607): first whitespace-delimited token, falling back
        // to the current target's name only when that target is a player.
        const name = rest.split(/\s+/)[0] || this.deps.getSelectedTargetName?.() || '';
        if (!name) {
          this.appendLine(`Usage: /${command} <player>`, 'wow-chat-line--system');
          return;
        }
        if (partyCommand === 'invite') world.inviteToParty(name);
        else if (partyCommand === 'uninvite') world.uninviteFromPartyByName(name);
        else if (!world.setPartyLeaderByName(name)) {
          this.appendLine(`${name} is not in your party.`, 'wow-chat-line--system');
        }
        return;
      }

      // Guild management (ChatFrame.lua). Aliases from GlobalStrings SLASH_GUILD_*. /gmotd takes
      // the whole rest of the line; the others take a single name (target fallback like /invite).
      const guildCommand = GUILD_COMMANDS[command];
      if (guildCommand) {
        if (guildCommand === 'info') { world.guildInfo(); return; }
        if (guildCommand === 'motd') { world.guildSetMotd(rest); return; }
        if (guildCommand === 'leave') { world.guildLeave(); return; }
        const name = rest.split(/\s+/)[0] || this.deps.getSelectedTargetName?.() || '';
        if (!name) { this.appendLine(`Usage: /${command} <player>`, 'wow-chat-line--system'); return; }
        if (guildCommand === 'invite') world.guildInvite(name);
        else if (guildCommand === 'promote') world.guildPromote(name);
        else if (guildCommand === 'demote') world.guildDemote(name);
        else if (guildCommand === 'remove') world.guildRemove(name);
        return;
      }

      // SLASH_RANDOM1..3 = /random, /rnd, /roll. `/roll` alone is 1-100; `/roll N` is 1-N;
      // `/roll A B` is A-B. The server rejects max > 10000 (GroupHandler.cpp:397) and broadcasts
      // the result to the party, so there is no local roll to print.
      if (command === 'roll' || command === 'random' || command === 'rnd') {
        const numbers = rest.split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite);
        const [minimum, maximum] = numbers.length >= 2
          ? [Math.floor(numbers[0]), Math.floor(numbers[1])]
          : numbers.length === 1 ? [1, Math.floor(numbers[0])] : [1, 100];
        if (minimum > maximum || maximum > 10000) {
          this.appendLine(`Usage: /${command} [min] [max]`, 'wow-chat-line--system');
          return;
        }
        world.randomRoll(minimum, maximum);
        return;
      }

      // SLASH_PLAYED1 = /played. Answered asynchronously with SMSG_PLAYED_TIME.
      if (command === 'played') { world.requestPlayedTime(); return; }

      // SLASH_PVP1 = /pvp. Empty body toggles the flag server-side.
      if (command === 'pvp') { world.togglePvp(); return; }

      // /inspect (SLASH_INSPECT: /inspect, /ins) inspects the current player target.
      if (command === 'inspect' || command === 'ins') {
        const guid = this.deps.getSelectedTargetGuid?.();
        const name = guid ? this.deps.getSelectedTargetName?.() : undefined;
        if (guid && name) world.inspect(guid);
        else this.appendLine('You have no target.', 'wow-chat-line--system');
        return;
      }

      // /duel challenges the current target (SLASH_DUEL). Vanilla requires a selected player.
      if (command === 'duel') {
        const guid = this.deps.getSelectedTargetGuid?.();
        const name = guid ? this.deps.getSelectedTargetName?.() : undefined;
        if (guid && name) world.challengeDuel(guid);
        else this.appendLine('You have no target.', 'wow-chat-line--system');
        return;
      }

      // Build 5875 ChatFrame.lua routes all three aliases through CancelDuel().
      if (command === 'forfeit' || command === 'concede' || command === 'yield') {
        world.cancelDuel();
        return;
      }

      // /r replies to the last whisper seen in either direction, matching vanilla.
      if (command === 'r' || command === 'reply') {
        if (!this.lastWhisperTarget) {
          this.appendLine('No one has whispered you yet.', 'wow-chat-line--system');
          return;
        }
        if (!rest) return;
        world.sendChat(rest, CHAT_TYPE.WHISPER, this.lastWhisperTarget);
        return;
      }

      // SOC-04: /dance, /wave, /bow... — every EmotesText.dbc command, sent as CMSG_TEXT_EMOTE
      // with the current selection so targeted lines ("You wave at X") resolve server-side.
      if (command === 'trade') {
        const targetGuid = this.deps.getSelectedTargetGuid?.();
        if (targetGuid) world.initiateTrade(targetGuid);
        else this.appendLine('Select a player before using /trade.', 'wow-chat-line--system');
        return;
      }
      const textEmoteId = TEXT_EMOTES[command];
      if (textEmoteId !== undefined) {
        world.textEmote(textEmoteId, this.deps.getSelectedTargetGuid?.());
      } else {
        this.appendLine(`Unknown command: /${command}`, 'wow-chat-line--system');
      }
    } else {
      world.sendChat(raw, CHAT_TYPE.SAY);
    }
  }
}
