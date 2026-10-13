import { qaGlobals } from '../qa-globals';
import {
  cyclePerformanceControl,
  onPerformanceControlChange,
  performanceControlState,
  setPerformanceInstrumentationSource,
  type PerformanceControlName,
} from './performance-controls';
import { performanceFrameProfiler, type PerformanceProfilerSnapshot } from './performance-frame-profiler';
import { PERFORMANCE_BUILD_INFO } from './performance-build-info';
import { performanceDetailDiagnostics } from './performance-detail-diagnostics';
import { cpuScopeProfiler, type CpuScopeSnapshot } from './performance-cpu-scopes';
import { rendererAttributionSnapshot, type RendererAttributionSnapshot } from './performance-renderer-attribution';
import { performanceAttributionCsv } from './performance-capture-export';

type HudHandle = { toggle(): void; show(): void; hide(): void; refresh(): void };
type SupplementalProvider = () => Record<string, unknown>;

const UPDATE_INTERVAL_MS = 1_000;
const SPARK = '▁▂▃▄▅▆▇█';
const PHASE_COLORS = ['#ef5350', '#ff9800', '#fdd835', '#66bb6a', '#42a5f5', '#ab47bc', '#26c6da', '#8d6e63'];

const css = `
#vanillagl-performance-hud{position:fixed;z-index:2147483646;left:8px;top:8px;width:min(590px,calc(100vw - 16px));max-height:calc(100vh - 16px);overflow:auto;background:rgba(7,10,15,.94);color:#d8e0ea;border:1px solid #546477;border-radius:5px;font:12px/1.3 Consolas,monospace;box-shadow:0 4px 18px #000b;pointer-events:auto}
#vanillagl-performance-hud[hidden]{display:none} #vanillagl-performance-hud *{box-sizing:border-box}
#vanillagl-performance-hud header{position:sticky;top:0;display:flex;align-items:center;gap:5px;padding:6px;background:#111923;z-index:1;border-bottom:1px solid #354657}
#vanillagl-performance-hud header strong{margin-right:auto;color:#fff} #vanillagl-performance-hud button{font:inherit;color:#dce8f5;background:#253343;border:1px solid #4d6278;border-radius:3px;padding:2px 6px;cursor:pointer}
#vanillagl-performance-hud button:hover{background:#344a60} #vanillagl-performance-hud .body{padding:6px}
#vanillagl-performance-hud .metrics{display:grid;grid-template-columns:135px 115px 1fr;gap:2px 7px;margin-bottom:5px}
#vanillagl-performance-hud .metric{display:contents} #vanillagl-performance-hud .label{color:#9cafc2} #vanillagl-performance-hud .value{text-align:right;color:#e8f0f8}
#vanillagl-performance-hud .history{color:#7295b7;white-space:pre;overflow:hidden} #vanillagl-performance-hud .good .value{color:#79d279} #vanillagl-performance-hud .warn .value{color:#ffd85a} #vanillagl-performance-hud .hot .value{color:#ff9b42} #vanillagl-performance-hud .bad .value{color:#ff5f5f}
#vanillagl-performance-hud canvas{display:block;width:100%;height:84px;background:#0a0f15;border:1px solid #263747;margin:4px 0}
#vanillagl-performance-hud .warnings{color:#ffcb66;min-height:16px} #vanillagl-performance-hud .top-costs{color:#b8cadb;white-space:pre-wrap}
#vanillagl-performance-hud details{border-top:1px solid #2c3948;padding:4px 0} #vanillagl-performance-hud summary{cursor:pointer;color:#c9d8e8}
#vanillagl-performance-hud pre{white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;margin:5px 0;color:#aebed0}
#vanillagl-performance-hud .switches{display:flex;flex-wrap:wrap;gap:4px;margin:5px 0} #vanillagl-performance-hud .foot{color:#71859a;margin-top:4px}
`;

function sparkline(values: readonly number[], maxValue?: number): string {
  const tail = values.slice(-42);
  const max = maxValue ?? Math.max(0.001, ...tail);
  return tail.map((value) => SPARK[Math.min(SPARK.length - 1, Math.floor((value / max) * (SPARK.length - 1)))]).join('');
}

function severity(value: number, yellow: number, orange: number, red: number): string {
  return value >= red ? 'bad' : value >= orange ? 'hot' : value >= yellow ? 'warn' : 'good';
}

