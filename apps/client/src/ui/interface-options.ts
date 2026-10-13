/** Asset conversion utility. */
import { CanvasPanel, UI_GRAY, type PanelHit } from './panel-kit';
import { DIALOG_EDGE, drawEdgedBox } from './vanilla-canvas';
import {
  INTERFACE_CVAR_DEFAULTS,
  loadInterfaceCvars,
  saveInterfaceCvars,
  type InterfaceCvars,
} from './interface-cvars';

type ApplyReason = 'ok' | 'defaults' | 'initial';
type NumKey = keyof InterfaceCvars;

type Row =
  | { kind: 'check'; key: NumKey; label: string; indent?: number; disabled?: (c: InterfaceCvars) => boolean }
  | { kind: 'slider'; key: NumKey; label: string; min: number; max: number; step: number }
  | { kind: 'choice'; key: NumKey; label: string; values: string[] }
  | { kind: 'button'; id: string; label: string };

type Column = { x: number; rows: Row[] };
type Section = { label: string; x: number; y: number; columns: Column[] };
type TabDef = { id: 'basic' | 'advanced'; label: string; sections: Section[] };

const WIDTH = 864;
const HEADER_H = 46;
const TAB_Y = 44;
const FOOTER_H = 56;
const SECTION_GAP = 28;
const ROW_H = 24;
const SLIDER_H = 44;
const CHOICE_H = 40;
const BUTTON_H = 32;

const rowHeight = (row: Row): number =>
  row.kind === 'slider' ? SLIDER_H : row.kind === 'choice' ? CHOICE_H : row.kind === 'button' ? BUTTON_H : ROW_H;

const columnBottom = (section: Section, column: Column): number =>
  section.y + SECTION_GAP + column.rows.reduce((sum, row) => sum + rowHeight(row), 0);

const namesOff = (c: InterfaceCvars) => Number(c.UnitNamePlayer) !== 1;
const fctOff = (c: InterfaceCvars) => Number(c.enableFCT) !== 1;
const targetDamageOff = (c: InterfaceCvars) => Number(c.enableFCT) !== 1 || Number(c.fctTargetDamage) !== 1;
const unavailableInAlpha = () => true;

// Column x anchors for the wide three/four-column bands.
const C1 = 44;
const C2 = 340;
const C3 = 620;

