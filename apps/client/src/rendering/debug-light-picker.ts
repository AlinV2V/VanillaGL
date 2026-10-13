import { qaGlobals } from '../qa-globals.ts';
/** Asset conversion utility. */
import * as THREE from 'three';

export type DebugLightDeps = {
  scene: THREE.Scene;
  camera: THREE.Camera;
  renderer: THREE.WebGLRenderer;
  domElement: HTMLElement;
  environment?: () => unknown;
};

const f3 = (v: THREE.Vector3 | number[] | undefined) => {
  if (!v) return null;
  const a = Array.isArray(v) ? v : [v.x, v.y, v.z];
  return a.map((n) => +n.toFixed(3));
};
const lum = (c: number[] | null) => (c ? +(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]).toFixed(3) : null);
const hex = (n: number | undefined) => (typeof n === 'number' ? `0x${(n >>> 0).toString(16)}` : null);
const u = (mat: any, name: string) => mat?.uniforms?.[name]?.value;
const xyz = (v: any): [number, number, number] => Array.isArray(v)
  ? [Number(v[0] ?? 0), Number(v[1] ?? 0), Number(v[2] ?? 0)]
  : [Number(v?.x ?? v?.r ?? 0), Number(v?.y ?? v?.g ?? 0), Number(v?.z ?? v?.b ?? 0)];
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const clamp3 = (v: number[]): [number, number, number] => [clamp01(v[0]), clamp01(v[1]), clamp01(v[2])];

function sharedLightSnapshot(mat: any) {
  const sky = f3(u(mat, 'uSkyAmbient'));
  const ground = f3(u(mat, 'uGroundAmbient'));
  const sun = f3(u(mat, 'uSunColor'));
  return {
    uSkyAmbient: sky, skyLuminance: lum(sky),
    uGroundAmbient: ground, groundLuminance: lum(ground),
    uSunColor: sun, sunLuminance: lum(sun),
    uSunDir: f3(u(mat, 'uSunDir')),
    uHalfLambert: u(mat, 'uHalfLambert'),
    uLocalCount: u(mat, 'uLocalCount'),
  };
}

export type DebugLightSample = {
  normal: THREE.Vector3;
  point: THREE.Vector3;
  normalSource: string;
};

/** Three-band clamped-cosine directional SH lobe used by Build 5875 M2 lighting. */
export function clientDirectionalSh(lightDot: number): number {
  return Math.max(0, 0.09375 + 0.5 * lightDot + 0.46875 * lightDot * lightDot);
}


export function clientPointAttenuation(attenStart: number, attenEnd: number, distance: number): number {
  const start = Math.max(0.001, attenStart);
  const end = Math.max(start + 0.001, attenEnd);
  const dist = Math.max(0, distance);
  if (dist >= end) return 0;
  const mid = (start + end) * 0.5;
  const ratio = (mid * mid) / (start * start);
  const linear = (2 - ratio) / (mid - ratio * start);
  const quadratic = (1 - linear * start) / (start * start);
  const denominator = linear * dist + quadratic * dist * dist;
  return Math.min(1, 1 / denominator);
}

/** CPU mirror of the Build 5875 enclosed CMapDoodadDef vertex-light branch. */
export function clientDoodadInteriorLight(tint: number[], normal: THREE.Vector3) {
  const authored = [tint[0] ?? 1, tint[1] ?? 1, tint[2] ?? 1];
  const maxChannel = Math.max(...authored, 1 / 255);
  const ambientScale = Math.min(1, (96 / 255) / maxChannel);
  const directionalScale = Math.max(1, (168 / 255) / maxChannel);
  const fixedDirection = new THREE.Vector3(0.30822, 0.30822, 0.9).normalize();
  const fixedDot = normal.clone().normalize().dot(fixedDirection);
  const fixedSh = clientDirectionalSh(fixedDot);
  const ambient = authored.map((channel) => channel * ambientScale);
  const directional = authored.map((channel) => channel * directionalScale);
  const light = clamp3(ambient.map((channel, index) => channel + directional[index] * fixedSh));
  return { ambient, directional, fixedDirection, fixedDot, fixedSh, light };
}