function download(name: string, type: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function csvFor(snapshot: PerformanceProfilerSnapshot, scopes?: CpuScopeSnapshot | null, renderer?: RendererAttributionSnapshot | null): string {
  const lines = ['frame,raf_ms,cpu_ms,render_ms,gpu_ms'];
  for (const frame of snapshot.history) {
    lines.push([frame.id, frame.rafMs, frame.cpuMs, frame.renderMs, frame.gpuMs ?? ''].join(','));
  }
  return `${lines.join('\n')}\n\n${performanceAttributionCsv(scopes, renderer)}`;
}

function warningsFor(snapshot: PerformanceProfilerSnapshot, detail?: unknown): string[] {
  const warnings: string[] = [];
  const phase = (name: string) => snapshot.phaseCosts.find((value) => value.name === name)?.p95Ms ?? 0;
  const data = detail as { subsystemCosts?: { currentFrame?: { picking?: { maxMs?: number }; m2?: { totalMs?: number } } }; wmoRender?: { submissions?: number } } | undefined;
  if (snapshot.renderMs.p95 > Math.max(6, snapshot.cpuWorkMs.p95 * 0.45)) warnings.push('render submission dominates');
  if (snapshot.gpuMs.samples && snapshot.gpuMs.p95 > Math.max(16.667, snapshot.cpuWorkMs.p95)) warnings.push('GPU-bound');
  if (phase('entity-animation') > 3 || phase('doodad-skeletal-animation') > 2 || (data?.subsystemCosts?.currentFrame?.m2?.totalMs ?? 0) > 3) warnings.push('animation sampling spike');
  if ((data?.subsystemCosts?.currentFrame?.picking?.maxMs ?? 0) > 2) warnings.push('picking spike');
  if (phase('runtime-work-scheduler') > 2 || phase('world-hydration') > 2) warnings.push('streaming hitch');
  if ((data?.wmoRender?.submissions ?? 0) > 1_000) warnings.push('WMO submissions are high');
  return warnings;
}

function drawFrameGraph(canvas: HTMLCanvasElement, snapshot: PerformanceProfilerSnapshot): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const width = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio));
  const height = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  ctx.clearRect(0, 0, width, height);
  const frames = snapshot.history;
  if (!frames.length) return;
  const scale = height / 50;
  const step = width / Math.max(1, frames.length - 1);
  for (const [field, color] of [['rafMs', '#f2f5f8'], ['cpuMs', '#49a7ff'], ['renderMs', '#ff9f43']] as const) {
    ctx.strokeStyle = color; ctx.lineWidth = devicePixelRatio; ctx.beginPath();
    frames.forEach((frame, index) => {
      const y = height - Math.min(height, frame[field] * scale);
      if (index === 0) ctx.moveTo(0, y); else ctx.lineTo(index * step, y);
    });
    ctx.stroke();
  }
  ctx.strokeStyle = '#e8c54788'; ctx.beginPath();
  const budgetY = height - 16.667 * scale; ctx.moveTo(0, budgetY); ctx.lineTo(width, budgetY); ctx.stroke();
}

function drawPhaseGraph(canvas: HTMLCanvasElement, snapshot: PerformanceProfilerSnapshot): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const width = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio));
  const height = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  ctx.clearRect(0, 0, width, height);
  const frames = snapshot.phaseHistory.frames.slice(-120);
  if (!frames.length) return;
  const barWidth = width / frames.length;
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
    let y = height;
    frames[frameIndex].forEach((value, phaseIndex) => {
      const h = Math.min(y, (value / 16.667) * height);
      y -= h;
      ctx.fillStyle = PHASE_COLORS[phaseIndex % PHASE_COLORS.length];
      ctx.fillRect(frameIndex * barWidth, y, Math.max(1, barWidth), h);
    });
  }
}

