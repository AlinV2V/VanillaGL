// Canonical rigid WMO shaders, moved verbatim from world-tile-loader.
const WMO_SELF_ILLUM_GLSL = /* glsl */ `
vec3 wmoSelfIllum(vec3 lit, float enabled, float night) {
  return lit * (1.0 + 4.0 * enabled * night);
}
`;
export const WMO_EXTERIOR_VERT = /* glsl */ `
  in vec4 wmoColor;
  out vec2 vUv;
  out vec3 vLit;
  out float vFog;
  uniform float uHasVertexColor;
  uniform vec3 uAmbient;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform float uFogNear;
  uniform float uFogFar;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vec3 n = normalize(mat3(modelMatrix) * normal);
    float ndl = max(dot(n, normalize(-uSunDir)), 0.0);
    // fixVertexColors stores MOCV at half intensity because Vanilla consumes it
    // through MODULATE2X. Restore that factor here; groups without MOCV use the
    // active outdoor ambient instead of an invented white vertex colour.
    // Exterior MOCV has the MOHD ambient floor subtracted by fixVertexColors.
    // Vanilla adds that floor back before MODULATE2X; replacing ambient with
    // MOCV made City_01 stone nearly black/red.
    vec3 baseLight = uAmbient + wmoColor.rgb * 2.0 * uHasVertexColor;
    vLit = clamp(baseLight + uSunColor * ndl, 0.0, 1.0);
    vec4 viewPos = viewMatrix * wp;
    float fogDepth = max(0.0, -viewPos.z);
    vFog = clamp((fogDepth - uFogNear) / max(1.0, uFogFar - uFogNear), 0.0, 1.0);
    gl_Position = projectionMatrix * viewPos;
  }
`;
export const WMO_EXTERIOR_FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  in vec3 vLit;
  in float vFog;
  out vec4 outColor;
  uniform sampler2D uMap;
  uniform float uHasMap;
  uniform vec3 uFallbackColor;
  uniform float uAlphaTest;
  uniform float uUnlit;
  uniform float uUnfogged;
  uniform float uAdditive;
  uniform float uSelfIllum;
  uniform float uNight;
  uniform vec3 uFogColor;
` + WMO_SELF_ILLUM_GLSL + `
  void main() {
    vec4 tex = uHasMap > 0.5 ? texture(uMap, vUv) : vec4(uFallbackColor, 1.0);
    if (uAlphaTest > 0.0 && tex.a < uAlphaTest) discard;
    vec3 c = mix(tex.rgb * wmoSelfIllum(vLit, uSelfIllum, uNight), tex.rgb, uUnlit);
    float fogAmount = vFog * (1.0 - uUnfogged);
    if (uAdditive > 0.5) {
      float visibility = 1.0 - fogAmount;
      outColor = vec4(c * visibility, tex.a * visibility);
    } else {
      outColor = vec4(mix(c, uFogColor, fogAmount * tex.a), tex.a);
    }
  }
`;
export const WMO_INTERIOR_VERT = /* glsl */ `
  in vec4 wmoColor;
  out vec2 vUv;
  out vec3 vLit;
  out float vFog;
  uniform vec3 uAmbient;
  uniform float uHasVertexColor;
  uniform int uLightCount;
  uniform vec3 uLightPos[8];
  uniform vec3 uLightColor[8];
  uniform vec2 uLightAtten[8];
  uniform float uFogNear;
  uniform float uFogFar;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uOutdoorAmbient;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    // MOLT lights are supplied in WMO model space, so the light loop runs there too: distance and
    // N.L are invariant under the instance/tile transform (no scale anywhere in the chain), and it
    // cannot drift when the render origin moves. wp stays for fog, which needs eye space.
    vec3 n = normalize(normal);
    // WoW renders interior surfaces MODULATE2X (vertex color x2) against the texture: the baked MOCV
    // already carries the interior lighting, so it must NOT be multiplied down by the dark MOHD ambient.
    // Ambient is used only as a brightness floor so unlit corners aren't pitch black; local MOLT lights add on top.
    vec3 lit = mix(max(uAmbient, vec3(0.1)), wmoColor.rgb * 2.0 + max(uAmbient, vec3(0.1)), uHasVertexColor);
    // Daylight spill through an opening. MOCV *alpha* is the authored "how much outdoor light
    // reaches this vertex" ramp, and fixVertexColors preserves it for the first batch range.
    // Measured on StartingZone_01 Abbey's two entrance groups, mean raw alpha by distance to the nearest
    // portal: group 3 = 135.9 / 45.2 / 84.2 / 32.2 / 3.7 / 0.0 and group 10 = 44.1 / 121.4 / 0.0 /
    // 1.2 / 0.2 / 0.1 over 0-1, 1-2, 2-3, 3-5, 5-8, 8+ yd. Deep-interior groups are flat 0, so this
    // term is self-limiting: it can only add light within a few yards of an actual opening.
    // Added rather than mixed so it can never darken a surface that the authored MOCV already lit.
    float ndl = max(dot(normalize(mat3(modelMatrix) * n), normalize(-uSunDir)), 0.0);
    lit += (uOutdoorAmbient + uSunColor * ndl) * wmoColor.a * uHasVertexColor;
    for (int i = 0; i < 8; i++) {
      if (i >= uLightCount) break;
      vec3 ld = uLightPos[i] - position;
      float dist = length(ld);
      float att = clamp(1.0 - (dist - uLightAtten[i].x) / max(0.001, uLightAtten[i].y - uLightAtten[i].x), 0.0, 1.0);
      float nDotL = max(dot(n, ld / max(dist, 0.001)), 0.0);
      lit += uLightColor[i] * att * nDotL;
    }
    vLit = clamp(lit, 0.0, 1.0);
    vec4 viewPos = viewMatrix * wp;
    float fogDepth = max(0.0, -viewPos.z);
    vFog = clamp((fogDepth - uFogNear) / max(1.0, uFogFar - uFogNear), 0.0, 1.0);
    gl_Position = projectionMatrix * viewPos;
  }
`;

export const WMO_INTERIOR_FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  in vec3 vLit;
  in float vFog;
  out vec4 outColor;
  uniform sampler2D uMap;
  uniform float uHasMap;
  uniform vec3 uFallbackColor;
  uniform float uAlphaTest;
  uniform float uUnlit;
  uniform float uUnfogged;
  uniform float uSelfIllum;
  uniform float uNight;
  uniform vec3 uFogColor;
` + WMO_SELF_ILLUM_GLSL + `
  void main() {
    vec4 tex = uHasMap > 0.5 ? texture(uMap, vUv) : vec4(uFallbackColor, 1.0);
    if (uAlphaTest > 0.0 && tex.a < uAlphaTest) discard;
    vec3 c = mix(tex.rgb * wmoSelfIllum(vLit, uSelfIllum, uNight), tex.rgb, uUnlit);
    c = mix(c, uFogColor, vFog * (1.0 - uUnfogged) * tex.a);
    outColor = vec4(c, tex.a);
  }
`;

