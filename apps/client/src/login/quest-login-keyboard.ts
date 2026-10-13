/** Canvas fallback for Quest Browser system-keyboard/compositor failures on the login page.
 * Credentials stay in the existing form, with password masking and normal input events.
 */
export function installQuestLoginKeyboard(form: HTMLFormElement, enabled = /OculusBrowser|Quest/i.test(navigator.userAgent)) {
  if (!enabled) return () => {};
  const inputs = [...form.querySelectorAll<HTMLInputElement>('input:not([type=checkbox])')];
  if (!inputs.length) return () => {};
  const saved = inputs.map(input => ({ inputMode: input.inputMode, readOnly: input.readOnly }));
  const canvas = document.createElement('canvas'); canvas.width = 1100; canvas.height = 400;
  canvas.setAttribute('aria-label', 'Quest login keyboard'); canvas.dataset.questKeyboard = 'true';
  canvas.tabIndex = 0;
  // The fallback belongs to this form's screen so navigation removes it immediately.
  Object.assign(canvas.style, { position: 'fixed', left: '50%', bottom: '12px', transform: 'translateX(-50%)',
    width: 'min(92vw, 1000px)', height: 'auto', zIndex: '20000', touchAction: 'none' });
  form.closest('.glue-screen')?.appendChild(canvas) ?? form.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;
  let target = inputs[0], shift = false, symbols = false, open = true;
  let hits: { x: number; y: number; w: number; h: number; key: string }[] = [];
  const rows = () => symbols ? ["!@#$%^&*()", "-_=+[]{}\\|", ";:'\",.<>/?", '`~']
    : ['1234567890', shift ? 'QWERTYUIOP' : 'qwertyuiop', shift ? 'ASDFGHJKL' : 'asdfghjkl', shift ? 'ZXCVBNM' : 'zxcvbnm'];
  const draw = () => {
    ctx.fillStyle = '#152133'; ctx.fillRect(0, 0, 1100, 400); hits = [];
    ctx.font = '24px sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    const button = (key: string, x: number, y: number, w: number, h = 54) => {
      ctx.fillStyle = '#344d68'; ctx.fillRect(x + 3, y + 3, w - 6, h - 6); ctx.fillStyle = '#fff';
      ctx.fillText(key, x + w / 2, y + h / 2); hits.push({ x, y, w, h, key });
    };
    button('Account', 0, 0, 180); button('Password', 180, 0, 180);
    button(open ? 'Hide' : 'Keyboard', 900, 0, 200);
    ctx.fillStyle = '#ffdc87';
    const label = target.type === 'password' ? 'Password: ' + '•'.repeat(target.value.length) : 'Account: ' + target.value;
    ctx.fillText(label.slice(0, 44), 630, 27, 520);
    if (open) {
      rows().forEach((row, r) => [...row].forEach((key, c) => button(key, c * 110, 58 + r * 64, 110, 64)));
      ['Shift', 'Symbols', 'Space', 'Backspace', 'Next', 'Login'].forEach((key, i) => button(key, i * (1100 / 6), 320, 1100 / 6, 70));
    }
  };
  const focus = (event: Event) => { target = event.target as HTMLInputElement; open = true; canvas.height = 400; draw(); };
  for (const input of inputs) {
    // Avoid summoning the broken system surface. Physical typing and canvas edits still work.
    input.inputMode = 'none'; input.autocapitalize = 'off'; input.spellcheck = false;
    input.addEventListener('focus', focus); input.addEventListener('input', draw);
  }
  const activate = (key: string) => {
    if (key === 'Hide' || key === 'Keyboard') { open = !open; canvas.height = open ? 400 : 54; }
    else if (key === 'Account' || key === 'Password' || key === 'Next') {
      target = key === 'Account' ? inputs[0] : key === 'Password' ? inputs[1] ?? inputs[0] : inputs[(inputs.indexOf(target) + 1) % inputs.length];
      open = true; canvas.height = 400;
    } else if (key === 'Shift') shift = !shift;
    else if (key === 'Symbols') symbols = !symbols;
    else if (key === 'Login') { if (!form.querySelector<HTMLButtonElement>('[type=submit]')?.disabled) form.requestSubmit(); }
    else if (!target.disabled) {
      const start = target.selectionStart ?? target.value.length, end = target.selectionEnd ?? start;
      const data = key === 'Backspace' ? '' : key === 'Space' ? ' ' : key;
      const inputType = key === 'Backspace' ? 'deleteContentBackward' : 'insertText';
      if (target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data }))) {
        target.setRangeText(data, key === 'Backspace' && start === end ? Math.max(0, start - 1) : start, end, 'end');
        target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data }));
      }
    }
    draw();
  };
  canvas.addEventListener('pointerdown', event => event.preventDefault());
  canvas.addEventListener('click', event => {
    event.preventDefault(); const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * canvas.width, y = (event.clientY - rect.top) / rect.height * canvas.height;
    const hit = hits.find(h => x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h);
    if (hit) activate(hit.key);
  });
  draw();
  return () => {
    canvas.remove(); inputs.forEach((input, i) => {
      input.inputMode = saved[i].inputMode; input.readOnly = saved[i].readOnly;
      input.removeEventListener('focus', focus); input.removeEventListener('input', draw);
    });
  };
}
