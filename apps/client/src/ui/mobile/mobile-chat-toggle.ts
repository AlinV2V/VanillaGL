import type { PerformanceProfile } from '../../platform/performance-profile';
import { VanillaCanvas } from '../vanilla-canvas';

const CHAT_BUTTON = '/ui/Interface/ChatFrame/UI-ChatIcon-Chat';
const COLLAPSED_CLASS = 'vanillagl-mobile-chat-collapsed';

export const shouldCollapseMobileChat = (kind: PerformanceProfile['device']['kind'], _landscape: boolean) =>
  kind === 'phone';

export function installMobileLandscapeChatToggle(
  root: HTMLElement,
  profile: PerformanceProfile,
): () => void {
  const html = document.documentElement;
  const surface = new VanillaCanvas(32, 32, 'vanillagl-mobile-chat-toggle');
  surface.canvas.setAttribute('role', 'button');
  surface.canvas.setAttribute('aria-label', 'Show chat');
  surface.canvas.setAttribute('aria-hidden', 'true');
  surface.canvas.tabIndex = -1;
  surface.canvas.hidden = true;
  surface.canvas.style.removeProperty('width');
  surface.canvas.style.removeProperty('height');
  root.appendChild(surface.canvas);

  let available = false;
  let collapsed = false;
  let pressed = false;
  let pointerId: number | null = null;
  let pressX = 0, pressY = 0;

  surface.onRender(() => {
    surface.clear();
    surface.image(`${CHAT_BUTTON}-${pressed ? 'Down' : 'Up'}.png`, 0, 0, 32, 32);
  });

  const apply = () => {
    html.classList.toggle(COLLAPSED_CLASS, available && collapsed);
    surface.canvas.hidden = !available;
    surface.canvas.tabIndex = available ? 0 : -1;
    surface.canvas.setAttribute('aria-hidden', String(!available));
    surface.canvas.setAttribute('aria-label', collapsed ? 'Show chat' : 'Hide chat');
    surface.requestRender();
  };

  const landscapeQuery = window.matchMedia('(orientation: landscape)');
  const syncOrientation = () => {
    const nextAvailable = shouldCollapseMobileChat(profile.device.kind, landscapeQuery.matches);
    if (nextAvailable !== available) {
      available = nextAvailable;
      collapsed = nextAvailable;
      pressed = false;
      pointerId = null;
    }
    apply();
  };

  const release = (event: PointerEvent, activate: boolean) => {
    if (pointerId !== event.pointerId) return;
    event.preventDefault();
    pointerId = null;
    pressed = false;
    const rect = surface.canvas.getBoundingClientRect();
    const tapped = Math.hypot(event.clientX - pressX, event.clientY - pressY) <= 12
      && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (activate && tapped) collapsed = !collapsed;
    apply();
  };

  surface.canvas.addEventListener('pointerdown', (event) => {
    if (!available || pointerId !== null) return;
    event.preventDefault();
    pointerId = event.pointerId;
    pressX = event.clientX; pressY = event.clientY;
    pressed = true;
    surface.canvas.setPointerCapture?.(event.pointerId);
    surface.requestRender();
  });
  surface.canvas.addEventListener('pointerup', (event) => release(event, true));
  surface.canvas.addEventListener('pointercancel', (event) => release(event, false));
  surface.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  landscapeQuery.addEventListener('change', syncOrientation);

  syncOrientation();

  return () => {
    landscapeQuery.removeEventListener('change', syncOrientation);
    html.classList.remove(COLLAPSED_CLASS);
    surface.canvas.remove();
  };
}
