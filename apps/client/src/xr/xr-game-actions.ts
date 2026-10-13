/** Use the HUD's actual handlers, independent of desktop key rebinding or keyboard focus. */
export function xrGameAction(name: string) {
  const selectors: Record<string, string> = { Bags: '.wow-backpack-button', Character: '.wow-micro-button--character',
    Spells: '.wow-micro-button--spellbook', Quests: '.wow-micro-button--quest', Map: '.wow-micro-button--world',
    'Game settings': '.wow-micro-button--mainmenu' };
  if (name === 'Skills') {
    if (document.querySelector('#wow-character-frame')?.classList.contains('is-hidden')) xrGameAction('Character');
    document.querySelector<HTMLButtonElement>('[data-char-tab="skills"]')?.click();
  } else document.querySelector<HTMLButtonElement>(selectors[name] ?? 'button[data-no-xr-action]')?.click();
}
