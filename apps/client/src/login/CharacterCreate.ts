import type { CharacterInfo, RealmWorldClient } from '../world';
import { RACE_CLASS_MATRIX, CUSTOMIZATION_SLOTS, validateCharacterName, type CustomizationConfig } from './constants';
import type { GlueOverlay } from './GlueOverlay';
import type { CharacterPreview } from './CharacterPreview';
import { renderCharacterCreateInfo } from './character-create-info';

export class CharacterCreate {
  private currentRace = 1; // Human
  private currentClass = 1; // Warrior
  private currentGender = 0; // Male
  
  // Customization indexes
  private skinIndex = 0;
  private faceIndex = 0;
  private hairStyleIndex = 0;
  private hairColorIndex = 0;
  private facialHairIndex = 0;

  private nameInput: HTMLInputElement | null = null;
  private currentScreenEl: HTMLElement | null = null;
  private rotationState: 'left' | 'right' | 'none' = 'none';

  constructor(
    private readonly overlay: GlueOverlay,
    private readonly preview: CharacterPreview,
    private readonly worldClient: RealmWorldClient,
    private readonly onCancel: () => void,
    private readonly onCreated: () => void,
    private readonly onRaceChanged?: (race: number) => void
  ) {}

  show() {
    this.currentRace = 1;
    this.currentClass = 1;
    this.currentGender = 0;
    this.rotationState = 'none';
    this.resetCustomizations();
    this.preview.setViewMode('full'); // don't inherit a stale face close-up from a previous screen
    this.onRaceChanged?.(this.currentRace);
    this.render();
  }

  getRotationState(): 'left' | 'right' | 'none' {
    return this.rotationState;
  }

  private resetCustomizations() {
    this.skinIndex = 0;
    this.faceIndex = 0;
    this.hairStyleIndex = 0;
    this.hairColorIndex = 0;
    this.facialHairIndex = 0;
  }

  private render() {
    const config = this.getCustomizationConfig();

    const html = `
      <div class="glue-char-create-container">
        <div class="glue-wow-logo" aria-hidden="true"></div>

        <div class="glue-create-configuration">
          <div class="glue-create-frame-art" aria-hidden="true"></div>
          <div class="glue-create-banners" aria-hidden="true">
            <span>Alliance</span><span>Horde</span>
          </div>

          <div class="glue-grid glue-race-grid" id="glue-race-grid">
            ${this.renderRaceGrid()}
          </div>

          <div class="glue-gender-container">
            <button class="glue-gender-btn ${this.currentGender === 0 ? 'selected' : ''}" data-gender="0" aria-label="Male"></button>
            <button class="glue-gender-btn ${this.currentGender === 1 ? 'selected' : ''}" data-gender="1" aria-label="Female"></button>
          </div>

          <div class="glue-grid glue-class-grid" id="glue-class-grid">
            ${this.renderClassGrid()}
          </div>

          <div class="glue-custom-controls">
            ${this.renderSlider('skin', 'Skin Color')}
            ${this.renderSlider('face', 'Face')}
            ${this.renderSlider('hairStyle', 'Hair Style')}
            ${this.renderSlider('hairColor', 'Hair Color')}
            ${config.facialHairName !== 'NONE' ? this.renderSlider('facialHair', config.facialHairName) : ''}
            <button id="glue-create-randomize" class="glue-button glue-create-randomize">Randomize</button>
          </div>
        </div>

        ${renderCharacterCreateInfo(this.currentRace, this.currentClass, this.currentGender)}

        <label class="glue-create-name-wrap">
          <span>Name</span>
          <input id="glue-create-name" class="glue-input" maxlength="12" autocomplete="off" />
          <span id="glue-create-name-error" class="glue-create-name-error"></span>
        </label>

        <div class="glue-rotate-container glue-char-create-rotate">
          <button id="glue-rotate-left" class="glue-rotate-btn glue-rotate-left"></button>
          <button id="glue-rotate-right" class="glue-rotate-btn glue-rotate-right"></button>
        </div>

        <button id="glue-create-accept" class="glue-button glue-button-large glue-create-accept">Accept</button>
        <button id="glue-create-cancel" class="glue-button glue-create-back">Back</button>
      </div>
    `;

    this.currentScreenEl = this.overlay.showScreen(html);
    this.nameInput = this.currentScreenEl.querySelector('#glue-create-name') as HTMLInputElement;

    this.bindEvents();
    this.updatePreviewCharacter();
  }

  private getCustomizationConfig(): CustomizationConfig {
    const key = `${this.currentRace}_${this.currentGender}`;
    return CUSTOMIZATION_SLOTS[key] || { skin: 5, face: 5, hairStyle: 5, hairColor: 5, facialHair: 0, facialHairName: 'NONE' };
  }

