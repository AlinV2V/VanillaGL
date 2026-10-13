/** Canvas transcription of FrameXML/UnitPopup.lua + UIDropDownMenuTemplates.xml (Build 5875). */
import { DIALOG_EDGE, drawEdgedBox, ensureVanillaFonts, VanillaCanvas } from './vanilla-canvas';
import { RAID_TARGET_ATLAS, RAID_TARGET_COLORS, RAID_TARGET_NAMES, raidTargetSource } from './raid-target-icons';
import { isDuelOpponent, type DuelReactionEntity } from './duel-reaction';

const ROW_HEIGHT = 16; // UIDROPDOWNMENU_BUTTON_HEIGHT
const BORDER_HEIGHT = 15; // UIDROPDOWNMENU_BORDER_HEIGHT
const SPACER = 6; // UNITPOPUP_SPACER_SPACING
const MIN_WIDTH = 128; // UIDropDownMenuButtonTemplate
const PADDING_X = 15;

type ActionId =
  | 'WHISPER' | 'INSPECT' | 'INVITE' | 'TRADE' | 'FOLLOW' | 'DUEL' | 'LEAVE' | 'CANCEL'
  | 'FORFEIT' | 'PROMOTE' | 'UNINVITE' | 'LOOT_PROMOTE' | 'LOOT_METHOD' | 'LOOT_THRESHOLD'
  | `LOOT_METHOD_${number}` | `LOOT_THRESHOLD_${number}`
  | 'RAID_TARGET_ICON' | 'RAID_TARGET_NONE' | `RAID_TARGET_${number}`;
type Row = {
  id?: ActionId;
  text: string;
  title?: boolean;
  spaceBefore?: boolean;
  submenu?: boolean;
  icon?: number;
  checked?: boolean;
  color?: string;
};

export type UnitPopupWorld = {
  getPlayerName(guid: string): { name: string; race?: number; gender?: number; classId?: number } | undefined;
  queryPlayerName(guid: string): void;
  initiateTrade?(guid: string): void;
  challengeDuel?(guid: string): void;
  inviteToParty?(name: string): void;
  inspect?(guid: string): void;
  leaveParty?(): void;
  cancelDuel?(): void;
  getEntity?(guid: string): DuelReactionEntity | undefined;
  getSocial?(): {
    group: Array<{ guid: string }>;
    groupLeaderGuid?: string;
    lootMethod?: number;
    looterGuid?: string;
    lootThreshold?: number;
  };
  setPartyLeader?(guid: string): void;
  uninviteFromParty?(guid: string): void;
  setLootMethod?(method: number, masterGuid: string, threshold: number): void;
  canSetRaidTarget?(): boolean;
  getRaidTargetIndex?(guid: string): number;
  setRaidTarget?(guid: string, uiIndex: number): void;
};

const EMPTY_GUID = '0000000000000000';
const LOOT_METHODS = ['Free for All', 'Round Robin', 'Master Looter', 'Group Loot', 'Need Before Greed'] as const;
const LOOT_THRESHOLDS = [
  { quality: 2, text: 'Uncommon', color: '#1eff00' },
  { quality: 3, text: 'Rare', color: '#0070dd' },
  { quality: 4, text: 'Epic', color: '#a335ee' },
] as const;

export function unitPopupPartyContext(world: UnitPopupWorld, playerGuid: string | undefined, guid: string) {
  const social = world.getSocial?.();
  const self = !!playerGuid && guid === playerGuid;
  const inParty = !!social?.group.some((member) => member.guid === guid);
  const isLeader = !!playerGuid && social?.groupLeaderGuid === playerGuid;
  const player = playerGuid ? world.getEntity?.(playerGuid) : undefined;
  const target = world.getEntity?.(guid);
  const playerInDuel = !!player?.duelArbiterGuid && !!player.duelTeam;
  const activeDuel = !self && isDuelOpponent(player, target);
  return { social, self, inParty, isLeader, playerInDuel, activeDuel };
}

