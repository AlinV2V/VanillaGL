/** Asset conversion utility. */
import { CanvasPanel, drawItemButton, UI_GRAY, type PanelHit } from './panel-kit';

type BakedTalent = { id: number; row: number; col: number; ranks: number[]; prereqTalent: number; prereqRank: number };
type BakedTab = { id: number; name: string; icon: number; classId: number; order: number; background: string; talents: BakedTalent[] };

const GRID = { x: 46, y: 92, pitchX: 63, pitchY: 63, icon: 36 };
const CONTENT = { x: 22, y: 74, width: 304, height: 348 };

export class TalentFrameController extends CanvasPanel {
  private tabs: BakedTab[] = [];
  private activeTab = 0;
  private scrollY = 0;
  private loaded?: Promise<void>;

  constructor(private readonly host: HTMLElement, private readonly deps: {
    playUi: (name: string) => void;
    getClassId: () => number | undefined;
    getKnownSpells: () => Iterable<number>;
    getUnspentPoints: () => number;
    learnTalent: (talentId: number, requestedRank: number) => void;
    getSpellName: (spellId: number) => string;
    getSpellIconUrl: (spellId: number) => string | undefined;
  }) {
    super(host, 384, 512, 'wow-native-panel-canvas', { playUi: deps.playUi });
    this.onWheel = (direction) => {
      const next = Math.max(0, Math.min(this.scrollLimit(), this.scrollY + direction * GRID.pitchY));
      if (next !== this.scrollY) { this.scrollY = next; this.surface.requestRender(); }
    };
  }

  private load() {
    this.loaded ??= fetch('/spells/talents.json', { cache: 'no-cache' })
      .then((res) => {
        if (!res.ok) throw new Error(`talent data request failed (${res.status})`);
        return res.json();
      })
      .then((data: { tabs: BakedTab[] }) => { this.tabs = data.tabs; })
      .catch((error) => {
        this.loaded = undefined;
        throw error;
      });
    return this.loaded;
  }

  isOpen() { return !this.host.classList.contains('is-hidden'); }
  toggle() { this.setOpen(!this.isOpen()); }
  requestRender() { this.surface.requestRender(); }

  setOpen(open: boolean) {
    if (open === this.isOpen()) return;
    this.host.classList.toggle('is-hidden', !open);
    this.playUi(open ? 'igCharacterInfoOpen' : 'igCharacterInfoClose');
    if (open) void this.load().then(() => this.surface.requestRender()).catch(() => { /* retry on next open */ });
  }

  private classTabs(): BakedTab[] {
    const classId = this.deps.getClassId();
    return this.tabs.filter((tab) => tab.classId === classId);
  }

  private scrollLimit(): number {
    const tabs = this.classTabs();
    const tab = tabs[Math.min(this.activeTab, Math.max(0, tabs.length - 1))];
    const lastRow = tab?.talents.reduce((max, talent) => Math.max(max, talent.row), 0) ?? 0;
    return Math.max(0, GRID.y + lastRow * GRID.pitchY + GRID.icon + 12 - (CONTENT.y + CONTENT.height));
  }

  private learnedRank(talent: BakedTalent, known: Set<number>): number {
    for (let rank = talent.ranks.length - 1; rank >= 0; rank--) {
      if (known.has(talent.ranks[rank])) return rank + 1;
    }
    return 0;
  }

