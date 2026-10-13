/** DOM glue coordinates are CSS pixels; WebGL's viewport origin is bottom-left. */
export function gluePreviewViewport(width: number, height: number, creation: boolean) {
  const slot = !creation && document.querySelector('.glue-char-preview');
  if (slot) {
    const rect = slot.getBoundingClientRect();
    return { x: rect.left, y: height - rect.bottom, w: rect.width, h: rect.height };
  }
  // The original panels scale in authored 1024x768 units, not fixed CSS pixels.
  const unit = Math.min(width / 1024, height / 768);
  const x = creation ? 260 * unit : 0;
  return { x, y: 0, w: Math.max(1, width - x - 280 * unit), h: height };
}
