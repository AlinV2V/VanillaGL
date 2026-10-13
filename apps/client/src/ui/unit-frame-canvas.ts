import * as THREE from 'three';
import { VanillaCanvas } from './vanilla-canvas';
import { getInterfaceCvars, onInterfaceCvars } from './interface-runtime';
import { resolveM2Skinning } from '../rendering/m2-gpu-skinning';
import { RAID_TARGET_ATLAS, raidTargetSource } from './raid-target-icons';
import { renderUnitPortrait } from './unit-portrait-renderer';
import { cloneMaterialWithSharedTextures } from '../rendering/clone-material-shared-textures';

const TARGET = '/ui/Interface/TargetingFrame';
const POWER_COLORS: Record<string, string> = {
  mana: '#0000ff',
  rage: '#ff0000',
  focus: '#ff8000',
  energy: '#ffff00',
  happiness: '#00ffff',
};

export type UnitFrameCanvasView = {
  side: 'player' | 'target';
  name: string;
  level: string;
  levelColor?: string;
  health: { current?: number; maximum?: number };
  power: { current?: number; maximum?: number; kind: string };
  dead?: boolean;
  skull?: boolean;
  attacking?: boolean;
  attackBlocked?: boolean;
  frameArt?: string;
  nameBackground?: string;
  pvpIconUrl?: string;
  fallbackPortraitUrl?: string;
  livePortrait?: boolean;
  /** Rogue/Druid combo points on this unit, 0..5. Target frame only. */
  comboPoints?: number;
  /** GetRaidTargetIndex result, 1..8; zero/undefined hides TargetRaidTargetIcon. */
  raidTargetIndex?: number;
};

/**
 * ComboFrame geometry transcribed from 1.12 FrameXML (`ComboFrame.xml`).
 *
 * The frame anchors TOPRIGHT to TargetFrame at (-44, -9); ComboPoint1 sits at its TOPRIGHT and
 * each later point anchors TOP-to-BOTTOM of the previous one with a small offset, producing the
 * characteristic downward-right arc. Points are 12x12 frames drawing a 12x16 texture, except the
 * fifth which is 15x18. WoW's positive Y offset moves up, so the cascade is (bottom - offsetY).
 */
const COMBO_POINT_ART = '/ui/Interface/CharacterFrame/ComboPoint.png';
// ComboPoint is a 32x16 atlas, not a single sprite. ComboFrame.xml slices it with TexCoords:
// base point 0 -> 0.375 (12px), highlight 0.375 -> 0.5625 (8px), shine 0.5625 -> 1 (14px, ADD).
// Only the base point is drawn here; highlight/shine are the fade-in flourish on gaining a point.
const COMBO_POINT_SRC = { x: 0, y: 0, w: 12, h: 16 };
const COMBO_POINTS = (() => {
  const points: Array<{ x: number; y: number; w: number; h: number }> = [];
  // ComboFrame TOPRIGHT = TargetFrame right (232) - 44; top = 9 below the frame top.
  let centerX = 232 - 44 - 6; // ComboPoint1 is 12 wide, anchored by its right edge
  let top = 9;
  const cascade: Array<[number, number]> = [[0, 0], [7, 4], [5, 2], [2, 1], [0, 1]];
  cascade.forEach(([dx, dy], index) => {
    const w = index === 4 ? 15 : 12;
    const h = index === 4 ? 18 : 16;
    if (index === 0) {
      points.push({ x: centerX - 6, y: top, w, h });
      return;
    }
    const previousBottom = top + 12; // anchor uses the 12x12 frame box, not the taller texture
    centerX += dx;
    top = previousBottom - dy;
    points.push({ x: centerX - w / 2, y: top, w, h });
  });
  return points;
})();

const ratio = (current?: number, maximum?: number) =>
  maximum && maximum > 0 && current !== undefined ? Math.max(0, Math.min(1, current / maximum)) : 0;

const valueText = (current?: number, maximum?: number) =>
  maximum && maximum > 0 && current !== undefined ? `${current} / ${maximum}` : '';

/** Exact 232x100 PlayerFrame/TargetFrame composition from 1.12 FrameXML. */
export class UnitFrameCanvas {
  readonly surface: VanillaCanvas;
  private view?: UnitFrameCanvasView;
  // Vanilla only prints the "cur / max" text on a unit-frame bar while the mouse is over the frame
  // (TextStatusBar.lua: lockShow>0 from UnitFrame OnEnter), or permanently when the "Status Bar
  // Text" option (statusBarText CVar) is on AND that bar is `textLockable` — which only the
  // player's own health/mana bars are. See the paint() note for the byte-level citation.
  private hovering = false;