const BASIC: TabDef = {
  id: 'basic',
  label: 'Basic',
  sections: [
    {
      label: 'Controls', x: 24, y: 64,
      columns: [
        { x: C1, rows: [
          { kind: 'slider', key: 'mousespeed', label: 'Mouse Sensitivity', min: 0.5, max: 1.5, step: 0.05 },
          { kind: 'check', key: 'autointeract', label: 'Click-to-Move' },
        ] },
        { x: 250, rows: [
          { kind: 'check', key: 'mouseInvertPitch', label: 'Invert Mouse' },
          { kind: 'choice', key: 'cameraSmoothTrackingStyle', label: 'Click-to-Move Camera Style', values: ['Smart', 'Locked', 'Never'] },
        ] },
        { x: 470, rows: [
          { kind: 'check', key: 'stickyTargeting', label: 'Sticky Targeting' },
          { kind: 'check', key: 'assistAttack', label: 'Attack on assist' },
          { kind: 'check', key: 'autoClearAFK', label: 'Auto Clear AFK' },
        ] },
        { x: 680, rows: [
          { kind: 'check', key: 'BlockTrades', label: 'Block Trades' },
          { kind: 'check', key: 'autoSelfCast', label: 'Auto Self Cast' },
        ] },
      ],
    },
    {
      label: 'Display', x: 24, y: 180,
      columns: [
        { x: C1, rows: [
          { kind: 'check', key: 'UberTooltips', label: 'Enhanced Tooltips' },
          { kind: 'check', key: 'statusBarText', label: 'Status Bar Text' },
          { kind: 'check', key: 'UnitNamePlayer', label: 'Player Names' },
          { kind: 'check', key: 'UnitNamePlayerGuild', label: 'Player Guild Names', indent: 14, disabled: namesOff },
          { kind: 'check', key: 'UnitNamePlayerPVPTitle', label: 'Player Titles', indent: 14, disabled: namesOff },
        ] },
        { x: C2, rows: [
          { kind: 'check', key: 'UnitNameNPC', label: 'NPC Names' },
          { kind: 'check', key: 'UnitNameOwn', label: 'Show Own Name' },
          { kind: 'check', key: 'showCloak', label: 'Show Cloak' },
          { kind: 'check', key: 'showHelm', label: 'Show Helm' },
          { kind: 'check', key: 'showPartyBackground', label: 'Show Party Background' },
        ] },
        { x: C3, rows: [
          { kind: 'check', key: 'instantQuestText', label: 'Instant Quest Text' },
          { kind: 'check', key: 'buffDurations', label: 'Buff Durations' },
          { kind: 'check', key: 'hideObjectiveTracker', label: 'Hide Zone Objective Tracker' },
          { kind: 'check', key: 'autoQuestWatch', label: 'Automatic Quest Tracking' },
          { kind: 'check', key: 'profanityFilter', label: 'Profanity Filter' },
        ] },
      ],
    },
    {
      label: 'Camera', x: 24, y: 344,
      columns: [
        { x: C1, rows: [
          { kind: 'choice', key: 'cameraSmoothStyle', label: 'Camera Following Style', values: ['Smart', 'Always', 'Never'] },
          { kind: 'check', key: 'cameraTerrainTilt', label: 'Follow Terrain' },
          { kind: 'check', key: 'cameraBobbing', label: 'Head Bob' },
        ] },
        { x: C2, rows: [
          { kind: 'slider', key: 'cameraYawSmoothSpeed', label: 'Auto-Follow Speed', min: 90, max: 270, step: 10 },
          { kind: 'check', key: 'cameraWaterCollision', label: 'Water Collision' },
          { kind: 'check', key: 'cameraPivot', label: 'Smart Pivot' },
        ] },
        { x: C3, rows: [
          { kind: 'slider', key: 'cameraYawMoveSpeed', label: 'Mouse Look Speed', min: 90, max: 270, step: 10 },
          { kind: 'slider', key: 'cameraDistanceMaxFactor', label: 'Max Camera Distance', min: 1, max: 2, step: 0.1 },
        ] },
      ],
    },
    {
      label: 'Help', x: 24, y: 476,
      columns: [
        { x: C1, rows: [
          { kind: 'check', key: 'showTutorials', label: 'Show Tutorials' },
          { kind: 'check', key: 'showLoadingScreenTips', label: 'Show Loading Screen Tips' },
        ] },
        { x: C2, rows: [{ kind: 'button', id: 'reset-tutorials', label: 'Reset Tutorials' }] },
        { x: 560, rows: [{ kind: 'check', key: 'detailedTooltips', label: 'Show Detailed Tooltips' }] },
      ],
    },
  ],
};

