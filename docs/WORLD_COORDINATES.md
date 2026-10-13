# World coordinates

All constants here match the current VanillaGL code and raw Build 5875 data.

## ADT grid

The outdoor world is a 64×64 ADT grid. `tools/bakers/bake-tile.ts` uses a tile width of 533.33333 yards and the Build 5875 world edge/centre magnitude 17066.666666666668. Each ADT has 16×16 MCNK chunks, so one chunk spans 33.333333 yards. A chunk's terrain lattice has 9×9 outer vertices plus 8×8 interleaved inner vertices (145 MCVT floats). The browser bakes the combined outer grid as 129×129 and inner points as 128×128; runtime step is `TILE / (129 - 1)`.

ADT indexing reverses the intuitive Cartesian direction: the 64-grid is measured from the positive world edge, and current tile geometry writes local X as `TILE_HALF - row*step` and local Y as `TILE_HALF - col*step`. MCNK headers store `indexX` at header +0x04, `indexY` +0x08, and base Z at +0x70 (the Z member of the float3 beginning +0x68).

## Runtime origin

`WorldTileLoader` stores an explicit render origin `(originX, originY)`:

```text
renderX = worldX - originX       worldX = renderX + originX
renderY = worldY - originY       worldY = renderY + originY
renderZ = worldZ
```

The active anchor uses the tile's `originX - TILE_HALF` and `originY - TILE_HALF`. Loaded tile groups are repositioned whenever the origin shifts, collision structures refresh, and server/network coordinates remain in world space. This keeps WebGL matrices near zero without changing protocol coordinates.

## Terrain sampling and collision

`world-tile-loader.ts` maps a world point into a tile-relative coordinate, computes clamped fractional row/column coordinates, applies 4×4 MCNK hole masks, then samples outer and inner height grids using the authored triangle topology. Interior masks can suppress terrain beneath enclosed WMOs. Water uses the same outer grid; four finite neighboring samples are averaged. WMO liquid sampling is performed in each WMO instance's transformed local grid.

Movement and camera work in render-local Three.js coordinates. `WorldCollision` uses WMO collision meshes and accelerated BVH raycasts for ground, wall, step, camera, and line tests; terrain height sampling is the cheap fallback/input where a mesh query is unnecessary. Ground-spell targeting iterates a camera ray against a plane and drapes its mesh with terrain samples, then converts the accepted point back to world coordinates for the cast packet.

## WMO, doodads, liquids, and visibility

WMO group vertices, portal planes, BSP nodes, local lights, and root doodads are model-local. A MODF placement supplies the root transform; baked instances apply it before entering the tile group. Doodad instance matrices remain local to that tile group. Terrain and WMO liquid type values exposed to gameplay are 1 river/water, 2 ocean, 3 magma, and 4 slime.

`rendering/wmo-visibility.ts` transforms camera probes into WMO/model space, resolves candidate groups through MOGP bounds and MOBN/MOBR BSP data, then walks MOPT/MOPR portal adjacency. MOGP flags classify interior (`0x2000`) and exterior/lit (`0x08`/`0x40`) groups. A fully enclosed interior can hide outdoor terrain, sky, celestial, cloud, and outdoor liquid layers; a portal path to an exterior group keeps them visible.

Coordinate signs and rotations must be validated at the boundary that owns them. Do not import later-expansion ADT/WMO coordinate conventions or apply an extra axis swap because a third-party parser happens to expose one.
