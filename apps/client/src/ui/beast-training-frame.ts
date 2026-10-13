/** Build-5875 Blizzard_CraftUI surface used by the Hunter's Beast Training spell. */
import type { PetSnapshot } from '../world';
import {
  resolveBeastTrainingRecipes,
  type BeastTrainingManifest,
  type BeastTrainingRecipeState,
} from '../world/pet-training';
import { loadSpellTooltips, spellDescription } from './spell-tooltip-text';
import { CanvasPanel, drawScrollBar, UI_GOLD, UI_GRAY, type PanelHit } from './panel-kit';

const OPENER = 5149;
const LIST = { x: 22, y: 96, width: 293, rowHeight: 16, rows: 8 };
const AVAILABLE = '#40bf40';

export class BeastTrainingCanvasPanel extends CanvasPanel {
  private manifest?: BeastTrainingManifest;
  private loadPromise?: Promise<void>;
  private openState = false;
  private selectedSpellId = 0;
  private scroll = 0;

  constructor(private readonly host: HTMLElement, private readonly deps: {
    getKnownSpells: () => readonly number[];
    getPet: () => PetSnapshot | undefined;
    castSpell: (teachingSpellId: number) => void;
    getPlayerPortraitSource?: () => CanvasImageSource | undefined;
    playUi?: (name: string) => unknown;
  }) {
    super(host, 384, 512, 'wow-native-panel-canvas', { playUi: deps.playUi });
    host.dataset.frameId = 'craft';
    this.onWheel = (direction) => this.changeScroll(direction);
  }

  initialize(): Promise<void> {
    if (this.manifest) return Promise.resolve();
    this.loadPromise ??= Promise.all([
      fetch('/spells/beast-training.json').then((response) => {
        if (!response.ok) throw new Error(`Beast Training manifest ${response.status}`);
        return response.json() as Promise<BeastTrainingManifest>;
      }),
      loadSpellTooltips(),
    ]).then(([manifest]) => { this.manifest = manifest; })
      .catch(() => { /* bake/asset verification owns diagnostics; a later click may retry */ })
      .finally(() => { this.loadPromise = undefined; });
    return this.loadPromise;
  }

  tryOpen(spellId: number) {
    if (spellId !== OPENER) return false;
    if (!this.manifest) {
      void this.initialize().then(() => { if (this.manifest) this.open(); });
    } else this.open();
    return true;
  }

  close() {
    if (!this.openState) return;
    this.openState = false;
    this.host.classList.add('is-hidden');
    this.playUi('igCharacterInfoClose');
  }

  isOpen() { return this.openState; }
  refresh() {
    if (!this.openState) return;
    const recipes = this.recipes();
    if (!recipes.some((recipe) => recipe.teachingSpell === this.selectedSpellId)) {
      this.selectedSpellId = recipes[0]?.teachingSpell ?? 0;
    }
    this.scroll = Math.min(this.scroll, Math.max(0, recipes.length - LIST.rows));
    this.surface.requestRender();
  }

  protected paint() {
    const s = this.surface;
    s.clear();
    s.fourSlice('/ui/Interface/ClassTrainerFrame', [
      'UI-ClassTrainer-TopLeft', 'UI-ClassTrainer-TopRight',
      'UI-ClassTrainer-BotLeft', 'UI-ClassTrainer-BotRight',
    ]);
    const portrait = this.deps.getPlayerPortraitSource?.();
    if (portrait) s.source(portrait, 7, 6, 60, 60, { circular: true });
    else s.image('/ui/Interface/CharacterFrame/TemporaryPortrait-Monster.png', 7, 6, 60, 60);
    s.text('Beast Training', 192, 17, { size: 14, align: 'center', baseline: 'middle', color: UI_GOLD });
    s.closeButton(323, 8, this.state('frameClose') as 'normal' | 'hover' | 'down');
    this.hit('frameClose', { x: 323, y: 8, width: 32, height: 32 });

    s.sprite('/ui/Interface/ClassTrainerFrame/UI-ClassTrainer-HorizontalBar.png', 0, 0, 256, 16, 15, 221, 256, 16);
    s.sprite('/ui/Interface/ClassTrainerFrame/UI-ClassTrainer-HorizontalBar.png', 0, 16, 75, 16, 271, 221, 75, 16);
    this.paintList();
    this.paintDetail();

    const pet = this.deps.getPet();
    if (pet?.trainingPoints !== undefined) {
      s.text('Training Points:', 145, 426, { size: 10, align: 'right', color: UI_GOLD });
      s.text(String(pet.trainingPoints), 170, 426, { size: 10, align: 'right', color: '#ffffff' });
    }
    const create = { x: 184, y: 411, width: 80, height: 22 };
    const exit = { x: 265, y: 411, width: 80, height: 22 };
    const selected = this.selected();
    const disabled = !selected || selected.used;
    s.panelButton('Create', create, disabled ? 'disabled' : this.state('create'));
    s.panelButton('Exit', exit, this.state('exit'));
    this.hit('create', create, { disabled }); this.hit('exit', exit);
  }

