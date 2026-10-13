type FullscreenDocument = Document & {
  webkitExitFullscreen?: () => void | Promise<void>;
  webkitFullscreenElement?: Element | null;
};

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => void | Promise<void>;
};

export function browserFullscreenElement(doc: Document = document): Element | null {
  const extended = doc as FullscreenDocument;
  return doc.fullscreenElement ?? extended.webkitFullscreenElement ?? null;
}

export function browserFullscreenSupported(doc: Document = document): boolean {
  const root = doc.documentElement as FullscreenElement;
  return typeof root.requestFullscreen === 'function' || typeof root.webkitRequestFullscreen === 'function';
}

export async function setBrowserFullscreen(wanted: boolean, doc: Document = document): Promise<void> {
  const active = browserFullscreenElement(doc);
  if (wanted === !!active) return;
  if (wanted) {
    const root = doc.documentElement as FullscreenElement;
    const request = root.requestFullscreen ?? root.webkitRequestFullscreen;
    if (request) await request.call(root);
    return;
  }
  const extended = doc as FullscreenDocument;
  const exit = doc.exitFullscreen ?? extended.webkitExitFullscreen;
  if (exit) await exit.call(doc);
}
