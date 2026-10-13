/** Asset conversion utility. */
export type CursorDropZone = {
  /** The element whose bounding box claims the drop. */
  element: HTMLElement;
  /** Handle a drop at these VIEWPORT coordinates; return false to let a lower zone try. */
  onDrop: (clientX: number, clientY: number) => boolean;
};

const zones: CursorDropZone[] = [];

/** Register a drop target. Returns the unregister function — call it from the panel's `destroy`. */
export function registerCursorDropZone(zone: CursorDropZone): () => void {
  zones.push(zone);
  return () => {
    const index = zones.indexOf(zone);
    if (index >= 0) zones.splice(index, 1);
  };
}

/**
 * Deliver a drop to whichever registered zone is under the point.
 *
 * Returns true when a zone consumed it. False means the drag ended over nothing that accepts it —
 * for an action or a spell that is a discard, which is how vanilla throws a button off the bar.
 */
export function routeCursorDrop(clientX: number, clientY: number): boolean {
  for (let index = zones.length - 1; index >= 0; index--) {
    const zone = zones[index];
    if (!zone.element.isConnected) continue;
    const rect = zone.element.getBoundingClientRect();
    const inside = clientX >= rect.left && clientX <= rect.right
      && clientY >= rect.top && clientY <= rect.bottom;
    if (inside && zone.onDrop(clientX, clientY)) return true;
  }
  return false;
}

/** Test seam: the number of live zones. */
export const cursorDropZoneCount = () => zones.filter((zone) => zone.element.isConnected).length;
