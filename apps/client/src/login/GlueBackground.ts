import * as THREE from 'three';
import { qaGlobals } from '../qa-globals.ts';
import { setM2Light } from '../m2-material';
import { getPerformanceProfile } from '../platform/performance-profile';
import { MobileCharacterBackdrop } from './mobile-character-backdrop';
import { disposeGlueScene, loadGlueScene, type GlueSceneKey, type LoadedGlueScene } from './glue-scene-loader';

/** Render the same race-specific M2 glue scenes used by the 1.12.1 client. */
export class GlueBackground {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly viewportSize = new THREE.Vector2();
  private readonly ambientLight: THREE.AmbientLight;
  private readonly directionalLight: THREE.DirectionalLight;
  private readonly redGlow: THREE.PointLight;
  private readonly centerGlow: THREE.PointLight;

  private loadedScene: LoadedGlueScene | null = null;
  private loadedSceneKey: GlueSceneKey | null = null;
  private pendingSceneKey: GlueSceneKey | null = null;
  private sceneKey: GlueSceneKey = 'mainmenu';
  private sceneLoadId = 0;
  private maxAnisotropy = 8;

  // Baked M2 camera (WoW units, Z-up); the manifest replaces these defaults when ready.
  private camPos = new THREE.Vector3(3.836, 2.012, -1.027);
  private camTarget = new THREE.Vector3(-1.369, 0.761, 0.922);
  private camFovRad = 1.501;

  private vortexTexture: THREE.Texture | null = null;
  private cloudsTexture1: THREE.Texture | null = null;
  private cloudsTexture2: THREE.Texture | null = null;

  private particles: THREE.Points | null = null;
  private particleGeom: THREE.BufferGeometry | null = null;
  private readonly particleCount = 140;
  private readonly particlePositions: Float32Array;
  private readonly particleSpeeds: number[] = [];
  private time = 0;
  private destroyed = false;
  private mobileBackdrop?: MobileCharacterBackdrop;

  constructor(private readonly canvas: HTMLCanvasElement, maxAnisotropy = 8) {
    this.maxAnisotropy = maxAnisotropy;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, canvas.width / canvas.height, 0.222, 1778);
    this.camera.up.set(0, 0, 1);

    this.ambientLight = new THREE.AmbientLight(0x161130, 1.3);
    this.ambientLight.name = 'glueAmbient';
    this.directionalLight = new THREE.DirectionalLight(0x4a3b7e, 2.2);
    this.directionalLight.name = 'glueSun';
    this.directionalLight.position.set(0, 3, 10);
    this.redGlow = new THREE.PointLight(0xff5500, 9.5, 12);
    this.redGlow.name = 'redGlow';
    this.centerGlow = new THREE.PointLight(0x5566ff, 8.0, 10);
    this.centerGlow.name = 'centerGlow';
    this.scene.add(this.ambientLight, this.directionalLight, this.redGlow, this.centerGlow);

    this.scene.fog = new THREE.FogExp2(0x06050f, 0.02);
    this.particlePositions = new Float32Array(this.particleCount * 3);

    qaGlobals.__wowGlueScene = this.scene;
    qaGlobals.__wowGlueCamera = this.camera;
    qaGlobals.__wowBackground = this;