/** Reproduce the m2-material.ts light branch at one sampled world point/normal. */
export function predictDoodadLight(
  mat: any,
  tint: number[] | null,
  lightClass: number,
  sample: DebugLightSample | null,
) {
  const mode = Number(u(mat, 'uModdLightMode') ?? 0);
  const scale = Number(u(mat, 'uModdScale') ?? 1);
  const floor = Number(u(mat, 'uModdFloor') ?? 0);
  const moddSun = Number(u(mat, 'uModdSun') ?? 0);
  const hasTint = Number(u(mat, 'uHasInstanceTint') ?? 0);
  const unlit = Number(u(mat, 'uUnlit') ?? 0);
  if (!sample) {
    return {
      uModdLightMode: mode, uModdScale: scale, uModdFloor: floor, uModdSun: moddSun,
      uHasInstanceTint: hasTint, uUnlit: unlit,
      finalLightTermAtHit: null,
      note: 'No interpolated geometry normal was available, so no light term was invented.',
    };
  }

  const sky = xyz(u(mat, 'uSkyAmbient'));
  const sunColor = xyz(u(mat, 'uSunColor'));
  const normal = sample.normal.clone().normalize();
  const normalUp = normal.z * 0.5 + 0.5;
  const sunDir = new THREE.Vector3(...xyz(u(mat, 'uSunDir'))).normalize().negate();
  const rawNdl = Math.max(normal.dot(sunDir), 0);
  const sunDot = normal.dot(sunDir);
  const sunSh = clientDirectionalSh(sunDot);
  const halfLambert = Number(u(mat, 'uHalfLambert') ?? 0);
  const ndl = rawNdl + ((0.5 + 0.5 * rawNdl) - rawNdl) * halfLambert;
  const objectLight = Number(u(mat, 'uObjectLight') ?? 0);
  const objectAmbient = xyz(u(mat, 'uObjectAmbient'));
  const objectDirectional = xyz(u(mat, 'uObjectDirectional'));
  const objectDirection = new THREE.Vector3(...xyz(u(mat, 'uObjectLightDir'))).normalize();

  const localSum: [number, number, number] = [0, 0, 0];
  const localCount = Math.max(0, Math.min(4, Number(u(mat, 'uLocalCount') ?? 0)));
  const localPos: any[] = u(mat, 'uLocalPos') ?? [];
  const localColor: any[] = u(mat, 'uLocalColor') ?? [];
  const localAtten: any[] = u(mat, 'uLocalAtten') ?? [];
  for (let i = 0; i < localCount; i++) {
    const ld = new THREE.Vector3(...xyz(localPos[i])).sub(sample.point);
    const distance = ld.length();
    const near = Number(localAtten[i]?.x ?? localAtten[i]?.[0] ?? 0);
    const far = Number(localAtten[i]?.y ?? localAtten[i]?.[1] ?? 0);
    const attenuation = clientPointAttenuation(near, far, distance);
    const localNdl = Math.max(normal.dot(ld.divideScalar(Math.max(distance, 0.001))), 0);
    const color = xyz(localColor[i]);
    for (let channel = 0; channel < 3; channel++) localSum[channel] += color[channel] * attenuation * localNdl;
  }

  const objectSh = clientDirectionalSh(normal.dot(objectDirection));
  const worldLit = sky.map((a, i) => a + sunColor[i] * sunSh);
  const interiorLit = objectAmbient.map((a, i) => a + objectDirectional[i] * objectSh + localSum[i]);
  const lit = clamp3(worldLit.map((value, i) => value + (interiorLit[i] - value) * objectLight));
  const ambient = sky.map((value, i) => value + (objectAmbient[i] - value) * objectLight);
  const clientInterior = clientDoodadInteriorLight(tint ?? [1, 1, 1], normal);
  const comparisonCurve = clamp3((tint ?? [1, 1, 1]).map((c, i) => c * scale + floor + sunColor[i] * ndl * moddSun));
  const bareMode2 = clamp3((tint ?? [1, 1, 1]).map((c) => c * scale));
  const normalM2 = mode < 0.5 || hasTint < 0.5;
  const mode2 = mode > 1.5 && mode < 2.5;
  const mode3 = mode > 2.5;
  const branch = normalM2
    ? 'vLit (normal M2 path)'
    : mode2 ? 'bare MODD mode 2 (comparison path; no floor or sun)'
      : mode3 ? 'old tunable comparison curve'
        : lightClass > 0.5 ? 'lit (OUTDOOR: live ambient + directional SH + local lights)' : 'client interior MOCV/MODD sample path';
  const term = normalM2 ? lit : mode2 ? bareMode2 : mode3 ? comparisonCurve : lightClass > 0.5 ? lit : clientInterior.light;
  const final = unlit > 0.5 ? [1, 1, 1] : term;
  return {
    uModdLightMode: mode, uModdScale: scale, uModdFloor: floor, uModdSun: moddSun,
    uHasInstanceTint: hasTint, uUnlit: unlit,
    branchTaken: branch,
    sampledWorldPoint: f3(sample.point),
    sampledWorldNormal: f3(normal),
    sampledNormalSource: sample.normalSource,
    sampledNormalUp: +normalUp.toFixed(3),
    sampledRawNdl: +rawNdl.toFixed(3),
    sampledNdl: +ndl.toFixed(3),
    sampledSunSh: +sunSh.toFixed(3),
    ambientAtHit: f3(ambient),
    localLightTermAtHit: f3(localSum),
    litIfOutdoorAtHit: f3(lit),
    clientInteriorAmbientAtHit: f3(clientInterior.ambient),
    clientInteriorDirectionalAtHit: f3(clientInterior.directional),
    clientInteriorFixedDot: +clientInterior.fixedDot.toFixed(3),
    clientInteriorFixedSh: +clientInterior.fixedSh.toFixed(3),
    moddInteriorIfIndoorAtHit: f3(clientInterior.light),
    finalLightTermAtHit: f3(final),
    finalLuminance: lum(f3(final)),
    followsTimeOfDay: unlit > 0.5 ? false : (normalM2 || lightClass > 0.5 || (mode3 && moddSun > 0)),
    note: 'One interpolated ray-hit sample; nearby vertices can have different normals and therefore different terms.',
  };
}

