import * as THREE from 'three';
import type { EnvironmentState, Incoming, LiveCommand, LiveProject, LiveTarget, MaterialLocator, MaterialOverride } from './studio-live-contract';
import { activeCamera, activeScene, applyTransform, cloneMaterial, doodadBindings, hooks, isStudioObject, keyFor, NotHydratedError, remove, restore, spawn, standalone, standaloneDoodad, wmoRoots } from './studio-live-objects';

let socket: WebSocket | null = null;
let reconnectTimer = 0, projectRetryTimer = 0;
let pendingProject: LiveProject | null = null;
let environmentOverride: EnvironmentState | null = null;
let stopped = false;
const send = (packet: unknown) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(packet)); };
const report = (level: 'info' | 'warn' | 'error', message: string) => {
  send({ type: 'bridge.log', level, message });
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.info)(`[studio-live] ${message}`);
};

const tintShader = (material: THREE.ShaderMaterial, color: THREE.Color) => {
  const m2Color = material.uniforms.uM2Color?.value;
  if (m2Color instanceof THREE.Vector4) { m2Color.set(color.r, color.g, color.b, m2Color.w); return; }
  if (!material.uniforms.uStudioTint) {
    material.uniforms.uStudioTint = { value: new THREE.Color(1, 1, 1) };
    material.fragmentShader = material.fragmentShader.replace('precision highp float;', 'precision highp float;\nuniform vec3 uStudioTint;')
      .replace('outColor = vec4(c * visibility, tex.a * visibility);', 'outColor = vec4(c * visibility * uStudioTint, tex.a * visibility);')
      .replace('outColor = vec4(mix(c, uFogColor, fogAmount * tex.a), tex.a);', 'outColor = vec4(mix(c * uStudioTint, uFogColor, fogAmount * tex.a), tex.a);')
      .replace('outColor = vec4(c, tex.a);', 'outColor = vec4(c * uStudioTint, tex.a);');
  }
  const tint = material.uniforms.uStudioTint.value;
  if (tint instanceof THREE.Color) tint.copy(color);
  material.needsUpdate = true;
};

const materialValues = async (material: THREE.Material, override: MaterialOverride) => {
  if (override.color) {
    const color = new THREE.Color(override.color);
    const basic = material as THREE.Material & { color?: THREE.Color; emissive?: THREE.Color };
    if (basic.color instanceof THREE.Color) basic.color.copy(color);
    else if (material instanceof THREE.ShaderMaterial) tintShader(material, color);
    if (override.emissive && basic.emissive instanceof THREE.Color) basic.emissive.set(override.emissive);
  }
  if (override.opacity !== undefined) { material.opacity = THREE.MathUtils.clamp(override.opacity, 0, 1); material.transparent ||= material.opacity < 1; }
  if (override.textureUrl) {
    const texture = await new THREE.TextureLoader().loadAsync(override.textureUrl);
    texture.colorSpace = THREE.NoColorSpace; texture.flipY = false;
    if (material instanceof THREE.ShaderMaterial && material.uniforms.uMap) {
      material.uniforms.uMap.value = texture;
      if (material.uniforms.uHasMap) material.uniforms.uHasMap.value = 1;
    } else if ('map' in material) (material as THREE.MeshBasicMaterial).map = texture;
  }
  material.needsUpdate = true;
};

const cloneSlot = (mesh: THREE.Mesh, index: number): THREE.Material | null => {
  const materials = Array.isArray(mesh.material) ? [...mesh.material] : [mesh.material], current = materials[index];
  if (!current) return null;
  const material = current.userData.studioLiveClone ? current : cloneMaterial(current);
  materials[index] = material; mesh.material = Array.isArray(mesh.material) ? materials : material;
  return material;
};

const materialMatches = (root: THREE.Object3D, locator: MaterialLocator, kind: 'wmo' | 'm2') => {
  let slot = 0;
  const matches: Array<{ mesh: THREE.Mesh; index: number }> = [];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const meta = (kind === 'wmo' ? mesh.userData?.wmoPick : mesh.userData?.wowDoodad) as Record<string, unknown> | undefined;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((_material, index) => {
      const partIndices = Array.isArray(meta?.parts) ? meta.parts : materials.map(() => meta?.part);
      const exactSlot = slot === locator.slot;
      const groupMatch = locator.groupIndex === undefined || Number(meta?.groupIndex) === locator.groupIndex;
      const meshMatch = locator.meshIndex === undefined || Number(meta?.meshIndex) === locator.meshIndex;
      const partMatch = locator.partIndex === undefined || Number(partIndices[index]) === locator.partIndex;
      const textureMatch = locator.textureIndex === undefined || Number(meta?.tex) === locator.textureIndex;
      const metadataMatch = kind === 'wmo'
        ? groupMatch && textureMatch && (locator.groupIndex !== undefined || locator.textureIndex !== undefined)
        : meshMatch && partMatch && (locator.meshIndex !== undefined || locator.partIndex !== undefined);
      if (exactSlot || metadataMatch) matches.push({ mesh, index });
      slot++;
    });
  });
  return matches;
};

