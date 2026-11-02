# Stage 1d "Realism pass" Implementation Plan

**Spec:** `docs/superpowers/specs/2026-11-01-desert-sniper-design.md` Addendum C (binding). **Base:** stage-1d (= stage-1c-int e157201 + assets). Tasks run in parallel worktrees and are merged by the controller; one whole-branch review at the end.

## Global Constraints
- All earlier constraints hold: LOS guarantees inside the ±12° sector (no vegetation/rock/decoration may block LOS to any target or sniper, from any position), meshes vs colliders within 3 cm, seeded determinism, purity of `src/mission/**`/`src/game/**`/`terrainField.ts`.
- Assets only from `public/assets/` (CC0, credited). Load with three's TextureLoader / RGBELoader / GLTFLoader (+ `MeshoptDecoder` from `three/examples/jsm/libs/meshopt_decoder.module.js`), with graceful fallback (current look) if a file fails.
- Performance: ≤ 400 draw calls largest mission (InstancedMesh = 1), 60 fps target, no per-frame allocations, texture memory sensible (1k textures, mipmaps, anisotropy).
- Shell PATH lacks node: `export PATH=$HOME/.nvm/versions/node/v22.22.0/bin:$PATH`. Never use ports 5173/5174. `npx vitest run --testTimeout=60000`, `npm run build`, `npm run smoke` must pass; inspect screenshots with `scripts/visual-check.mjs`.

## Tasks (parallel)
- **R1 Terrain realism** (`src/scene/terrain.ts`, new `src/scene/terrainMaterial.ts`; pure helpers for bake in `src/scene/terrainBake.ts`): C.1.
- **R2 Sky, light, post** (`src/scene/sky.ts`, `src/scene/renderer.ts`, new `src/scene/postfx.ts`, render path in `src/mission/run.ts` minimal): C.2.
- **R3 Buildings & vehicles** (`src/scene/props.ts`, `src/scene/vehicleTarget.ts`, new `src/scene/materials.ts`): C.3.
- **R4 Vegetation, rocks, firing nest** (new `src/scene/vegetation.ts`, `src/scene/nest.ts`, pure placement in `src/mission/scatter.ts`; wire in `src/mission/world.ts`): C.4.
- **R5 Rifle finish** (`src/player/rifle.ts`): C.5.
