import { CombatLogHistory } from './combat-log-history';
import {
  formatDeath,
  formatMeleeDamage,
  formatPeriodicAura,
  formatSpellDamage,
  formatSpellEnergize,
  formatSpellHeal,
  formatSpellMiss,
  formatXpGain,
  type CombatLogLine,
} from './combat-log-format';
/** Asset conversion utility. */
/** ChatFrame2 geometry, in UIParent units. */
const FRAME = { width: 320, height: 120, offsetX: -32, offsetY: 75 } as const;
/** CombatLogButtons, in UIParent units. */
const BUTTONS = { anchorX: -32, anchorY: 60, size: 32, bottomOffsetX: 32, bottomOffsetY: 36 } as const;
/** Vanilla keeps 128 lines of scrollback per chat frame (FCF default numMessages). */
const MAX_LINES = 128;
/** One click scrolls three lines; a right click pages by the visible line count. */
const SCROLL_STEP = 3;

export interface CombatLogDeps {
  /** Resolve a unit GUID to its display name; undefined while the name query is in flight. */
  resolveName: (guid: string) => string | undefined;
  /** Spell.dbc name for a spell id. */
  resolveSpellName: (spellId: number) => string | undefined;
  /** The local player's GUID, for the SELF/OTHER split the whole string table turns on. */
  getPlayerGuid: () => string | undefined;
  playUi?: (name: string) => void;
}

export class CombatLogController {
  private readonly root: HTMLDivElement;
  private readonly messages: HTMLDivElement;
  private readonly buttons: HTMLDivElement;
  private readonly lines = new CombatLogHistory<CombatLogLine>(MAX_LINES);
  private scrollOffset = 0;
  private visible = false;

