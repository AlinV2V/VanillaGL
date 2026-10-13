import * as THREE from 'three';
import { qaGlobals } from '../qa-globals.ts';
import { setPerformanceShaderPrewarmer } from './performance-runtime';
import { resolveGlowPath } from './glow-path';
import { renderLiveWorld } from './world-live-streaming';
/** Asset conversion utility. */
export const renderSkyThenWorld = (
  renderer: THREE.WebGLRenderer,
  worldScene: THREE.Scene,
  camera: THREE.Camera,
  skyScene?: THREE.Scene | null,
) => {
  if (!skyScene) {
    renderLiveWorld(renderer,worldScene,camera);
    return;
  }
  const previousAutoClear = renderer.autoClear;
  try {
    renderer.autoClear = true;
    renderer.render(skyScene, camera);
    renderer.clearDepth();
    renderer.autoClear = false;
    renderLiveWorld(renderer,worldScene,camera);
  } finally {
    renderer.autoClear = previousAutoClear;
  }
};

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * ffxGlow composite — captured program 0029.
 *
 *   step1 = mix(base, bloom, primary.z)      // LERP toward the blurred image, not an add
 *   step2 = step1 + bloom * bloom * primary.w // SQUARED bloom is what makes the glow selective
 *
 * The squaring is why the client needs no bright-pass: dim areas contribute ~nothing once squared,
 * bright ones dominate. An earlier version of this pass invented a smoothstep threshold to get the
 * same selectivity; that is a mechanism the client does not have, and it is gone.
 *
 * The gamma ramp rides along in the same pass (the client applies it as a hardware ramp after the
 * 3D frame; browsers have no SetGammaRamp).
 */
const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform float uGamma;
uniform float uBlend;
uniform float uIntensity;
void main() {
  vec4 base = texture2D(tScene, vUv);
  vec3 bloom = texture2D(tBloom, vUv).rgb;
  vec3 color = mix(base.rgb, bloom, uBlend) + bloom * bloom * uIntensity;
  vec3 corrected = pow(max(color, vec3(0.0)), vec3(1.0 / max(uGamma, 0.001)));
  gl_FragColor = vec4(corrected, base.a);
}
`;


const DOWNSAMPLE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
void main() {
  vec3 sum = texture2D(tSrc, vUv + uTexel * vec2(-1.5, -1.5)).rgb;
  sum += texture2D(tSrc, vUv + uTexel * vec2( 0.5, -0.5)).rgb;
  sum += texture2D(tSrc, vUv + uTexel * vec2( 0.5,  0.5)).rgb;
  sum += texture2D(tSrc, vUv + uTexel * vec2(-1.5,  0.5)).rgb;
  gl_FragColor = vec4(sum * 0.25, 1.0);
}
`;


