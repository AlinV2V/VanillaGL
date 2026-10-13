/** Asset conversion utility. */
import type { StableState, StabledPet } from '../world';
import { drawMoney } from './money';
import { CanvasPanel, drawItemButton, UI_GOLD, UI_GRAY, UI_RED, UI_WHITE, type PanelHit } from './panel-kit';

const FRAME_WIDTH = 384;
const FRAME_HEIGHT = 512;
/** NUM_PET_STABLE_SLOTS, PetStable.lua:1. */
const STABLE_SLOTS = 2;
const SLOT_SIZE = 37;
/** BOTTOMLEFT (95,150) -> canvas y = 512 - 150 - 37. */
const CURRENT_SLOT = { x: 95, y: FRAME_HEIGHT - 150 - SLOT_SIZE };
/** +53 then +15 gaps measured edge-to-edge from the previous button's RIGHT. */
const SLOT_X = [CURRENT_SLOT.x + SLOT_SIZE + 53, CURRENT_SLOT.x + SLOT_SIZE + 53 + SLOT_SIZE + 15];

/**
 * StableSlotPrices.dbc rows 1 and 2. The server charges from that DBC
 * (NPCHandler.cpp:717) and we do not bake it, so these are shown as a hint and the
 * server's answer (STABLE_ERR_MONEY) remains authoritative.
 */
const SLOT_PRICE_HINT = [10_000, 100_000];

export type PetStableDeps = {
  playUi: (name: string) => void;
  getUnitPortraitSource?: (guid: string) => CanvasImageSource | undefined;
  creatureIconUrl: (entry: number) => string | undefined;
  getPlayerMoney: () => number;
  stableCurrentPet: () => void;
  unstablePet: (petNumber: number) => void;
  swapPet: (petNumber: number) => void;
  buySlot: () => void;
  onClose: () => void;
};

export class PetStableCanvasPanel extends CanvasPanel {
  private stableState?: StableState;
  private portraitGuid?: string;
  private portraitSource?: CanvasImageSource;
  /** 0 = the active pet, 1..2 = stable slots — matches PetStable.lua's `selectedPet`. */
  private selected = 0;

  constructor(private readonly host: HTMLElement, private readonly deps: PetStableDeps) {
    super(host, FRAME_WIDTH, FRAME_HEIGHT, 'wow-native-panel-canvas', { playUi: deps.playUi });
  }

  show(state: StableState) {
    if (state.guid !== this.portraitGuid) {
      this.portraitGuid = state.guid;
      this.portraitSource = undefined;
    }
    const opening = !this.isOpen();
    this.stableState = state;
    if (opening) {
      this.selected = 0;
      this.host.classList.remove('is-hidden');
      this.playUi('igMainMenuOpen');
    }
    this.updatePortrait();
    this.surface.requestRender();
  }

  update(state: StableState) {
    if (!this.isOpen()) return;
    this.stableState = state;
    this.updatePortrait();
    this.surface.requestRender();
  }

  updatePortrait() {
    const guid = this.stableState?.guid;
    if (!guid || !this.isOpen()) return;
    const source = this.deps.getUnitPortraitSource?.(guid);
    if (source && source !== this.portraitSource) {
      this.portraitSource = source;
      this.surface.requestRender();
    }
  }

  hide() {
    this.host.classList.add('is-hidden');
  }

  isOpen() {
    return !this.host.classList.contains('is-hidden');
  }

  /** Wire slot 1 is the pet that is out; 2..3 are stable slots 1..2. */
  private petAt(uiSlot: number): StabledPet | undefined {
    return this.stableState?.pets.find((pet) => pet.slot === uiSlot + 1);
  }