  constructor(private readonly deps: CombatLogDeps, parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    // VanillaGL keeps the optional, locked ChatFrame2 hidden on login/new characters. The
    // TOGGLECOMBATLOG binding can reveal it without making every fresh character start with a
    // large combat transcript over the world view.
    this.root.className = 'wow-combat-log is-hidden';
    this.root.style.setProperty('--combat-log-width', `${FRAME.width}px`);
    this.root.style.setProperty('--combat-log-height', `${FRAME.height}px`);
    this.root.style.setProperty('--combat-log-right', `${-FRAME.offsetX}px`);
    this.root.style.setProperty('--combat-log-bottom', `${FRAME.offsetY}px`);

    this.messages = document.createElement('div');
    this.messages.className = 'wow-combat-log-messages';
    this.root.appendChild(this.messages);

    this.buttons = document.createElement('div');
    this.buttons.className = 'wow-combat-log-buttons is-hidden';
    this.buttons.style.setProperty('--combat-log-button-size', `${BUTTONS.size}px`);
    this.buttons.style.setProperty('--combat-log-buttons-right', `${-BUTTONS.anchorX - BUTTONS.bottomOffsetX}px`);
    this.buttons.style.setProperty('--combat-log-buttons-bottom', `${BUTTONS.anchorY + BUTTONS.bottomOffsetY}px`);
    // Stacked bottom-to-top exactly as CombatLog.xml anchors them: Bottom, then Down above it,
    // then Up above that.
    for (const [id, label, title] of [
      ['bottom', '⤓', 'Scroll to bottom'],
      ['down', '▼', 'Scroll down (right click: page)'],
      ['up', '▲', 'Scroll up (right click: page)'],
    ] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `wow-combat-log-button wow-combat-log-button--${id}`;
      button.textContent = label;
      button.title = title;
      button.addEventListener('click', () => this.onButton(id, false));
      button.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.onButton(id, true);
      });
      this.buttons.appendChild(button);
    }
    this.root.appendChild(this.buttons);
    parent.appendChild(this.root);
  }

  /** CombatLog.lua ToggleCombatLog: frame and buttons show and hide together. */
  toggle(): boolean {
    this.setVisible(!this.visible);
    return this.visible;
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.root.classList.toggle('is-hidden', !visible);
    this.buttons.classList.toggle('is-hidden', !visible);
    if (visible) this.render();
    this.deps.playUi?.(visible ? 'igCharacterInfoOpen' : 'igCharacterInfoClose');
  }

  isVisible() {
    return this.visible;
  }

  /** Exposed for the gate and for tests; the newest line is last. */
  getLines(): readonly CombatLogLine[] {
    return this.lines.toArray();
  }

  private onButton(id: 'bottom' | 'down' | 'up', page: boolean) {
    const step = page ? this.visibleLineCount() : SCROLL_STEP;
    if (id === 'bottom') this.scrollOffset = 0;
    else if (id === 'down') this.scrollOffset = Math.max(0, this.scrollOffset - step);
    else this.scrollOffset = Math.min(Math.max(0, this.lines.length - this.visibleLineCount()), this.scrollOffset + step);
    this.deps.playUi?.('igChatScrollUp');
    this.render();
  }

  private visibleLineCount() {
    // 14px line-height inside a 120-unit frame, matching the chat box's own metrics.
    return Math.max(1, Math.floor(FRAME.height / 14));
  }

  push(line: CombatLogLine | null) {
    if (!line) return;
    this.lines.push(line);
    // Vanilla keeps a scrolled-back frame where the reader left it rather than yanking to the end.
    if (this.scrollOffset > 0) this.scrollOffset = Math.min(this.scrollOffset + 1, Math.max(0, this.lines.length - this.visibleLineCount()));
    if (this.visible) this.render();
  }

  private render() {
    const count = this.visibleLineCount();
    const end = Math.max(0, this.lines.length - this.scrollOffset);
    const start = Math.max(0, end - count), length = end - start;
    while (this.messages.children.length > length) this.messages.lastElementChild?.remove();
    for (let i = 0; i < length; i++) {
      const line = this.lines.at(start + i);
      let el = this.messages.children[i] as HTMLDivElement | undefined;
      if (!el) { el = document.createElement('div'); this.messages.appendChild(el); }
      const className = `wow-combat-log-line wow-combat-log-line--${line.channel.toLowerCase().replace(/_/g, '-')}`;
      if (el.className !== className) el.className = className;
      if (el.textContent !== line.text) el.textContent = line.text;
    }
  }

  // ------------------------------------------------------------------ packet -> line adapters

  private name(guid: string | undefined): string {
    if (!guid) return 'Unknown';
    return this.deps.resolveName(guid) ?? 'Unknown';
  }

  private spell(spellId: number): string {
    return this.deps.resolveSpellName(spellId) ?? `Spell ${spellId}`;
  }

  private isPlayer(guid: string | undefined): boolean {
    const self = this.deps.getPlayerGuid();
    return Boolean(self && guid === self);
  }

  handleMeleeDamage(e: { attackerGuid: string; victimGuid: string; hitInfo: number; totalDamage: number; school: number; absorb: number; targetState: number }) {
    this.push(
      formatMeleeDamage({
        sourceName: this.name(e.attackerGuid),
        targetName: this.name(e.victimGuid),
        sourceIsPlayer: this.isPlayer(e.attackerGuid),
        targetIsPlayer: this.isPlayer(e.victimGuid),
        hitInfo: e.hitInfo,
        totalDamage: e.totalDamage,
        school: e.school,
        absorb: e.absorb,
        targetState: e.targetState,
      }),
    );
  }

  handleSpellDamage(e: { attackerGuid: string; targetGuid: string; spellId: number; damage: number; school: number; absorb: number; hitInfo: number; periodic: boolean }) {
    if (e.periodic) return; // SMSG_PERIODICAURALOG already logs the tick.
    this.push(
      formatSpellDamage({
        sourceName: this.name(e.attackerGuid),
        targetName: this.name(e.targetGuid),
        sourceIsPlayer: this.isPlayer(e.attackerGuid),
        targetIsPlayer: this.isPlayer(e.targetGuid),
        spellName: this.spell(e.spellId),
        damage: e.damage,
        school: e.school,
        absorb: e.absorb,
        // SpellHitType bit 0x02 is the crit flag on SMSG_SPELLNONMELEEDAMAGELOG.
        critical: (e.hitInfo & 0x02) !== 0,
      }),
    );
  }

  handleSpellMiss(e: { casterGuid: string; targetGuid: string; spellId: number; missInfo: number }) {
    this.push(
      formatSpellMiss({
        sourceName: this.name(e.casterGuid),
        targetName: this.name(e.targetGuid),
        sourceIsPlayer: this.isPlayer(e.casterGuid),
        targetIsPlayer: this.isPlayer(e.targetGuid),
        spellName: this.spell(e.spellId),
        missInfo: e.missInfo,
      }),
    );
  }

  handleSpellHeal(e: { healerGuid: string; targetGuid: string; spellId: number; amount: number; critical: boolean }) {
    this.push(
      formatSpellHeal({
        sourceName: this.name(e.healerGuid),
        targetName: this.name(e.targetGuid),
        sourceIsPlayer: this.isPlayer(e.healerGuid),
        targetIsPlayer: this.isPlayer(e.targetGuid),
        spellName: this.spell(e.spellId),
        amount: e.amount,
        critical: e.critical,
      }),
    );
  }

  handleSpellEnergize(e: { casterGuid: string; targetGuid: string; spellId: number; powerType: number; amount: number }) {
    this.push(
      formatSpellEnergize({
        sourceName: this.name(e.casterGuid),
        targetName: this.name(e.targetGuid),
        sourceIsPlayer: this.isPlayer(e.casterGuid),
        targetIsPlayer: this.isPlayer(e.targetGuid),
        spellName: this.spell(e.spellId),
        amount: e.amount,
        powerType: e.powerType,
      }),
    );
  }

  handlePeriodicAura(e: { casterGuid: string; targetGuid: string; spellId: number; auraType: number; amount: number; school?: number; absorb?: number; powerType?: number }) {
    this.push(
      formatPeriodicAura({
        sourceName: this.name(e.casterGuid),
        targetName: this.name(e.targetGuid),
        sourceIsPlayer: this.isPlayer(e.casterGuid),
        targetIsPlayer: this.isPlayer(e.targetGuid),
        spellName: this.spell(e.spellId),
        amount: e.amount,
        school: e.school ?? 0,
        absorb: e.absorb ?? 0,
        powerType: e.powerType,
        auraType: e.auraType,
      }),
    );
  }

  handleDeath(e: { guid: string; hostile: boolean }) {
    this.push(formatDeath({ name: this.name(e.guid), isPlayer: this.isPlayer(e.guid), hostile: e.hostile }));
  }

  handleXpGain(e: { victimGuid: string; totalXp: number; baseXp?: number }) {
    this.push(formatXpGain({
      victimName: /^0+$/.test(e.victimGuid) ? undefined : this.name(e.victimGuid),
      totalXp: e.totalXp,
      baseXp: e.baseXp,
    }));
  }
}
