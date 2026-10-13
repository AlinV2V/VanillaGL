import type { CharacterInfo, RealmWorldClient } from '../world';
import { RACES, CLASSES, MAP_NAMES } from './constants';
import type { GlueOverlay } from './GlueOverlay';
import type { CharacterPreview } from './CharacterPreview';

export class CharacterSelect {
  private selectedIndex = 0;
  private selectedNameEl: HTMLElement | null = null;
  private rotationState: 'left' | 'right' | 'none' = 'none';

  constructor(
    private readonly overlay: GlueOverlay,
    private readonly preview: CharacterPreview,
    private readonly worldClient: RealmWorldClient,
    private readonly realmName: string,
    private readonly onEnterWorld: (character: CharacterInfo) => void | Promise<void>,
    private readonly onCreateCharacter: () => void,
    private readonly onChangeRealm: () => void,
    private readonly onBack: () => void,
    private readonly onRaceChanged?: (race: number) => void
  ) {}

  show() {
    this.selectedIndex = 0;
    this.rotationState = 'none';
    this.render();
  }

  getRotationState(): 'left' | 'right' | 'none' {
    return this.rotationState;
  }

  private render() {
    const list = this.worldClient.characters;

    let listHtml = '';
    list.forEach((char, index) => {
      const race = RACES[char.race] ?? `Race ${char.race}`;
      const klass = CLASSES[char.classId] ?? `Class ${char.classId}`;
      const zoneName = MAP_NAMES[char.map] ?? `Map ${char.map}`;
      listHtml += `
        <div class="glue-char-item ${index === this.selectedIndex ? 'selected' : ''}" data-index="${index}">
          <div class="glue-char-name">${this.escape(char.name)}</div>
          <div class="glue-char-desc">Level ${char.level} ${race} ${klass}</div>
          <div class="glue-char-location">${this.escape(zoneName)}</div>
        </div>
      `;
    });

    if (list.length === 0) {
      listHtml = `
        <div class="glue-char-empty">No characters on this realm</div>
      `;
    }

    const html = `
      <div class="glue-char-select-container">
        <div class="glue-char-preview" role="status" aria-live="polite"></div>
        <div class="glue-wow-logo" aria-hidden="true"></div>
        <div id="glue-char-selected-name" class="glue-char-selected-name"></div>

        <button id="glue-char-enter" class="glue-button glue-button-large glue-char-enter" ${!list.length ? 'disabled' : ''}>Enter World</button>

        <div class="glue-rotate-container glue-char-select-rotate">
          <button id="glue-rotate-left" class="glue-rotate-btn glue-rotate-left"></button>
          <button id="glue-rotate-right" class="glue-rotate-btn glue-rotate-right"></button>
        </div>

        <div class="glue-char-roster">
          <div class="glue-char-realm-name">${this.escape(this.realmName)}</div>
          <button id="glue-char-realm" class="glue-button glue-char-realm">Change Realm</button>
          <div class="glue-char-list-box">
            ${listHtml}
          </div>
          <button id="glue-char-create" class="glue-button glue-char-create-new">Create New Character</button>
        </div>

        <button id="glue-char-delete" class="glue-button glue-char-delete" ${!list.length ? 'disabled' : ''}>Delete Character</button>
        <button id="glue-char-back" class="glue-button glue-char-back">Back</button>
        <button id="glue-char-addons" class="glue-button glue-char-addons">AddOns</button>
      </div>
    `;

    const el = this.overlay.showScreen(html);
    this.selectedNameEl = el.querySelector('#glue-char-selected-name')!;

    // Bind row clicks
    const items = el.querySelectorAll<HTMLDivElement>('.glue-char-item');
    items.forEach((item) => {
      item.addEventListener('click', () => {
        items.forEach((x) => x.classList.remove('selected'));
        item.classList.add('selected');
        this.selectCharacter(Number(item.dataset.index));
      });

      item.addEventListener('dblclick', () => {
        this.selectCharacter(Number(item.dataset.index));
        this.enterWorld();
      });
    });

    // Bind rotation buttons
    const rotLeft = el.querySelector('#glue-rotate-left')!;
    const rotRight = el.querySelector('#glue-rotate-right')!;

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

    // Bind action buttons
    el.querySelector('#glue-char-enter')!.addEventListener('click', () => this.enterWorld());
    el.querySelector('#glue-char-create')!.addEventListener('click', () => this.onCreateCharacter());
    el.querySelector('#glue-char-delete')!.addEventListener('click', () => this.confirmDeleteCharacter());
    el.querySelector('#glue-char-realm')!.addEventListener('click', () => this.onChangeRealm());
    el.querySelector('#glue-char-back')!.addEventListener('click', () => this.onBack());
    el.querySelector('#glue-char-addons')!.addEventListener('click', () => {
      this.overlay.showError('AddOn management is not available in this browser build.');
    });

    // Initial load
    if (list.length > 0) {
      this.selectCharacter(this.selectedIndex);
    } else {
      this.preview.unload();
    }
  }