  private renderRaceGrid(): string {
    const allianceRaces = [1, 3, 7, 4]; // Human, Dwarf, Gnome, Night Elf
    const hordeRaces = [2, 5, 6, 8]; // Orc, Undead, Tauren, Troll
    const allRaces = [...allianceRaces, ...hordeRaces];

    const getSpritePosition = (race: number, gender: number) => {
      let col = 0;
      let row = gender === 0 ? 0 : 2;

      if (race === 1) col = 0;
      else if (race === 3) col = 1;
      else if (race === 7) col = 2;
      else if (race === 4) col = 3;
      else {
        row += 1;
        if (race === 6) col = 0;
        else if (race === 5) col = 1;
        else if (race === 8) col = 2;
        else if (race === 2) col = 3;
      }
      return `${col * 33.33}% ${row * 33.33}%`;
    };

    return allRaces
      .map((race) => {
        const bgPos = getSpritePosition(race, this.currentGender);
        const selected = race === this.currentRace ? 'selected' : '';
        return `<div class="glue-grid-item ${selected}" data-race="${race}"><div class="glue-race-icon" style="background-position: ${bgPos}"></div></div>`;
      })
      .join('');
  }

  private renderClassGrid(): string {
    const allowed = RACE_CLASS_MATRIX[this.currentRace] || [1];

    // Authentic CLASS_BUTTONS texcoords from 1.12 GlueXML CharacterCreate.lua — the atlas is a
    // 4×4 grid (0.25 UV steps): warrior/mage/rogue/druid row 0, hunter/shaman/priest/warlock
    // row 1, paladin row 2. (The old ad-hoc 4×3 mapping cut icons across cell boundaries.)
    const getClassSpritePosition = (cls: number) => {
      let col = 0, row = 0;
      if (cls === 1) { col = 0; row = 0; }       // Warrior
      else if (cls === 8) { col = 1; row = 0; }  // Mage
      else if (cls === 4) { col = 2; row = 0; }  // Rogue
      else if (cls === 11) { col = 3; row = 0; } // Druid
      else if (cls === 3) { col = 0; row = 1; }  // Hunter
      else if (cls === 7) { col = 1; row = 1; }  // Shaman
      else if (cls === 5) { col = 2; row = 1; }  // Priest
      else if (cls === 9) { col = 3; row = 1; }  // Warlock
      else if (cls === 2) { col = 0; row = 2; }  // Paladin
      return `${col * 33.33}% ${row * 33.33}%`;
    };

    return allowed
      .map((cls) => {
        const bgPos = getClassSpritePosition(cls);
        const selected = cls === this.currentClass ? 'selected' : '';
        return `<div class="glue-grid-item ${selected}" data-class="${cls}"><div class="glue-class-icon" style="background-position: ${bgPos}"></div></div>`;
      })
      .join('');
  }

  private renderSlider(id: string, label: string): string {
    return `
      <div class="glue-slider-row" data-slider="${id}">
        <div class="glue-slider-label">${this.escape(label)}</div>
        <button class="glue-slider-btn glue-slider-prev" data-action="prev" aria-label="Previous ${this.escape(label)}"></button>
        <button class="glue-slider-btn glue-slider-next" data-action="next" aria-label="Next ${this.escape(label)}"></button>
      </div>
    `;
  }