  constructor(host: HTMLElement) {
    this.surface = new VanillaCanvas(232, 100, 'wow-unit-frame-canvas');
    host.appendChild(this.surface.canvas);
    this.surface.canvas.addEventListener('mouseenter', () => { this.hovering = true; this.surface.requestRender(); });
    this.surface.canvas.addEventListener('mouseleave', () => { this.hovering = false; this.surface.requestRender(); });
    // Repaint when the "Status Bar Text" Interface option is toggled so the change previews live.
    onInterfaceCvars(() => this.surface.requestRender());
    this.surface.onRender(() => this.paint());
  }

  setView(view: UnitFrameCanvasView) {
    this.view = view;
    this.surface.requestRender();
  }

  private paint() {
    const s = this.surface;
    const view = this.view;
    s.clear();
    if (!view) return;
    const player = view.side === 'player';
    const barX = player ? 106 : 7;
    const portraitX = player ? 42 : 126;
    const nameX = player ? 116 : 16;
    const levelX = player ? 53 : 179;

    const ctx = s.ctx;
    ctx.fillStyle = 'rgba(0,0,0,0.52)';
    ctx.fillRect(barX, 22, 119, 41);
    if (view.nameBackground) {
      ctx.fillStyle = view.nameBackground;
      ctx.fillRect(barX, 22, 119, 19);
    }

    // Fallback is only visible while the live model clone is unavailable.
    if (!view.livePortrait) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(portraitX + 32, 44, 31, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = '#080b0f';
      ctx.fillRect(portraitX, 12, 64, 64);
      if (view.fallbackPortraitUrl) s.image(view.fallbackPortraitUrl, portraitX, 12, 64, 64);
      ctx.restore();
    }

    this.drawBar(barX, 41, ratio(view.health.current, view.health.maximum), '#00ff00');
    this.drawBar(barX, 52, ratio(view.power.current, view.power.maximum), POWER_COLORS[view.power.kind] ?? POWER_COLORS.mana);

    if (player && view.attacking) {
      s.image(`${TARGET}/UI-TargetingFrame-AttackBackground.png`, 37, 50, 32, 32);
      s.sprite('/ui/Interface/CharacterFrame/UI-StateIcon.png', 32, 0, 32, 32, 38, 51, 32, 32);
      if (view.attackBlocked) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.78;
        s.sprite('/ui/Interface/CharacterFrame/UI-StateIcon.png', 32, 32, 32, 32, 38, 51, 32, 32);
        ctx.restore();
      }
    }

    const art = view.frameArt ?? `${TARGET}/UI-TargetingFrame.png`;
    ctx.save();
    if (player) {
      ctx.translate(232, 0);
      ctx.scale(-1, 1);
    }
    s.sprite(art, 24, 0, 232, 100, 0, 0, 232, 100);
    ctx.restore();

    if (view.pvpIconUrl) s.image(view.pvpIconUrl, player ? 28 : 176, 52, 30, 30);
    if (!player && view.raidTargetIndex) {
      const icon = raidTargetSource(view.raidTargetIndex);
      // TargetFrame.xml: 26x26 CENTER on TOPRIGHT with offset (-73,-14) -> top-left (146,1).
      s.sprite(RAID_TARGET_ATLAS, icon.x, icon.y, icon.w, icon.h, 146, 1, 26, 26);
    }
    s.text(view.name, nameX + 50, 32, { size: 10, color: '#ffd100', align: 'center', baseline: 'middle', maxWidth: 98 });
    if (view.skull) s.image(`${TARGET}/UI-TargetingFrame-Skull.png`, 169, 58, 20, 20);
    else s.text(view.level, levelX, 68, { size: 10, color: view.levelColor ?? '#ffd100', align: 'center', baseline: 'middle' });
    if (view.dead && !player) s.text('DEAD', 66, 49, { size: 10, color: '#ffd100', align: 'center', baseline: 'middle' });
    // Bar values follow the vanilla rule, which is per-bar and not global. TextStatusBar.lua:47
    // only honours the "Status Bar Text" option for bars flagged `textLockable`, and in 1.12.1
    // exactly two unit-frame bars set it: PlayerFrameHealthBar and PlayerFrameManaBar
    // (PlayerFrame.xml:276/304). TargetFrame.xml sets it nowhere — so a selected NPC or mob
    // never shows locked-on numbers, only the hover reveal (lockShow>0 from UnitFrame OnEnter).
    if (this.hovering || (player && Number(getInterfaceCvars().statusBarText) === 1)) {
      const textColor = view.dead ? '#bdbdbd' : '#ffffff';
      s.text(valueText(view.health.current, view.health.maximum), barX + 59.5, 47, { family: 'sans', size: 9, color: textColor, align: 'center', baseline: 'middle', maxWidth: 116 });
      s.text(valueText(view.power.current, view.power.maximum), barX + 59.5, 58, { family: 'sans', size: 9, color: textColor, align: 'center', baseline: 'middle', maxWidth: 116 });
    }

