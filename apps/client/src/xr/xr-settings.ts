export type XrSettings = { resolution: number; foveation: number; distance: number; handScale: number; pitch: number; roll: number };
const key = 'vanillagl-xr-settings-v1';
export function defaultXrSettings(standalone: boolean): XrSettings {
  return { resolution: standalone ? 0.85 : 1.25, foveation: standalone ? 0.5 : 0,
    distance: standalone ? 180 : 500, handScale: 0.8, pitch: 0, roll: 0 };
}
export function sanitizeXrSettings(value: Partial<XrSettings>, defaults: XrSettings): XrSettings {
  const range = (name: keyof XrSettings, min: number, max: number) => Number.isFinite(value[name])
    ? Math.max(min, Math.min(max, value[name]!)) : defaults[name];
  return { resolution: range('resolution', 0.7, 1.5), foveation: range('foveation', 0, 1), distance: range('distance', 100, 700),
    handScale: range('handScale', 0.6, 1), pitch: range('pitch', -90, 90), roll: range('roll', -90, 90) };
}
export function loadXrSettings(): XrSettings {
  const defaults = defaultXrSettings(/OculusBrowser|Quest|Android/i.test(navigator.userAgent));
  try { return sanitizeXrSettings(JSON.parse(localStorage.getItem(key) ?? '{}') ?? {}, defaults); } catch { return defaults; }
}
export function saveXrSettings(settings: XrSettings) {
  try { localStorage.setItem(key, JSON.stringify(settings)); } catch { /* Private browsing can disable persistence. */ }
}

/** One action per hold, with a tap deferred until release. Interruption cancels both. */
export class XrHoldButton {
  private started: number | undefined;
  private fired = false;
  sample(pressed: boolean, time: number): 'tap' | 'hold' | 'release' | undefined {
    if (pressed) {
      if (this.started === undefined) this.started = time;
      if (!this.fired && time - this.started >= 450) { this.fired = true; return 'hold'; }
    } else if (this.started !== undefined) {
      const result = this.fired ? 'release' : 'tap'; this.reset(); return result;
    }
    return undefined;
  }
  get pressed() { return this.started !== undefined; }
  reset() { this.started = undefined; this.fired = false; }
}
