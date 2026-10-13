import { LuaFactory, type LuaEngine } from 'wasmoon';
import wasmUrl from 'wasmoon/dist/glue.wasm?url';
import frameApi from './frame-api.lua?raw';
import type { MirrorTimerEvent } from '../../world';
import { readMirrorXml } from './framexml';
import { MirrorXmlRenderer } from './renderer';

export type TimerSnapshot = { name: string; shown: boolean; timer?: string; value?: number; paused: boolean };
type Manifest = { version: number; build: number; labels: Record<string, string>; sources: {path: string; sha256: string; bytes: number}[] };
const timerNames = ['EXHAUSTION', 'BREATH', 'FEIGNDEATH'];
const factory = new LuaFactory(wasmUrl);
export class LuaMirrorTimer {
  private disposed = false;
  private raf = 0;
  private previous = performance.now();
  private readonly start: (...args: unknown[]) => boolean;
  private readonly pause: (...args: unknown[]) => void;
  private readonly event: (...args: unknown[]) => void;
  private readonly tick: (elapsed: number) => void;
  private readonly inspect: () => TimerSnapshot[];
  private readonly active: () => boolean;
  private constructor(private readonly lua: LuaEngine, readonly renderer: MirrorXmlRenderer,
    readonly manifest: Manifest, private readonly autoTick: boolean) {
    this.start = lua.global.get('__start'); this.pause = lua.global.get('__pause');
    this.event = lua.global.get('__event'); this.tick = lua.global.get('__tick');
    this.inspect = lua.global.get('__snapshot');
    this.active = lua.global.get('__active');
  }
  static async create(host: HTMLElement, options: { autoTick?: boolean; width?: number; height?: number; originY?: number; assetBase?: string } = {}) {
    const base = options.assetBase ?? '/ui-lua/mirror-timer';
    const fetchText = async (name: string) => {
      const response = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Lua timer asset ${name}: HTTP ${response.status}. Run the mirror-timer baker.`);
      return response.text();
    };
    const [source, xml, meta] = await Promise.all(['MirrorTimer.lua', 'MirrorTimer.xml', 'manifest.json'].map(fetchText));
    const manifest: Manifest = JSON.parse(meta);
    if (manifest.version !== 1 || manifest.build !== 5875) throw new Error('Expected Build 5875 timer assets');
    for (const [name, content] of [['MirrorTimer.lua', source], ['MirrorTimer.xml', xml]]) {
      const entry = manifest.sources.find(s => s.path.endsWith(name));
      const bytes = new TextEncoder().encode(content);
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join('');
      if (!entry || entry.sha256 !== digest) throw new Error(`Extracted ${name} does not match its manifest`);
    }
    const nodes = readMirrorXml(xml);
    const lua = await factory.createEngine({ enableProxy: false, functionTimeout: 100 });
    let renderer: MirrorXmlRenderer | undefined;
    try {
      renderer = new MirrorXmlRenderer(nodes, host, options.width, options.height, options.originY);
      const surface = renderer;
      lua.global.set('__ui', (name: string, method: string, ...args: (number | string | boolean)[]) => surface.mutate(name, method, ...args));
      lua.doStringSync(frameApi);
      lua.doStringSync(source);
      const create = lua.global.get('__create');
      const script = lua.global.get('__script');
      for (const node of nodes) create(node.name, node.parent, node.hidden, node.level);
      for (const node of nodes) for (const [kind, code] of Object.entries(node.scripts)) script(node.name, kind, code);
      lua.global.get('__initialize')();
      const result = new LuaMirrorTimer(lua, renderer, manifest, options.autoTick !== false);
      result.clear();
      return result;
    } catch (error) { renderer?.dispose(); lua.global.close(); throw error; }
  }
  private label(name: string) { return this.manifest.labels[name] ?? 'Feign Death'; }
  handle(input: MirrorTimerEvent) {
    if (this.disposed) return;
    const name = timerNames[input.timerType];
    if (!name) return;
    if (this.autoTick) this.advanceClock();
    if (input.kind === 'start') this.start(name, input.remainingMs, input.durationMs, input.scale, input.paused ? 1 : 0, this.label(name));
    else if (input.kind === 'pause') this.pause(name, input.paused ? 1 : 0, this.label(name));
    else this.event('MIRROR_TIMER_STOP', name);
    this.renderer.requestRender();
    this.schedule();
  }
  /** Deterministic clock for the comparison page and regression; production uses RAF. */
  advance(seconds: number) {
    if (this.disposed) return;
    this.tick(Math.max(0, seconds));
    this.renderer.requestRender();
  }
  snapshot(): TimerSnapshot[] { return this.disposed ? [] : this.inspect(); }
  private advanceClock() {
    const now = performance.now();
    this.advance((now - this.previous) / 1000);
    this.previous = now;
  }
  private schedule() {
    if (!this.autoTick || this.raf || this.disposed) return;
    if (!this.active()) return;
    this.previous = performance.now();
    this.raf = requestAnimationFrame(() => {
      this.raf = 0; this.advanceClock(); this.schedule();
    });
  }
  clear() {
    if (this.disposed) return;
    cancelAnimationFrame(this.raf); this.raf = 0;
    this.event('PLAYER_ENTERING_WORLD');
    this.renderer.requestRender(); this.previous = performance.now();
  }
  dispose() {
    if (this.disposed) return;
    this.clear(); this.disposed = true; this.renderer.dispose(); this.lua.global.close();
  }
}