export function installPerformanceHud(getSupplemental: SupplementalProvider): HudHandle | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  const search = new URLSearchParams(location.search);
  const devBuild = Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
  if (!devBuild && search.get('perfhud') !== '1' && search.get('debugtools') !== '1') return null;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const root = document.createElement('section');
  root.id = 'vanillagl-performance-hud';
  root.hidden = true;
  root.innerHTML = `<header><strong>VanillaGL frame profiler</strong><button data-action="freeze">Freeze</button><button data-action="gpu">GPU: off</button><button data-action="details">Deep snapshot</button><button data-action="json">JSON</button><button data-action="csv">CSV</button><button data-action="close">×</button></header><div class="body"><div class="metrics"></div><div class="warnings"></div><div class="top-costs"></div><canvas data-graph="frames" title="RAF (white), CPU (blue), submit (orange); click a frame to inspect"></canvas><details><summary>Stacked CPU-phase graph</summary><canvas data-graph="phases" title="Stacked recent CPU phases"></canvas></details><details open><summary>Runtime A/B controls</summary><div class="switches"></div></details><details><summary>CPU attribution (capture-only, intrusive)</summary><pre data-panel="cpu-attribution">Run __vanillaPerfCapture({ cpuScopes: true, ... }). Native V8 sampling is external DevTools data.</pre></details><details><summary>Selected slow frame</summary><pre data-panel="selected"></pre></details><details><summary>Subsystem counters</summary><pre data-panel="subsystems"></pre></details><details><summary>Streaming / memory / renderer (manual)</summary><pre data-panel="runtime">Press Deep snapshot to collect expensive world, streaming and memory diagnostics outside a measured run.</pre></details><div class="foot">Alt+Shift+P toggles · fixed 360-frame buffer · HUD refresh 1 Hz · GPU and deep diagnostics opt-in</div></div>`;
  document.body.appendChild(root);

  const metricNames = ['FPS', 'RAF interval', 'CPU work', 'Render submit', 'GPU', '60 Hz CPU headroom', 'Long / 30 Hz frames', 'Profiler overhead', 'Draw calls', 'Triangles'];
  const metrics = root.querySelector('.metrics')!;
  const metricRows = new Map<string, { root: HTMLElement; value: HTMLElement; history: HTMLElement }>();
  for (const name of metricNames) {
    const row = document.createElement('div'); row.className = 'metric';
    const label = document.createElement('span'); label.className = 'label'; label.textContent = name;
    const value = document.createElement('span'); value.className = 'value';
    const history = document.createElement('span'); history.className = 'history';
    row.append(label, value, history); metrics.appendChild(row); metricRows.set(name, { root: row, value, history });
  }
  const frameGraph = root.querySelector('[data-graph="frames"]') as HTMLCanvasElement;
  const phaseGraph = root.querySelector('[data-graph="phases"]') as HTMLCanvasElement;
  const selectedPanel = root.querySelector('[data-panel="selected"]') as HTMLElement;
  const subsystemPanel = root.querySelector('[data-panel="subsystems"]') as HTMLElement;
  const runtimePanel = root.querySelector('[data-panel="runtime"]') as HTMLElement;
  const cpuAttributionPanel = root.querySelector('[data-panel="cpu-attribution"]') as HTMLElement;
  const warnings = root.querySelector('.warnings') as HTMLElement;
  const topCosts = root.querySelector('.top-costs') as HTMLElement;
  const switches = root.querySelector('.switches') as HTMLElement;
  const switchNames: PerformanceControlName[] = ['shadows', 'm2Sampling', 'hoverPicking', 'minimap', 'wmoRendering'];
  const switchButtons = new Map<PerformanceControlName, HTMLButtonElement>();
  for (const name of switchNames) {
    const button = document.createElement('button'); button.dataset.control = name; switches.appendChild(button); switchButtons.set(name, button);
  }

  let shown = false;
  let lastUpdateAt = -Infinity;
  let lastSnapshot = performanceFrameProfiler.snapshot();
  let lastSupplemental: Record<string, unknown> | null = null;
  let refreshTimer: number | null = null;
  let deepSnapshotPending = false;
  let lastHudRefreshMs = 0;
  const updateSwitches = () => {
    const state = performanceControlState();
    for (const name of switchNames) {
      const text = `${name}: ${state[name]}`;
      if (switchButtons.get(name)!.textContent !== text) switchButtons.get(name)!.textContent = text;
    }
  };
  const setMetric = (name: string, value: string, history: string, level = 'good') => {
    const row = metricRows.get(name)!;
    const className = `metric ${level}`;
    if (row.root.className !== className) row.root.className = className;
    if (row.value.textContent !== value) row.value.textContent = value;
    if (row.history.textContent !== history) row.history.textContent = history;
  };
  const refresh = (force = false) => {
    if (!shown || (performanceFrameProfiler.isFrozen() && !force)) return;
    const now = performance.now();
    if (!force && now - lastUpdateAt < UPDATE_INTERVAL_MS) return;
    lastUpdateAt = now;
    const snapshot = performanceFrameProfiler.snapshot(); lastSnapshot = snapshot;
    const detail = performanceDetailDiagnostics();
    const rafHistory = snapshot.history.map((frame) => frame.rafMs);
    const cpuHistory = snapshot.history.map((frame) => frame.cpuMs);
    const renderHistory = snapshot.history.map((frame) => frame.renderMs);
    setMetric('FPS', `${snapshot.fps.current.toFixed(1)} now · ${snapshot.fps.mean.toFixed(1)} avg`, `p50 ${snapshot.fps.p50.toFixed(1)}  p95 ${snapshot.fps.p95.toFixed(1)}  p99 ${snapshot.fps.p99.toFixed(1)}`, severity(60 - snapshot.fps.mean, 2, 8, 20));
    setMetric('RAF interval', `${snapshot.frameTimeMs.current.toFixed(2)} ms`, sparkline(rafHistory, 50), severity(snapshot.frameTimeMs.p95, 12, 16.667, 33.333));
    setMetric('CPU work', `${snapshot.cpuWorkMs.current.toFixed(2)} ms`, sparkline(cpuHistory, 25), severity(snapshot.cpuWorkMs.p95, 6, 11, 16.667));
    setMetric('Render submit', `${snapshot.renderMs.current.toFixed(2)} ms`, sparkline(renderHistory, 16), severity(snapshot.renderMs.p95, 4, 8, 12));
    setMetric('GPU', snapshot.gpuMs.samples ? `${snapshot.gpuMs.current.toFixed(2)} ms` : snapshot.gpuStatus, snapshot.gpuMs.samples ? `p95 ${snapshot.gpuMs.p95.toFixed(2)} ms` : '', severity(snapshot.gpuMs.p95, 8, 13, 16.667));
    setMetric('60 Hz CPU headroom', `${snapshot.cpuBudgetRemainingP95Ms.toFixed(2)} ms`, '', snapshot.cpuBudgetRemainingP95Ms < 0 ? 'bad' : snapshot.cpuBudgetRemainingP95Ms < 3 ? 'hot' : 'good');
    setMetric('Long / 30 Hz frames', `${snapshot.longFrames} / ${snapshot.dropped30HzFrames}`, '', snapshot.dropped30HzFrames ? 'bad' : snapshot.longFrames > 20 ? 'hot' : 'good');
    setMetric('Profiler overhead', `${snapshot.overheadMs.mean.toFixed(3)} ms avg · HUD ${lastHudRefreshMs.toFixed(2)} ms`, `p95 ${snapshot.overheadMs.p95.toFixed(3)}`, severity(Math.max(snapshot.overheadMs.p95, lastHudRefreshMs), .25, .5, 1));
    setMetric('Draw calls', String(snapshot.current?.calls ?? 0), '', severity(snapshot.current?.calls ?? 0, 800, 1400, 1800));
    setMetric('Triangles', (snapshot.current?.triangles ?? 0).toLocaleString(), '', 'good');
    warnings.textContent = warningsFor(snapshot, detail).map((value) => `⚠ ${value}`).join(' · ') || 'No active budget warning';
    topCosts.textContent = `Top now: ${snapshot.phaseCosts.slice(0, 5).map((phase) => `${phase.name} ${phase.currentMs.toFixed(2)}ms`).join(' · ')}`;
    if ((selectedPanel.parentElement as HTMLDetailsElement | null)?.open) selectedPanel.textContent = JSON.stringify(snapshot.selected, null, 2);
    if ((subsystemPanel.parentElement as HTMLDetailsElement | null)?.open) subsystemPanel.textContent = JSON.stringify(detail ?? { note: 'Enter the world to populate subsystem counters.' }, null, 2);
    if ((cpuAttributionPanel.parentElement as HTMLDetailsElement | null)?.open) {
      const scopes = cpuScopeProfiler.snapshot(); const rendererAttribution = rendererAttributionSnapshot();
      cpuAttributionPanel.textContent = JSON.stringify({
        warning: scopes.frames.length ? 'Intrusive capture-only attribution; not a clean FPS baseline.' : 'CPU scopes are disabled by default.',
        dataSources: { cpuScopes: 'in-page hierarchical wall-clock scopes', nativeV8: 'external Chrome DevTools sampling; not included here' },
        overhead: { scopes: scopes.overhead, renderer: rendererAttribution?.profilerOverhead ?? null },
        topInclusive: scopes.scopes.slice(0, 10),
        topSelf: [...scopes.scopes].sort((a, b) => b.selfMs - a.selfMs).slice(0, 10),
        slowestFrame: scopes.slowestFrame,
        categories: rendererAttribution?.categories ?? [],
        rendererCurrent: rendererAttribution?.current ?? null,
        ablations: rendererAttribution?.ablations ?? [],
        wmoDrilldown: rendererAttribution?.wmoDrilldown ?? null,
      }, null, 2);
    }
    drawFrameGraph(frameGraph, snapshot);
    if ((phaseGraph.parentElement as HTMLDetailsElement | null)?.open) drawPhaseGraph(phaseGraph, snapshot);
    updateSwitches();
    lastHudRefreshMs = Math.max(0, performance.now() - now);
    performanceFrameProfiler.addOverhead(lastHudRefreshMs);
  };

  const refreshDeepSnapshot = () => {
    if (deepSnapshotPending) return;
    deepSnapshotPending = true;
    runtimePanel.textContent = 'Collecting manual deep snapshot…';
    window.setTimeout(() => {
      const started = performance.now();
      try {
        lastSupplemental = getSupplemental();
        runtimePanel.textContent = `Manual snapshot cost ${Math.max(0, performance.now() - started).toFixed(2)} ms\n${JSON.stringify(lastSupplemental, null, 2)}`;
      } catch (error) {
        runtimePanel.textContent = `Deep snapshot failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        deepSnapshotPending = false;
      }
    }, 0);
  };
  const show = () => {
    shown = true; root.hidden = false; setPerformanceInstrumentationSource('hud', true); refresh(true);
    if (refreshTimer === null) refreshTimer = window.setInterval(() => refresh(), UPDATE_INTERVAL_MS);
  };
  const hide = () => {
    shown = false; root.hidden = true; setPerformanceInstrumentationSource('hud', false);
    if (refreshTimer !== null) { window.clearInterval(refreshTimer); refreshTimer = null; }
  };
  const toggle = () => shown ? hide() : show();
  root.querySelector('header')?.insertAdjacentHTML('beforeend', '<button data-action="diagnose">Scan bottlenecks</button><button data-action="soak">120s soak</button>');
  onPerformanceControlChange(() => { updateSwitches(); refresh(true); });
  root.addEventListener('click', (event) => {
    event.stopPropagation();
    const target = event.target as HTMLElement;
    const control = target.dataset.control as PerformanceControlName | undefined;
    if (control) { cyclePerformanceControl(control); return; }
    const action = target.dataset.action;
    if (action === 'diagnose' || action === 'soak') {
      const run = qaGlobals[action === 'diagnose' ? '__vanillaPerfDiagnose' : '__vanillaMobileSoak'] as (() => Promise<unknown>) | undefined;
      if (run) { hide(); void run().catch(error => { console.error(error); show(); }); }
      return;
    }
    if (action === 'close') hide();
    else if (action === 'freeze') { performanceFrameProfiler.setFrozen(!performanceFrameProfiler.isFrozen()); target.textContent = performanceFrameProfiler.isFrozen() ? 'Resume' : 'Freeze'; refresh(true); }
    else if (action === 'gpu') { performanceFrameProfiler.setGpuEnabled(!performanceFrameProfiler.isGpuEnabled()); target.textContent = `GPU: ${performanceFrameProfiler.isGpuEnabled() ? 'on' : 'off'}`; refresh(true); }
    else if (action === 'details') refreshDeepSnapshot();
    else if (action === 'json') download(`vanillagl-profiler-${Date.now()}.json`, 'application/json', JSON.stringify({ schema: 'vanillagl.performance-hud/v2', build: PERFORMANCE_BUILD_INFO, page: location.href, userAgent: navigator.userAgent, controls: performanceControlState(), frames: lastSnapshot, cpuAttribution: cpuScopeProfiler.snapshot(), rendererAttribution: rendererAttributionSnapshot(), performanceDetail: performanceDetailDiagnostics(), manualDiagnostics: lastSupplemental }, null, 2));
    else if (action === 'csv') download(`vanillagl-profiler-${Date.now()}.csv`, 'text/csv', csvFor(lastSnapshot, cpuScopeProfiler.snapshot(), rendererAttributionSnapshot()));
  });
  frameGraph.addEventListener('click', (event) => {
    const rect = frameGraph.getBoundingClientRect();
    const index = Math.min(lastSnapshot.history.length - 1, Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * lastSnapshot.history.length)));
    performanceFrameProfiler.selectFrame(lastSnapshot.history[index]?.id ?? null); refresh(true);
  });
  window.addEventListener('keydown', (event) => {
    if (event.altKey && event.shiftKey && event.code === 'KeyP') { event.preventDefault(); toggle(); }
  });
  performanceFrameProfiler.setGpuEnabled(search.get('perfgpu') === '1');
  updateSwitches();
  if (search.get('perfhud') === '1') show();
  const handle = { toggle, show, hide, refresh: () => refresh(true) };
  qaGlobals.__vanillaPerfHud = handle;
  return handle;
}
