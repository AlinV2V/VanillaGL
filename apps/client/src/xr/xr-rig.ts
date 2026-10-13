import * as THREE from 'three';
import { XR_TO_GAME, YARDS_PER_METRE } from './xr-input-state';
import { xrViewState } from '../rendering/xr-view-state';

export class XrRig {
  readonly root = new THREE.Group();
  readonly camera = new THREE.PerspectiveCamera();
  readonly grips: THREE.Group[] = [];
  readonly rays: THREE.Group[] = [];
  readonly head = new THREE.Vector3();
  readonly referenceHead = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private calibrated = false;
  distance = 500;
  eyeForward = 0.12;
  private yawOffset = 0;
  private readonly facing = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly zAxis = new THREE.Vector3(0, 0, 1);
  private readonly anchor = new THREE.Vector3();
  private readonly worldScale = new THREE.Vector3();
  private readonly fade: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private saved?: { position: THREE.Vector3; quaternion: THREE.Quaternion; near: number; far: number; fov: number; zoom: number };
  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly scene: THREE.Scene,
    private readonly worldCamera: THREE.PerspectiveCamera) {
    this.root.name = 'VR tracking origin'; this.root.scale.setScalar(YARDS_PER_METRE); this.root.add(this.camera);
    this.root.visible = false; scene.add(this.root);
    for (let i = 0; i < 2; i++) {
      const grip = renderer.xr.getControllerGrip(i), ray = renderer.xr.getController(i);
      const proxy = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.065, 0.12), new THREE.MeshBasicMaterial({ color: i ? 0x78b9ff : 0xffda78 }));
      grip.add(proxy);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -4)]),
        new THREE.LineBasicMaterial({ color: 0x80cfff, transparent: true, opacity: 0.5 }));
      ray.add(line); this.root.add(grip, ray); this.grips.push(grip); this.rays.push(ray);
    }
    this.fade = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
    this.fade.frustumCulled = false; this.fade.renderOrder = 100000; this.camera.add(this.fade);
  }
  start() {
    const c = this.worldCamera;
    this.saved = { position: c.position.clone(), quaternion: c.quaternion.clone(), near: c.near, far: c.far, fov: c.fov, zoom: c.zoom };
    this.camera.near = 0.08; this.camera.far = this.distance;
    c.far = this.camera.far;
    this.root.visible = true; this.calibrated = false;
  }
  recenter() { this.calibrated = false; }
  update(frame: XRFrame, player: THREE.Vector3, yaw: number, eyeHeight: number,
    blocked: (start: THREE.Vector3, end: THREE.Vector3) => boolean): boolean {
    const space = this.renderer.xr.getReferenceSpace();
    const pose = space && frame.getViewerPose(space);
    if (!pose) { this.fade.material.opacity = 1; return false; }
    const p = pose.transform.position; this.referenceHead.set(p.x, p.y, p.z);
    if (!this.calibrated) {
      this.offset.copy(this.referenceHead); this.calibrated = true;
      const q = pose.transform.orientation;
      if (q) {
        this.rotation.set(q.x, q.y, q.z, q.w);
        this.facing.set(0, 0, -1).applyQuaternion(this.rotation).applyQuaternion(XR_TO_GAME);
        this.yawOffset = -Math.atan2(this.facing.y, this.facing.x);
      } else this.yawOffset = 0;
    }
    this.camera.far = this.distance; this.worldCamera.far = this.distance;
    this.rotation.setFromAxisAngle(this.zAxis, yaw + this.yawOffset).multiply(XR_TO_GAME);
    this.root.quaternion.copy(this.rotation);
    this.root.position.copy(this.offset).multiplyScalar(-YARDS_PER_METRE).applyQuaternion(this.rotation).add(player);
    this.root.position.z += eyeHeight;
    this.root.position.x += Math.cos(yaw) * this.eyeForward; this.root.position.y += Math.sin(yaw) * this.eyeForward;
    this.root.updateMatrixWorld(true);
    this.renderer.xr.updateCamera(this.camera);
    const xrCamera = this.renderer.xr.getCamera();
    xrViewState.views = xrCamera.cameras;
    xrCamera.matrixWorld.decompose(this.worldCamera.position, this.worldCamera.quaternion, this.worldScale);
    this.worldCamera.projectionMatrix.copy(xrCamera.projectionMatrix);
    this.worldCamera.projectionMatrixInverse.copy(xrCamera.projectionMatrixInverse);
    this.worldCamera.updateMatrixWorld(true);
    this.head.copy(this.referenceHead).applyMatrix4(this.root.matrixWorld);
    const anchor = this.anchor.set(player.x, player.y, player.z + eyeHeight);
    const separation = Math.hypot(p.x - this.offset.x, p.z - this.offset.z);
    this.fade.material.opacity = blocked(anchor, this.head) ? 1 : THREE.MathUtils.smoothstep(separation, 0.45, 0.7);
    return true;
  }
  end(player: THREE.Vector3) {
    this.root.visible = false; this.fade.material.opacity = 0; this.calibrated = false;
    const saved = this.saved; if (!saved) return;
    const c = this.worldCamera;
    c.near = saved.near; c.far = saved.far; c.fov = saved.fov; c.zoom = saved.zoom;
    c.position.copy(player).add(new THREE.Vector3(-5, 0, 3)); c.lookAt(player.clone().add(new THREE.Vector3(0, 0, 1.5)));
    c.updateProjectionMatrix(); c.updateMatrixWorld(true); this.saved = undefined;
  }
  dispose() {
    this.root.removeFromParent();
    this.root.traverse(object => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      if (Array.isArray(mesh.material)) mesh.material.forEach(m => m.dispose()); else mesh.material?.dispose();
    });
  }
}