  private bindEvents() {
    if (!this.currentScreenEl) return;

    // Race grid clicks
    this.currentScreenEl.querySelectorAll('#glue-race-grid .glue-grid-item').forEach((item) => {
      item.addEventListener('click', () => {
        this.currentRace = Number((item as HTMLElement).dataset.race);
        this.onRaceChanged?.(this.currentRace);
        
        // Auto select first allowed class
        const allowed = RACE_CLASS_MATRIX[this.currentRace] || [1];
        if (!allowed.includes(this.currentClass)) {
          this.currentClass = allowed[0];
        }
        this.resetCustomizations();
        this.render();
      });
    });

    // Class grid clicks
    this.currentScreenEl.querySelectorAll('#glue-class-grid .glue-grid-item').forEach((item) => {
      item.addEventListener('click', () => {
        this.currentClass = Number((item as HTMLElement).dataset.class);
        this.render();
      });
    });

    // Gender clicks
    this.currentScreenEl.querySelectorAll('.glue-gender-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.currentGender = Number((btn as HTMLElement).dataset.gender);
        this.resetCustomizations();
        this.render();
      });
    });

    // Customization slider clicks
    this.currentScreenEl.querySelectorAll('.glue-slider-row').forEach((row) => {
      const sliderId = (row as HTMLElement).dataset.slider!;
      const config = this.getCustomizationConfig();
      const max = (config as any)[sliderId] || 1;

      const prev = row.querySelector('[data-action="prev"]')!;
      const next = row.querySelector('[data-action="next"]')!;

      prev.addEventListener('click', () => {
        let val = (this as any)[sliderId + 'Index'];
        val = (val - 1 + max) % max;
        (this as any)[sliderId + 'Index'] = val;
        this.updatePreviewCharacter();
      });

      next.addEventListener('click', () => {
        let val = (this as any)[sliderId + 'Index'];
        val = (val + 1) % max;
        (this as any)[sliderId + 'Index'] = val;
        this.updatePreviewCharacter();
      });
    });

    // Bind rotation buttons
    const rotLeft = this.currentScreenEl.querySelector('#glue-rotate-left')!;
    const rotRight = this.currentScreenEl.querySelector('#glue-rotate-right')!;

    const setRot = (dir: 'left' | 'right' | 'none') => {
      this.rotationState = dir;
      if (dir !== 'none') {
        this.preview.setAutoRotate(false);
      } else {
        setTimeout(() => {
          if (this.rotationState === 'none') {
            this.preview.setAutoRotate(true);
          }
        }, 5000);
      }
    };

    rotLeft.addEventListener('pointerdown', () => setRot('left'));
    rotLeft.addEventListener('pointerup', () => setRot('none'));
    rotLeft.addEventListener('pointerleave', () => setRot('none'));

    rotRight.addEventListener('pointerdown', () => setRot('right'));
    rotRight.addEventListener('pointerup', () => setRot('none'));
    rotRight.addEventListener('pointerleave', () => setRot('none'));

    // The enUS 1.12.1 frame exposes appearance randomization; its random-name button is hidden.
    this.currentScreenEl.querySelector('#glue-create-randomize')!.addEventListener('click', () => {
      const config = this.getCustomizationConfig();
      this.skinIndex = Math.floor(Math.random() * config.skin);
      this.faceIndex = Math.floor(Math.random() * config.face);
      this.hairStyleIndex = Math.floor(Math.random() * config.hairStyle);
      this.hairColorIndex = Math.floor(Math.random() * config.hairColor);
      this.facialHairIndex = config.facialHair > 0 ? Math.floor(Math.random() * config.facialHair) : 0;
      this.updatePreviewCharacter();
    });

    // Zoom/Close up click
    this.currentScreenEl.querySelectorAll('.glue-slider-row').forEach((row) => {
      const sliderId = (row as HTMLElement).dataset.slider!;
      row.addEventListener('mouseenter', () => {
        if (['face', 'hairStyle', 'hairColor', 'facialHair'].includes(sliderId)) {
          this.preview.setViewMode('face');
        } else {
          this.preview.setViewMode('full');
        }
      });
    });

    // Accept / Cancel buttons
    this.currentScreenEl.querySelector('#glue-create-accept')!.addEventListener('click', () => this.handleAccept());
    this.currentScreenEl.querySelector('#glue-create-cancel')!.addEventListener('click', () => this.onCancel());
  }

  private updatePreviewCharacter() {
    // Build fake CharacterInfo struct
    const fake: CharacterInfo = {
      guid: '0',
      guidBytes: [0, 0, 0, 0, 0, 0, 0, 0],
      name: 'Preview',
      race: this.currentRace,
      classId: this.currentClass,
      gender: this.currentGender,
      skin: this.skinIndex,
      face: this.faceIndex,
      hairStyle: this.hairStyleIndex,
      hairColor: this.hairColorIndex,
      facialHair: this.facialHairIndex,
      level: 1,
      zone: 0,
      map: 0,
      x: 0,
      y: 0,
      z: 0,
      equipment: [5, 8, 9, 11].includes(this.currentClass)
        ? [
            { displayInfoId: 11668, inventoryType: 20 },
            { displayInfoId: 10003, inventoryType: 8 },
          ]
        : [
            { displayInfoId: 10001, inventoryType: 4 },
            { displayInfoId: 10002, inventoryType: 7 },
            { displayInfoId: 10003, inventoryType: 8 },
          ],
    };
    this.preview.loadCharacter(fake);
  }

  private async handleAccept() {
    if (!this.nameInput) return;
    const name = this.nameInput.value.trim();
    const errEl = document.getElementById('glue-create-name-error')!;

    const nameError = validateCharacterName(name);
    if (nameError) {
      errEl.textContent = nameError;
      errEl.style.display = 'block';
      this.nameInput.focus();
      return;
    }

    errEl.style.display = 'none';
    this.overlay.showLoading(`Creating character ${name}...`);

    try {
      const result = await this.worldClient.createCharacter({
        name,
        race: this.currentRace,
        classId: this.currentClass,
        gender: this.currentGender,
        skin: this.skinIndex,
        face: this.faceIndex,
        hairStyle: this.hairStyleIndex,
        hairColor: this.hairColorIndex,
        facialHair: this.facialHairIndex,
      });

      if (result.success) {
        // Reload character list and transition back
        await this.worldClient.reloadCharacters();
        this.overlay.hideLoading();
        this.preview.unload();
        this.onCreated();
      } else {
        this.overlay.hideLoading();
        errEl.textContent = result.error || 'Failed to create character.';
        errEl.style.display = 'block';
      }
    } catch (err) {
      this.overlay.hideLoading();
      errEl.textContent = (err as Error).message;
      errEl.style.display = 'block';
    }
  }

  private escape(value: string) {
    return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
  }
}
