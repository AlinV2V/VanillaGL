import type { RealmWorldClient, WorldEntity } from '../world';
import type { ActionCombatController } from './action-combat';
import { containsPoint, ensureVanillaFonts, VanillaCanvas, type CanvasRect } from './vanilla-canvas';
import { getGameTooltip } from './game-tooltip';
import { textTooltipLines } from './tooltip-content';
import { spellButtonTooltip } from './action-tooltip';
import { routeCursorDrop } from './cursor-drop-router';
import { loadSpellTooltips } from './spell-tooltip-text';

type SpellMeta = Record<number, [string, string, number, number?, number?, number?]>;
type SpellbookData = {
  skillLines: Record<number, [string, number]>;
  abilities: Record<number, Array<[number, number, number]>>;
};
type BookSpell = { id: number; name: string; rank: string; icon: number; passive: boolean; tab: number };
type Hit = { kind: 'close' | 'prev' | 'next' | 'tab' | 'spell'; rect: CanvasRect; id?: number; tooltip?: string };
/** Asset conversion utility. */
const SPELLS_PER_PAGE = 12;
const SPELL_ROWS_PER_PAGE = 6;
/** Matches the action bar's own threshold so both panels feel the same. */
const SPELLBOOK_DRAG_THRESHOLD_PX = 5;

const classBit = (classId: number) => classId > 0 ? 1 << (classId - 1) : 0;
const raceBit = (race: number) => race > 0 ? 1 << (race - 1) : 0;

export class SpellbookController {
  private openState = false;
  private page = 0;
  private tab = 0;
  private meta: SpellMeta = {};
  private data: SpellbookData = { skillLines: {}, abilities: {} };
  private loaded?: Promise<void>;
  private readonly surface = new VanillaCanvas(384, 512, 'wow-native-panel-canvas wow-spellbook-canvas');
  private hits: Hit[] = [];
  private hover?: Hit;
  private pressed?: Hit;
  /** Viewport point the press began at, for the drag threshold. */
  private pressOrigin?: { x: number; y: number };
  /** A spell has been lifted onto the cursor; the release is a drop, not a click. */
  private dragging = false;
  /**
   * The in-flight `pickupSpellbookSpell`. It is async — it awaits the action controller's OWN spell
   * metadata, which is a separate cache from this panel's and may still be a network fetch the
   * first time. A drag lasts a few hundred ms, so releasing before it settles left the cursor empty
   * and the drop landed on nothing. The drop waits on this instead of assuming it is done.
   */
  private pickupInFlight?: Promise<void>;

  constructor(private readonly deps: {
    root: HTMLElement;
    getWorld: () => RealmWorldClient | undefined;
    getPlayer: () => WorldEntity | undefined;
    actionCombat: () => ActionCombatController;
    playUi: (name: string) => void;
    /** Drop the held spell when a drag ends over nothing that accepts it. */
    clearHeldCursor?: () => void;
  }) {
    deps.root.replaceChildren(this.surface.canvas);
    this.surface.onRender(() => this.paint());
    this.surface.canvas.addEventListener('pointermove', (event) => this.onMove(event));
    this.surface.canvas.addEventListener('pointerleave', () => { this.hover = undefined; getGameTooltip().hide(); this.surface.requestRender(); });
    this.surface.canvas.addEventListener('pointerdown', (event) => this.onDown(event));
    this.surface.canvas.addEventListener('pointerup', (event) => this.onUp(event));
    void ensureVanillaFonts().then(() => this.surface.requestRender());
  }

  isOpen() { return this.openState; }
  toggle() { this.setOpen(!this.openState); }
  setOpen(value: boolean) {
    if (this.openState === value) return;
    this.openState = value;
    this.deps.root.classList.toggle('is-hidden', !value);
    this.deps.playUi(value ? 'SPELLBOOKOPEN' : 'SPELLBOOKCLOSE');
    // Warm the tooltip corpus while the book opens so the first hover already has its text; the
    // resolver reads it synchronously during paint.
    if (value) { void loadSpellTooltips().then(() => this.surface.requestRender()); void this.render(); }
  }

