/** Asset conversion utility. */
export function terrainTypeForTexture(textureName: string): number {
  const parts = textureName.replace(/\\/g, '/').split('/');
  let name = parts.pop()?.replace(/\.blp$/i, '').toLowerCase() ?? '';
  // Strip a geographic prefix (DuskwoodGrass, City_02Snow) before matching
  // material names; otherwise zone names create false wood/metal matches.
  const zonePrefix = (parts.pop() ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (zonePrefix && name.replace(/[^a-z0-9]/g, '').startsWith(zonePrefix)) name = name.slice(zonePrefix.length);
  if (/snow|ice|frost/.test(name)) return 4;
  if (/cobble|stone|rock|brick|marble|flagstone|paving|slate|street/.test(name)) return 3;
  if (/metal|iron|steel|copper|bronze|grate/.test(name)) return 2;
  if (/wood|timber|plank|board/.test(name)) return 5;
  if (/sand|beach|desert|dune/.test(name)) return 8;
  if (/leaf|leaves|needle/.test(name)) return 7;
  if (/soggy|mud|swamp|marsh|bog/.test(name)) return 9;
  if (/dust.*grass|drygrass|grass|moss|clover/.test(name)) return 6;
  return 1;
}