const ADVANCED: TabDef = {
  id: 'advanced',
  label: 'Advanced Options',
  sections: [
    {
      label: 'Action Bars', x: 24, y: 64,
      columns: [
        { x: C1, rows: [
          { kind: 'check', key: 'lockActionBars', label: 'Lock ActionBars' },
          { kind: 'check', key: 'showBottomLeftActionBar', label: 'Show Bottom Left ActionBar' },
        ] },
        { x: C2, rows: [
          { kind: 'check', key: 'alwaysShowActionBars', label: 'Always Show ActionBars' },
          { kind: 'check', key: 'showBottomRightActionBar', label: 'Show Bottom Right ActionBar' },
        ] },
        { x: C3, rows: [
          { kind: 'check', key: 'showRightActionBar', label: 'Show Right ActionBar', disabled: unavailableInAlpha },
          { kind: 'check', key: 'showRightActionBar2', label: 'Show Right ActionBar 2', disabled: unavailableInAlpha },
        ] },
      ],
    },
    {
      label: 'Chat', x: 24, y: 156,
      columns: [{ x: C1, rows: [
        { kind: 'check', key: 'simpleChat', label: 'Simple Chat' },
        { kind: 'check', key: 'chatLocked', label: 'Lock Chat Settings' },
        { kind: 'check', key: 'guildMemberNotify', label: 'Guild Member Alert' },
        { kind: 'check', key: 'removeChatDelay', label: 'Remove Chat Hover Delay' },
        { kind: 'check', key: 'chatBubbles', label: 'Show Chat Bubbles' },
        { kind: 'check', key: 'detailedLootInfo', label: 'Detailed Loot Information' },
        { kind: 'check', key: 'chatBubblesParty', label: 'Show Party Chat Bubbles' },
        { kind: 'check', key: 'autoJoinGuildRecruitment', label: 'Auto-join Guild Recruitment Channel' },
        { kind: 'check', key: 'disableSpamFilter', label: 'Disable Spam Filter' },
      ] }],
    },
    {
      label: 'Raid & Party', x: 300, y: 156,
      columns: [{ x: 320, rows: [
        { kind: 'check', key: 'hidePartyInRaid', label: 'Hide Party Interface in Raid' },
        { kind: 'check', key: 'showPartyPets', label: "Show Party Members' Pets" },
        { kind: 'check', key: 'showDispelDebuffs', label: 'Show Dispellable Debuffs' },
        { kind: 'check', key: 'showCastableBuffs', label: 'Show Castable Buffs' },
        { kind: 'check', key: 'showTargetOfTarget', label: 'Show Target of Target' },
        { kind: 'choice', key: 'targetOfTargetMode', label: '', values: ['Always', 'In Raids', 'Never'] },
      ] }],
    },
    {
      label: 'Floating Combat Text', x: 576, y: 156,
      columns: [{ x: 596, rows: [
        { kind: 'check', key: 'enableFCT', label: 'Enable Floating Combat Text' },
        { kind: 'choice', key: 'fctFloatMode', label: 'Combat Text Float Mode', values: ['Scroll Up', 'Scroll Down'] },
        { kind: 'check', key: 'fctLowManaHealth', label: 'Show Low Mana and Health', disabled: fctOff },
        { kind: 'check', key: 'fctAuras', label: 'Show Auras', disabled: fctOff },
        { kind: 'check', key: 'fctFadingAuras', label: 'Show Fading Auras', disabled: fctOff },
        { kind: 'check', key: 'fctCombatState', label: 'Show Combat State', disabled: fctOff },
        { kind: 'check', key: 'fctDodgeParryMiss', label: 'Show Dodge/Parries/Misses', disabled: fctOff },
        { kind: 'check', key: 'fctDamageReduction', label: 'Show Damage Reduction', disabled: fctOff },
        { kind: 'check', key: 'fctReputation', label: 'Show Reputation', disabled: fctOff },
        { kind: 'check', key: 'fctReactives', label: 'Show Reactive Spells and Abilities', disabled: fctOff },
        { kind: 'check', key: 'fctFriendlyHealers', label: 'Show Friendly Healer Names', disabled: fctOff },
        { kind: 'check', key: 'fctComboPoints', label: 'Show Combo Points', disabled: fctOff },
        { kind: 'check', key: 'fctEnergyGains', label: 'Show Energy Gains', disabled: fctOff },
        { kind: 'check', key: 'fctHonorGained', label: 'Show Honor Gained', disabled: fctOff },
        { kind: 'check', key: 'fctTargetDamage', label: 'Show Target Damage', disabled: fctOff },
        { kind: 'check', key: 'fctPeriodicDamage', label: 'Periodic Damage', indent: 16, disabled: targetDamageOff },
        { kind: 'check', key: 'fctPetDamage', label: 'Pet Damage', indent: 16, disabled: targetDamageOff },
      ] }],
    },
  ],
};