    // ComboFrame is hidden entirely at zero points (ComboFrame.lua ComboPointsFrame_OnEvent).
    if (!player && view.comboPoints) {
      const shown = Math.max(0, Math.min(COMBO_POINTS.length, view.comboPoints));
      for (let i = 0; i < shown; i++) {
        const point = COMBO_POINTS[i];
        s.sprite(COMBO_POINT_ART, COMBO_POINT_SRC.x, COMBO_POINT_SRC.y, COMBO_POINT_SRC.w, COMBO_POINT_SRC.h, point.x, point.y, point.w, point.h);
      }
    }
  }

  private drawBar(x: number, y: number, fill: number, color: string) {
    const s = this.surface;
    const ctx = s.ctx;
    ctx.fillStyle = '#050505';
    ctx.fillRect(x, y, 119, 12);
    const width = Math.round(119 * fill);
    if (width <= 0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, 12);
    ctx.clip();
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 119, 12);
    // UI-StatusBar is an opaque grayscale highlight. Pass alpha to the image
    // helper itself: it deliberately resets globalAlpha, so setting it only on
    // the outer context made the texture fully opaque and hid every HP/MP tint.
    s.image(`${TARGET}/UI-StatusBar.png`, x, y, 119, 12, 0.22);
    ctx.restore();
  }
}

/**
 * Static 3D portrait canvas backed by the already-loaded world model. Vanilla
 * unit portraits do not bob or run with their world model; capture once when
 * the source changes and retain that frame until another model is selected.
 */
export class LiveUnitPortrait {
  readonly canvas: HTMLCanvasElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
  private source?: THREE.Object3D;
  private clone?: THREE.Object3D;
  private renderedSource?: THREE.Object3D;
  /** Frozen copy of the source rig's pose; owned by this portrait, disposed when the source changes. */
  private boneSnapshot?: THREE.DataTexture;

  constructor(host: HTMLElement, side: 'player' | 'target') {
    this.canvas = document.createElement('canvas');

    // native resolution so the cached portrait has the same edge/sharpness character as 1.12.
    this.canvas.width = 64;
    this.canvas.height = 64;
    this.canvas.className = `wow-unit-live-portrait wow-unit-live-portrait--${side}`;
    host.appendChild(this.canvas);
    this.camera.up.set(0, 0, 1);
  }

  render(source: THREE.Object3D | undefined): boolean {
    if (!source) {
      this.canvas.style.display = 'none';
      return false;
    }
    if (source === this.renderedSource && this.clone) {
      this.canvas.style.display = 'block';
      return true;
    }
    if (source !== this.source) this.setSource(source);
    if (!this.clone) return false;
    this.canvas.style.display = 'block';
    if (!renderUnitPortrait(this.scene, this.camera, this.canvas)) {
      this.canvas.style.display = 'none';
      return false;
    }
    this.renderedSource = source; queueMicrotask(() => this.canvas.dispatchEvent(new Event('portrait-rendered')));
    return true;
  }

