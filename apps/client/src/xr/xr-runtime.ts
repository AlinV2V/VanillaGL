import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { PlayerMovementController } from '../player/movement-controller';
import type { LoadedPlayerModel } from '../model-loader';
import type { WorldCollision } from '../world-collision';
import { xrViewState } from '../rendering/xr-view-state';
import { XrAvatar } from './xr-avatar';
import { XrRig } from './xr-rig';
import { XrCanvasPanel } from './xr-canvas-panel';
import { movementKeys, SnapTurn, SwingGesture } from './xr-input-state';
import { XrPerformance } from './xr-performance';
import { XrHoldButton, loadXrSettings } from './xr-settings';
import { XrMenu } from './xr-menu';
import { XrHud } from './xr-hud';
import { xrGameAction } from './xr-game-actions';
import './xr-ui.css';

export type XrRuntimeDeps = {
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls;
  movement: PlayerMovementController; playerRoot: THREE.Group; collision: WorldCollision;
  ready: () => boolean; avatarAllowed: () => boolean; eyeHeight: () => number;
  twoHanded: () => boolean; resetClock: () => void;
  attack: () => void; toggleAttack: () => void; cycleTarget: () => void;
  pick: (camera: THREE.PerspectiveCamera, interact: boolean) => void;
  log: (message: string) => void;
};

/** Optional presentation/input adapter. Realm traffic stays in the existing gameplay controllers. */
export class XrRuntime {
  readonly avatar = new XrAvatar();
  private readonly rig: XrRig;
  private readonly panel: XrCanvasPanel;
  private readonly settings = loadXrSettings();
  private readonly menu: XrMenu;
  private readonly hud: XrHud;
  private readonly menuButton = new XrHoldButton();
  private appliedResolution = 1;
  private readonly snap = new SnapTurn();
  private readonly swing = new SwingGesture();
  private readonly pickCamera = new THREE.PerspectiveCamera(60, 1, 0.03, 100);
  private readonly ray = new THREE.Ray();
  private readonly position = new THREE.Vector3();
  private readonly button = document.createElement('canvas');
  private readonly buttons = new Map<string, boolean>();
  private frame?: XRFrame;
  private session?: XRSession;
  private pending = false;
  private status = 'Checking VR support…';
  private supported = false;
  private controlsEnabled = true;
  private savedXrEnabled = false;
  private savedAutoUpdate = true;
  private attackRequestedAt = -Infinity;
  private latestTime = 0;
  private validTracking = false;
  private mustRelease = true;
  private readonly handMatrix = new THREE.Matrix4();
  private readonly headMatrix = new THREE.Matrix4();
  private xrTarget: THREE.WebGLRenderTarget | null = null;
  private readonly performance = new XrPerformance();
  private inputHands = 0;
  private readonly statusTimer: ReturnType<typeof setInterval>;
  private readonly restoreRender: () => void;
  private readonly restoreLoop: () => void;