const TABS: TabDef[] = [BASIC, ADVANCED];

export type InterfaceOptionsCallbacks = {
  onApply?: (cvars: InterfaceCvars, reason: ApplyReason) => void;
  onClose: () => void;
  playUi?: (name: string) => boolean;
};

class InterfaceOptionsPanel extends CanvasPanel {
  private saved: InterfaceCvars = loadInterfaceCvars();
  private draft: InterfaceCvars = { ...this.saved };
  private tab: TabDef = BASIC;

  constructor(host: HTMLElement, private readonly cb: InterfaceOptionsCallbacks) {
    super(host, WIDTH, 640, 'wow-native-panel-canvas', { playUi: cb.playUi });
    this.onDrag = (hit, point) => {
      if (!hit.id.startsWith('slider:')) return;
      const row = hit.data as Extract<Row, { kind: 'slider' }>;
      const ratio = Math.max(0, Math.min(1, (point.x - hit.rect.x) / hit.rect.width));
      const raw = row.min + ratio * (row.max - row.min);
      const snapped = Math.round(raw / row.step) * row.step;
      (this.draft as Record<string, number | string>)[row.key] = Number(snapped.toFixed(4));
      this.cb.onApply?.(this.draft, 'initial');
      this.surface.requestRender();
    };
  }

  open() {
    this.saved = loadInterfaceCvars();
    this.draft = { ...this.saved };
    this.tab = BASIC;
    this.relayout();
  }

  cancel() {
    this.draft = { ...this.saved };
    this.cb.onApply?.(this.saved, 'initial');
  }

  private relayout() {
    let bottom = 0;
    for (const section of this.tab.sections) {
      for (const column of section.columns) bottom = Math.max(bottom, columnBottom(section, column));
    }
    this.surface.resize(WIDTH, bottom + FOOTER_H);
    this.surface.requestRender();
  }

  private num(key: NumKey): number { return Number(this.draft[key]); }
  private str(key: NumKey): string { return String(this.draft[key]); }

  protected paint() {
    const s = this.surface;
    const height = this.surface.canvas.height;
    s.clear();
    drawEdgedBox(s, { x: 0, y: 0, width: WIDTH, height }, DIALOG_EDGE);
    s.image('/ui/Interface/DialogFrame/UI-DialogBox-Header.png', WIDTH / 2 - 128, -6, 256, 64);
    s.text('Interface Options', WIDTH / 2, 21, { size: 13, align: 'center', baseline: 'middle' });

    this.paintTabs();

    for (const section of this.tab.sections) {
      this.paintSection(section);
      for (const column of section.columns) {
        let y = section.y + SECTION_GAP;
        for (const row of column.rows) {
          this.paintRow(row, column.x, y);
          y += rowHeight(row);
        }
      }
    }

    const footerY = height - 42;
    const defaultsRect = { x: 24, y: footerY, width: 110, height: 22 };
    const okRect = { x: WIDTH - 210, y: footerY, width: 88, height: 22 };
    const cancelRect = { x: WIDTH - 112, y: footerY, width: 88, height: 22 };
    s.panelButton('Defaults', defaultsRect, this.buttonState('footer:defaults'));
    s.panelButton('Okay', okRect, this.buttonState('footer:ok'));
    s.panelButton('Cancel', cancelRect, this.buttonState('footer:cancel'));
    this.hit('footer:defaults', defaultsRect);
    this.hit('footer:ok', okRect);
    this.hit('footer:cancel', cancelRect);
  }