function shaderSampleAtHit(hit: THREE.Intersection, mat: any, camera: THREE.Camera): DebugLightSample | null {
  const object = hit.object as THREE.Mesh;
  const geometry = object.geometry as THREE.BufferGeometry | undefined;
  const normalAttribute = geometry?.getAttribute('normal');
  const face = hit.face;
  const bary = hit.barycoord;
  if (!normalAttribute || !face || !bary) return null;

  const localNormal = new THREE.Vector3()
    .fromBufferAttribute(normalAttribute, face.a).multiplyScalar(bary.x)
    .addScaledVector(new THREE.Vector3().fromBufferAttribute(normalAttribute, face.b), bary.y)
    .addScaledVector(new THREE.Vector3().fromBufferAttribute(normalAttribute, face.c), bary.z)
    .normalize();
  let modelMatrix = object.matrixWorld;
  if ((object as THREE.InstancedMesh).isInstancedMesh && hit.instanceId !== undefined) {
    const instanceMatrix = new THREE.Matrix4();
    (object as THREE.InstancedMesh).getMatrixAt(hit.instanceId, instanceMatrix);
    modelMatrix = new THREE.Matrix4().multiplyMatrices(object.matrixWorld, instanceMatrix);
  }

  if (mat?.defines?.WOW_BILLBOARD) {
    const pivot = new THREE.Vector3(...xyz(u(mat, 'uBillboardPivot')));
    if ((object as THREE.InstancedMesh).isInstancedMesh && hit.instanceId !== undefined) {
      const instanceMatrix = new THREE.Matrix4();
      (object as THREE.InstancedMesh).getMatrixAt(hit.instanceId, instanceMatrix);
      pivot.applyMatrix4(instanceMatrix);
    }
    pivot.applyMatrix4(object.matrixWorld);
    return {
      normal: camera.position.clone().sub(pivot).normalize(),
      point: hit.point.clone(),
      normalSource: 'WOW_BILLBOARD camera-facing shader normal',
    };
  }

  // Match the shader literally: normalize(mat3(modelMatrix) * localNormal).
  localNormal.applyMatrix3(new THREE.Matrix3().setFromMatrix4(modelMatrix)).normalize();
  return {
    normal: localNormal,
    point: hit.point.clone(),
    normalSource: 'interpolated current geometry normal',
  };
}

