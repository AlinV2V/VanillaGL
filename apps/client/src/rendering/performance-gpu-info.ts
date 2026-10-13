type GlContext = WebGLRenderingContext | WebGL2RenderingContext;

const cache = new WeakMap<GlContext, Record<string, unknown>>();

export function performanceGpuInfo(context: GlContext | null | undefined): Record<string, unknown> {
  if (!context) return { available: false };
  const prior = cache.get(context);
  if (prior) return prior;
  let vendor = String(context.getParameter(context.VENDOR) ?? 'unavailable');
  let renderer = String(context.getParameter(context.RENDERER) ?? 'unavailable');
  const debug = context.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_VENDOR_WEBGL: number; UNMASKED_RENDERER_WEBGL: number } | null;
  if (debug) {
    vendor = String(context.getParameter(debug.UNMASKED_VENDOR_WEBGL) ?? vendor);
    renderer = String(context.getParameter(debug.UNMASKED_RENDERER_WEBGL) ?? renderer);
  }
  const result = {
    available: true,
    vendor,
    renderer,
    version: String(context.getParameter(context.VERSION) ?? 'unavailable'),
    shadingLanguage: String(context.getParameter(context.SHADING_LANGUAGE_VERSION) ?? 'unavailable'),
    maxTextureSize: Number(context.getParameter(context.MAX_TEXTURE_SIZE) ?? 0),
    debugIdentityAvailable: debug !== null,
  };
  cache.set(context, result);
  return result;
}
