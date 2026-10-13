import type { PerformanceProfile } from '../../platform/performance-profile';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const MAJOR_PANEL_SELECTOR = [
  '.wow-character-frame',
  '.wow-spellbook-frame',
  '.wow-social-frame',
  '.wow-quest-log-frame',
  '.wow-ui-panel',
  '.wow-auction-frame',
  '.wow-mail-frame',
  '.wow-tradeskill-frame',
  '.wow-bank-frame',
  '.wow-trade-frame',
  '.wow-pet-stable-frame',
  '.wow-petition-frame',
  '.wow-guild-registrar-frame',
  '.wow-esc-layer',
  '.wow-keybinding-layer',
  '.wow-macro-layer',
].join(',');

const isVisible = (element: HTMLElement) =>
  !element.classList.contains('is-hidden') && getComputedStyle(element).display !== 'none';

function visibleContainerFrames(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.wow-container-frame')).filter(isVisible);
}

function hasMajorPanelOpen() {
  return Array.from(document.querySelectorAll<HTMLElement>(MAJOR_PANEL_SELECTOR)).some(isVisible);
}

export function mobileViewportScales(width: number, height: number, requestedUiScale = 1.25, phone = true) {
  const landscape = width > height;
  const multiplier = clamp(requestedUiScale / 1.25, 0.64 / 1.25, 2 / 1.25);
  const landscapeHudScale = clamp(height / 768, 0.48, 0.68) * multiplier;
  const hudScale = phone ? (landscape ? landscapeHudScale : clamp(width / 600, .56, .78) * multiplier) : requestedUiScale;
  const physicalPanelScale = clamp(Math.min((width - 20) / 384, (height - 20) / 512), 0.64, 1);
  const localScale = (physicalScale: number) => physicalScale / hudScale;
  return {
    landscape,
    hudScale,
    landscapeHudScale,
    landscapeControlScale: clamp(height / 520, 0.62, 0.78),
    panelScale: localScale(physicalPanelScale),
    wideScale: localScale(clamp(Math.min((width - 20) / 768, (height - 20) / 471), 0.48, 1)),
    mailScale: localScale(clamp(Math.min((width - 20) / 520, (height - 20) / 560), 0.56, 1)),
    tradeSkillScale: localScale(clamp(Math.min((width - 20) / 430, (height - 20) / 535), 0.58, 1)),
    bagScale: localScale(clamp(physicalPanelScale + (landscape ? 0.06 : 0), 0.68, 0.98)),
  };
}

export function installMobileViewportLayout(profile: PerformanceProfile): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};

  const root = document.documentElement;
  const mobile = profile.device.mobile;
  root.classList.toggle('vanillagl-mobile', mobile);
  root.classList.toggle('vanillagl-phone', mobile && profile.device.kind === 'phone');
  root.classList.toggle('vanillagl-tablet', mobile && profile.device.kind === 'tablet');

  if (!mobile) return () => {};

  const viewportMeta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  const originalViewport = viewportMeta?.content;
  viewportMeta?.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');

  const update = () => {
    const viewport = window.visualViewport;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const requestedUiScale = Number.parseFloat(getComputedStyle(root).getPropertyValue('--wow-ui-scale')) || 1.25;
    const scales = mobileViewportScales(width, height, requestedUiScale, profile.device.kind === 'phone');
    const visibleBags = visibleContainerFrames();

    root.dataset.vanillaglOrientation = scales.landscape ? 'landscape' : 'portrait';
    root.classList.toggle('vanillagl-mobile-panel-open', hasMajorPanelOpen());
    root.classList.toggle('vanillagl-mobile-bag-open', visibleBags.length > 0);
    root.style.setProperty('--vanillagl-mobile-panel-scale', scales.panelScale.toFixed(4));
    root.style.setProperty('--vanillagl-mobile-wide-scale', scales.wideScale.toFixed(4));
    root.style.setProperty('--vanillagl-mobile-mail-scale', scales.mailScale.toFixed(4));
    root.style.setProperty('--vanillagl-mobile-tradeskill-scale', scales.tradeSkillScale.toFixed(4));
    root.style.setProperty('--vanillagl-mobile-bag-scale', scales.bagScale.toFixed(4));
    root.style.setProperty('--vanillagl-mobile-vw', `${width}px`);
    root.style.setProperty('--vanillagl-mobile-vh', `${height}px`);
    root.style.setProperty('--vanillagl-mobile-landscape-hud-scale', scales.landscapeHudScale.toFixed(4));
    root.style.setProperty('--vanillagl-mobile-hud-scale', scales.hudScale.toFixed(4));
    root.style.setProperty('--vanillagl-mobile-landscape-control-scale', scales.landscapeControlScale.toFixed(4));

    // Classic bag windows are individually positioned by the desktop client. On touch devices,
    // cascade only the currently-visible bags so every title/close area remains reachable.
    visibleBags.forEach((frame, index) => {
      frame.style.setProperty('--vanillagl-mobile-bag-index', String(index));
    });
  };

  const panelSelector = `${MAJOR_PANEL_SELECTOR},.wow-container-frame`;
  const containsPanel = (node: Node) => node instanceof Element
    && (node.matches(panelSelector) || !!node.querySelector(panelSelector));
  let queued = 0;
  const schedule = () => {
    if (!queued) queued = requestAnimationFrame(() => { queued = 0; update(); });
  };
  // Combat text, cooldowns and action-button class changes are not layout changes.
  // Scanning all panels and forcing computed styles for those mutations stalls mobile combat.
  const observer = new MutationObserver((mutations) => {
    if (mutations.some((m) => m.type === 'attributes'
      ? m.target instanceof Element && m.target.matches(panelSelector)
      : [...m.addedNodes, ...m.removedNodes].some(containsPanel))) schedule();
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });

  update();
  schedule();
  window.addEventListener('resize', update, { passive: true });
  window.addEventListener('vanillagl-ui-scale', update);
  window.addEventListener('orientationchange', update, { passive: true });
  window.visualViewport?.addEventListener('resize', update, { passive: true });

  return () => {
    observer.disconnect();
    cancelAnimationFrame(queued);
    window.removeEventListener('resize', update);
    window.removeEventListener('vanillagl-ui-scale', update);
    window.removeEventListener('orientationchange', update);
    window.visualViewport?.removeEventListener('resize', update);
    root.classList.remove('vanillagl-mobile', 'vanillagl-phone', 'vanillagl-tablet', 'vanillagl-mobile-panel-open', 'vanillagl-mobile-bag-open');
    root.removeAttribute('data-vanillagl-orientation');
    if (viewportMeta && originalViewport !== undefined) viewportMeta.content = originalViewport;
    for (const name of [
      '--vanillagl-mobile-panel-scale', '--vanillagl-mobile-wide-scale', '--vanillagl-mobile-mail-scale',
      '--vanillagl-mobile-tradeskill-scale', '--vanillagl-mobile-bag-scale', '--vanillagl-mobile-vw', '--vanillagl-mobile-vh',
      '--vanillagl-mobile-landscape-hud-scale', '--vanillagl-mobile-landscape-control-scale', '--vanillagl-mobile-hud-scale',
    ]) root.style.removeProperty(name);
  };
}