  protected paint() {
    const s = this.surface;
    s.clear();
    const tabs = this.classTabs();
    const tab = tabs[Math.min(this.activeTab, Math.max(0, tabs.length - 1))];
    // TalentFrame.xml borrows the CharacterFrame General top quadrants and only
    // ships its own bottom pair (matching FriendsFrame's composition).
    s.image('/ui/Interface/PaperDollInfoFrame/UI-Character-General-TopLeft.png', 0, 0, 256, 256);
    s.image('/ui/Interface/PaperDollInfoFrame/UI-Character-General-TopRight.png', 256, 0, 128, 256);
    s.image('/ui/Interface/TalentFrame/UI-TalentFrame-BotLeft.png', 0, 256, 256, 256);
    s.image('/ui/Interface/TalentFrame/UI-TalentFrame-BotRight.png', 256, 256, 128, 256);
    if (tab?.background) {
      const base = `/ui/Interface/TalentFrame/${tab.background}`;
      s.image(`${base}-TopLeft.png`, CONTENT.x, CONTENT.y, 256, 256);
      s.image(`${base}-TopRight.png`, CONTENT.x + 256, CONTENT.y, CONTENT.width - 256, 256);
      s.image(`${base}-BottomLeft.png`, CONTENT.x, CONTENT.y + 256, 256, CONTENT.height - 256);
      s.image(`${base}-BottomRight.png`, CONTENT.x + 256, CONTENT.y + 256, CONTENT.width - 256, CONTENT.height - 256);
    }
    if (tab?.icon) {
      const ctx = s.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.arc(37, 36, 28, 0, Math.PI * 2);
      ctx.clip();
      s.image(`/spells/icons/${tab.icon}.png`, 9, 8, 56, 56);
      ctx.restore();
    }
    const known = new Set(this.deps.getKnownSpells());
    const spent = tab ? tab.talents.reduce((n, t) => n + this.learnedRank(t, known), 0) : 0;
    const unspent = this.deps.getUnspentPoints();
    s.text(tab ? `${tab.name} (${spent} point${spent === 1 ? '' : 's'} spent)` : 'Talents', 192, 24, {
      size: 13, color: '#ffffff', align: 'center', baseline: 'middle', maxWidth: 280,
    });
    s.closeButton(323, 8, this.hoverState('close'));
    this.hit('close', { x: 323, y: 8, width: 32, height: 32 });

    if (tab) {
      const centerOf = (talent: BakedTalent) => ({
        x: GRID.x + talent.col * GRID.pitchX + GRID.icon / 2,
        y: GRID.y + talent.row * GRID.pitchY + GRID.icon / 2 - this.scrollY,
      });
      const byId = new Map(tab.talents.map((talent) => [talent.id, talent]));
      const ctx = s.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.rect(CONTENT.x, CONTENT.y, CONTENT.width, CONTENT.height);
      ctx.clip();
      for (const talent of tab.talents) {
        const prereq = talent.prereqTalent ? byId.get(talent.prereqTalent) : undefined;
        if (!prereq) continue;
        const from = centerOf(prereq);
        const to = centerOf(talent);
        ctx.save();
        ctx.strokeStyle = this.learnedRank(prereq, known) >= (talent.prereqRank || prereq.ranks.length) ? '#ffd100' : '#7a7a7a';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y + GRID.icon / 2);
        if (from.x !== to.x) { ctx.lineTo(from.x, to.y); ctx.lineTo(to.x - Math.sign(to.x - from.x) * GRID.icon / 2, to.y); }
        else ctx.lineTo(to.x, to.y - GRID.icon / 2);
        ctx.stroke();
        ctx.restore();
      }
      for (const talent of tab.talents) {
        const x = GRID.x + talent.col * GRID.pitchX;
        const y = GRID.y + talent.row * GRID.pitchY - this.scrollY;
        const rank = this.learnedRank(talent, known);
        const prereq = talent.prereqTalent ? byId.get(talent.prereqTalent) : undefined;
        const prereqMet = !prereq || this.learnedRank(prereq, known) >= (talent.prereqRank || prereq.ranks.length);
        const available = rank < talent.ranks.length && unspent > 0 && spent >= talent.row * 5 && prereqMet;
        const id = `talent:${talent.id}`;
        drawItemButton(s, x, y, GRID.icon, {
          iconUrl: this.deps.getSpellIconUrl(talent.ranks[Math.max(0, rank - 1)]),
          hover: this.state(id) === 'hover',
          disabled: !available && rank === 0,
        });
        s.text(`${rank}/${talent.ranks.length}`, x + GRID.icon - 1, y + GRID.icon + 10, {
          size: 11, font: 'number', align: 'right',
          color: rank >= talent.ranks.length ? '#ffd100' : available || rank > 0 ? '#1eff00' : UI_GRAY,
        });
        if (y + GRID.icon >= CONTENT.y && y <= CONTENT.y + CONTENT.height) {
          this.hit(id, { x: x - 2, y: Math.max(CONTENT.y, y - 2), width: GRID.icon + 4,
            height: Math.min(CONTENT.y + CONTENT.height, y + GRID.icon + 2) - Math.max(CONTENT.y, y - 2) }, {
            data: { talent, rank, available },
            tooltip: () => {
              const spell = talent.ranks[Math.min(talent.ranks.length - 1, rank)];
              return [
                { text: this.deps.getSpellName(spell), color: '#ffffff' },
                { text: `Rank ${Math.min(rank + 1, talent.ranks.length)}/${talent.ranks.length}`, color: '#ffffff' },
                ...(!available && rank < talent.ranks.length ? [{ text: 'Requirements not met', color: '#e60b0b' }] : []),
              ];
            },
          });
        }
      }
      ctx.restore();
    }

    s.text(`${unspent} Talent Point${unspent === 1 ? '' : 's'} Available`, 192, 434, {
      size: 12, align: 'center', color: unspent > 0 ? '#ffd100' : UI_GRAY, maxWidth: 280,
    });

    tabs.forEach((candidate, index) => {
      const rect = { x: 24 + index * 106, y: 452, width: 100, height: 30 };
      const active = index === this.activeTab;
      s.image(`/ui/Interface/PaperDollInfoFrame/UI-Character-${active ? 'Active' : 'Inactive'}Tab.png`, rect.x, rect.y, rect.width, rect.height);
      s.text(candidate.name, rect.x + rect.width / 2, rect.y + 16, {
        size: 11, align: 'center', baseline: 'middle', color: active ? '#ffffff' : '#ffd100', maxWidth: 92,
      });
      this.hit(`tab:${index}`, rect, { data: index });
    });
  }

  private hoverState(id: string): 'normal' | 'hover' | 'down' {
    const state = this.state(id);
    return state === 'disabled' ? 'normal' : state;
  }

  protected activate(hit: PanelHit) {
    if (hit.id === 'close') { this.setOpen(false); return; }
    if (hit.id.startsWith('tab:')) {
      this.activeTab = hit.data as number;
      this.scrollY = 0;
      this.playUi('igCharacterInfoTab');
      this.surface.requestRender();
      return;
    }
    if (hit.id.startsWith('talent:')) {
      const data = hit.data as { talent?: BakedTalent; rank?: number; available?: boolean } | undefined;
      if (!data?.talent || data.rank === undefined || !data.available) return;
      this.deps.learnTalent(data.talent.id, data.rank);
      this.playUi('igAbilityPageTurn');
    }
  }
}