  private selectCharacter(index: number) {
    const list = this.worldClient.characters;
    const char = list[index];
    if (!char) return;

    this.selectedIndex = index;
    this.onRaceChanged?.(char.race);
    
    // Update preview mode
    this.preview.setViewMode('full');
    const slot = document.querySelector('.glue-char-preview');
    if (slot) slot.textContent = 'Loading character…';
    void this.preview.loadCharacter(char).then(() => {
      if (slot?.isConnected && this.selectedIndex === index) {
        slot.textContent = this.preview.ready ? '' : 'Character preview unavailable';
      }
    });

    if (this.selectedNameEl) this.selectedNameEl.textContent = char.name;
  }

  private enterWorld() {
    const list = this.worldClient.characters;
    const char = list[this.selectedIndex];
    if (char) {
      this.preview.unload();
      void this.onEnterWorld(char);
    }
  }

  private confirmDeleteCharacter() {
    const list = this.worldClient.characters;
    const char = list[this.selectedIndex];
    if (!char) return;

    const overlay = this.overlay;
    const nameInputId = 'glue-delete-confirm-name';

    // WoW-like delete verification: user must type "DELETE" to confirm
    const html = `
      <div class="glue-popup-overlay">
        <div class="glue-dialog glue-error-dialog" style="width: 360px;">
          <div class="glue-dialog-header">Delete Character</div>
          <div class="glue-dialog-body">
            <p style="color:#fff; text-align:center;">Enter "DELETE" to confirm deletion of <strong style="color:#ff0000;">${this.escape(char.name)}</strong>:</p>
            <div class="glue-input-container" style="margin-top: 10px;">
              <input id="${nameInputId}" class="glue-input" style="text-align: center; text-transform: uppercase;" autocomplete="off" />
            </div>
            <div class="glue-dialog-actions" style="display:flex; justify-content:space-between; margin-top:15px;">
              <button id="glue-delete-cancel" class="glue-button">Cancel</button>
              <button id="glue-delete-confirm-btn" class="glue-button" disabled>Delete</button>
            </div>
          </div>
        </div>
      </div>
    `;

    const popup = document.createElement('div');
    popup.innerHTML = html;
    const popupEl = popup.firstElementChild as HTMLElement;
    document.getElementById('glue-overlay')!.appendChild(popupEl);

    const input = popupEl.querySelector(`#${nameInputId}`) as HTMLInputElement;
    const deleteBtn = popupEl.querySelector('#glue-delete-confirm-btn') as HTMLButtonElement;
    const cancelBtn = popupEl.querySelector('#glue-delete-cancel')!;

    input.focus();

    input.addEventListener('input', () => {
      deleteBtn.disabled = input.value.trim().toUpperCase() !== 'DELETE';
    });

    cancelBtn.addEventListener('click', () => {
      popupEl.remove();
    });

    deleteBtn.addEventListener('click', async () => {
      popupEl.remove();
      this.overlay.showLoading(`Deleting ${char.name}...`);
      try {
        const res = await this.worldClient.deleteCharacter(char.guidBytes);
        if (res.success) {
          await this.worldClient.reloadCharacters();
          this.overlay.hideLoading();
          this.render(); // Redraw character select list
        } else {
          this.overlay.hideLoading();
          this.overlay.showError(res.error || 'Deletion failed.');
        }
      } catch (err) {
        this.overlay.hideLoading();
        this.overlay.showError((err as Error).message);
      }
    });
  }

  private escape(value: string) {
    return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
  }
}
