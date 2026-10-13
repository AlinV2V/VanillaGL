import type { MirrorTimerEvent } from '../world';
import { MirrorTimerCanvas } from './mirror-timer';
import type { LuaMirrorTimer } from './lua-mirror/runtime';

/** Default path is unchanged. Only ?mirrortimer=lua downloads/initializes the VM. */
export function createMirrorTimers(host: HTMLElement, mode = new URLSearchParams(location.search).get('mirrortimer')) {
  const legacy = new MirrorTimerCanvas(host);
  if (mode !== 'lua') return legacy;
  const luaHost = document.createElement('div');
  luaHost.style.transform = 'translateY(-25px)';
  let lua: LuaMirrorTimer | undefined;
  let disposed = false;
  type State = Extract<MirrorTimerEvent, { kind: 'start' }> & { at: number };
  const states = new Map<number, State>();
  const dispose = () => {
    disposed = true; states.clear(); legacy.clear(); lua?.dispose(); luaHost.remove();
    window.removeEventListener('pagehide', onPageHide);
  };
  const onPageHide = (event: PageTransitionEvent) => { if (!event.persisted) dispose(); };
  window.addEventListener('pagehide', onPageHide);
  const advance = (state: State, at: number) => {
    if (!state.paused) state.remainingMs = Math.max(0, Math.min(state.durationMs, state.remainingMs + state.scale * (at - state.at)));
    state.at = at;
  };
  const visible = () => host.classList.toggle('is-hidden', states.size === 0);
  const activate = import('./lua-mirror/runtime').then(async ({ LuaMirrorTimer }) => {
    const ready = await LuaMirrorTimer.create(luaHost);
    if (disposed) { ready.dispose(); return; }
    const now = performance.now();
    for (const state of states.values()) { advance(state, now); ready.handle(state); }
    legacy.clear();
    // Keep the existing instance available, with only its visual surface hidden.
    const canvas = host.querySelector<HTMLCanvasElement>('.wow-mirror-timer-canvas');
    if (canvas) canvas.style.display = 'none';
    host.appendChild(luaHost);
    lua = ready; host.dataset.mirrorTimerBackend = 'lua'; visible();
  }).catch(error => {
    luaHost.remove(); host.dataset.mirrorTimerBackend = 'typescript-fallback';
    console.warn('[Lua mirror timer] Prototype unavailable; existing UI remains active.', error);
  });
  void activate;
  host.dataset.mirrorTimerBackend = 'typescript-loading-lua';
  return {
    ready: activate,
    dispose,
    handle(event: MirrorTimerEvent) {
      if (disposed) return;
      if (event.timerType < 0 || event.timerType > 2) return;
      const now = performance.now();
      const state = states.get(event.timerType);
      if (event.kind === 'start') states.set(event.timerType, { ...event, at: now });
      else if (event.kind === 'pause' && state) { advance(state, now); state.paused = event.paused; }
      else if (event.kind === 'stop') states.delete(event.timerType);
      if (lua) { lua.handle(event); visible(); } else legacy.handle(event);
    },
    clear() { states.clear(); legacy.clear(); lua?.clear(); visible(); },
  };
}