/** Dispatch the server-owned party/duel commands exposed by this popup. */
export function dispatchPartyPopupAction(
  world: UnitPopupWorld,
  action: string,
  guid: string,
  playerGuid: string | undefined,
): boolean {
  const context = unitPopupPartyContext(world, playerGuid, guid);
  const threshold = context.social?.lootThreshold ?? 2;
  if (action === 'FORFEIT' && context.playerInDuel && (context.self || context.activeDuel)) { world.cancelDuel?.(); return true; }
  if (action === 'PROMOTE' && context.isLeader && context.inParty) { world.setPartyLeader?.(guid); return true; }
  if (action === 'UNINVITE' && context.isLeader && context.inParty) { world.uninviteFromParty?.(guid); return true; }
  if (action === 'LOOT_PROMOTE' && context.isLeader && context.inParty) { world.setLootMethod?.(2, guid, threshold); return true; }
  if (action.startsWith('LOOT_METHOD_') && context.isLeader && playerGuid) {
    const method = Number(action.slice('LOOT_METHOD_'.length));
    if (Number.isInteger(method) && method >= 0 && method <= 4) {
      world.setLootMethod?.(method, method === 2 ? playerGuid : EMPTY_GUID, threshold);
      return true;
    }
  }
  if (action.startsWith('LOOT_THRESHOLD_') && context.isLeader) {
    const quality = Number(action.slice('LOOT_THRESHOLD_'.length));
    if (Number.isInteger(quality) && quality >= 2 && quality <= 4) {
      world.setLootMethod?.(
        context.social?.lootMethod ?? 1,
        context.social?.looterGuid ?? EMPTY_GUID,
        quality,
      );
      return true;
    }
  }
  return false;
}

type UnitPopupConfig = {
  getWorld: () => UnitPopupWorld | undefined;
  getPlayerGuid: () => string | undefined;
  playUi?: (name: string) => unknown;
  startWhisper?: (name: string) => void;
};

class UnitPopup {
  private readonly surface = new VanillaCanvas(MIN_WIDTH, 64, 'wow-unit-popup-canvas');
  private readonly submenu = new VanillaCanvas(MIN_WIDTH, 64, 'wow-unit-popup-canvas wow-unit-popup-submenu');
  private rows: Row[] = [];
  private subRows: Row[] = [];
  private rowTops: number[] = [];
  private subTops: number[] = [];
  private guid = '';
  private hover = -1;
  private subHover = -1;
  private visible = false;
  private submenuVisible = false;
  private left = 0;
  private top = 0;

  constructor(private readonly config: UnitPopupConfig) {
    this.installCanvas(this.surface, 110);
    this.installCanvas(this.submenu, 111);
    this.surface.onRender(() => this.paintMenu(this.surface, this.rows, this.rowTops, this.hover, this.visible));
    this.submenu.onRender(() => this.paintMenu(this.submenu, this.subRows, this.subTops, this.subHover, this.submenuVisible));

    this.surface.canvas.addEventListener('pointermove', (event) => {
      const next = this.rowAt(this.surface, this.rows, this.rowTops, event);
      if (next !== this.hover) { this.hover = next; this.surface.requestRender(); }
      if (this.rows[next]?.submenu) this.showSubmenu(this.rows[next].id);
    });
    this.surface.canvas.addEventListener('pointerleave', () => { this.hover = -1; this.surface.requestRender(); });
    this.surface.canvas.addEventListener('pointerdown', (event) => event.stopPropagation());
    this.surface.canvas.addEventListener('pointerup', (event) => {
      event.stopPropagation();
      const row = this.rows[this.rowAt(this.surface, this.rows, this.rowTops, event)];
      if (row?.id) this.activate(row.id);
    });
    this.surface.canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    this.submenu.canvas.addEventListener('pointermove', (event) => {
      const next = this.rowAt(this.submenu, this.subRows, this.subTops, event);
      if (next !== this.subHover) { this.subHover = next; this.submenu.requestRender(); }
    });
    this.submenu.canvas.addEventListener('pointerleave', () => { this.subHover = -1; this.submenu.requestRender(); });
    this.submenu.canvas.addEventListener('pointerdown', (event) => event.stopPropagation());
    this.submenu.canvas.addEventListener('pointerup', (event) => {
      event.stopPropagation();
      const row = this.subRows[this.rowAt(this.submenu, this.subRows, this.subTops, event)];
      if (row?.id) this.activate(row.id);
    });
    this.submenu.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    document.addEventListener('pointerdown', () => this.hide());
    window.addEventListener('blur', () => this.hide());
    void ensureVanillaFonts().then(() => { this.surface.requestRender(); this.submenu.requestRender(); });
  }

