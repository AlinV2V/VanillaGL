import * as THREE from 'three';
import { restoreRendererViewport } from '../rendering/renderer-viewport';
import { qaGlobals } from '../qa-globals.ts';
import { loadBakedCharacterModel } from '../model-loader';
import type { LoadedPlayerModel } from '../model-loader';
import type { CharacterInfo } from '../world';

export class CharacterPreview {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly modelRoot: THREE.Group;
  private loadedModel: LoadedPlayerModel | null = null;
  private autoRotate = true;
  private rotationSpeed = 0.4; // rads per sec
  private targetRotation = 0;
  private currentRotation = 0;
  // WoW character models face +X in model space; the camera sits on -Y. Yaw the model -90°
  // so the character faces the viewer (matches the real char-select pose).
  private readonly baseRotation = -Math.PI / 2;
  private maxAnisotropy = 8;
  private currentLoadId = 0;
  private viewMode: 'full' | 'face' = 'full';
  private pointerDragging = false;
  private previousPointerX = 0;
  private autoRotateTimer?: ReturnType<typeof setTimeout>;
  private readonly onPointerDown = (event: PointerEvent) => {
    this.pointerDragging = true;
    this.previousPointerX = event.clientX;
    this.autoRotate = false;
  };
  private readonly onPointerMove = (event: PointerEvent) => {
    if (!this.pointerDragging) return;
    this.targetRotation += (event.clientX - this.previousPointerX) * 0.012;
    this.previousPointerX = event.clientX;
  };
  private readonly onPointerUp = () => {
    this.pointerDragging = false;
    clearTimeout(this.autoRotateTimer);
    this.autoRotateTimer = setTimeout(() => { if (!this.pointerDragging) this.autoRotate = true; }, 5000);
  };

  constructor(private readonly canvas: HTMLCanvasElement, maxAnisotropy = 8) {
    this.maxAnisotropy = maxAnisotropy;
    this.scene = new THREE.Scene();
    this.scene.background = null; // transparent, composites over background scene

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    // Z-up scene (baked player models are Z-up). The camera looks along +Y, so the default
    // three.js up vector (0,1,0) is parallel to the view direction — that degenerates the view
    // matrix and the preview model never showed. World-up must be +Z here.
    this.camera.up.set(0, 0, 1);
    // Initial camera placement
    this.camera.position.set(0, -3.2, 1.0);
    this.camera.lookAt(0, 0, 0.95);

    this.modelRoot = new THREE.Group();
    this.scene.add(this.modelRoot);

    qaGlobals.__wowPreview = this;

    this.setupMouseInput();
  }

  get ready(): boolean { return this.loadedModel !== null; }

  async loadCharacter(info: CharacterInfo) {
    // unload() FIRST — it bumps currentLoadId itself. Capturing loadId before calling it made
    // the staleness guard below always true, so every loaded model was instantly disposed
    // (the preview never displayed a character at all).
    this.unload();
    const loadId = ++this.currentLoadId;

    try {
      const model = await loadBakedCharacterModel(info, this.maxAnisotropy);
      if (loadId !== this.currentLoadId) {
        model.dispose(); // discard if obsolete
        return;
      }
      this.loadedModel = model;
      this.modelRoot.add(model.group);
      this.applyPreviewLighting(model.group);
      
      // Stand animation by default
      model.animator?.update(0, 'stand');

      // Reset rotation
      this.targetRotation = 0;
      this.currentRotation = 0;
      this.modelRoot.rotation.set(0, 0, this.baseRotation);

      // position model centered
      model.group.position.set(0, 0, 0);

      // Frame camera based on race height centroid
      this.applyCameraFraming();
    } catch (e) {
      console.error('Failed to load preview character model', e);
    }
  }

