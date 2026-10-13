import type { CombatEvent, InventorySnapshot, ItemInfo, SkillSnapshot } from '../world';
import { CanvasPanel, drawItemButton, UI_GOLD, UI_GRAY, type PanelHit } from './panel-kit';

// Blizzard_TradeSkillUI.lua / .xml: eight 16px recipe rows in a 384x512 frame.
const TRADE_SKILLS_DISPLAYED = 8;
const TRADE_SKILL_HEIGHT = 16;

type Recipe = {
  skillId: number; min: number; high: number; low: number; skillUps: number;
  createItem?: number; enchantItem?: boolean; reagents: Array<[number, number]>;
};
type RecipeManifest = {
  skillLines: Record<number, [string, number]>;
  openers: Record<number, number>;
  recipes: Record<number, Recipe>;
};
type SpellMeta = Record<number, [string, string, number]>;

export class TradeSkillCanvasPanel extends CanvasPanel {
  private manifest: RecipeManifest = { skillLines: {}, openers: {}, recipes: {} };
  private spellMeta: SpellMeta = {};
  private skillId = 0;
  private selectedSpellId = 0;
  private scroll = 0;
  private openState = false;
  private loaded = false;
  private loadPromise?: Promise<void>;
  private queue?: { spellId: number; remaining: number; waiting: boolean };

  constructor(private readonly host: HTMLElement, private readonly deps: {
    getKnownSpells: () => readonly number[];
    getSkills: () => SkillSnapshot | undefined;
    getInventory: () => InventorySnapshot | undefined;
    getItemInfo: (entry: number) => ItemInfo | undefined;
    requestItemInfo: (entry: number) => void;
    itemIconUrl: (displayInfoId?: number, entry?: number) => string;
    castSpell: (spellId: number) => void;
    playUi?: (name: string) => unknown;
  }) {
    super(host, 384, 512, 'wow-native-panel-canvas', { playUi: deps.playUi });
    host.dataset.frameId = 'tradeskill';
    this.onWheel = (direction) => {
      const recipes = this.activeRecipes();
      this.scroll = Math.max(0, Math.min(Math.max(0, recipes.length - TRADE_SKILLS_DISPLAYED), this.scroll + direction));
      this.surface.requestRender();
    };
  }