  constructor(private readonly deps: XrRuntimeDeps) {
    const { renderer, scene, camera } = deps;
    this.rig = new XrRig(renderer, scene, camera);
    this.panel = new XrCanvasPanel(scene, renderer.domElement, name => this.action(name));
    this.menu = new XrMenu(scene, this.settings, name => this.action(name), () => this.applySettings());
    this.hud = new XrHud(scene);
    // Auxiliary portraits/offscreen renders must never consume the headset's stereo camera.
    const render = renderer.render.bind(renderer);
    renderer.render = (renderScene, renderCamera) => {
      const enabled = renderer.xr.enabled;
      if (this.active && renderCamera === camera) renderer.setRenderTarget(this.xrTarget);
      if (this.active && renderCamera !== camera) renderer.xr.enabled = false;
      try { render(renderScene, renderCamera); } finally { renderer.xr.enabled = enabled; }
    };
    this.restoreRender = () => { renderer.render = render; };
    const loop = renderer.setAnimationLoop.bind(renderer);
    renderer.setAnimationLoop = callback => loop(callback ? (time, frame) => {
      const started = performance.now(); this.beforeFrame(time, frame); callback(time, frame);
      if (this.active && this.validTracking) this.performance.record(time, performance.now() - started, this.session?.frameRate ?? 72);
    } : null);
    this.restoreLoop = () => { renderer.setAnimationLoop = loop; };
    this.button.width = 440; this.button.height = 52;
    this.button.setAttribute('role', 'button'); this.button.tabIndex = 0;
    Object.assign(this.button.style, { position: 'fixed', top: '8px', left: '50%', transform: 'translateX(-50%)',
      width: '330px', height: '39px', zIndex: '10000', cursor: 'pointer' });
    this.button.addEventListener('click', () => void this.enter());
    this.button.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') void this.enter(); });
    document.body.appendChild(this.button);
    this.statusTimer = setInterval(() => this.paintStatus(), 500);
    renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);
    const xrSystem = navigator.xr as XRSystem & { addEventListener?: EventTarget['addEventListener'] } | undefined;
    xrSystem?.addEventListener?.('devicechange', this.onDeviceChange);
    window.addEventListener('focus', this.onDeviceChange);
    (globalThis as unknown as { __wowXR: () => unknown }).__wowXR = () => this.diagnostics();
    void this.detect();
  }
  get active() { return !!this.session; }
  bindModel(model: LoadedPlayerModel, race: number) { this.avatar.bind(model, race); this.rig.eyeForward = this.avatar.eyeForward; }
  clearModel() { this.avatar.clear(); }
  private action(name: string) {
    if (name === 'Recenter') { this.recenter(); this.menu.hide(); }
    else if (name === 'Exit VR') void this.exit();
    else if (name === 'Attack') this.deps.toggleAttack();
    else if (name === 'Minimap') this.hud.minimap = !this.hud.minimap;
    else if (name === 'Combat') { this.hud.combat = !this.hud.combat; this.menu.hide(); this.panel.hide(); }
    else if (name === 'Settings') { this.panel.hide(); this.menu.show(this.deps.camera, 'settings', this.appliedResolution); }
    else { this.menu.hide(); xrGameAction(name); this.panel.show(this.deps.camera); }
  }
  private applySettings() {
    if (this.active) this.deps.renderer.xr.setFoveation(this.settings.foveation);
    this.rig.distance = this.settings.distance;
    this.avatar.handScale = this.settings.handScale; this.avatar.gripPitch = this.settings.pitch; this.avatar.gripRoll = this.settings.roll;
  }
  private async detect() {
    try {
      this.supported = !!navigator.xr && await navigator.xr.isSessionSupported('immersive-vr');
      this.status = this.supported ? 'Enter VR · Experimental' : 'No compatible XR runtime · click to retry';
    } catch (error) { this.supported = false; this.status = `VR unavailable: ${(error as Error).message}`; }
    if (!window.isSecureContext) this.status = 'VR requires trusted HTTPS (or PC localhost)';
    this.paintStatus();
  }
  private paintStatus() {
    // Desktop players without a headset never see VR UI; devicechange/focus re-detection reveals it when one connects.
    const offerVr = this.supported || this.pending;
    this.button.style.display = this.active || !this.deps.ready() || !offerVr ? 'none' : 'block';
    const ctx = this.button.getContext('2d')!;
    ctx.fillStyle = '#17212e'; ctx.fillRect(0, 0, 440, 52); ctx.strokeStyle = '#c7a35d'; ctx.strokeRect(1, 1, 438, 50);
    ctx.fillStyle = '#ffdc87'; ctx.font = '18px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(this.pending ? 'Connecting VR…' : this.status, 220, 32, 426);
    this.button.setAttribute('aria-label', this.status);
  }
  async enter() {
    if (this.pending || this.active || !this.deps.ready()) return;
    if (!navigator.xr) { this.status = 'Use Quest Browser or Windows Chrome/Edge'; this.deps.log(this.status); this.paintStatus(); return; }
    if (!this.supported) { await this.detect(); this.deps.log('VR uses the active Windows OpenXR runtime. Restart Chrome/Edge after changing runtime; Steam Link alone does not enable WebXR. Click Enter VR again if detected.'); return; }
    this.pending = true; this.paintStatus();
    const xr = this.deps.renderer.xr;
    this.savedXrEnabled = xr.enabled; this.savedAutoUpdate = xr.cameraAutoUpdate;
    let session: XRSession | undefined;
    try {
      session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
      if (!this.deps.ready()) { await session.end(); return; }
      xr.enabled = true; xr.cameraAutoUpdate = false;
      xr.setReferenceSpaceType(session.enabledFeatures?.includes('local-floor') ? 'local-floor' : 'local');
      this.appliedResolution = this.settings.resolution; xr.setFramebufferScaleFactor(this.appliedResolution);
      this.session = session; this.controlsEnabled = this.deps.controls.enabled; this.deps.controls.enabled = false;
      this.rig.start(); this.deps.movement.setXrInput(true, []);
      document.documentElement.classList.add('vanillagl-xr');
      this.avatar.reset(); this.performance.reset(); xrViewState.active = true; this.deps.resetClock();
      session.addEventListener('end', this.onEnd);
      session.addEventListener('visibilitychange', this.onVisibility);
      await xr.setSession(session);
      xr.getReferenceSpace()?.addEventListener('reset', this.onReferenceReset);
      this.applySettings();
      if (session.supportedFrameRates?.includes(72)) await session.updateTargetFrameRate(72).catch(() => {});
      this.status = 'Enter VR · Experimental';
      this.deps.log(`VR connected: ${Math.round(this.appliedResolution * 100)}% resolution. Hold B for menu and clarity settings.`);
    } catch (error) {
      this.status = `VR: ${(error as Error).message}`; this.deps.log(this.status);
      if (session) await session.end().catch(() => {});
      if (this.session) this.onEnd();
      else { xr.enabled = this.savedXrEnabled; xr.cameraAutoUpdate = this.savedAutoUpdate; }
    } finally { this.pending = false; this.paintStatus(); }
  }
  async exit() { if (this.session) await this.session.end().catch(error => this.deps.log(`VR exit: ${error}`)); }
  recenter() { this.rig.recenter(); this.releaseInput(); }
  private readonly onContextLost = () => { void this.exit(); };
  private readonly onDeviceChange = () => { void this.detect(); };
  private readonly onReferenceReset = () => this.recenter();
  private readonly onVisibility = () => { this.releaseInput(); if (this.session?.visibilityState === 'visible') this.recenter(); };
  private readonly onEnd = () => {
    const session = this.session;
    if (!session) return;
    session?.removeEventListener('end', this.onEnd); session?.removeEventListener('visibilitychange', this.onVisibility);
    this.deps.renderer.xr.getReferenceSpace()?.removeEventListener('reset', this.onReferenceReset);
    this.releaseInput(); this.session = undefined; this.frame = undefined;
    this.avatar.enabled = false; this.avatar.reset(); this.panel.hide(); this.menu.hide(); this.hud.hide();
    document.documentElement.classList.remove('vanillagl-xr');
    xrViewState.active = false; xrViewState.views = [];
    this.deps.movement.setXrInput(false, []);
    this.deps.controls.enabled = this.controlsEnabled;
    this.deps.controls.target.copy(this.deps.movement.charPos).z += this.deps.eyeHeight();
    this.rig.end(this.deps.movement.charPos);
    this.deps.renderer.xr.enabled = this.savedXrEnabled;
    this.deps.renderer.xr.cameraAutoUpdate = this.savedAutoUpdate;
    this.deps.resetClock();
    this.paintStatus();
  };
  private releaseInput() {
    this.deps.movement.setXrInput(this.active, []); this.buttons.clear(); this.snap.reset(); this.swing.reset();
    if (this.active && this.validTracking) { try { this.deps.movement.sendHeartbeat(true); } catch { /* disconnected realm */ } }
    this.panel.release(); this.avatar.setHand('left'); this.avatar.setHand('right'); this.validTracking = false;
    this.menuButton.reset(); this.menu.hide(); this.hud.release();
    this.mustRelease = true; this.inputHands = 0; this.performance.pause(); this.deps.resetClock();
  }
  private edge(key: string, pressed: boolean) {
    const old = this.buttons.get(key) ?? false; this.buttons.set(key, pressed);
    return { down: pressed && !old, up: !pressed && old };
  }
  private beforeFrame(time: number, frame?: XRFrame) {
    this.frame = frame; this.latestTime = time;
    if (!this.session) return;
    this.xrTarget = this.deps.renderer.getRenderTarget();
    if (!this.deps.ready()) { this.releaseInput(); void this.exit(); return; }
    if (!frame || this.session.visibilityState !== 'visible') { this.releaseInput(); return; }
    this.syncPose();
    if (!this.validTracking) { this.releaseInput(); return; }
    if (this.hud.hasNewDialog(time)) { this.menu.hide(); this.panel.show(this.deps.camera); }
    this.hud.update(this.deps.camera, time, !this.menu.visible && !this.panel.mesh.visible);
    const space = this.deps.renderer.xr.getReferenceSpace(); if (!space) return;
    if (this.mustRelease) {
      const neutral = Array.from(this.session.inputSources).every(source => !source.gamepad
        || (source.gamepad.buttons.every(button => !button.pressed) && source.gamepad.axes.every(axis => Math.abs(axis) < 0.25)));
      if (neutral) this.mustRelease = false;
      return;
    }
    let forward = 0, strafe = 0, jump = false;
    let leftTracked = false, rightTracked = false;
    for (const source of this.session.inputSources) {
      const hand = source.handedness; if (hand !== 'left' && hand !== 'right') continue;
      const pose = source.gripSpace && frame.getPose(source.gripSpace, space), gamepad = source.gamepad;
      if (!pose || pose.emulatedPosition || !gamepad || gamepad.mapping !== 'xr-standard') continue;
      const pressed = (i: number) => gamepad.buttons[i]?.pressed ?? false;
      if (hand === 'left') {
        leftTracked = true; this.avatar.supportGrip = this.deps.twoHanded() && pressed(1);
        strafe = gamepad.axes[2] ?? 0; forward = -(gamepad.axes[3] ?? 0);
        if (this.edge('X', pressed(4)).down) this.deps.cycleTarget();
        if (this.edge('Y', pressed(5)).down) this.action('Minimap');
        if (this.edge('leftStick', pressed(3)).down) this.recenter();
      } else {
        rightTracked = true;
        const menuEvent = this.menuButton.sample(pressed(5), time);
        if (menuEvent === 'hold') { this.panel.hide(); this.menu.show(this.deps.camera, 'wheel', this.appliedResolution); }
        if (menuEvent === 'tap') {
          if (this.menu.visible || this.panel.mesh.visible) { this.menu.hide(); this.panel.hide(); }
          else this.action('Bags');
        }
        if (this.menu.wheel) this.menu.stick(gamepad.axes[2] ?? 0, gamepad.axes[3] ?? 0);
        if (menuEvent === 'release') this.menu.choose();
        if (!this.menu.visible && !this.menuButton.pressed && !this.panel.mesh.visible && menuEvent !== 'release') this.deps.movement.snapXrTurn(this.snap.sample(gamepad.axes[2] ?? 0));
        else this.snap.sample(1); // Require neutral before turning after a menu gesture.
        jump = pressed(4) && !this.menu.visible;
        if (this.edge('rightStick', pressed(3)).down) this.action('Combat');
        const aim = frame.getPose(source.targetRaySpace, space), edge = this.edge('trigger', pressed(0));
        let ui = false;
        if (aim) {
          this.pickCamera.matrix.fromArray(aim.transform.matrix).premultiply(this.rig.root.matrixWorld);
          this.pickCamera.matrix.decompose(this.pickCamera.position, this.pickCamera.quaternion, this.pickCamera.scale);
          this.pickCamera.updateMatrixWorld(true);
          this.ray.origin.copy(this.pickCamera.position); this.pickCamera.getWorldDirection(this.ray.direction);
          ui = this.menu.pointer(this.ray, edge.down) || this.panel.pointer(this.ray, edge.down, edge.up)
            || this.hud.pointer(this.ray, edge.down, edge.up);
          if (!ui && !this.menu.visible && !this.panel.mesh.visible && edge.down) this.deps.pick(this.pickCamera, true);
        }
        const p = pose.transform.position; this.position.set(p.x, p.y, p.z);
        if (this.swing.sample(this.position, time, pressed(1) && !ui && !this.panel.mesh.visible && !this.menu.visible && !this.menuButton.pressed)
          && time - this.attackRequestedAt > 750) { this.attackRequestedAt = time; this.deps.attack(); }
      }
    }
    if (!leftTracked) { this.buttons.delete('X'); this.buttons.delete('Y'); this.buttons.delete('leftStick'); this.avatar.supportGrip = false; }
    if (!rightTracked) { this.buttons.delete('trigger'); this.buttons.delete('rightStick'); this.menuButton.reset(); this.snap.reset(); this.swing.reset(); this.panel.release(); this.hud.release(); }
    const hands = (leftTracked ? 1 : 0) | (rightTracked ? 2 : 0);
    if (this.inputHands & ~hands) { this.releaseInput(); return; }
    this.inputHands = hands;
    this.deps.movement.setXrInput(true, this.panel.mesh.visible || this.menu.visible || this.menuButton.pressed ? [] : movementKeys(forward, strafe, jump));
    this.panel.paint(time);
  }
  /** Called again after collision/movement and before local animation sampling. */
  syncPose() {
    if (!this.session || !this.frame) return;
    if (this.session.visibilityState !== 'visible') { this.avatar.enabled = false; return; }
    this.validTracking = this.rig.update(this.frame, this.deps.movement.charPos, this.deps.movement.getServerOrientation(),
      this.deps.eyeHeight(), (start, end) => this.deps.collision.clampSegment(start, end, 0.1).distanceToSquared(end) > 0.0001);
    this.avatar.enabled = this.validTracking && this.deps.avatarAllowed();
    this.avatar.setHand('left'); this.avatar.setHand('right');
    const space = this.deps.renderer.xr.getReferenceSpace();
    if (this.validTracking && space) {
      const head = this.frame.getViewerPose(space);
      if (head) this.avatar.setHead(this.headMatrix.fromArray(head.transform.matrix).premultiply(this.rig.root.matrixWorld));
      for (const source of this.session.inputSources) {
        const hand = source.handedness, pose = source.gripSpace && this.frame.getPose(source.gripSpace, space);
        if (pose && !pose.emulatedPosition && (hand === 'left' || hand === 'right')) this.avatar.setHand(hand, this.handMatrix.fromArray(pose.transform.matrix).premultiply(this.rig.root.matrixWorld));
      }
    }
    for (const grip of this.rig.grips) if (grip.children[0]) grip.children[0].visible = !this.avatar.enabled || !this.avatar.supported;
  }
  haptic() {
    const pad = Array.from(this.session?.inputSources ?? []).find(s => s.handedness === 'right')?.gamepad;
    void pad?.hapticActuators?.[0]?.pulse(0.25, 35).catch(() => {});
  }
  diagnostics() { return { active: this.active, supported: this.supported, tracked: this.validTracking, humanRig: this.avatar.supported,
    frameRate: this.session?.frameRate, frameTime: this.latestTime, status: this.status, settings: { ...this.settings }, appliedResolution: this.appliedResolution,
    profiles: Array.from(this.session?.inputSources ?? []).map(s => ({ hand: s.handedness, profiles: s.profiles, mapping: s.gamepad?.mapping })), performance: this.performance.summary() }; }
  async dispose() {
    await this.exit(); clearInterval(this.statusTimer); this.button.remove(); this.avatar.clear(); this.panel.dispose(); this.menu.dispose(); this.hud.dispose(); this.rig.dispose();
    this.deps.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost); this.restoreRender(); this.restoreLoop();
    const xrSystem = navigator.xr as XRSystem & { removeEventListener?: EventTarget['removeEventListener'] } | undefined;
    xrSystem?.removeEventListener?.('devicechange', this.onDeviceChange);
    window.removeEventListener('focus', this.onDeviceChange);
  }
}