const applyMaterial = async (target: LiveTarget, override: MaterialOverride) => {
  if (target.kind === 'wmo') {
    const roots = override.scope === 'asset' ? wmoRoots(target, true)
      : [standalone.get(keyFor(target)) ?? wmoRoots(target)[0]].filter(Boolean) as THREE.Object3D[];
    if (!roots.length) throw new NotHydratedError(`WMO ${target.model} is not loaded`);
    for (const root of roots) for (const match of materialMatches(root, override.locator, 'wmo')) {
      const material = cloneSlot(match.mesh, match.index); if (material) await materialValues(material, override);
    }
    return;
  }
  if (target.kind === 'm2' && override.scope === 'instance') {
    const root = standaloneDoodad(target);
    for (const match of materialMatches(root, override.locator, 'm2')) {
      const material = cloneSlot(match.mesh, match.index); if (material) await materialValues(material, override);
    }
    return;
  }
  if (target.kind === 'm2') {
    const scene = activeScene();
    if (!scene) throw new NotHydratedError('world scene is not ready');
    const pending: Promise<void>[] = [], normalizedModel = target.model.replaceAll('\\', '/').toLowerCase();
    scene.traverse((object) => {
      if (isStudioObject(object)) return;
      const mesh = object as THREE.InstancedMesh, meta = mesh.userData?.wowDoodad as Record<string, unknown> | undefined;
      if (!mesh.isInstancedMesh || !meta) return;
      if (String(meta.tileKey ?? '') !== target.tileKey || String(meta.source ?? '').replaceAll('\\', '/').toLowerCase() !== normalizedModel) return;
      if (override.locator.meshIndex !== undefined && Number(meta.meshIndex) !== override.locator.meshIndex) return;
      const partIndices = Array.isArray(meta.parts) ? meta.parts.map(Number) : [Number(meta.part)];
      if (override.locator.partIndex !== undefined && !partIndices.includes(override.locator.partIndex)) return;
      const materials = Array.isArray(mesh.material) ? [...mesh.material] : [mesh.material];
      for (let index = 0; index < materials.length; index++) {
        if (override.locator.partIndex !== undefined && partIndices[index] !== override.locator.partIndex) continue;
        const material = materials[index].userData.studioLiveClone ? materials[index] : cloneMaterial(materials[index]);
        materials[index] = material; pending.push(materialValues(material, override));
      }
      mesh.material = Array.isArray(mesh.material) ? materials : materials[0];
    });
    if (!pending.length) throw new NotHydratedError(`M2 ${target.model} is not loaded`);
    await Promise.all(pending); return;
  }
  throw new Error(`material overrides are not implemented for ${target.kind}`);
};

const enforceEnvironment = () => {
  const environment = environmentOverride, scene = activeScene();
  if (!environment || !scene) return;
  hooks.wowTune?.({ time: THREE.MathUtils.clamp(environment.hour, 0, 24) * 120 });
  if (scene.fog instanceof THREE.Fog) {
    scene.fog.near = Math.max(0, environment.fogNear); scene.fog.far = Math.max(environment.fogNear + 1, environment.fogFar);
    scene.fog.color.set(environment.fogColor);
  }
  const type = environment.weather === 'rain' ? 1 : environment.weather === 'snow' ? 2 : 0;
  hooks.__wowWeather?.setWeather({ type, grade: type ? 1 : 0, soundId: 0, instant: true });
};
const applyEnvironment = (environment: EnvironmentState) => { environmentOverride = { ...environment }; enforceEnvironment(); };

const focus = (target: LiveTarget) => {
  const camera = activeCamera(), controls = hooks.__wowControls;
  if (!camera || !controls) throw new NotHydratedError('runtime camera is not ready');
  const object = standalone.get(keyFor(target)) ?? (target.kind === 'wmo' ? wmoRoots(target)[0] : null);
  let point: THREE.Vector3 | null = object ? object.getWorldPosition(new THREE.Vector3()) : null;
  if (!point && target.kind === 'm2') {
    const binding = doodadBindings(target)[0];
    if (binding) { const matrix = new THREE.Matrix4(); binding.mesh.getMatrixAt(binding.instanceId, matrix); point = new THREE.Vector3().setFromMatrixPosition(binding.mesh.matrixWorld.clone().multiply(matrix)); }
  }
  if (!point) throw new NotHydratedError(`${target.model} is not loaded`);
  const offset = camera.position.clone().sub(controls.target);
  controls.target.copy(point); camera.position.copy(point).add(offset.lengthSq() > 1 ? offset : new THREE.Vector3(12, 12, 8));
  controls.update(); window.focus();
};