function describeHit(hit: THREE.Intersection, camera: THREE.Camera): any {
  const o: any = hit.object;
  const materialIndex = hit.face?.materialIndex ?? 0;
  const mat: any = Array.isArray(o.material) ? o.material[materialIndex] ?? o.material[0] : o.material;
  const sample = shaderSampleAtHit(hit, mat, camera);
  const base = {
    point: f3(hit.point),
    distance: +hit.distance.toFixed(2),
    objectType: o.isInstancedMesh ? 'InstancedMesh' : 'Mesh',
    materialType: mat?.type,
  };

  const dd = o.userData?.wowDoodad;
  if (dd) {
    const id = hit.instanceId ?? 0;
    const tintAttr = o.geometry.getAttribute('instanceTint');
    const classAttr = o.geometry.getAttribute('instanceLightClass');
    const tint = tintAttr
      ? [tintAttr.getX(id), tintAttr.getY(id), tintAttr.getZ(id)].map((n) => +n.toFixed(3))
      : null;
    const lightClass = classAttr ? classAttr.getX(id) : 0;
    const classNames: Record<number, string> = {
      0: 'LIT_INTERIOR - vertical-ray MOCV sample, raw MODD fallback',
      1: 'OUTDOOR - takes ambient + sun, follows time of day',
    };
    return {
      ...base,
      kind: dd.kind,
      tileKey: dd.tileKey,
      model: dd.source,
      meshIndex: dd.meshIndex,
      submeshPart: Array.isArray(dd.parts) ? dd.parts[materialIndex] : dd.part,
      instanceId: id,
      bakedInstanceIndex: dd.sourceIndices?.[id],
      clientLightSampleRGB: tint,
      clientLightSampleLuminance: lum(tint),
      clientLightSample255: tint ? tint.map((c) => Math.round(c * 255)) : null,
      bakedLightClass: lightClass,
      bakedLightClassMeaning: classNames[lightClass] ?? `unknown (${lightClass})`,
      lighting: predictDoodadLight(mat, tint, lightClass, sample),
      sharedLight: sharedLightSnapshot(mat),
      hint: dd.kind === 'wmoDoodad'
        ? 'class comes from the raw root MODD index joined through the owning group MODR'
        : 'terrain doodad - no MODD colour, lit by the normal M2 path',
    };
  }

  const pick = o.userData?.wmoPick;
  if (pick) {
    const ambient = f3(u(mat, 'uAmbient'));
    return {
      ...base,
      kind: 'wmoSurface',
      groupIndex: pick.groupIndex,
      groupFlags: hex(pick.groupFlags),
      interiorGroup: pick.interiorGroup,
      usesOutdoorLighting: pick.usesOutdoorLighting,
      formula: pick.usesOutdoorLighting
        ? 'uAmbient + MOCV*2*uHasVertexColor + uSunColor*ndl'
        : 'mix(max(uAmbient,0.1), MOCV*2 + max(uAmbient,0.1), uHasVertexColor)',
      uAmbient: ambient, ambientLuminance: lum(ambient),
      uHasVertexColor: u(mat, 'uHasVertexColor'),
      uSunColor: f3(u(mat, 'uSunColor')),
      uSelfIllum: u(mat, 'uSelfIllum'),
      uNight: u(mat, 'uNight'),
      followsTimeOfDay: true,
      hint: 'building surface; compare a nearby doodad against this group lighting class',
    };
  }

  if (o.userData?.wowWmoLiquid) return { ...base, kind: 'wmoLiquid', uniforms: Object.keys(mat?.uniforms ?? {}) };
  if (o.userData?.wowCollision) return { ...base, kind: 'collisionMesh (invisible)', name: o.userData.wowName };

  if (mat?.uniforms?.uSkyAmbient) {
    return {
      ...base,
      kind: 'm2Model',
      name: o.name || '(unnamed)',
      uUnlit: u(mat, 'uUnlit'),
      uM2Color: u(mat, 'uM2Color')?.toArray?.().map((n: number) => +n.toFixed(3)),
      lighting: predictDoodadLight(mat, null, 0, sample),
      sharedLight: sharedLightSnapshot(mat),
      hint: 'characters have no static lightmap term: only ambient, sun and active local lights',
    };
  }

  return { ...base, kind: 'other', name: o.name || '(unnamed)', userDataKeys: Object.keys(o.userData ?? {}) };
}