  private async load() {
    if (!this.loaded) this.loaded = Promise.all([
      fetch('/spells/spells.json', { cache: 'no-cache' }).then((r) => {
        if (!r.ok) throw new Error(`spell metadata request failed (${r.status})`);
        return r.json();
      }),
      fetch('/spells/spellbook.json', { cache: 'no-cache' }).then((r) => {
        if (!r.ok) throw new Error(`spellbook data request failed (${r.status})`);
        return r.json();
      }),
    ])
      .then(([meta, data]) => { this.meta = meta; this.data = data; })
      .catch((error) => {
        this.loaded = undefined;
        throw error;
      });
    return this.loaded;
  }

  private spells(): BookSpell[] {
    const player = this.deps.getPlayer();
    const cm = classBit(player?.classId ?? 0);
    const rm = raceBit(player?.race ?? 0);
    const result: BookSpell[] = [];
    for (const id of this.deps.getWorld()?.getKnownSpells() ?? []) {
      const meta = this.meta[id];
      if (!meta || !meta[0] || !meta[2] || ((meta[5] ?? 0) & 0x80)) continue;
      const passive = ((meta[5] ?? 0) & 0x40) !== 0;
      const matches = (this.data.abilities[id] ?? []).filter(([, raceMask, classMask]) =>
        (!raceMask || (raceMask & rm) !== 0) && (!classMask || (classMask & cm) !== 0));
      const classAssociation = passive ? undefined : matches.find(([, , mask]) => !!mask && (mask & cm) !== 0);
      result.push({ id, name: meta[0], rank: meta[1], icon: meta[2], passive, tab: classAssociation?.[0] ?? 0 });
    }
    const highest = new Map<string, BookSpell>();
    for (const spell of result) {
      const previous = highest.get(`${spell.tab}:${spell.name}`);
      const rank = Number(spell.rank.match(/\d+/)?.[0] ?? 0);
      const oldRank = Number(previous?.rank.match(/\d+/)?.[0] ?? -1);
      if (!previous || rank >= oldRank) highest.set(`${spell.tab}:${spell.name}`, spell);
    }
    // Map preserves SMSG_INITIAL_SPELLS learn order, matching the native book.
    return [...highest.values()].sort((a, b) => a.tab - b.tab);
  }

  async render() {
    try {
      await this.load();
      this.surface.requestRender();
    } catch {
      // A later open retries after load() clears the rejected promise.
    }
  }