  async initialize(): Promise<void> {
    if (this.loaded) return;
    // Share a single in-flight load; on failure leave `loaded` false so tryOpen can retry rather
    // than leaving every profession window permanently unopenable after one bad boot-time fetch.
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const [manifest, spells] = await Promise.all([
            fetch('/spells/recipes.json').then((response) => response.json()),
            fetch('/spells/spells.json').then((response) => response.json()),
          ]);
          this.manifest = manifest;
          this.spellMeta = spells;
          this.loaded = true;
        } catch { /* asset verification reports missing data; retry on next tryOpen */ } finally {
          this.loadPromise = undefined;
        }
      })();
    }
    return this.loadPromise;
  }

  tryOpen(openerSpellId: number) {
    const skillId = this.manifest.openers[openerSpellId];
    if (!skillId) {
      // Either not a profession opener, or the boot fetch failed and left the manifest empty. Only
      // the latter is recoverable: reload once, then re-open the same spell when the data arrives.
      if (!this.loaded) void this.initialize().then(() => { if (this.loaded) this.tryOpen(openerSpellId); });
      return false;
    }
    this.skillId = skillId;
    this.scroll = 0;
    this.selectedSpellId = this.activeRecipes()[0] ?? 0;
    this.requestRecipeItems();
    this.openState = true;
    this.host.classList.remove('is-hidden');
    this.surface.requestRender();
    this.playUi('igCharacterInfoOpen');
    return true;
  }

  close() { this.cancelQueue(); this.openState = false; this.host.classList.add('is-hidden'); }
  isOpen() { return this.openState; }
  refresh() { if (this.openState) this.surface.requestRender(); }
  update(playerMoving: boolean, inCombat: boolean) { if (this.queue && (playerMoving || inCombat)) this.cancelQueue(); }

  handleCombatEvent(event: CombatEvent, playerGuid?: string) {
    const queue = this.queue;
    if (!queue || (event.kind !== 'spellFailure' && event.kind !== 'spellGo')) return;
    if (event.casterGuid !== playerGuid || event.spellId !== queue.spellId) return;
    if (event.kind === 'spellFailure') { this.cancelQueue(); return; }
    if (event.kind !== 'spellGo') return;
    queue.remaining--;
    queue.waiting = false;
    if (queue.remaining <= 0 || this.maxCraftable(queue.spellId) <= 0) { this.cancelQueue(); return; }
    window.setTimeout(() => {
      if (!this.queue || this.queue.waiting) return;
      this.queue.waiting = true;
      this.deps.castSpell(this.queue.spellId);
    }, 180);
  }

  protected paint() {
    const s = this.surface;
    s.clear();
    s.image('/ui/Interface/ClassTrainerFrame/UI-ClassTrainer-TopLeft.png', 0, 0, 256, 256);
    s.image('/ui/Interface/ClassTrainerFrame/UI-ClassTrainer-TopRight.png', 256, 0, 128, 256);
    s.image('/ui/Interface/TradeSkillFrame/UI-TradeSkill-BotLeft.png', 0, 256, 256, 256);
    s.image('/ui/Interface/ClassTrainerFrame/UI-ClassTrainer-BotRight.png', 256, 256, 128, 256);
    s.image('/ui/Interface/Icons/INV_TradeskillItem_03.png', 7, 6, 60, 60);
    const frameCloseState = this.state('frameClose');
    s.closeButton(323, 8, frameCloseState === 'disabled' ? 'normal' : frameCloseState);
    this.hit('frameClose', { x: 323, y: 8, width: 32, height: 32 });
    const skill = this.deps.getSkills()?.skills.find((entry) => entry.skillId === this.skillId);
    const title = this.manifest.skillLines[this.skillId]?.[0] ?? 'Trade Skill';
    s.text(title, 192, 17, { size: 14, align: 'center', baseline: 'middle', color: UI_GOLD });
    const rank = Math.max(0, skill?.value ?? 0);
    const rankMax = Math.max(1, skill?.max ?? 0);
    s.ctx.save();
    s.ctx.fillStyle = '#1a1008'; s.ctx.fillRect(73, 37, 268, 15);
    s.ctx.fillStyle = '#0b6a14'; s.ctx.fillRect(74, 38, 266 * Math.min(1, rank / rankMax), 13);
    s.ctx.restore();
    s.text(`${title} ${rank} / ${skill?.max ?? 0}`, 79, 48, { size: 10, color: UI_GOLD });
    const recipes = this.activeRecipes();
    recipes.slice(this.scroll, this.scroll + TRADE_SKILLS_DISPLAYED).forEach((spellId, row) => {
      const y = 96 + row * TRADE_SKILL_HEIGHT;
      const meta = this.spellMeta[spellId];
      const rect = { x: 22, y, width: 293, height: TRADE_SKILL_HEIGHT };
      const selected = spellId === this.selectedSpellId;
      if (selected || this.isHover(`recipe:${spellId}`)) {
        s.ctx.save(); s.ctx.fillStyle = selected ? 'rgba(190,130,20,.35)' : 'rgba(255,255,255,.08)'; s.ctx.fillRect(rect.x, rect.y, rect.width, rect.height); s.ctx.restore();
      }
      s.text(meta?.[0] ?? `Spell ${spellId}`, 30, y + 12, { size: 11, color: this.difficultyColor(spellId, rank), maxWidth: 245 });
      const craftable = this.maxCraftable(spellId);
      s.text(craftable > 0 ? String(craftable) : '', 307, y + 12, { size: 10, align: 'right', color: craftable > 0 ? '#ffffff' : UI_GRAY });
      this.hit(`recipe:${spellId}`, rect, { data: spellId });
    });
    const selected = this.manifest.recipes[this.selectedSpellId];
    const detailY = 237;
    if (selected) {
      const output = selected.createItem ? this.deps.getItemInfo(selected.createItem) : undefined;
      drawItemButton(s, 28, detailY, 37, { iconUrl: output ? this.deps.itemIconUrl(output.displayInfoId, output.entry) : undefined });
      s.text(output?.name ?? this.spellMeta[this.selectedSpellId]?.[0] ?? '', 70, detailY + 15, { size: 12, color: '#ffffff', maxWidth: 244 });
      s.text(selected.enchantItem ? 'Requires an equipment target' : 'Reagents', 28, detailY + 48, { size: 10, color: UI_GOLD });
      selected.reagents.slice(0, 8).forEach(([entry, count], index) => {
        const x = 23 + (index % 2) * 145;
        const y = detailY + 62 + Math.floor(index / 2) * 39;
        const info = this.deps.getItemInfo(entry);
        const owned = this.itemCount(entry);
        drawItemButton(s, x, y, 34, { iconUrl: info ? this.deps.itemIconUrl(info.displayInfoId, entry) : undefined, count });
        s.text(String(owned), x + 31, y + 32, { size: 9, align: 'right', color: owned >= count ? '#ffffff' : '#ff2020' });
      });
    }
    const create = { x: 184, y: 411, width: 80, height: 22 };
    const createAll = { x: 18, y: 411, width: 80, height: 22 };
    const close = { x: 265, y: 411, width: 80, height: 22 };
    const disabled = !selected || this.maxCraftable(this.selectedSpellId) <= 0 || !!this.queue;
    s.panelButton('Exit', close, this.state('close'));
    s.panelButton(this.queue ? 'Creating...' : 'Create', create, disabled ? 'disabled' : this.state('create'));
    s.panelButton('Create All', createAll, disabled ? 'disabled' : this.state('createAll'));
    this.hit('close', close);
    this.hit('create', create, { disabled });
    this.hit('createAll', createAll, { disabled });
  }

  protected activate(hit: PanelHit) {
    if (hit.id.startsWith('recipe:')) { this.selectedSpellId = hit.data as number; this.requestRecipeItems(); }
    else if (hit.id === 'close' || hit.id === 'frameClose') this.close();
    else if (hit.id === 'create') this.startQueue(1);
    else if (hit.id === 'createAll') this.startQueue(this.maxCraftable(this.selectedSpellId));
  }

  private activeRecipes() {
    const known = new Set(this.deps.getKnownSpells());
    return Object.entries(this.manifest.recipes)
      .filter(([spellId, recipe]) => recipe.skillId === this.skillId && known.has(Number(spellId)))
      .map(([spellId]) => Number(spellId))
      .sort((a, b) => (this.manifest.recipes[a].min - this.manifest.recipes[b].min) || (this.spellMeta[a]?.[0] ?? '').localeCompare(this.spellMeta[b]?.[0] ?? ''));
  }
  private startQueue(count: number) {
    if (!this.selectedSpellId || count <= 0) return;
    this.queue = { spellId: this.selectedSpellId, remaining: count, waiting: true };
    this.deps.castSpell(this.selectedSpellId);
    this.surface.requestRender();
  }
  private cancelQueue() { this.queue = undefined; this.surface.requestRender(); }
  private itemCount(entry: number) {
    const inventory = this.deps.getInventory();
    if (!inventory) return 0;
    return [...inventory.equipment, ...inventory.bags.flatMap((bag) => bag.slots), ...inventory.keyring.slots]
      .reduce((sum, slot) => sum + (slot.item?.entry === entry ? slot.item.count : 0), 0);
  }
  private maxCraftable(spellId: number) {
    const recipe = this.manifest.recipes[spellId];
    if (!recipe) return 0;
    if (recipe.enchantItem) return 1;
    if (!recipe.reagents.length) return 1;
    return Math.min(...recipe.reagents.map(([entry, count]) => Math.floor(this.itemCount(entry) / count)));
  }
  private requestRecipeItems() {
    const recipe = this.manifest.recipes[this.selectedSpellId];
    if (!recipe) return;
    if (recipe.createItem) this.deps.requestItemInfo(recipe.createItem);
    for (const [entry] of recipe.reagents) this.deps.requestItemInfo(entry);
  }
  private difficultyColor(spellId: number, skill: number) {
    const recipe = this.manifest.recipes[spellId];
    if (!recipe) return '#ffffff';
    if (skill >= recipe.high) return '#808080';
    if (skill >= (recipe.high + recipe.low) / 2) return '#40c040';
    if (skill >= recipe.low) return '#ffff00';
    return '#ff8040';
  }
}
