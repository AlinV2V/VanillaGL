import type { PetSnapshot } from '../world';
import { qaGlobals } from '../qa-globals';
import { BeastTrainingCanvasPanel } from './beast-training-frame';

/** Offline CraftFrame fixture: Cat family filtering, rank refunds, red gates and a long list. */
export function showBeastTrainingPreview(hud: HTMLElement) {
  const host = document.createElement('section');
  host.className = 'wow-tradeskill-frame is-hidden';
  hud.appendChild(host);
  const portrait = new Image();
  const pet: PetSnapshot = {
    guid: 'pet-preview', name: 'Ashclaw', level: 32, petFamily: 2, trainingPoints: 17,
    spellState: { spells: [{ action: 4189 }, { action: 16829 }, { action: 17256 }] } as PetSnapshot['spellState'],
  };
  // A representative level-32 spellbook. Great Stamina rank 4 becomes the first row and costs
  // only 10 TP because rank 3 is known; incompatible family abilities are filtered by the model.
  const known = [
    4198, 4199, 4200, 4201, 1749, 1750, 2982, 3667, 2975, 2976,
    17263, 17264, 17265, 17266, 23100, 23111, 24440, 24441, 24451, 24454,
  ];
  const panel = new BeastTrainingCanvasPanel(host, {
    getKnownSpells: () => known, getPet: () => pet,
    castSpell: (spellId) => { qaGlobals.__wowPreviewBeastTrainingCast = spellId; host.dataset.castSpell = String(spellId); },
    getPlayerPortraitSource: () => portrait.complete && portrait.naturalWidth ? portrait : undefined,
    playUi: () => {},
  });
  portrait.addEventListener('load', () => panel.refresh(), { once: true });
  portrait.src = '/ui/Interface/CharacterFrame/TemporaryPortrait-Male-Human.png';
  void panel.initialize().then(() => panel.tryOpen(5149));
  return true;
}