    this.applyCamera();
    this.applySceneLighting('mainmenu');
    this.initParticles();
    this.setScene('mainmenu');
  }

  /** Keep the authored horizontal FOV fixed, as finite glue-scene billboards assume 4:3 framing. */
  private applyCamera() {
    const fovOverride = Number(new URLSearchParams(location.search).get('gluefov') ?? 0);
    const aspect = Math.max(this.camera.aspect || 4 / 3, 1.0);
    const vertical = fovOverride > 0
      ? fovOverride
      : THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(this.camFovRad / 2) / aspect));
    this.camera.fov = Math.min(vertical, 100);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);
    this.camera.updateProjectionMatrix();
  }

  /** Swap a glue scene only when the login flow explicitly changes screen/race. */
  setScene(key: GlueSceneKey) {
    if (key === this.loadedSceneKey || key === this.pendingSceneKey) return;
    this.sceneKey = key;
    this.pendingSceneKey = key;
    const requestId = ++this.sceneLoadId;

    void loadGlueScene(key, this.maxAnisotropy).then((next) => {
      if (requestId !== this.sceneLoadId || key !== this.sceneKey) {
        disposeGlueScene(next);
        return;
      }
      if (this.loadedScene) this.scene.remove(this.loadedScene.group);
      disposeGlueScene(this.loadedScene);
      this.loadedScene = next;
      this.loadedSceneKey = key;
      this.pendingSceneKey = null;
      this.scene.add(next.group);
      this.resetCameraDefaults();
      this.applyBakedCamera(next.camera);
      this.applySceneLighting(key);
      if (this.particles) this.particles.visible = key === 'mainmenu';
      this.vortexTexture = this.findTexture(next, 'DARKPORTAL_NICK');
      this.cloudsTexture1 = this.findTexture(next, 'MM_CLOUDS_01', 'MM_CLOUDS_03', 'AA_NE_CLOUDS', 'MM_ORC_CLOUDS', 'CLOUDS');
      this.cloudsTexture2 = this.findTexture(next, 'MM_CLOUDS_02');
      this.repositionEffects();
      console.log(`3D ${key} glue scene loaded (${next.group.children.length} meshes).`);
    }).catch((error) => {
      if (requestId === this.sceneLoadId) {
        this.pendingSceneKey = null;
        this.sceneKey = this.loadedSceneKey ?? 'mainmenu';
        console.error(`Failed to load ${key} glue scene; keeping ${this.sceneKey}:`, error);
      }
    });
  }

  private resetCameraDefaults() {
    this.camPos.set(3.836, 2.012, -1.027);
    this.camTarget.set(-1.369, 0.761, 0.922);
    this.camFovRad = 1.501;
    this.camera.near = 0.222;
    this.camera.far = this.sceneKey === 'mainmenu' ? 1778 : 700;
    this.applyCamera();
  }

  private applyBakedCamera(camera: LoadedGlueScene['camera']) {
    if (!camera?.position || !camera.target) return;
    this.camPos.fromArray(camera.position);
    this.camTarget.fromArray(camera.target);
    this.camFovRad = camera.fov || this.camFovRad;
    this.camera.near = Math.max(0.05, camera.nearClip || 0.222);
    this.camera.far = camera.farClip || this.camera.far;
    this.applyCamera();
  }

  private findTexture(scene: LoadedGlueScene, ...needles: string[]) {
    const index = scene.textureNames.findIndex((name) => {
      const upper = name.toUpperCase();
      return needles.some((needle) => upper.includes(needle));
    });
    return index >= 0 ? scene.textures[index] ?? null : null;
  }

  private applySceneLighting(key: GlueSceneKey) {
    const dark = key === 'mainmenu' || key === 'scourge';
    this.ambientLight.color.setHex(dark ? 0x161130 : 0xffe4c2);
    this.ambientLight.intensity = dark ? 1.3 : 1.8;
    this.directionalLight.color.setHex(dark ? 0x4a3b7e : 0xffd8ad);
    this.directionalLight.intensity = dark ? 2.2 : 1.6;
    this.redGlow.visible = key === 'mainmenu';
    this.centerGlow.visible = key === 'mainmenu';
    setM2Light({
      sunDir: new THREE.Vector3(0, -0.687, -0.688).normalize(),
      sunColor: dark ? [1.8, 1.6, 1.4] : [1.45, 1.28, 1.1],
      skyAmbient: dark ? [1.2, 0.9, 1.5] : [1.1, 1.0, 0.9],
      groundAmbient: dark ? [0.6, 0.4, 0.8] : [0.65, 0.58, 0.48],
      fogColor: dark ? [0.06, 0.05, 0.15] : [0.38, 0.43, 0.42],
      fogNear: dark ? 1600 : 350,
      fogFar: dark ? 3200 : 700,
    });
    const fog = this.scene.fog as THREE.FogExp2 | null;
    if (fog) {
      fog.color.setHex(dark ? 0x06050f : 0x71807a);
      fog.density = dark ? 0.02 : 0.006;
    }
  }

  private initParticles() {
    const loader = new THREE.TextureLoader();
    loader.load('/login/textures/FlameLick.png', (texture) => {
      if (this.destroyed) { texture.dispose(); return; }
      this.particleGeom = new THREE.BufferGeometry();
      const target = this.camTarget;
      for (let i = 0; i < this.particleCount; i++) {
        this.particlePositions[i * 3] = target.x + (Math.random() - 0.5) * 6;
        this.particlePositions[i * 3 + 1] = target.y + (Math.random() - 0.5) * 8;
        this.particlePositions[i * 3 + 2] = target.z - 3 + Math.random() * 7;
        this.particleSpeeds[i] = 0.4 + Math.random() * 1.2;
      }
      this.particleGeom.setAttribute('position', new THREE.BufferAttribute(this.particlePositions, 3));
      const material = new THREE.PointsMaterial({ map: texture, size: 0.25, transparent: true, opacity: 0.8, color: 0xff5500, blending: THREE.AdditiveBlending, depthWrite: false });
      this.particles = new THREE.Points(this.particleGeom, material);
      this.particles.visible = this.sceneKey === 'mainmenu';
      this.scene.add(this.particles);
    });
  }

  private repositionEffects() {
    const target = this.camTarget;
    this.redGlow.position.set(target.x + 1.5, target.y, target.z - 2.5);
    this.centerGlow.position.set(target.x, target.y, target.z + 0.5);
  }

  resize(width: number, height: number) {
    this.camera.aspect = width / height;
    this.applyCamera();
  }

  private textureReady(texture: THREE.Texture | null): texture is THREE.Texture {
    const image = texture?.image as { width?: number; height?: number } | undefined;
    return !!image && Number(image.width) > 0 && Number(image.height) > 0;
  }

  update(dt: number, characterPreview = false) {
    if (characterPreview && getPerformanceProfile().device.mobile) return;
    this.time += dt;
    this.camera.position.set(
      this.camPos.x + Math.sin(this.time * 0.25) * 0.02,
      this.camPos.y + Math.cos(this.time * 0.2) * 0.015,
      this.camPos.z + Math.sin(this.time * 0.15) * 0.01,
    );
    this.camera.lookAt(this.camTarget);

    if (this.textureReady(this.cloudsTexture1)) this.cloudsTexture1.offset.x += 0.008 * dt;
    if (this.textureReady(this.cloudsTexture2)) this.cloudsTexture2.offset.x -= 0.005 * dt;
    if (this.textureReady(this.vortexTexture)) {
      this.vortexTexture.offset.x += 0.018 * dt;
      this.vortexTexture.offset.y += 0.024 * dt;
      this.centerGlow.intensity = 5.0 + Math.sin(this.time * 1.5) * 1.5;
    }
    if (this.redGlow.visible) this.redGlow.intensity = 9.5 + Math.sin(this.time * 8.0) * 0.8 + (Math.random() - 0.5) * 0.3;

    if (this.particles?.visible && this.particleGeom) {
      const attribute = this.particleGeom.getAttribute('position') as THREE.BufferAttribute;
      const values = attribute.array as Float32Array;
      const target = this.camTarget;
      for (let i = 0; i < this.particleCount; i++) {
        values[i * 3 + 2] += this.particleSpeeds[i] * dt;
        values[i * 3 + 1] += Math.sin(this.time * 2 + i) * 0.05 * dt;
        if (values[i * 3 + 2] > target.z + 5) {
          values[i * 3 + 2] = target.z - 3;
          values[i * 3 + 1] = target.y + (Math.random() - 0.5) * 8;
        }
      }
      attribute.needsUpdate = true;
    }
  }

  render(renderer: THREE.WebGLRenderer, characterPreview = false) {
    // Resize events can arrive before the renderer's deferred resize, particularly on iOS.
    // Match the camera to the actual viewport at draw time, including the first frame.
    const size = renderer.getSize(this.viewportSize);
    if (this.camera.aspect !== size.x / size.y) this.resize(size.x, size.y);
    if (characterPreview && getPerformanceProfile().device.mobile) {
      (this.mobileBackdrop ??= new MobileCharacterBackdrop()).render(renderer);
      return;
    }
    renderer.render(this.scene, this.camera);
  }

  destroy() {
    this.mobileBackdrop?.destroy();
    this.destroyed = true;
    this.sceneLoadId++;
    if (this.loadedScene) this.scene.remove(this.loadedScene.group);
    disposeGlueScene(this.loadedScene);
    this.loadedScene = null;
    this.loadedSceneKey = null;
    this.pendingSceneKey = null;
    if (this.particles) {
      this.scene.remove(this.particles);
      this.particleGeom?.dispose();
      (this.particles.material as THREE.PointsMaterial).map?.dispose();
      (this.particles.material as THREE.Material).dispose();
    }
  }
}
