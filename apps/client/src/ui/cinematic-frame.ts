/** Asset conversion utility. */
/**
 * 128 SCREEN pixels, flat — not scaled, and not a percentage of the viewport.
 *
 * `CinematicFrame` declares no `parent` attribute, unlike its neighbours (`CombatLogButtons` spells
 * out `parent="UIParent"`, which would be redundant if UIParent were the default). An unparented
 * frame does not inherit UIParent's scale, so its `AbsDimension y="128"` is 128 real pixels rather
 * than 128 UIParent units. Two consequences, and both match what the real client looks like:
 *
 *  - Multiplying by `--wow-ui-scale` was simply wrong. That is UIParent's scale; applying it here
 *    inflated the bars, which is why the crop was too aggressive.
 *  - The crop gets proportionally THINNER as the window grows — ~24% of a 1080-tall viewport, but a
 *    third of an 800-tall one. That is the real behaviour, not a bug to normalise away.
 */
const BAR_HEIGHT_PX = 128;

export interface CinematicFrameHandle {
  show(): void;
  hide(): void;
  isVisible(): boolean;
  destroy(): void;
}

export function createCinematicFrame(parent: HTMLElement = document.body): CinematicFrameHandle {
  const frame = document.createElement('div');
  frame.className = 'wow-cinematic-frame';
  frame.setAttribute('aria-hidden', 'true');
  Object.assign(frame.style, {
    position: 'fixed',
    inset: '0',
    display: 'none',
    zIndex: '9000',
    pointerEvents: 'auto',
    cursor: 'none',
  } satisfies Partial<CSSStyleDeclaration>);

  const bar = (edge: 'top' | 'bottom') => {
    const el = document.createElement('div');
    Object.assign(el.style, {
      position: 'absolute',
      left: '0',
      right: '0',
      [edge]: '0',
      height: `${BAR_HEIGHT_PX}px`,
      background: '#000',
    } as Partial<CSSStyleDeclaration>);
    return el;
  };

  frame.append(bar('top'), bar('bottom'));
  parent.appendChild(frame);

  let visible = false;

  return {
    show() {
      visible = true;
      frame.style.display = 'block';
      frame.setAttribute('aria-hidden', 'false');
    },
    hide() {
      visible = false;
      frame.style.display = 'none';
      frame.setAttribute('aria-hidden', 'true');
    },
    isVisible() {
      return visible;
    },
    destroy() {
      frame.remove();
    },
  };
}