  private paintTabs() {
    const s = this.surface;
    let x = 30;
    for (const tab of TABS) {
      const width = Math.round(s.measureText(tab.label, { size: 12 })) + 28;
      const rect = { x, y: TAB_Y, width, height: 24 };
      const active = tab.id === this.tab.id;
      s.panelButton(tab.label, rect, active ? 'down' : this.buttonState(`tab:${tab.id}`));
      if (active) {
        s.ctx.save();
        s.ctx.strokeStyle = '#ffd100';
        s.ctx.beginPath();
        s.ctx.moveTo(rect.x + 4, rect.y + rect.height);
        s.ctx.lineTo(rect.x + rect.width - 4, rect.y + rect.height);
        s.ctx.stroke();
        s.ctx.restore();
      }
      this.hit(`tab:${tab.id}`, rect, { data: tab });
      x += width + 8;
    }
  }

  private paintSection(section: Section) {
    const s = this.surface;
    s.text(section.label, section.x, section.y + 15, { size: 13, color: '#ffd100' });
    const lineY = section.y + 20;
    s.ctx.save();
    s.ctx.strokeStyle = 'rgba(255, 209, 0, 0.25)';
    s.ctx.beginPath();
    s.ctx.moveTo(section.x + s.measureText(section.label, { size: 13 }) + 10, lineY);
    s.ctx.lineTo(WIDTH - 24, lineY);
    s.ctx.stroke();
    s.ctx.restore();
  }

  private paintRow(row: Row, x: number, y: number) {
    if (row.kind === 'check') this.paintCheck(row, x, y);
    else if (row.kind === 'slider') this.paintSlider(row, x, y);
    else if (row.kind === 'choice') this.paintChoice(row, x, y);
    else this.paintButton(row, x, y);
  }

  private paintCheck(row: Extract<Row, { kind: 'check' }>, x: number, y: number) {
    const s = this.surface;
    const disabled = row.disabled?.(this.draft) ?? false;
    const bx = x + (row.indent ?? 0);
    const id = `check:${row.key}`;
    const boxY = y + 1;
    s.image(`/ui/Interface/Buttons/UI-CheckBox-${this.state(id) === 'down' && !disabled ? 'Down' : 'Up'}.png`, bx, boxY, 22, 22);
    if (this.num(row.key) === 1) s.image(`/ui/Interface/Buttons/UI-CheckBox-Check${disabled ? '-Disabled' : ''}.png`, bx, boxY, 22, 22);
    if (this.state(id) === 'hover' && !disabled) s.addImage('/ui/Interface/Buttons/UI-CheckBox-Highlight.png', bx, boxY, 22, 22, 0.7);
    s.text(row.label, bx + 26, y + 16, { size: 11, color: disabled ? UI_GRAY : '#ffd100', maxWidth: 236 });
    this.hit(id, { x: bx, y: boxY, width: 26 + s.measureText(row.label, { size: 11 }), height: 22 }, { data: row, disabled });
  }

  private paintSlider(row: Extract<Row, { kind: 'slider' }>, x: number, y: number) {
    const s = this.surface;
    const id = `slider:${row.key}`;
    s.text(row.label, x, y + 12, { size: 11, color: '#ffd100' });
    const track = { x, y: y + 20, width: 170, height: 12 };
    s.image('/ui/Interface/Buttons/UI-SliderBar-Background.png', track.x, track.y, track.width, track.height);
    drawEdgedBox(s, { x: track.x - 4, y: track.y - 4, width: track.width + 8, height: track.height + 8 }, {
      edgeFile: '/ui/Interface/Buttons/UI-SliderBar-Border.png', edgeSize: 8,
    });
    const ratio = Math.max(0, Math.min(1, (this.num(row.key) - row.min) / (row.max - row.min)));
    const knobX = track.x + ratio * track.width - 10;
    s.image('/ui/Interface/Buttons/UI-SliderBar-Button-Horizontal.png', knobX, track.y - 10, 20, 32);
    s.text('Low', track.x, y + 42, { size: 10, color: '#ffffff' });
    s.text('High', track.x + track.width, y + 42, { size: 10, color: '#ffffff', align: 'right' });
    this.hit(id, { x: track.x, y: track.y - 4, width: track.width, height: 20 }, { data: row });
  }