  protected paint() {
    const s = this.surface;
    s.clear();
    s.fourSlice('/ui/Interface/PetStableFrame', [
      'UI-PetStable-TopLeft', 'UI-PetStable-TopRight', 'UI-PetStable-BottomLeft', 'UI-PetStable-BottomRight',
    ]);
    if (this.portraitSource) s.source(this.portraitSource, 12, 8, 58, 58, { circular: true });
    else s.image('/ui/Interface/CharacterFrame/TemporaryPortrait-Monster.png', 12, 8, 58, 58);
    // STABLES, GlobalStrings.lua:3637.
    s.text('Stables', 192, 26, { size: 13, color: UI_WHITE, align: 'center', baseline: 'middle' });
    s.closeButton(FRAME_WIDTH - 29 - 32, 8, this.buttonState('close'));
    this.hit('close', { x: FRAME_WIDTH - 29 - 32, y: 8, width: 32, height: 32 });

    const purchased = this.stableState?.stableSlots ?? 0;
    // STABLED_PETS, GlobalStrings.lua:3636.
    s.text('Stabled Pets:', CURRENT_SLOT.x, CURRENT_SLOT.y - 14, { size: 12, color: UI_GOLD });

    this.paintSlot('slot:0', CURRENT_SLOT.x, CURRENT_SLOT.y, 0, true);
    for (let index = 0; index < STABLE_SLOTS; index++) {
      this.paintSlot(`slot:${index + 1}`, SLOT_X[index], CURRENT_SLOT.y, index + 1, index < purchased);
    }

    const selectedPet = this.petAt(this.selected);
    if (selectedPet) {
      // UNIT_LEVEL_TEMPLATE = "Level %d". PetStable.lua:86 concatenates name, level and family.
      s.text(`${selectedPet.name} Level ${selectedPet.level}`, 192, 110, {
        size: 14, color: UI_WHITE, align: 'center',
      });
      s.text(`Loyalty ${selectedPet.loyalty}`, 192, 130, { size: 12, color: UI_GOLD, align: 'center' });
    } else {
      // EMPTY_STABLE_SLOT, GlobalStrings.lua:1167.
      s.text(this.selected === 0 ? 'No pet' : 'Empty Stable Slot', 192, 110, {
        size: 13, color: UI_GRAY, align: 'center',
      });
    }

    // Vanilla has NO stable/call/swap button: the slot buttons ARE the action. Both
    // PetStableCurrentPet and PetStableStabledPetN run `ClickStablePet(this:GetID())`
    // (PetStable.xml:42-52), and the client picks the opcode from the current state. Anything
    // else here would be a control the 1.12 UI does not have.

    // PetStablePurchaseButton 80x22 at BOTTOMRIGHT (-110,105); the cost sits to its left.
    const purchaseRect = { x: FRAME_WIDTH - 110 - 80, y: FRAME_HEIGHT - 105 - 22, width: 80, height: 22 };
    const canBuy = purchased < STABLE_SLOTS;
    s.panelButton('Purchase', purchaseRect, canBuy ? this.buttonState('purchase') : 'disabled');
    this.hit('purchase', purchaseRect, { disabled: !canBuy });
    if (canBuy) {
      s.text('Cost:', 40, purchaseRect.y + 15, { size: 12, color: UI_GOLD });
      drawMoney(s, 80, purchaseRect.y + 4, SLOT_PRICE_HINT[purchased] ?? 0, { align: 'left' });
    } else {
      s.text('All stable slots purchased.', 40, purchaseRect.y + 15, { size: 12, color: UI_GRAY });
    }

    // PetStableMoneyFrame BOTTOMRIGHT (-45,84).
    drawMoney(s, FRAME_WIDTH - 45, FRAME_HEIGHT - 84 - 12, this.deps.getPlayerMoney(), { align: 'right' });
  }

  private paintSlot(id: string, x: number, y: number, uiSlot: number, unlocked: boolean) {
    const s = this.surface;
    const pet = this.petAt(uiSlot);
    const icon = pet ? this.deps.creatureIconUrl(pet.entry) : undefined;
    drawItemButton(s, x, y, SLOT_SIZE, {
      iconUrl: icon,
      hover: this.isHover(id),
      disabled: !unlocked,
    });
    if (!unlocked) {
      // PetStable.lua:112 tints a locked slot's background red rather than hiding it.
      s.addImage('/ui/Interface/Buttons/UI-EmptySlot.png', x - 13, y - 13, 64, 64, 0.25);
      s.text('X', x + SLOT_SIZE / 2, y + SLOT_SIZE / 2 + 5, { size: 16, color: UI_RED, align: 'center' });
    }
    if (uiSlot === this.selected) {
      s.addImage('/ui/Interface/Buttons/CheckButtonHilight.png', x - 2, y - 2, SLOT_SIZE + 4, SLOT_SIZE + 4, 0.9);
    }
    this.hit(id, { x, y, width: SLOT_SIZE, height: SLOT_SIZE }, {
      disabled: !unlocked,
      tooltip: pet
        ? [{ text: pet.name, color: UI_WHITE }, { text: `Level ${pet.level}`, color: '#ffffff' }]
        : unlocked
          ? [{ text: 'Empty Stable Slot', color: UI_WHITE }]
          : undefined,
    });
  }

  private buttonState(id: string): 'normal' | 'hover' | 'down' {
    const state = this.state(id);
    return state === 'disabled' ? 'normal' : state;
  }

  protected activate(hit: PanelHit) {
    if (hit.id === 'close') {
      this.playUi('igMainMenuClose');
      this.deps.onClose();
      this.hide();
      return;
    }
    if (hit.id.startsWith('slot:')) {
      // `ClickStablePet(slotId)` — selecting and acting are the same click in 1.12.
      const uiSlot = Number(hit.id.slice(5));
      this.selected = uiSlot;
      this.playUi('igMainMenuOptionCheckBoxOn');
      this.surface.requestRender();
      const activePet = this.petAt(0);
      const clicked = this.petAt(uiSlot);
      if (uiSlot === 0) {
        // Clicking the pet that is out stables it, if a slot has been bought.
        if (activePet && (this.stableState?.stableSlots ?? 0) > 0) this.deps.stableCurrentPet();
        return;
      }
      if (clicked) {
        // CMSG_STABLE_SWAP_PET while a pet is summoned, CMSG_UNSTABLE_PET otherwise —
        // vMaNGOS rejects an unstable with a pet already out (NPCHandler.cpp:661-700).
        if (activePet) this.deps.swapPet(clicked.petNumber);
        else this.deps.unstablePet(clicked.petNumber);
      } else if (activePet) {
        // Dropping the active pet into an empty purchased slot.
        this.deps.stableCurrentPet();
      }
      return;
    }
    if (hit.id === 'purchase') this.deps.buySlot();
  }
}
