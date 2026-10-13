/** Console-only diagnostics are absent from production unless an explicit QA build opts in. */
export const QA_GLOBALS_ENABLED = typeof __BP_QA_GLOBALS__ !== 'undefined' && __BP_QA_GLOBALS__;

/**
 * Studio live authoring is opt-in per browser session. Normal gameplay keeps the
 * same production global isolation; only a URL carrying ?studioBridge=<ws-url>
 * exposes the small set of existing runtime hooks that the Studio receiver uses.
 */
export const STUDIO_LIVE_ENABLED = typeof location !== 'undefined'
  && new URLSearchParams(location.search).has('studioBridge');

export const qaGlobals = (
  QA_GLOBALS_ENABLED || STUDIO_LIVE_ENABLED ? globalThis : Object.create(null)
) as Record<string, unknown>;

if (QA_GLOBALS_ENABLED) {
  void import('./diagnostics/browserport-api').then(({ installBrowserPortApi }) => installBrowserPortApi());
}

if (STUDIO_LIVE_ENABLED) {
  void import('./platform/studio-bridge-client')
    .then(({ installStudioBridgeClient }) => installStudioBridgeClient())
    .catch((error) => console.error('[studio-live] receiver failed to load', error));
}
