import { wheelStepsFromDelta } from './camera-zoom';

const PINCH_STEP_PX = 48;
const MAX_PINCH_SESSION_STEPS = 4;

export function pinchZoomStep(deltaPx: number, remainderPx: number): { steps: number; remainder: number } {
  const total = remainderPx + deltaPx;
  const rawSteps = Math.trunc(total / PINCH_STEP_PX);
  const steps = Math.max(-1, Math.min(1, rawSteps));
  return { steps: -steps, remainder: Math.abs(rawSteps) > 1 ? 0 : total - steps * PINCH_STEP_PX };
}

export function installWorldCanvasGestures(
  canvas: HTMLElement,
  onZoomSteps: (steps: number) => void,
  freeCamEnabled: () => boolean,
): () => void {
  const touches = new Map<number, { x: number; y: number }>();
  let pinchDistance: number | undefined;
  let pinchRemainder = 0;
  let pinchSessionSteps = 0;

  const distance = () => {
    const [a, b] = [...touches.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : undefined;
  };

  const onWheel = (event: WheelEvent) => {
    if (freeCamEnabled()) return;
    event.preventDefault();
    onZoomSteps(wheelStepsFromDelta(event.deltaY));
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return;
    event.preventDefault();
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size === 2) {
      pinchDistance = distance();
      pinchRemainder = 0;
      pinchSessionSteps = 0;
    }
  };
  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || !touches.has(event.pointerId)) return;
    event.preventDefault();
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size !== 2 || freeCamEnabled()) return;
    const nextDistance = distance();
    if (nextDistance === undefined || pinchDistance === undefined) { pinchDistance = nextDistance; return; }
    const zoom = pinchZoomStep(nextDistance - pinchDistance, pinchRemainder);
    pinchDistance = nextDistance;
    pinchRemainder = zoom.remainder;
    if (zoom.steps) {
      const nextSessionSteps = Math.max(-MAX_PINCH_SESSION_STEPS, Math.min(MAX_PINCH_SESSION_STEPS, pinchSessionSteps + zoom.steps));
      const acceptedSteps = nextSessionSteps - pinchSessionSteps;
      pinchSessionSteps = nextSessionSteps;
      if (acceptedSteps) onZoomSteps(acceptedSteps);
    }
  };
  const releasePointer = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return;
    touches.delete(event.pointerId);
    pinchDistance = touches.size === 2 ? distance() : undefined;
    if (touches.size < 2) { pinchRemainder = 0; pinchSessionSteps = 0; }
  };

  canvas.style.touchAction = 'none';
  canvas.style.userSelect = 'none';
  canvas.style.setProperty('-webkit-user-select', 'none');
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);

  return () => {
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', releasePointer);
    canvas.removeEventListener('pointercancel', releasePointer);
  };
}