  show(guid: string, clientX: number, clientY: number, raidTargetOnly = false) {
    const world = this.config.getWorld();
    if (!world || raidTargetOnly && !world.canSetRaidTarget?.()) return;
    const playerGuid = this.config.getPlayerGuid();
    const context = unitPopupPartyContext(world, playerGuid, guid);
    const { self } = context;
    const name = raidTargetOnly ? undefined : world.getPlayerName(guid)?.name;
    if (!raidTargetOnly && !name) world.queryPlayerName(guid);
    this.guid = guid;
    const marker = world.canSetRaidTarget?.() ? { id: 'RAID_TARGET_ICON' as const, text: 'Raid Target Icon', submenu: true } : undefined;
    const lootRows: Row[] = context.social?.group.length && context.isLeader
      ? [
          { id: 'LOOT_METHOD', text: LOOT_METHODS[context.social.lootMethod ?? 1] ?? 'Loot Method', submenu: true },
          { id: 'LOOT_THRESHOLD', text: `Loot Threshold: ${LOOT_THRESHOLDS.find((entry) => entry.quality === (context.social?.lootThreshold ?? 2))?.text ?? 'Uncommon'}`, submenu: true },
        ]
      : [];
    this.rows = raidTargetOnly
      ? this.raidTargetRows()
      : self
        ? [
            { text: name ?? 'Player', title: true },
            ...lootRows,
            ...(context.social?.group.length ? [{ id: 'LEAVE' as const, text: 'Leave Party' }] : []),
            ...(context.playerInDuel ? [{ id: 'FORFEIT' as const, text: 'Forfeit Duel', spaceBefore: true }] : []),
            ...(marker ? [marker] : []),
            { id: 'CANCEL', text: 'Cancel', spaceBefore: true },
          ]
        : context.inParty
          ? [
              { text: name ?? 'Unknown', title: true },
              ...(context.isLeader ? [
                { id: 'PROMOTE' as const, text: 'Promote to Leader' },
                ...(context.social?.lootMethod === 2 && context.social.looterGuid !== guid
                  ? [{ id: 'LOOT_PROMOTE' as const, text: 'Promote to Master Looter' }]
                  : []),
                { id: 'UNINVITE' as const, text: 'Uninvite' },
              ] : []),
              { id: 'WHISPER', text: 'Whisper' }, { id: 'INSPECT', text: 'Inspect' }, { id: 'TRADE', text: 'Trade' },
              { id: 'FOLLOW', text: 'Follow' },
              ...(context.activeDuel
                ? [{ id: 'FORFEIT' as const, text: 'Forfeit Duel', spaceBefore: true }]
                : [{ id: 'DUEL' as const, text: 'Duel', spaceBefore: true }]),
              ...(marker ? [marker] : []),
              { id: 'CANCEL', text: 'Cancel', spaceBefore: true },
            ]
          : [
              { text: name ?? 'Unknown', title: true },
              { id: 'WHISPER', text: 'Whisper' }, { id: 'INSPECT', text: 'Inspect' }, { id: 'INVITE', text: 'Invite' },
              { id: 'TRADE', text: 'Trade' }, { id: 'FOLLOW', text: 'Follow' },
              ...(context.activeDuel
                ? [{ id: 'FORFEIT' as const, text: 'Forfeit Duel', spaceBefore: true }]
                : [{ id: 'DUEL' as const, text: 'Duel', spaceBefore: true }]),
              ...(marker ? [marker] : []),
              { id: 'CANCEL', text: 'Cancel', spaceBefore: true },
            ];
    this.sizeMenu(this.surface, this.rows);
    this.left = Math.max(4, Math.min(window.innerWidth - this.surface.width - 4, clientX));
    this.top = Math.max(4, Math.min(window.innerHeight - this.surface.height - 4, clientY));
    Object.assign(this.surface.canvas.style, {
      display: 'block', transform: `translate(${Math.round(this.left)}px, ${Math.round(this.top)}px)`,
    });
    this.visible = true;
    this.hover = -1;
    this.hideSubmenu();
    this.surface.requestRender();
    this.config.playUi?.('igMainMenuOpen');
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.surface.canvas.style.display = 'none';
    this.hideSubmenu();
  }