  /** M2s use their shader's light uniforms, so Three.js scene lights cannot illuminate this view. */
  private applyPreviewLighting(root: THREE.Object3D) {
    const sunDir = new THREE.Vector3(0, 1, -0.35).normalize();
    const sunColor = new THREE.Vector3(0.78, 0.72, 0.63);
    const ambient = new THREE.Vector3(0.5, 0.5, 0.5);
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        const uniforms = (material as THREE.ShaderMaterial).uniforms;
        if (!uniforms?.uSunDir) continue;
        uniforms.uSunDir = { value: sunDir.clone() };
        uniforms.uSunColor = { value: sunColor.clone() };
        uniforms.uSkyAmbient = { value: ambient.clone() };
        uniforms.uGroundAmbient = { value: ambient.clone() };
        if (uniforms.uLocalCount) uniforms.uLocalCount = { value: 0 };
      }
    });
  }

  unload() {
    this.currentLoadId++; // Invalidate any active async loads
    if (this.loadedModel) {
      this.modelRoot.remove(this.loadedModel.group);
      this.loadedModel.dispose();
      this.loadedModel = null;
    }
  }

  setViewMode(mode: 'full' | 'face') {
    this.viewMode = mode;
    this.applyCameraFraming();
  }

  private applyCameraFraming() {
    if (!this.loadedModel) return;
    // Stand is sampled before this method is called. Frame the current skinned head rather than
    // its bind-pose location; Undead/Troll/Tauren lean far enough that the static target cropped
    // their eyes/hair in the creation close-up.
    const hc = this.loadedModel.getHeadCentroid();

    if (this.viewMode === 'face') {
      // Head close up: transform the animated model-space center through the preview yaw.
      // This keeps strongly hunched/asymmetric idle poses centered instead of targeting x/y=0.
      const yaw = this.modelRoot.rotation.z;
      const x = hc.x * Math.cos(yaw) - hc.y * Math.sin(yaw);
      const y = hc.x * Math.sin(yaw) + hc.y * Math.cos(yaw);
      this.camera.position.set(x, y - 0.85, hc.z);
      this.camera.lookAt(x, y, hc.z);
    } else {
      // Full body framing: at 30° vertical FOV the visible height is 2·d·tan(15°) ≈ 0.54·d.
      // d = 2.6 + headZ·1.6 guarantees clear headroom on every race (horned Tauren included)
      // even in short/wide browser windows, without gnomes drowning in empty space.
      const distance = (2.6 + hc.z * 1.6) * Math.max(1, 0.65 / this.camera.aspect);
      const targetZ = hc.z * 0.5;
      this.camera.position.set(0, -distance, targetZ + 0.15);
      this.camera.lookAt(0, 0, targetZ);
    }
  }

  update(dt: number) {
    if (this.loadedModel?.animator) {
      this.loadedModel.animator.update(dt, 'stand');
    }

    if (this.autoRotate) {
      this.targetRotation += this.rotationSpeed * dt;
    }

    // Smoothly interpolate rotation
    this.currentRotation += (this.targetRotation - this.currentRotation) * 0.1;
    this.modelRoot.rotation.z = this.baseRotation + this.currentRotation;
  }

  render(renderer: THREE.WebGLRenderer, x: number, y: number, w: number, h: number) {
    const aspectChanged = this.camera.aspect !== w / h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (aspectChanged) this.applyCameraFraming();

    // Use scissor and viewport to draw character in a box
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, w, h);
    renderer.setViewport(x, y, w, h);

    // Don't autoClear since we render over the background scene
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    // The background scene already wrote depth for this frame; with the authentic (near) glue
    // camera those depths are small enough to occlude the preview model entirely. Clear depth
    // (scissored to this box) so the character always composites on top of the backdrop.
    renderer.clearDepth();

    renderer.render(this.scene, this.camera);

    restoreRendererViewport(renderer);
    renderer.autoClear = oldAutoClear;
  }

  private setupMouseInput() {
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
  }

  rotateLeft(dt: number) {
    this.autoRotate = false;
    this.targetRotation += 1.8 * dt;
  }

  rotateRight(dt: number) {
    this.autoRotate = false;
    this.targetRotation -= 1.8 * dt;
  }

  setAutoRotate(value: boolean) {
    this.autoRotate = value;
  }

  destroy() {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    clearTimeout(this.autoRotateTimer);
    this.unload();
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry?.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose());
        } else {
          obj.material?.dispose();
        }
      }
    });
  }
}