const applyProject = async (project: LiveProject, retry: boolean): Promise<number> => {
  let missing = 0;
  for (const item of project.objects ?? []) {
    try {
      if (item.state === 'deleted') remove(item.target);
      else if (item.state === 'added' && item.transform) await spawn(item.target, item.transform);
      else if (item.transform) await applyTransform(item.target, item.transform);
    } catch (error) { if (error instanceof NotHydratedError) missing++; else throw error; }
  }
  for (const override of project.materials ?? []) {
    const target: LiveTarget = { recordId: override.recordId, tileKey: override.tileKey, kind: override.kind, model: override.model, sourceId: override.sourceId };
    try { await applyMaterial(target, override); }
    catch (error) { if (error instanceof NotHydratedError) missing++; else throw error; }
  }
  if (project.environment) applyEnvironment(project.environment);
  if (retry && missing) {
    pendingProject = project; window.clearTimeout(projectRetryTimer);
    projectRetryTimer = window.setTimeout(() => {
      if (pendingProject) void applyProject(pendingProject, true).catch((error) => report('error', `project retry failed: ${error instanceof Error ? error.message : String(error)}`));
    }, 1200);
  } else if (!missing && pendingProject === project) pendingProject = null;
  return missing;
};

const applyCommand = async (command: LiveCommand): Promise<string> => {
  switch (command.type) {
    case 'transform.set': await applyTransform(command.target, command.transform); return 'transform updated';
    case 'object.spawn': await spawn(command.target, command.transform); return 'object spawned';
    case 'object.delete': remove(command.target); return 'object hidden';
    case 'object.restore': restore(command.target); return 'object restored';
    case 'material.set': await applyMaterial(command.target, command.override); return 'material override applied';
    case 'environment.set': applyEnvironment(command.environment); return 'environment override applied';
    case 'project.apply': { const missing = await applyProject(command.project, true); return missing ? `project applied; ${missing} target(s) waiting for hydration` : 'project applied'; }
    case 'playmode.set': hooks.__wowFreeCam?.(!command.playing); return command.playing ? 'gameplay camera enabled' : 'Studio free camera enabled';
    case 'selection.focus': focus(command.target); return 'runtime camera focused';
  }
};

const runtimeReady = () => !!activeScene() && !!activeCamera();
const sendState = () => send({ type: 'runtime.state', runtime: location.host, sceneReady: runtimeReady() });
const onPacket = async (raw: unknown) => {
  let packet: Incoming;
  try { packet = JSON.parse(String(raw)) as Incoming; } catch { return; }
  if (packet.type === 'bridge.hello') {
    sendState();
    if (packet.cachedProject) {
      pendingProject = packet.cachedProject;
      void applyProject(packet.cachedProject, true).catch((error) => report('error', `saved project failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    return;
  }
  if (packet.type !== 'bridge.command') return;
  try {
    const message = await applyCommand(packet.command);
    send({ type: 'bridge.ack', id: packet.id, commandType: packet.command.type, ok: true, message });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send({ type: 'bridge.ack', id: packet.id, commandType: packet.command.type, ok: false, message });
    if (!(error instanceof NotHydratedError)) report('error', `${packet.command.type}: ${message}`);
  }
};

const connect = (bridgeUrl: string) => {
  window.clearTimeout(reconnectTimer);
  const url = new URL(bridgeUrl);
  url.searchParams.set('role', 'runtime'); url.searchParams.set('client', `VanillaGL ${location.host || 'Runtime'}`);
  const ws = new WebSocket(url); socket = ws;
  ws.addEventListener('open', () => { report('info', 'VanillaGL runtime connected to Studio.'); sendState(); });
  ws.addEventListener('message', (event) => { void onPacket(event.data); });
  ws.addEventListener('close', () => { if (socket === ws) socket = null; if (!stopped) reconnectTimer = window.setTimeout(() => connect(bridgeUrl), 1500); });
};

export function installStudioLiveReceiver() {
  const bridgeUrl = new URLSearchParams(location.search).get('studioBridge');
  if (!bridgeUrl || socket) return;
  stopped = false; connect(bridgeUrl);
  const readyTimer = window.setInterval(() => { if (!runtimeReady()) return; sendState(); window.clearInterval(readyTimer); }, 250);
  const environmentTimer = window.setInterval(enforceEnvironment, 300);
  window.addEventListener('beforeunload', () => {
    stopped = true; window.clearInterval(readyTimer); window.clearInterval(environmentTimer);
    window.clearTimeout(reconnectTimer); window.clearTimeout(projectRetryTimer); socket?.close(1000, 'runtime unload');
  }, { once: true });
}