  private setSource(source: THREE.Object3D) {
    if (this.clone) {
      this.scene.remove(this.clone);
      this.clone.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
      });
    }
    this.source = source;
    this.renderedSource = undefined;
    // The clone renders in its own scene and the shared portrait WebGLRenderer, so it never receives the
    // per-draw `onBeforeRender` hook that binds the rig's bone texture — three's `Object3D.copy`
    // does not carry render hooks. Without this the cloned material keeps `uBoneTexture: null`,
    // every texelFetch returns zero, all four bone matrices collapse, and the portrait draws a
    // degenerate model at the origin. Snapshot the pose so the capture is frozen, matching this
    // class's contract, rather than aliasing the live rig texture.
    this.boneSnapshot?.dispose();
    this.boneSnapshot = resolveM2Skinning(source)?.snapshotTexture();
    const usesAuthoredCamera = !!source.userData?.portraitCamera;
    this.clone = source.clone(true);
    this.clone.position.set(0, 0, 0);
    // Authored M2 cameras and geometry share model space. Legacy models without a camera still
    // need the old +X-front to -Y-camera conversion used by the semantic head fallback.
    this.clone.rotation.set(0, 0, usesAuthoredCamera ? 0 : -Math.PI / 2);
    this.clone.traverse((object) => {
      object.frustumCulled = false;
      if (object.userData?.isBlobShadow) object.visible = false;
      if (!(object instanceof THREE.Mesh)) return;
      // M2s use custom shader materials whose light uniforms are normally shared with the world.
      // PortraitButton.cpp replaces those with a fixed portrait rig: ambient RGB 0.45 and one white
      // directional ray (-1,0,-1), with no world fog. Clone before overriding so the world model is
      // untouched while the cached portrait gets the native deterministic illumination.
      const portraitMaterial = (material: THREE.Material) => {
        const cloned = cloneMaterialWithSharedTextures(material);
        if (!(cloned instanceof THREE.ShaderMaterial)) return cloned;
        const uniforms = cloned.uniforms;
        uniforms.uSunDir?.value?.set?.(-1, 0, -1)?.normalize?.();
        uniforms.uSunColor?.value?.set?.(1, 1, 1);
        uniforms.uSkyAmbient?.value?.set?.(0.45, 0.45, 0.45);
        uniforms.uGroundAmbient?.value?.set?.(0.45, 0.45, 0.45);
        if (uniforms.uUnfogged) uniforms.uUnfogged.value = 1;
        if (uniforms.uHalfLambert) uniforms.uHalfLambert.value = 0;
        if (uniforms.uLocalCount) uniforms.uLocalCount.value = 0;
        // The borrowed bone uniform captures whichever rig was
        // bound on the previous world draw. Overwrite it with this portrait's own frozen pose.
        if (uniforms.uBoneTexture && this.boneSnapshot) uniforms.uBoneTexture.value = this.boneSnapshot;
        return cloned;
      };
      object.material = Array.isArray(object.material)
        ? object.material.map(portraitMaterial)
        : portraitMaterial(object.material);
    });
    this.scene.add(this.clone);
    this.clone.updateWorldMatrix(true, true);
    const bounds = new THREE.Box3().setFromObject(this.clone);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    if (!Number.isFinite(size.z) || size.z <= 0.01) {
      this.scene.remove(this.clone);
      this.clone = undefined;
      return;
    }
    const framing = source.userData?.portraitFraming as
      | { focus?: [number, number, number]; radius?: number }
      | undefined;
    const authoredCamera = source.userData?.portraitCamera as
      | {
          fov?: number;
          nearClip?: number;
          farClip?: number;
          position?: [number, number, number];
          target?: [number, number, number];
        }
      | undefined;
    const target = center.clone();
    let distance: number;
    if (
      authoredCamera?.position?.length === 3 &&
      authoredCamera.target?.length === 3 &&
      authoredCamera.position.every(Number.isFinite) &&
      authoredCamera.target.every(Number.isFinite) &&
      Number.isFinite(authoredCamera.fov) &&
      (authoredCamera.fov ?? 0) > 0
    ) {
      // Character M2 camera type 0 is the exact SetPortraitTexture camera. It is already authored
      // in the model's coordinate space and differs per race/gender; no extra yaw or head fit.
      target.fromArray(authoredCamera.target);
      this.camera.position.fromArray(authoredCamera.position);
      // Vanilla M2 camera FOV is horizontal at the authored 4:3 aspect. Three.js expects vertical
      // FOV, and the portrait target is square. Treating the stored value as vertical made every
      // face about 25% too small inside the medallion.
      const verticalFov = 2 * Math.atan(Math.tan(authoredCamera.fov! / 2) / (4 / 3));
      this.camera.fov = THREE.MathUtils.radToDeg(verticalFov);
      this.camera.near = Math.max(0.001, authoredCamera.nearClip ?? 0.05);
      this.camera.far = Math.max(this.camera.near + 1, authoredCamera.farClip ?? 100);
      distance = this.camera.position.distanceTo(target);
    } else if (
      framing?.focus?.length === 3 &&
      framing.focus.every(Number.isFinite) &&
      Number.isFinite(framing.radius) &&
      (framing.radius ?? 0) > 0
    ) {
      // SetPortraitTexture frames the semantic M2 head rather than the model AABB. Transform that
      // point after rotating the clone into its front view, then fit the tight head volume.
      target.fromArray(framing.focus).applyMatrix4(this.clone.matrixWorld);
      const radius = framing.radius!;
      // Vanilla's cached 64x64 portrait is a tight bust/face crop. Keep only a
      // sliver of the shoulders on players and let long-snouted creatures fill
      // the medallion instead of reading as a miniature full model.
      distance = Math.max(0.3, radius * 3.4);
      this.camera.position.set(target.x, target.y - distance, target.z + radius * 0.04);
    } else {
      // A few legacy/effect models have no head key bone. Keep a conservative upper-body crop
      // rather than returning to the old whole-body view.
      target.z = bounds.min.z + size.z * 0.84;
      distance = Math.max(0.42, size.z * 0.38);
      this.camera.position.set(target.x, target.y - distance, target.z + size.z * 0.01);
    }
    this.camera.lookAt(target);
    if (!authoredCamera?.position) {
      this.camera.fov = 30;
      this.camera.near = Math.max(0.01, distance * 0.02);
      this.camera.far = Math.max(25, distance * 8);
    }
    this.camera.updateProjectionMatrix();
  }
}
