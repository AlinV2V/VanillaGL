/** Safari may start a long-press selection on HUD descendants during a camera drag. */
export function installMobileSelectionGuard(): () => void {
  const editable = (node: EventTarget | null): boolean => {
    const element = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
    return !!element?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])');
  };
  const guard = (event: Event) => {
    if (editable(event.target)) return;
    event.preventDefault();
  };
  // iOS can create a selection without selectstart (multi-touch/selection handles).
  const clearSelection = () => {
    const selection = document.getSelection();
    if (selection?.rangeCount && !(editable(selection.anchorNode) && editable(selection.focusNode))) {
      selection.removeAllRanges();
    }
  };
  const touch = (event: Event) => { if (!editable(event.target)) clearSelection(); };
  document.addEventListener('selectionchange', clearSelection);
  document.addEventListener('touchstart', touch, { capture: true, passive: true });
  document.addEventListener('touchmove', touch, { capture: true, passive: true });
  document.addEventListener('touchend', touch, { capture: true, passive: true });
  document.addEventListener('selectstart', guard, true);
  document.addEventListener('contextmenu', guard, true);
  document.addEventListener('dragstart', guard, true);
  return () => {
    document.removeEventListener('selectionchange', clearSelection);
    document.removeEventListener('touchstart', touch, true);
    document.removeEventListener('touchmove', touch, true);
    document.removeEventListener('touchend', touch, true);
    document.removeEventListener('selectstart', guard, true);
    document.removeEventListener('contextmenu', guard, true);
    document.removeEventListener('dragstart', guard, true);
  };
}