  private paint() {
    const s = this.surface;
    s.clear();
    s.fourSlice('/ui/Interface/Spellbook', [
      'UI-SpellbookPanel-TopLeft', 'UI-SpellbookPanel-TopRight',
      'UI-SpellbookPanel-BotLeft', 'UI-SpellbookPanel-BotRight',
    ]);
    s.image('/ui/Interface/Spellbook/Spellbook-Icon.png', 7, 5, 60, 60);
    s.text('Spellbook', 192, 22, { color: '#ffd100', align: 'center', baseline: 'middle', size: 14 });
    s.closeButton(324, 9, this.hitState('close'));

    const all = this.spells();
    const tabs = [0, ...new Set(all.map((spell) => spell.tab).filter(Boolean))];
    if (!tabs.includes(this.tab)) this.tab = tabs[0] ?? 0;
    const current = all.filter((spell) => spell.tab === this.tab);
    const maxPage = Math.max(0, Math.ceil(current.length / SPELLS_PER_PAGE) - 1);
    this.page = Math.max(0, Math.min(maxPage, this.page));
    this.hits = [{ kind: 'close', rect: { x: 324, y: 9, width: 32, height: 32 } }];

    tabs.forEach((id, index) => {
      const y = 76 + index * 43;
      const rect = { x: 347, y, width: 37, height: 37 };
      const line = this.data.skillLines[id];
      const first = all.find((spell) => spell.tab === id);
      const icon = id === 0 ? (first?.icon ?? 26) : (line?.[1] || first?.icon || 26);
      s.image('/ui/Interface/Spellbook/SpellBook-SkillLineTab.png', 342, y - 13, 64, 64);
      s.image(`/spells/icons/${icon}.png`, rect.x + 3, rect.y + 3, 31, 31);
      if (id === this.tab) s.image('/ui/Interface/Spellbook/UI-SpellbookPanel-Tab-Highlight.png', 342, y - 13, 64, 64);
      this.hits.push({ kind: 'tab', id, rect, tooltip: id === 0 ? 'General' : line?.[0] ?? 'Class Spells' });
    });

    // Geometry transcribed from SpellBookFrame.xml/.lua, not remembered:
    //   SPELLS_PER_PAGE = 12 (SpellBookFrame.lua:3); SpellButton1..12 exist.
    //   Button ids run 1..6 down the LEFT column and 7..12 down the RIGHT, so the fill is
    //   column-major with SIX rows (SpellButton1 id=1, SpellButton2 id=7, SpellButton3 id=2 ...).
    //   SpellButton1 anchors TOPLEFT (34, -85); column 2 is +157; each row anchors to the previous
    //   row's BOTTOMLEFT at (0, -14) over a 37x37 template => 51px pitch.
    //   The button IS the 37x37 icon: UI-Quickslot2 (64x64) is its NormalTexture, centred, and the
    //   name is a FontString anchored LEFT to the button's RIGHT at (4, 4), width 103.
    //   There is no per-row background plate — UI-Spellbook-SpellBackground is not referenced
    //   anywhere in the extracted Interface corpus, and a 58px plate cannot fit a 44px pitch.
    current.slice(this.page * SPELLS_PER_PAGE, this.page * SPELLS_PER_PAGE + SPELLS_PER_PAGE)
      .forEach((spell, index) => {
        const column = index < SPELL_ROWS_PER_PAGE ? 0 : 1;
        const row = index % SPELL_ROWS_PER_PAGE;
        const x = 34 + column * 157;
        const y = 85 + row * 51;
        const rect = { x, y, width: 37, height: 37 };
        s.image('/ui/Interface/Buttons/UI-Quickslot2.png', x - 13.5, y - 13.5, 64, 64);
        s.image(`/spells/icons/${spell.icon}.png`, x, y, 37, 37);
        s.text(spell.name, x + 41, y + 14, { size: 13, maxWidth: 103 });
        s.text(spell.passive ? 'Passive' : spell.rank, x + 41, y + 29, { size: 10, color: '#8c795d', maxWidth: 103 });
        this.hits.push({ kind: 'spell', id: spell.id, rect, tooltip: `${spell.name}${spell.rank ? `\n${spell.rank}` : ''}${spell.passive ? '\nPassive' : ''}` });
      });

    s.text(`Page ${this.page + 1}`, 192, 414, { align: 'center', size: 13 });
    const prevRect = { x: 34, y: 391, width: 32, height: 32 };
    const nextRect = { x: 298, y: 391, width: 32, height: 32 };
    s.image(`/ui/Interface/Buttons/UI-SpellbookIcon-PrevPage-${this.page === 0 ? 'Disabled' : 'Up'}.png`, prevRect.x, prevRect.y, 32, 32);
    s.image(`/ui/Interface/Buttons/UI-SpellbookIcon-NextPage-${this.page >= maxPage ? 'Disabled' : 'Up'}.png`, nextRect.x, nextRect.y, 32, 32);
    s.text('Prev', 78, 408, { align: 'center', baseline: 'middle', size: 12 });
    s.text('Next', 287, 408, { align: 'right', baseline: 'middle', size: 12 });
    if (this.page > 0) this.hits.push({ kind: 'prev', rect: prevRect });
    if (this.page < maxPage) this.hits.push({ kind: 'next', rect: nextRect });
  }

  private hitState(kind: Hit['kind']): 'normal' | 'hover' | 'down' {
    if (this.pressed?.kind === kind) return 'down';
    if (this.hover?.kind === kind) return 'hover';
    return 'normal';
  }

  private hitAt(event: PointerEvent) {
    const point = this.surface.point(event);
    return this.hits.find((hit) => containsPoint(hit.rect, point));
  }

