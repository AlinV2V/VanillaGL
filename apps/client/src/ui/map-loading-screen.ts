export type WorldRevealEnvironment = {
  isHidden: () => boolean;
  requestFrame: (callback: () => void) => void;
  subscribeVisibility?: (callback: () => void) => () => void;
};

const defaultRevealEnvironment: WorldRevealEnvironment = {
  isHidden: () => document.hidden,
  requestFrame: (callback) => requestAnimationFrame(callback),
  subscribeVisibility: (callback) => {
    document.addEventListener('visibilitychange', callback);
    return () => document.removeEventListener('visibilitychange', callback);
  },
};

const waitForFrameOrHidden = (environment: WorldRevealEnvironment): Promise<boolean> => {
  if (environment.isHidden()) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const finish = (rendered: boolean) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      resolve(rendered);
    };
    unsubscribe = environment.subscribeVisibility?.(() => {
      if (environment.isHidden()) finish(false);
    });
    environment.requestFrame(() => finish(true));
    if (environment.isHidden()) finish(false);
  });
};

export const loadingScreenBackground = (mapId: number): string => mapId === 0
  ? '/ui/Interface/Glues/LoadingScreens/LoadScreenEasternKingdom.png'
  : mapId === 1
    ? '/ui/Interface/Glues/LoadingScreens/LoadScreenKalimdor.png'
    : '/ui/Interface/Glues/LoadingScreens/LoadScreenDungeon.png';

/**
 * Preserve the visible-tab two-frame correctness gate without deadlocking a hidden tab. Assets and
 * essential uploads are already settled before this runs; hidden pages have no frames to inspect.
 */
export async function waitForWorldRevealFrames(
  environment: WorldRevealEnvironment = defaultRevealEnvironment,
): Promise<boolean> {
  for (let frame = 0; frame < 2; frame++) {
    if (!await waitForFrameOrHidden(environment)) return false;
  }
  return true;
}

export function showMapLoadingScreen(mapId: number): void {
  document.getElementById('map-loading-screen')?.remove();
  const screen = document.createElement('div');
  screen.id = 'map-loading-screen';
  screen.className = 'glue-load-screen-overlay';
  screen.style.backgroundImage = `url('${loadingScreenBackground(mapId)}')`;
  screen.innerHTML = `
    <div id="map-loading-progress" class="glue-load-progress" role="progressbar" aria-label="Loading world" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <div class="glue-load-progress-background"></div>
      <div id="map-loading-progress-fill" class="glue-load-progress-fill"></div>
      <div class="glue-load-progress-glow"></div>
      <div class="glue-load-progress-glass"></div>
      <div class="glue-load-progress-border"></div>
    </div>`;
  document.body.appendChild(screen);
}

export function updateMapLoadingProgress(percent: number): void {
  const progress = document.getElementById('map-loading-progress');
  if (!progress) return;
  const value = Math.max(0, Math.min(100, percent));
  progress.style.setProperty('--loading-progress', `${value}%`);
  progress.setAttribute('aria-valuenow', String(Math.round(value)));
}

export function hideMapLoadingScreen(): void {
  const screen = document.getElementById('map-loading-screen');
  if (!screen) return;
  if (document.hidden) {
    screen.remove();
    return;
  }
  screen.classList.add('is-hiding');
  window.setTimeout(() => screen.remove(), 500);
}
