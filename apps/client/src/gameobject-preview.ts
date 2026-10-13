/** Standalone production-path GameObject display inspector: ?gameobject=<displayId>[&entry=<entry>]. */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { WorldEntityRenderer } from './world-entity-renderer';
import { TypeID, type WorldEntity } from './world-entities';
import { configureKtx2Support } from './rendering/optimized-texture-loader';
import { registerWebglRenderer } from './rendering/webgl-context-registry';

const query = new URLSearchParams(location.search);
const displayId = Number(query.get('gameobject'));
const entry = Number(query.get('entry') ?? 0);
if (!Number.isInteger(displayId) || displayId <= 0) throw new Error(`invalid gameobject display ${displayId}`);

document.body.replaceChildren();
const renderer = new THREE.WebGLRenderer({ antialias: true });
registerWebglRenderer('gameobject-preview', renderer);
await configureKtx2Support(renderer, 2);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x29323c);
scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 2.4));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-6, -8, 12);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 500);
camera.position.set(8, -16, 7);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 2.5);
controls.autoRotate = !query.has('rot');
controls.autoRotateSpeed = 1.5;
controls.update();

const entities = new WorldEntityRenderer({
  scene,
  worldToLocal: () => ({ x: 0, y: 0 }),
  sampleHeight: () => 0,
  getTextureAnisotropy: () => renderer.capabilities.getMaxAnisotropy(),
});
entities.upsert({
  guid: 'gameobject-preview', typeId: TypeID.GAMEOBJECT, typeName: 'gameobject',
  entry: entry || undefined, displayId, gameObjectType: 0,
  x: 0, y: 0, z: 0, o: 0, fields: new Map(), updatedAt: performance.now(),
} as WorldEntity);

const clock = new THREE.Clock();
let framed = false;
let diagnosticsPublished = false;
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  entities.update(dt, camera);
  if (!diagnosticsPublished) {
    const inspection = entities.inspect('gameobject-preview');
    const render = inspection?.render;
    if (render?.modelLoaded || render?.assetState === 'unbaked') {
      document.documentElement.dataset.gameobjectAssetState = render.assetState ?? 'unknown';
      document.documentElement.dataset.gameobjectDisplayId = String(render.modelDisplayId ?? displayId);
      document.documentElement.dataset.gameobjectModelLoaded = String(render.modelLoaded);
      document.documentElement.dataset.gameobjectPlaceholderVisible = String(render.placeholderVisible);
      document.documentElement.dataset.gameobjectModelParts = String(render.modelParts ?? 0);
      document.documentElement.dataset.gameobjectModelTextures = String(render.modelTextures ?? 0);
      document.documentElement.dataset.gameobjectModelBones = String(render.modelBones ?? 0);
      diagnosticsPublished = true;
    }
  }
  if (!framed) {
    const bounds = new THREE.Box3().setFromObject(scene);
    const size = bounds.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z);
    if (Number.isFinite(span) && span > 2) {
      const center = bounds.getCenter(new THREE.Vector3());
      controls.target.copy(center);
      camera.position.copy(center).add(new THREE.Vector3(span * 0.8, -span * 1.8, span * 0.65));
      controls.update();
      framed = true;
    }
  }
  controls.update();
  renderer.render(scene, camera);
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