export type WowDoodadIdentity = {
  kind?: string;
  tileKey?: string;
  meshIndex?: number;
  sourceIndices?: number[];
};

/** Stable logical-placement identity shared by every rendered submesh part of one doodad. */
export function doodadSurveyIdentity(dd: WowDoodadIdentity, instanceId: number): string {
  return [dd.kind ?? 'unknown', dd.tileKey ?? 'unknown-tile', dd.meshIndex ?? -1, dd.sourceIndices?.[instanceId] ?? instanceId].join('|');
}

export function installDebugLightPicker(deps: DebugLightDeps): void {
  const { scene, camera, renderer, domElement, environment } = deps;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  const panel = document.createElement('div');
  panel.style.cssText = [
    'position:fixed', 'right:8px', 'top:8px', 'width:min(560px,42vw)', 'max-height:80vh',
    'overflow:auto', 'z-index:99999', 'background:rgba(8,10,14,.92)', 'color:#cfe3ff',
    'font:11px/1.45 Consolas,monospace', 'padding:10px 12px', 'border:1px solid #2b3b55',
    'border-radius:6px', 'white-space:pre-wrap', 'pointer-events:auto',
  ].join(';');
  panel.textContent = 'debuglight: Alt+click any object to inspect its lighting.\nShift-click adds; Esc clears.';
  document.body.appendChild(panel);

  // The old performance report was captured under SwiftShader. Keep the active backend and
  // renderer.info beside the visual probe so screenshots cannot accidentally be reported as a
  // hardware measurement without proving which WebGL device drew them.
  const renderInfoPanel = document.createElement('div');
  renderInfoPanel.id = 'debug-renderer-info';
  renderInfoPanel.style.cssText = [
    'position:fixed', 'left:8px', 'bottom:8px', 'z-index:99999',
    'background:rgba(8,10,14,.86)', 'color:#cfe3ff', 'font:11px/1.4 Consolas,monospace',
    'padding:6px 8px', 'border:1px solid #2b3b55', 'border-radius:5px', 'white-space:pre-wrap',
  ].join(';');
  document.body.appendChild(renderInfoPanel);

  // A frame uses several renderer.render() calls (world target, composite, UI helpers). The default
  // auto-reset leaves only the final pass visible, which can misleadingly report one fullscreen
  // draw. In this opt-in diagnostic, reset once per animation frame and retain the full aggregate.
  renderer.info.autoReset = false;
  let lastFrameRender = { calls: 0, triangles: 0, lines: 0, points: 0 };
  let lastFrameAt = performance.now();
  const frameTimes: number[] = [];
  const collectFrameRender = () => {
    const now = performance.now();
    const frameMs = now - lastFrameAt;
    lastFrameAt = now;
    if (frameMs > 0 && frameMs < 1000) {
      frameTimes.push(frameMs);
      if (frameTimes.length > 120) frameTimes.shift();
    }
    const render = renderer.info.render;
    if (render.calls > 0) lastFrameRender = {
      calls: render.calls, triangles: render.triangles, lines: render.lines, points: render.points,
    };
    renderer.info.reset();
    window.requestAnimationFrame(collectFrameRender);
  };
  renderer.info.reset();
  window.requestAnimationFrame(collectFrameRender);

  const rendererInfo = () => {
    const gl = renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const sortedFrameTimes = frameTimes.slice().sort((a, b) => a - b);
    const frameMsAvg = frameTimes.length
      ? frameTimes.reduce((sum, value) => sum + value, 0) / frameTimes.length
      : 0;
    return {
      ...lastFrameRender,
      frameMsAvg: +frameMsAvg.toFixed(2),
      frameMsP95: +(sortedFrameTimes[Math.floor((sortedFrameTimes.length - 1) * 0.95)] ?? 0).toFixed(2),
      fpsAvg: frameMsAvg > 0 ? +(1000 / frameMsAvg).toFixed(2) : 0,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      programs: renderer.info.programs?.length ?? 0,
      vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      device: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    };
  };
  const refreshRendererInfo = () => {
    const info = rendererInfo();
    renderInfoPanel.textContent = `debugrender calls=${info.calls} triangles=${info.triangles} `
      + `frameMsAvg=${info.frameMsAvg} frameMsP95=${info.frameMsP95} fpsAvg=${info.fpsAvg} `
      + `geometries=${info.geometries} textures=${info.textures} programs=${info.programs}\n`
      + `gpu=${info.vendor} / ${info.device} buffer=${info.drawingBuffer.join('x')}`
      + (environment ? `\nenvironment=${JSON.stringify(environment())}` : '');
  };
  refreshRendererInfo();
  window.setInterval(refreshRendererInfo, 500);

  const selection: any[] = [];
  const render = () => {
    const payload = selection.length === 1 ? selection[0] : selection;
    const json = JSON.stringify(payload, null, 2);
    panel.textContent = `debuglight - ${selection.length} selected (copied to clipboard)\n\n${json}`;
    void navigator.clipboard?.writeText(json).catch(() => {});
    console.log('[debuglight]', payload);
  };

  domElement.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0 || !event.altKey) return;
    const rect = domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera as THREE.PerspectiveCamera);
    const hits = raycaster.intersectObjects(scene.children, true)
      .filter((h) => (h.object as any).isMesh || (h.object as any).isInstancedMesh)
      .filter((h) => !(h.object as any).userData?.wowCollision);
    if (!hits.length) return;
    event.preventDefault();
    event.stopPropagation();
    const info = describeHit(hits[0], camera);
    if (!event.shiftKey) selection.length = 0;
    selection.push(info);
    render();
  }, true);

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      selection.length = 0;
      panel.textContent = 'debuglight: cleared.';
    }
  });

  qaGlobals.__wowDebugLight = {
    selection: () => selection,
    rendererInfo,
    /** One row per model, counting logical placements once rather than once per submesh part. */
    survey: () => {
      const rows = new Map<string, any>();
      const seen = new Set<string>();
      scene.traverse((o: any) => {
        const dd = o.userData?.wowDoodad;
        if (!dd || !o.isInstancedMesh) return;
        const classAttr = o.geometry.getAttribute('instanceLightClass');
        const tintAttr = o.geometry.getAttribute('instanceTint');
        const full = String(dd.source);
        const displayName: string = full.split(/[\\/]/).pop() || full;
        const modelKey = `${String(dd.kind).toLowerCase()}|${full.toLowerCase()}`;
        const row = rows.get(modelKey) ?? {
          model: full, displayName, kind: dd.kind,
          instances: 0, outdoor: 0, interior: 0, untinted: 0, tintSum: 0,
        };
        for (let i = 0; i < o.count; i++) {
          const identity = doodadSurveyIdentity(dd, i);
          if (seen.has(identity)) continue;
          seen.add(identity);
          row.instances++;
          if (!tintAttr) {
            row.untinted++;
            continue;
          }
          if (classAttr && classAttr.getX(i) > 0.5) row.outdoor++;
          else row.interior++;
          row.tintSum += lum([tintAttr.getX(i), tintAttr.getY(i), tintAttr.getZ(i)]) ?? 0;
        }
        rows.set(modelKey, row);
      });
      const out = [...rows.values()].map((row) => {
        const tinted = row.outdoor + row.interior;
        return {
          model: row.model, displayName: row.displayName, kind: row.kind, instances: row.instances,
          tinted, outdoor: row.outdoor, interior: row.interior, untinted: row.untinted,
          avgTintLuminance: tinted ? +(row.tintSum / tinted).toFixed(3) : null,
          followsTimeOfDay: tinted === 0 ? 'yes (normal M2 path)'
            : row.interior === 0 ? 'yes (all outdoor)'
              : row.outdoor === 0 ? 'NO - fully static interior'
                : `mixed (${row.outdoor} outdoor / ${row.interior} static)`,
        };
      }).sort((a, b) => b.instances - a.instances);
      console.table(out);
      return out;
    },
    staticOnly: () => (qaGlobals.__wowDebugLight as { survey: () => any[] }).survey()
      .filter((row: any) => String(row.followsTimeOfDay).startsWith('NO') || String(row.followsTimeOfDay).startsWith('mixed')),
  };

  console.log('[debuglight] ready - ALT+CLICK an object; __wowDebugLight.survey() / .staticOnly()');
}