  private installCanvas(surface: VanillaCanvas, zIndex: number) {
    Object.assign(surface.canvas.style, {
      position: 'fixed', left: '0', top: '0', zIndex: String(zIndex), display: 'none',
      pointerEvents: 'auto', transform: 'translate(0, 0)',
    });
    document.body.appendChild(surface.canvas);
  }

  private sizeMenu(surface: VanillaCanvas, rows: Row[]) {
    let width = MIN_WIDTH;
    for (const row of rows) {
      const extras = row.icon ? 20 : 0;
      width = Math.max(width, Math.ceil(surface.measureText(row.text, { size: 12 })) + PADDING_X * 2 + extras + (row.submenu ? 14 : 0));
    }
    let height = BORDER_HEIGHT * 2;
    for (const row of rows) height += ROW_HEIGHT + (row.spaceBefore ? SPACER : 0);
    surface.resize(width, height);
  }

  private raidTargetRows(): Row[] {
    const selected = this.config.getWorld()?.getRaidTargetIndex?.(this.guid) ?? 0;
    return [
      ...RAID_TARGET_NAMES.map((text, index) => ({
        id: `RAID_TARGET_${index + 1}` as ActionId, text, icon: index + 1,
        checked: selected === index + 1, color: RAID_TARGET_COLORS[index],
      })),
      { id: 'RAID_TARGET_NONE' as const, text: 'None', checked: selected === 0 },
    ];
  }

  private showSubmenu(action?: ActionId) {
    const world = this.config.getWorld();
    if (!this.visible || !world) return;
    if (action === 'RAID_TARGET_ICON') {
      if (!world.canSetRaidTarget?.()) return;
      this.subRows = this.raidTargetRows();
    } else if (action === 'LOOT_METHOD') {
      const selected = world.getSocial?.().lootMethod ?? 1;
      this.subRows = LOOT_METHODS.map((text, method) => ({
        id: `LOOT_METHOD_${method}` as ActionId,
        text,
        checked: selected === method,
      }));
    } else if (action === 'LOOT_THRESHOLD') {
      const selected = world.getSocial?.().lootThreshold ?? 2;
      this.subRows = LOOT_THRESHOLDS.map(({ quality, text, color }) => ({
        id: `LOOT_THRESHOLD_${quality}` as ActionId,
        text,
        color,
        checked: selected === quality,
      }));
    } else return;
    this.sizeMenu(this.submenu, this.subRows);
    const parent = Math.max(0, this.rows.findIndex((row) => row.id === action));
    const left = Math.max(4, Math.min(window.innerWidth - this.submenu.width - 4, this.left + this.surface.width - 4));
    const top = Math.max(4, Math.min(window.innerHeight - this.submenu.height - 4, this.top + (this.rowTops[parent] ?? BORDER_HEIGHT) - BORDER_HEIGHT));
    Object.assign(this.submenu.canvas.style, {
      display: 'block', transform: `translate(${Math.round(left)}px, ${Math.round(top)}px)`,
    });
    this.submenuVisible = true;
    this.subHover = -1;
    this.submenu.requestRender();
  }

