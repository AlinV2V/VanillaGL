type Capture = { element: Element; set: Element['setPointerCapture']; release: Element['releasePointerCapture']; has: Element['hasPointerCapture'] };
const captured = new WeakSet<Element>();

/** XR rays have no OS pointer ID. Emulate capture only while dispatching our synthetic event. */
export function dispatchXrPointer(element: HTMLElement, event: PointerEvent) {
  const restore: Capture[] = [];
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const item = { element: node, set: node.setPointerCapture, release: node.releasePointerCapture, has: node.hasPointerCapture };
    restore.push(item);
    node.setPointerCapture = id => { if (id === event.pointerId) captured.add(item.element); else item.set.call(item.element, id); };
    node.releasePointerCapture = id => { if (id === event.pointerId) captured.delete(item.element); else item.release.call(item.element, id); };
    node.hasPointerCapture = id => id === event.pointerId ? captured.has(item.element) : item.has.call(item.element, id);
  }
  try { element.dispatchEvent(event); } finally {
    for (const item of restore) {
      item.element.setPointerCapture = item.set; item.element.releasePointerCapture = item.release; item.element.hasPointerCapture = item.has;
      if (event.type === 'pointerup' || event.type === 'pointercancel') captured.delete(item.element);
    }
  }
}