const BLUR_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uDir;
void main() {
  vec3 sum = texture2D(tSrc, vUv - uDir * 2.5).rgb * 0.125;
  sum += texture2D(tSrc, vUv - uDir * 0.5).rgb * 0.375;
  sum += texture2D(tSrc, vUv + uDir * 0.5).rgb * 0.375;
  sum += texture2D(tSrc, vUv + uDir * 2.5).rgb * 0.125;
  gl_FragColor = vec4(sum, 1.0);
}
`;


export class VanillaGammaPass {
  private readonly target: THREE.WebGLRenderTarget;
  private readonly quarterA: THREE.WebGLRenderTarget;
  private readonly quarterB: THREE.WebGLRenderTarget;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly compositeMaterial: THREE.ShaderMaterial;
  private readonly downsampleMaterial: THREE.ShaderMaterial;
  private readonly blurMaterial: THREE.ShaderMaterial;
  private gamma = 1;
  /** ffxGlow CVar: 1 enabled (vanilla default), 0 disables the whole FBO chain. */
  private glowEnabled = 1;
  private glowIntensity = 0.5;
  /**
   * A/B instrumentation (FIX 4): true when the last render() presented the
   * world straight to the canvas (Path A — canvas MSAA applies to geometry),
   * false when it composited through the single-sample offscreen target
   * (Path B — canvas MSAA cannot antialias the world). Read-only signal for
   * controlled captures; never a render input.
   */
  lastRenderDirectPath = true;


  // Temporary side-by-side preset requested for visual QA. Flip this single flag to false to
  // restore the exact Build 5875 values (84/255 blend and unscaled LightParams intensity).
  private static readonly REDUCED_GLOW_COMPARISON = true;
  private static readonly DEFAULT_BLEND = VanillaGammaPass.REDUCED_GLOW_COMPARISON ? 0.20 : 84 / 255;
  private static readonly DEFAULT_INTENSITY_SCALE = VanillaGammaPass.REDUCED_GLOW_COMPARISON ? 0.60 : 1;

  /**
   * FIX 6 A/B: legacy mode keeps the pre-optimization driver clears before
   * every post pass (`?glowpath=legacy`). Resolved once at startup — the
   * render path must not re-parse URLs per frame.
   */
  private readonly clearPasses: boolean;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    width: number,
    height: number,
  ) {
    this.clearPasses = typeof location !== 'undefined'
      && resolveGlowPath(location.search) === 'legacy';
    const pixelRatio = this.renderer.getPixelRatio();
    const w = Math.max(1, Math.floor(width * pixelRatio));
    const h = Math.max(1, Math.floor(height * pixelRatio));
    this.target = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true, stencilBuffer: false });
    this.target.texture.name = 'VanillaGammaPass.scene';
    this.target.texture.colorSpace = THREE.NoColorSpace;
    const makeQuarter = (name: string) => {
      const t = new THREE.WebGLRenderTarget(Math.max(1, w >> 2), Math.max(1, h >> 2), { depthBuffer: false, stencilBuffer: false });
      t.texture.name = name;
      t.texture.colorSpace = THREE.NoColorSpace;
      t.texture.minFilter = THREE.LinearFilter;
      t.texture.magFilter = THREE.LinearFilter;
      return t;
    };
    this.quarterA = makeQuarter('VanillaGammaPass.bloomA');
    this.quarterB = makeQuarter('VanillaGammaPass.bloomB');

    const fsMaterial = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false });

    this.compositeMaterial = fsMaterial(COMPOSITE_FRAG, {
      tScene: { value: this.target.texture },
      tBloom: { value: this.quarterA.texture },
      uGamma: { value: this.gamma },
      uBlend: { value: VanillaGammaPass.DEFAULT_BLEND },
      uIntensity: { value: this.glowIntensity },
    });
    this.downsampleMaterial = fsMaterial(DOWNSAMPLE_FRAG, {
      tSrc: { value: this.target.texture },
      uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
    });
    this.blurMaterial = fsMaterial(BLUR_FRAG, {
      tSrc: { value: this.quarterA.texture },
      uDir: { value: new THREE.Vector2() },
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMaterial);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    setPerformanceShaderPrewarmer((object, camera, scene) => this.prewarm(object, camera, scene));
  }

  dispose() {
    setPerformanceShaderPrewarmer(null);
    this.target.dispose();
    this.quarterA.dispose();
    this.quarterB.dispose();
    this.compositeMaterial.dispose();
    this.downsampleMaterial.dispose();
    this.blurMaterial.dispose();
    this.quad.geometry?.dispose?.();
  }

  setGamma(value: number) {
    this.gamma = Number.isFinite(value) ? Math.max(0.5, Math.min(1.5, value)) : 1;
    this.compositeMaterial.uniforms.uGamma.value = this.gamma;
  }

  /** ffxGlow CVar, on/off. */
  setGlow(value: number) {
    this.glowEnabled = value > 0 ? 1 : 0;
  }

  /** Spatially blended LightParams.dbc field 4, used as FFXGlow fullscreen primary.w. */
  setGlowIntensity(value: number) {
    this.glowIntensity = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
  }

  setSize(width: number, height: number) {
    const pixelRatio = this.renderer.getPixelRatio();
    const w = Math.max(1, Math.floor(width * pixelRatio));
    const h = Math.max(1, Math.floor(height * pixelRatio));
    this.target.setSize(w, h);
    this.quarterA.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    this.quarterB.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    (this.downsampleMaterial.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
  }

  private runPass(material: THREE.ShaderMaterial, targetBuffer: THREE.WebGLRenderTarget | null) {
    this.quad.material = material;
    this.renderer.setRenderTarget(targetBuffer);
    if (this.clearPasses) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    // Optimized path (FIX 6): every post shader draws an opaque fullscreen
    // quad (2x2 NDC triangle pair, frustumCulled=false, depthTest/depthWrite
    // off, no discard in any pass shader), so the driver's pre-pass clear is
    // pure overhead — every pixel is overwritten regardless. The flag is
    // restored for all other renders (world/sky passes need their clears).
    const previousAutoClear = this.renderer.autoClear;
    try {
      this.renderer.autoClear = false;
      this.renderer.render(this.scene, this.camera);
    } finally {
      this.renderer.autoClear = previousAutoClear;
    }
  }

  /** Compile a streamed object for the same output target used by the next world render. */
  async prewarm(object: THREE.Object3D, camera: THREE.Camera, worldScene: THREE.Scene): Promise<void> {
    const tune = (qaGlobals.__wowGlowTune ?? {}) as { blend?: number; intensity?: number; intensityScale?: number };
    const intensity = tune.intensity
      ?? this.glowIntensity * (tune.intensityScale ?? VanillaGammaPass.DEFAULT_INTENSITY_SCALE);
    const glowActive = this.glowEnabled > 0
      && ((tune.blend ?? VanillaGammaPass.DEFAULT_BLEND) > 0 || intensity > 0);
    const target = Math.abs(this.gamma - 1) >= 0.001 || glowActive ? this.target : null;
    const previousTarget = this.renderer.getRenderTarget();
    let compilation: Promise<unknown>;
    try {
      this.renderer.setRenderTarget(target);
      compilation = this.renderer.compileAsync(object, camera, worldScene);
    } finally {
      this.renderer.setRenderTarget(previousTarget);
    }
    try { await compilation; } catch { /* First-use compilation remains the safe driver fallback. */ }
  }

  render(scene: THREE.Scene, camera: THREE.Camera, skyScene?: THREE.Scene | null) {
    if (this.renderer.xr.isPresenting) { renderSkyThenWorld(this.renderer, scene, camera, skyScene); return; }
    const tune = (qaGlobals.__wowGlowTune ?? {}) as { blend?: number; intensity?: number; intensityScale?: number };
    const blend = this.glowEnabled ? (tune.blend ?? VanillaGammaPass.DEFAULT_BLEND) : 0;
    const intensity = this.glowEnabled
      ? (tune.intensity
        ?? this.glowIntensity * (tune.intensityScale ?? VanillaGammaPass.DEFAULT_INTENSITY_SCALE))
      : 0;
    const glowActive = blend > 0 || intensity > 0;

    if (Math.abs(this.gamma - 1) < 0.001 && !glowActive) {
      this.lastRenderDirectPath = true;
      this.renderer.setRenderTarget(null);
      renderSkyThenWorld(this.renderer, scene, camera, skyScene);
      return;
    }
    this.lastRenderDirectPath = false;

    this.renderer.setRenderTarget(this.target);
    renderSkyThenWorld(this.renderer, scene, camera, skyScene);

    if (glowActive) {
      // 0027: box downsample full-res scene -> quarter res.
      this.downsampleMaterial.uniforms.tSrc.value = this.target.texture;
      this.runPass(this.downsampleMaterial, this.quarterA);
      // 0028: separable [1,3,3,1]/8, horizontal then vertical.
      this.blurMaterial.uniforms.tSrc.value = this.quarterA.texture;
      (this.blurMaterial.uniforms.uDir.value as THREE.Vector2).set(1 / this.quarterA.width, 0);
      this.runPass(this.blurMaterial, this.quarterB);
      this.blurMaterial.uniforms.tSrc.value = this.quarterB.texture;
      (this.blurMaterial.uniforms.uDir.value as THREE.Vector2).set(0, 1 / this.quarterB.height);
      this.runPass(this.blurMaterial, this.quarterA);
    }
    // 0029: mix(base, bloom, blend) + bloom^2 * intensity.
    this.compositeMaterial.uniforms.uBlend.value = blend;
    this.compositeMaterial.uniforms.uIntensity.value = intensity;
    this.runPass(this.compositeMaterial, null);
  }
}
