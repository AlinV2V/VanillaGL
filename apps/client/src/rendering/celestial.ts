import * as THREE from 'three';
/** Asset conversion utility. */
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const celestialLayerVisible = (effectiveOpacity: number) => effectiveOpacity > 0;
export const resolveCelestialVisibilityPath = (search: string): 'optimized' | 'legacy' =>
  new URLSearchParams(search).get('celestialvisibility') === 'legacy' ? 'legacy' : 'optimized';

export function createCelestialLayer(radius: number) {
  const visibilityPath = resolveCelestialVisibilityPath(typeof location !== 'undefined' ? location.search : '');
  const layerVisible = (opacity: number) => visibilityPath === 'legacy' || celestialLayerVisible(opacity);
  const group = new THREE.Group();
  group.renderOrder = -999; // just in front of the sky dome (-1000), behind the world
  group.frustumCulled = false;

  const textureLoader = new THREE.TextureLoader();
  const loadSkyTexture = (url: string, repeat = false) => {
    const texture = textureLoader.load(url);
    // The BLP->PNG bake preserves the M2 texture orientation. TextureLoader's default flip would
    // invert those authored UVs, while Stars.m2 texture flags 3 require wrap on both axes.
    texture.colorSpace = THREE.NoColorSpace;
    texture.flipY = false;
    texture.wrapS = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    texture.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    return texture;
  };

  // SunGlare is the authored corona halo behind SunCenter (1.12 texture.MPQ has no
  // "SunCorona" asset). Added to the group first so the additive halo composites
  // under the sun disc, and scaled wider than the disc like the client's flare.
  const sunGlare = new THREE.Sprite(new THREE.SpriteMaterial({
    map: loadSkyTexture('/sky/sun-glare.png'),
    color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true,
    depthTest: true, depthWrite: false, fog: false,
  }));
  // SunGlare's gradient fills its whole quad while SunCenter's bright core does
  // not, so ~0.45 reads as a halo ~1.3x the visible disc core rather than a wash.
  sunGlare.scale.setScalar(radius * 0.45);
  group.add(sunGlare);

  const sun = new THREE.Sprite(new THREE.SpriteMaterial({
    map: loadSkyTexture('/sky/sun-center.png'),
    color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true,
    depthTest: true, depthWrite: false, fog: false,
  }));
  sun.scale.setScalar(radius * 0.55);
  group.add(sun);

  const moon = new THREE.Sprite(new THREE.SpriteMaterial({
    map: loadSkyTexture('/sky/moon.png'),
    color: 0xffffff, blending: THREE.NormalBlending, transparent: true,
    depthTest: true, depthWrite: false, fog: false,
  }));
  moon.scale.setScalar(radius * 0.22);
  group.add(moon);

  // Lightweight fallback while the exact authored Stars.m2 dome JSON streams in.
  const fallbackStars = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 0.965, 48, 24),
    new THREE.MeshBasicMaterial({
      map: loadSkyTexture('/sky/stars2.png', true), color: 0xffffff,
      side: THREE.BackSide, transparent: true, depthTest: true, depthWrite: false,
      fog: false, blending: THREE.NormalBlending,
    }),
  );
  fallbackStars.frustumCulled = false;
  fallbackStars.renderOrder = -999;
  fallbackStars.visible = layerVisible(0);
  group.add(fallbackStars);
  const starMaterials: Array<{ mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; authoredOpacity: number }> = [
    { mesh: fallbackStars, material: fallbackStars.material, authoredOpacity: 1 },
  ];
  let currentStarOpacity = 0;

  // Generic outdoor night sky is itself a Vanilla M2 (LightSkybox ID 4), with seven authored
  // translucent layers split between Stars.blp and Stars2.blp. Preserve that geometry and its
  // per-layer weights instead of stretching one faint texture over a generic sphere.
  void fetch('/sky/stars-model.json').then(async (response) => {
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok || !contentType.includes('application/json')) {
      throw new Error(`Stars.m2 bake unavailable (${response.status} ${contentType || 'unknown content type'})`);
    }
    const model = await response.json() as {
      positions: number[];
      uvs: number[];
      parts: Array<{ indices: number[]; texture: number; opacity: number }>;
    };
    const position = new THREE.Float32BufferAttribute(model.positions, 3);
    const uv = new THREE.Float32BufferAttribute(model.uvs, 2);
    const textures = [
      loadSkyTexture('/sky/stars.png', true),
      loadSkyTexture('/sky/stars2.png', true),
    ];
    for (const part of model.parts) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', position);
      geometry.setAttribute('uv', uv);
      geometry.setIndex(part.indices);
      const material = new THREE.MeshBasicMaterial({
        map: textures[part.texture] ?? textures[0],
        color: 0xffffff,
        side: THREE.DoubleSide,
        transparent: true,
        // Transparent sky layers render after opaque terrain in Three's transparent pass. Test the
        // terrain depth buffer so stars cannot shine through mountains, buildings, or relief.
        depthTest: true,
        depthWrite: false,
        fog: false,
        // Stars.m2 uses Vanilla blend mode 2 (ordinary alpha), not additive blending.
        blending: THREE.NormalBlending,
        opacity: currentStarOpacity * part.opacity,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.scale.setScalar(radius / 25);
      mesh.frustumCulled = false;
      mesh.renderOrder = -999;
      mesh.visible = layerVisible(material.opacity);
      group.add(mesh);
      starMaterials.push({ mesh, material, authoredOpacity: part.opacity });
    }
    group.remove(fallbackStars);
    fallbackStars.geometry.dispose();
    fallbackStars.material.dispose();
    starMaterials.shift();
  }).catch(() => { /* fallback remains visible */ });

  const scratch = new THREE.Vector3();
  /** sunDir = direction the sunlight travels (downward); dayFactor 0=night .. 1=full day. */
  const update = (sunDir: THREE.Vector3, dayFactor: number) => {
    scratch.copy(sunDir).normalize().multiplyScalar(-radius * 0.9); // toward the sun
    sun.position.copy(scratch);
    sunGlare.position.copy(scratch);
    // Moon on the opposite AZIMUTH but kept high in the sky (the sun direction is fixed/upward here,
    // so a true antipode would put the moon underground and it'd never show at night).
    moon.position.set(-scratch.x, -scratch.y, Math.abs(scratch.z) * 0.85);
    const day = clamp01(dayFactor);
    sun.material.opacity = clamp01(day * 1.3);
    sun.visible = sun.material.opacity > 0.01;
    // Halo fades with the disc but stays subtler so it reads as haze, not a second sun.
    sunGlare.material.opacity = clamp01(day * 0.3);
    sunGlare.visible = sun.visible;
    moon.material.opacity = clamp01((1 - day) * 0.85 + 0.1);
    currentStarOpacity = clamp01((1 - day) * 1.35 - 0.05);
    for (const star of starMaterials) {
      star.material.opacity = currentStarOpacity * star.authoredOpacity;
      star.mesh.visible = layerVisible(star.material.opacity);
    }
  };

  const diagnostics = () => ({
    opacity: currentStarOpacity,
    visibilityPath,
    layerCount: starMaterials.length,
    layers: starMaterials.map((star) => ({
      opacity: star.material.opacity,
      authoredOpacity: star.authoredOpacity,
      visible: star.mesh.visible,
      textureLoaded: !!star.material.map?.image,
      wrapS: star.material.map?.wrapS,
      wrapT: star.material.map?.wrapT,
      flipY: star.material.map?.flipY,
    })),
  });

  return { group, update, diagnostics };
}