  private hideSubmenu() {
    this.submenuVisible = false;
    this.submenu.canvas.style.display = 'none';
  }

  private paintMenu(surface: VanillaCanvas, rows: Row[], tops: number[], hover: number, visible: boolean) {
    if (!visible) return;
    surface.clear();
    drawEdgedBox(surface, { x: 0, y: 0, width: surface.width, height: surface.height }, DIALOG_EDGE);
    tops.length = 0;
    let y = BORDER_HEIGHT;
    rows.forEach((row, index) => {
      if (row.spaceBefore) y += SPACER;
      tops.push(y);
      if (index === hover && !row.title) {
        surface.ctx.save(); surface.ctx.globalCompositeOperation = 'lighter';
        surface.image('/ui/Interface/QuestFrame/UI-QuestTitleHighlight.png', 10, y, surface.width - 20, ROW_HEIGHT);
        surface.ctx.restore();
      }
      let textX = row.title ? surface.width / 2 : PADDING_X;
      if (row.icon) {
        const icon = raidTargetSource(row.icon);
        surface.sprite(RAID_TARGET_ATLAS, icon.x, icon.y, icon.w, icon.h, PADDING_X, y, ROW_HEIGHT, ROW_HEIGHT);
        textX += 20;
      }
      if (row.checked) surface.text('✓', surface.width - 17, y + ROW_HEIGHT / 2, { size: 12, color: '#ffd100', align: 'center', baseline: 'middle' });
      if (row.submenu) surface.text('▶', surface.width - 14, y + ROW_HEIGHT / 2, { size: 9, color: '#ffd100', align: 'center', baseline: 'middle' });
      surface.text(row.text, textX, y + ROW_HEIGHT / 2, {
        size: 12, color: row.title ? '#ffd100' : row.color ?? '#ffffff',
        align: row.title ? 'center' : 'left', baseline: 'middle',
      });
      y += ROW_HEIGHT;
    });
  }

  private rowAt(surface: VanillaCanvas, rows: Row[], tops: number[], event: PointerEvent) {
    const point = surface.point(event);
    return tops.findIndex((top, index) => !!rows[index]?.id && point.y >= top && point.y < top + ROW_HEIGHT);
  }

  private activate(action: ActionId) {
    const world = this.config.getWorld();
    const guid = this.guid;
    const name = world?.getPlayerName(guid)?.name;
    if (action === 'RAID_TARGET_ICON' || action === 'LOOT_METHOD' || action === 'LOOT_THRESHOLD') { this.showSubmenu(action); return; }
    this.hide();
    if (!world || action === 'CANCEL') return;
    if (dispatchPartyPopupAction(world, action, guid, this.config.getPlayerGuid())) {
      this.config.playUi?.('igChatScrollButton');
    } else if (action.startsWith('RAID_TARGET_')) {
      const uiIndex = action === 'RAID_TARGET_NONE' ? 0 : Number(action.slice('RAID_TARGET_'.length));
      world.setRaidTarget?.(guid, uiIndex);
      this.config.playUi?.('igChatScrollButton');
    } else if (action === 'TRADE') world.initiateTrade?.(guid);
    else if (action === 'WHISPER' && name) this.config.startWhisper?.(name);
    else if (action === 'DUEL') world.challengeDuel?.(guid);
    else if (action === 'INVITE' && name) world.inviteToParty?.(name);
    else if (action === 'INSPECT') world.inspect?.(guid);
    else if (action === 'LEAVE') world.leaveParty?.();
    else if (action === 'FOLLOW') window.dispatchEvent(new CustomEvent('wow-follow-unit', { detail: { guid } }));
  }
}

let popup: UnitPopup | undefined;

/** Install once from the unit-frame controller; world picking reuses the same popup. */
export function installUnitPopup(config: UnitPopupConfig) { popup ??= new UnitPopup(config); }

export function showUnitPopup(guid: string, clientX: number, clientY: number, raidTargetOnly = false) {
  popup?.show(guid, clientX, clientY, raidTargetOnly);
}
