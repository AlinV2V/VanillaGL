export type LightingPanelValues = Record<string, number>;

export const createLightingPanel = (opts: {
  dayLength: number;
  values: () => LightingPanelValues;
  setTuning: (partial: Record<string, number>) => void;
  onManualTime: () => void;
  log: (message: string) => void;
}) => {
  const { dayLength, values, setTuning, onManualTime, log } = opts;
  const panel = document.createElement('div');
  panel.id = 'lighting-panel';
  panel.style.cssText =
    'position:fixed;right:10px;bottom:10px;z-index:9998;width:230px;background:rgba(18,22,28,0.92);' +
    'color:#dfe6ec;font:12px/1.5 monospace;border:1px solid #3a4654;border-radius:8px;padding:8px 10px;' +
    'box-shadow:0 4px 16px rgba(0,0,0,0.5);user-select:none';
  const sliders: Array<{ key: string; label: string; min: number; max: number; step: number }> = [
    { key: 'ambsat', label: 'ambient saturation', min: 0, max: 1, step: 0.02 },
    { key: 'amb', label: 'ambient brightness', min: 0, max: 2, step: 0.02 },
    { key: 'sun', label: 'sun strength', min: 0, max: 2, step: 0.02 },
    { key: 'exp', label: 'exposure', min: 0.3, max: 2, step: 0.02 },
    { key: 'fog', label: 'fog distance', min: 0.2, max: 3, step: 0.05 },
    { key: 'zone', label: 'zone light (0=global)', min: 0, max: 1, step: 0.05 },
    { key: 'tex', label: 'texture scale', min: 16, max: 256, step: 8 },
    { key: 'detail', label: 'terrain detail/highlight', min: 0, max: 1, step: 0.05 },
  ];
  const current = (): LightingPanelValues => values();
  const header = document.createElement('div');
  header.textContent = '☀ Lighting ▾';
  header.style.cssText = 'cursor:pointer;font-weight:bold;margin-bottom:6px;color:#ffd34d';
  panel.appendChild(header);
  const body = document.createElement('div');
  panel.appendChild(body);

  const fmtTime = (t: number) => {
    const mins = Math.round(t / 2) % 1440;
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  };
  const timeRow = document.createElement('div');
  timeRow.style.cssText = 'margin:5px 0';
  const timeLabel = document.createElement('div');
  timeLabel.style.cssText = 'display:flex;justify-content:space-between';
  const timeSpan = document.createElement('span');
  timeLabel.append('time of day: ', timeSpan);
  const timeInput = document.createElement('input');
  timeInput.type = 'range';
  timeInput.min = '0';
  timeInput.max = String(dayLength);
  timeInput.step = '15';
  timeInput.value = String(current().time);
  timeSpan.textContent = fmtTime(current().time);
  timeInput.style.cssText = 'width:100%;accent-color:#ffd34d';
  timeInput.addEventListener('input', () => {
    onManualTime();
    setTuning({ time: Number(timeInput.value) });
    timeSpan.textContent = fmtTime(Number(timeInput.value));
  });
  timeRow.append(timeLabel, timeInput);
  body.appendChild(timeRow);

  const valueSpans: Record<string, HTMLSpanElement> = {};
  for (const s of sliders) {
    const row = document.createElement('div');
    row.style.cssText = 'margin:5px 0';
    const label = document.createElement('div');
    const span = document.createElement('span');
    valueSpans[s.key] = span;
    label.append(`${s.label}: `, span);
    label.style.cssText = 'display:flex;justify-content:space-between';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(s.min);
    input.max = String(s.max);
    input.step = String(s.step);
    input.value = String(current()[s.key]);
    span.textContent = Number(input.value).toFixed(2);
    input.style.cssText = 'width:100%;accent-color:#ffd34d';
    input.addEventListener('input', () => {
      setTuning({ [s.key]: Number(input.value) });
      span.textContent = Number(input.value).toFixed(2);
    });
    row.append(label, input);
    body.appendChild(row);
  }

  const buttons = document.createElement('div');
  buttons.style.cssText = 'display:flex;gap:6px;margin-top:8px';
  const copyBtn = document.createElement('button');
  copyBtn.textContent = 'Copy values';
  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  for (const b of [copyBtn, resetBtn]) {
    b.style.cssText =
      'flex:1;cursor:pointer;background:#2a3340;color:#dfe6ec;border:1px solid #3a4654;border-radius:5px;padding:4px';
  }
  copyBtn.addEventListener('click', () => {
    const text = JSON.stringify(current());
    void navigator.clipboard.writeText(text).then(() => {
      copyBtn.textContent = 'Copied!';
      log(`lighting ${text} -- paste this to me to bake in`);
      window.setTimeout(() => (copyBtn.textContent = 'Copy values'), 1200);
    });
  });
  resetBtn.addEventListener('click', () => {
    setTuning({ amb: 1, sun: 1, ambsat: 1, exp: 1, fog: 1 });
    for (const s of sliders) {
      const v = current()[s.key];
      (body.querySelectorAll('input')[sliders.indexOf(s)] as HTMLInputElement).value = String(v);
      valueSpans[s.key].textContent = v.toFixed(2);
    }
  });
  buttons.append(copyBtn, resetBtn);
  body.appendChild(buttons);

  let open = true;
  const toggle = () => {
    open = !open;
    body.style.display = open ? 'block' : 'none';
    header.textContent = open ? '☀ Lighting ▾' : '☀ Lighting ▸';
  };
  header.addEventListener('click', toggle);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyL' && !(e.target instanceof HTMLInputElement)) toggle();
  });
  document.body.appendChild(panel);
  return panel;
};