  private onMove(event: PointerEvent) {
    // SpellBookFrame.xml:169-171 — OnDragStart runs SpellButton_OnClick(1), i.e. PickupSpell.
    // Passive spells are not draggable (attribute 0x40), same test the click path uses.
    if (this.pressed?.kind === 'spell' && this.pressed.id !== undefined && !this.dragging && this.pressOrigin) {
      const moved = Math.hypot(event.clientX - this.pressOrigin.x, event.clientY - this.pressOrigin.y);
      if (moved > SPELLBOOK_DRAG_THRESHOLD_PX && ((this.meta[this.pressed.id]?.[5] ?? 0) & 0x40) === 0) {
        this.dragging = true;
        this.pickupInFlight = this.deps.actionCombat().pickupSpellbookSpell(this.pressed.id);
        void this.pickupInFlight;
      }
    }
    this.hover = this.hitAt(event);
    if (this.hover?.kind === 'spell' && this.hover.id !== undefined) {
      getGameTooltip().show(this.spellTooltip(this.hover.id), event.clientX, event.clientY);
    } else {
      const tooltip = this.hover?.tooltip?.split('\n').filter(Boolean) ?? [];
      if (tooltip.length) getGameTooltip().show(textTooltipLines(tooltip[0], ...tooltip.slice(1)), event.clientX, event.clientY);
      else getGameTooltip().hide();
    }
    this.surface.requestRender();
  }

  /** Full GameTooltip for a spellbook button, using this panel's own already-loaded metadata. */
  private spellTooltip(spellId: number) {
    return spellButtonTooltip(spellId, this.meta[spellId], `Spell ${spellId}`);
  }

  private onDown(event: PointerEvent) {
    if (event.button !== 0) return;
    this.pressed = this.hitAt(event);
    this.pressOrigin = { x: event.clientX, y: event.clientY };
    this.dragging = false;
    // Only swallow presses on interactive hits; empty parchment must bubble to
    // the host so installDraggableFrames can move the panel.
    if (this.pressed) {
      event.preventDefault();
      event.stopPropagation();
      // Capture so the RELEASE still arrives here after the pointer has left the panel — the drop
      // it produces is then routed to whatever is underneath (`cursor-drop-router.ts`). Without
      // this the pointerup lands on the action bar, which has no matching press, and the gesture
      // silently does nothing. That is the reported "cannot drag a spell to the action bar".
      this.surface.canvas.setPointerCapture(event.pointerId);
    }
    this.surface.requestRender();
  }

  private onUp(event: PointerEvent) {
    const hit = this.hitAt(event);
    const pressed = this.pressed;
    const dropping = this.dragging;
    this.pressed = undefined;
    this.pressOrigin = undefined;
    this.dragging = false;
    if (this.surface.canvas.hasPointerCapture(event.pointerId)) {
      this.surface.canvas.releasePointerCapture(event.pointerId);
    }
    if (dropping) {
      // Hand the release to whatever accepts it; landing on nothing throws the spell away, exactly
      // as dropping an action off the bar does. The point is captured before awaiting because the
      // event object is recycled.
      event.preventDefault();
      event.stopPropagation();
      const { clientX, clientY } = event;
      const pickup = this.pickupInFlight ?? Promise.resolve();
      this.pickupInFlight = undefined;
      void pickup.then(() => {
        if (!routeCursorDrop(clientX, clientY)) this.deps.clearHeldCursor?.();
        this.surface.requestRender();
      });
      return;
    }
    if (!hit || !pressed || hit.kind !== pressed.kind || hit.id !== pressed.id) { this.surface.requestRender(); return; }
    event.preventDefault();
    event.stopPropagation();
    if (hit.kind === 'close') this.setOpen(false);
    else if (hit.kind === 'prev') { this.page--; this.deps.playUi('ABILIITYPAGETURN'); this.surface.requestRender(); }
    else if (hit.kind === 'next') { this.page++; this.deps.playUi('ABILIITYPAGETURN'); this.surface.requestRender(); }
    else if (hit.kind === 'tab') { this.tab = hit.id ?? 0; this.page = 0; this.surface.requestRender(); }
    else if (hit.kind === 'spell' && hit.id !== undefined && ((this.meta[hit.id]?.[5] ?? 0) & 0x40) === 0) {
      void this.deps.actionCombat().pickupSpellbookSpell(hit.id);
    }
  }
}
