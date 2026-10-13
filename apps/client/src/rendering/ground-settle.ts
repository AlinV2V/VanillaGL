export type GroundProbe = { x: number; y: number; z: number };

// Keep this bounded: absent WMO collision must never drag a unit to terrain far below it. A full
// patch-10 vMaNGOS scan against all 768 baked tiles, excluding water, holes and WMO/M2 footprints,
// found credible ground spawns through 3.32734 yd (Gnaz Blunderflame). The 3.5 rail covers that
// cluster while rejecting the separate 4.13+ yd cliff/event/elevated-object outliers.
export const LIVING_UNIT_GROUND_SETTLE_MAX = 3.5;

export const shouldApplyLivingUnitGroundSettle = (sourceZ: number, groundZ: number) =>
  Number.isFinite(sourceZ)
  && Number.isFinite(groundZ)
  && Math.abs(sourceZ - groundZ) <= LIVING_UNIT_GROUND_SETTLE_MAX;

/** Asset conversion utility. */
export const groundProbeSource = (
  cached: GroundProbe | undefined,
  rendered: GroundProbe,
  authoritativeZ: number | undefined,
): GroundProbe => {
  // A revalidate re-uses the original source verbatim: same position, same answer, no drift.
  if (cached) return cached;
  return {
    x: rendered.x,
    y: rendered.y,
    z: Number.isFinite(authoritativeZ) ? (authoritativeZ as number) : rendered.z,
  };
};

/** A sampled server spline is authoritative presentation Z without becoming canonical entity state. */
export const unitGroundProbeZ = (
  presentationOwned: boolean,
  splineZ: number | undefined,
  entityZ: number | undefined,
): number | undefined => presentationOwned && Number.isFinite(splineZ) ? splineZ : entityZ;