  private paintChoice(row: Extract<Row, { kind: 'choice' }>, x: number, y: number) {
    const s = this.surface;
    if (row.label) s.text(row.label, x, y + 11, { size: 11, color: '#ffd100' });
    const boxY = y + (row.label ? 15 : 4);
    const boxW = 148;
    const boxH = 22;
    s.ctx.save();
    s.ctx.fillStyle = 'rgba(0,0,0,0.55)';
    s.ctx.fillRect(x, boxY, boxW, boxH);
    s.ctx.strokeStyle = 'rgba(255,209,0,0.35)';
    s.ctx.strokeRect(x + 0.5, boxY + 0.5, boxW - 1, boxH - 1);
    s.ctx.restore();
    s.text(this.str(row.key), x + (boxW - 20) / 2, boxY + 15, { size: 12, align: 'center', color: '#ffffff' });
    const arrow = this.state(`choice:${row.key}`) === 'down' ? 'Down' : 'Up';
    s.image(`/ui/Interface/Buttons/UI-SpellbookIcon-NextPage-${arrow}.png`, x + boxW - 24, boxY - 2, 26, 26);
    this.hit(`choice:${row.key}`, { x, y: boxY, width: boxW, height: boxH }, { data: row });
  }

  private paintButton(row: Extract<Row, { kind: 'button' }>, x: number, y: number) {
    const rect = { x, y: y + 2, width: 120, height: 22 };
    this.surface.panelButton(row.label, rect, this.buttonState(`button:${row.id}`));
    this.hit(`button:${row.id}`, rect);
  }

  private buttonState(id: string): 'normal' | 'hover' | 'down' {
    const state = this.state(id);
    return state === 'disabled' ? 'normal' : state;
  }

  protected activate(hit: PanelHit) {
    if (hit.id.startsWith('tab:')) {
      const tab = hit.data as TabDef;
      if (tab.id !== this.tab.id) {
        this.tab = tab;
        this.playUi('igMainMenuOptionClick');
        this.relayout();
      }
      return;
    }
    if (hit.id.startsWith('footer:')) {
      this.playUi('igMainMenuOptionClick');
      const action = hit.id.slice(7);
      if (action === 'ok') {
        this.saved = { ...this.draft };
        saveInterfaceCvars(this.saved);
        this.cb.onApply?.(this.saved, 'ok');
        this.cb.onClose();
      } else if (action === 'cancel') {
        this.cancel();
        this.cb.onClose();
      } else {
        this.draft = { ...INTERFACE_CVAR_DEFAULTS };
        this.cb.onApply?.(this.draft, 'defaults');
        this.relayout();
      }
      return;
    }
    if (hit.id.startsWith('check:')) {
      const row = hit.data as Extract<Row, { kind: 'check' }>;
      const next = this.num(row.key) === 1 ? 0 : 1;
      (this.draft as Record<string, number | string>)[row.key] = next;
      this.playUi(next === 1 ? 'igMainMenuOptionCheckBoxOn' : 'igMainMenuOptionCheckBoxOff');
      this.cb.onApply?.(this.draft, 'initial');
      this.surface.requestRender();
      return;
    }
    if (hit.id.startsWith('choice:')) {
      const row = hit.data as Extract<Row, { kind: 'choice' }>;
      const index = Math.max(0, row.values.indexOf(this.str(row.key)));
      (this.draft as Record<string, number | string>)[row.key] = row.values[(index + 1) % row.values.length];
      this.playUi('igMainMenuOptionCheckBoxOn');
      this.cb.onApply?.(this.draft, 'initial');
      this.surface.requestRender();
      return;
    }
    if (hit.id === 'button:reset-tutorials') this.playUi('igMainMenuOptionClick');
  }
}

export type InterfaceOptions = { open: () => void; cancel: () => void };

export function createInterfaceOptions(host: HTMLElement, cb: InterfaceOptionsCallbacks): InterfaceOptions {
  const panel = new InterfaceOptionsPanel(host, cb);
  return { open: () => panel.open(), cancel: () => panel.cancel() };
}