  protected activate(hit: PanelHit) {
    if (hit.id.startsWith('recipe:')) this.selectedSpellId = hit.data as number;
    else if (hit.id === 'scroll:up') this.changeScroll(-1);
    else if (hit.id === 'scroll:down') this.changeScroll(1);
    else if (hit.id === 'frameClose' || hit.id === 'exit') this.close();
    else if (hit.id === 'create') {
      const recipe = this.selected();
      if (recipe && !recipe.used) this.deps.castSpell(recipe.teachingSpell);
    }
  }

  private open() {
    const recipes = this.recipes();
    this.selectedSpellId = recipes[0]?.teachingSpell ?? 0;
    this.scroll = 0; this.openState = true;
    this.host.classList.remove('is-hidden');
    this.surface.requestRender(); this.playUi('igCharacterInfoOpen');
  }

  private recipes() {
    return this.manifest
      ? resolveBeastTrainingRecipes(this.manifest, this.deps.getKnownSpells(), this.deps.getPet())
      : [];
  }

  private selected() { return this.recipes().find((recipe) => recipe.teachingSpell === this.selectedSpellId); }

  private changeScroll(direction: number) {
    const max = Math.max(0, this.recipes().length - LIST.rows);
    this.scroll = Math.max(0, Math.min(max, this.scroll + direction));
    this.surface.requestRender();
  }

  private paintList() {
    const s = this.surface;
    const recipes = this.recipes();
    const maxScroll = Math.max(0, recipes.length - LIST.rows);
    this.scroll = Math.min(this.scroll, maxScroll);
    recipes.slice(this.scroll, this.scroll + LIST.rows).forEach((recipe, index) => {
      const y = LIST.y + index * LIST.rowHeight;
      const id = `recipe:${recipe.teachingSpell}`;
      if (recipe.teachingSpell === this.selectedSpellId) {
        s.image('/ui/Interface/Buttons/UI-Listbox-Highlight2.png', LIST.x, y, LIST.width, LIST.rowHeight, 0.65);
      } else if (this.isHover(id)) {
        s.addImage('/ui/Interface/Buttons/UI-Listbox-Highlight2.png', LIST.x, y, LIST.width, LIST.rowHeight, 0.35);
      }
      const label = `${recipe.name}${recipe.rank ? ` (${recipe.rank})` : ''}`;
      const color = recipe.used ? UI_GRAY : AVAILABLE;
      s.text(label, LIST.x + 3, y + 12, { size: 11, color, maxWidth: 228 });
      if (recipe.cost > 0) s.text(`${recipe.cost} TP`, LIST.x + 278, y + 12, { size: 10, align: 'right', color });
      this.hit(id, { x: LIST.x, y, width: LIST.width, height: LIST.rowHeight }, { data: recipe.teachingSpell });
    });
    if (!recipes.length) s.text('No training is available.', 170, 158, { size: 12, align: 'center', color: UI_GRAY });
    if (maxScroll > 0) drawScrollBar(this, 'scroll', 324, LIST.y, 130, this.scroll, maxScroll);
  }

  private paintDetail() {
    const recipe = this.selected();
    if (!recipe) return;
    const s = this.surface;
    s.image('/ui/Interface/ClassTrainerFrame/UI-ClassTrainer-DetailHeaderLeft.png', 20, 231, 256, 64);
    s.image('/ui/Interface/ClassTrainerFrame/UI-ClassTrainer-DetailHeaderRight.png', 276, 231, 64, 64);
    s.image(`/spells/icons/${recipe.iconId}.png`, 28, 237, 37, 37);
    s.text(recipe.name, 70, 249, { size: 12, color: recipe.used ? UI_GRAY : UI_GOLD, maxWidth: 244 });
    const pet = this.deps.getPet();
    let y = 263;
    if (recipe.requiredLevel > 0) {
      s.text(`Requires Pet Level ${recipe.requiredLevel}`, 70, y, {
        size: 10, color: (pet?.level ?? 0) >= recipe.requiredLevel ? '#ffffff' : '#ff2020',
      });
      y += 13;
    }
    if (recipe.cost > 0) {
      s.text(`Costs ${recipe.cost} Training Points`, 70, y, {
        size: 10, color: (pet?.trainingPoints ?? 0) >= recipe.cost ? '#ffffff' : '#ff2020',
      });
    }
    let descriptionY = 294;
    for (const line of s.wrapText(spellDescription(recipe.learnedSpell), 285, { size: 11 })) {
      s.text(line, 25, descriptionY, { size: 11, color: '#ffffff' });
      descriptionY += 13;
    }
  }
}
