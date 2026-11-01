# Stage 1b "Mission Setup" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A start menu configures the mission (theme, range band, soldiers, vehicle targets, wind speed + clock direction, rifle, buildings, scenery vehicles, random); the mission spawns a seeded layout of soldiers, vehicle targets, buildings and vehicles that act as real cover; the mission ends with a results screen.

**Architecture:** Pure, seeded, three-free modules decide everything (`src/mission/`: config + URL codec, themes, layout generator; `src/scene/terrainField.ts`: per-theme height field; `src/game/`: box colliders and obstacle hits). Three.js modules only build meshes from those decisions, using the same dimension constants for meshes and colliders. The URL is the single source of a mission: the menu navigates to `?m=<encoded config>`; Restart reloads it; no mission param → menu.

**Tech Stack:** as stage 1 (TypeScript strict, Vite, Vitest, three@0.187.0, Web Audio). Codex CLI for textures and menu art (done by the controller).

**Spec:** `docs/superpowers/specs/2026-11-01-desert-sniper-design.md` — **Addendum A** (mission setup). Stage 1 spec sections still bind.

## Global Constraints

- All stage-1 Global Constraints still apply (units, axes Y-up/−Z downrange/+X right, pure modules must not import `three`, rifle data, constants).
- Seeded determinism: every random decision in a mission comes from one `mulberry32(seed)`-style PRNG passed explicitly; no `Math.random()` in `src/mission/**` or layout code. Same config + seed → identical layout.
- Theme air (verbatim from spec A.3): desert 38 °C / 1013.25 hPa; arctic −15 °C / 1013.25 hPa; valley 18 °C / 900 hPa. Built with `makeAtmosphere(tempC, hPa)`.
- Wind clock (verbatim from spec A.2): 12 = from downrange (headwind, air moves toward +Z), 3 = from the right (toward −X), 6 = from behind (toward −Z), 9 = from the left (toward +X). Vector = `speed · (−sin θ, 0, cos θ)`, θ = clock·30°.
- Ranges: band 100–1500 m, min ≤ max. Soldiers 1–10, vehicle targets 0–3, wind 0–12 m/s.
- Soldiers stand within ±10° of straight downrange. Every soldier's head centre and upper-torso centre have clear line of sight from `SHOOTER_POS` past terrain and all colliders.
- Density counts: buildings none 0 / few 3–5 / many 8–12; scenery vehicles none 0 / few 2–3 / many 5–7.
- Meshes and colliders come from the same dimension constants (as `target.ts` already does for the dummy).
- Legacy URL `?range=…&wind=…&rifle=…&air=…[&debug=1]` keeps working (one soldier at that range, no props, desert) so `npm run smoke` keeps passing.
- Commits end with the session's Co-Authored-By trailer.

## Review Focus

1. **Line of sight with props**: a soldier "behind cover" must still show head + upper torso; a target fully hidden by a building is a broken mission. Test in Task 4.
2. **Bullet vs thin cover at high speed**: a 0.3 m wall must stop an 800 m/s bullet even with 0.8 m substep segments (swept segment–box test, not point sampling). Test in Task 3.
3. **Bad / hand-edited mission URL** (`?m=garbage`, out-of-range numbers, missing fields): falls back to defaults/clamps, never a blank page. Test in Task 1.
4. **Range band with min = max, and 10 soldiers + many props in a narrow band**: the layout still places everything (relax spacing, retry with bounded attempts, then place fewer props — never fewer targets) and never hangs. Test in Task 4.
5. **Restart / Menu round-trip**: Restart reproduces the identical layout (same seed); Menu shows the menu with the last settings pre-filled. Test in Task 1 (codec round-trip) and Task 7 (smoke).

---

### Task 1: Mission config, URL codec, wind clock, themes (pure)

**Files:** Create `src/mission/config.ts`, `src/mission/themes.ts`, `src/mission/random.ts`; Test `tests/mission/config.test.ts`, `tests/mission/themes.test.ts`, `tests/mission/random.test.ts`.

**Interfaces (produces):**
```ts
// random.ts
export type Rng = () => number;                       // [0,1)
export function createRng(seed: number): Rng;          // mulberry32
export function randInt(rng: Rng, min: number, max: number): number; // inclusive
// themes.ts
export type ThemeId = 'desert' | 'arctic' | 'valley';
export interface ThemeDef { id: ThemeId; name: string; airTempC: number; airPressureHPa: number; }
export const THEMES: Record<ThemeId, ThemeDef>;
export function themeAtmosphere(id: ThemeId): Atmosphere;
// config.ts
export type Density = 'none' | 'few' | 'many';
export interface MissionConfig {
  theme: ThemeId; rangeMin: number; rangeMax: number; soldiers: number; vehicleTargets: number;
  windSpeedMps: number; windClock: number; rifle: '308' | '338'; buildings: Density; vehicles: Density; seed: number;
}
export const DEFAULT_MISSION: MissionConfig;            // spec A.2 defaults, seed 1
export function clampMission(c: Partial<MissionConfig>): MissionConfig; // fills defaults, clamps, swaps min/max if reversed; QUANTISES: ranges integer metres, soldiers/vehicleTargets integers, windSpeedMps to 0.1 m/s, windClock integer wrapped into 1..12 ((n-1) mod 12 + 1), seed uint32
export function encodeMission(c: MissionConfig): string; // URL-safe compact string
export function decodeMission(s: string): MissionConfig | null; // null if undecodable; clamps if decodable
export function randomMission(rng: Rng): MissionConfig;  // every field random within limits, new seed; returns clampMission(...) output (already quantised)
export function windVector(speedMps: number, clock: number): Vec3;
export function windClockLabel(clock: number): string;  // e.g. "from 9 o'clock (left)"
export type Route = { kind: 'menu'; last: MissionConfig | null } | { kind: 'mission'; config: MissionConfig; legacy: boolean; debug: boolean };
export function routeFromSearch(search: string): Route; // ?m=… → mission; legacy ?range= → mission (soldiers 1, rangeMin=rangeMax=range, buildings/vehicles none, theme desert, wind from legacy wind as clock 9 or 3 by sign); else menu (last = decoded ?last= if present)
```
- Replaces `src/game/config.ts` usage later (Task 6); keep `src/game/config.ts` until Task 6 deletes it.

- [ ] **Step 1: Tests:** `createRng(1)` deterministic sequence and in [0,1); `windVector(5, 3)` ≈ (−5,0,0), `(5,9)` ≈ (5,0,0), `(5,12)` ≈ (0,0,5), `(5,6)` ≈ (0,0,−5); `themeAtmosphere('arctic').densityRatio > themeAtmosphere('desert').densityRatio`; `themeAtmosphere('valley')` built from 18 °C / 900 hPa; `decodeMission(encodeMission(c))` deep-equals `c` for DEFAULT_MISSION and 50 `randomMission` outputs; `decodeMission('garbage') === null`; `clampMission({ rangeMin: 2000, rangeMax: 50, soldiers: 99, windSpeedMps: -3, windClock: 13 })` → rangeMin 100, rangeMax 1500 (swapped then clamped), soldiers 10, wind 0, windClock 1 (wrap); `clampMission({ windSpeedMps: 4.4704 }).windSpeedMps === 4.5`; `clampMission({ windClock: 0 }).windClock === 12`; `routeFromSearch('?m=' + encodeMission(DEFAULT_MISSION) + '&debug=1')` → mission with `debug: true`, `legacy: false`; `routeFromSearch('')` → menu; `routeFromSearch('?m=garbage')` → menu; `routeFromSearch('?range=800&debug=1')` → mission, legacy, debug, soldiers 1, rangeMin = rangeMax = 800; `routeFromSearch('?m=' + encodeMission(DEFAULT_MISSION))` → mission with that config.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS. **Step 5:** Commit `feat(mission): config, URL codec, themes, wind clock`.

---

### Task 2: Per-theme terrain field with an engagement sector (pure) + theme terrain material

**Files:** Create `src/scene/terrainField.ts`; Modify `src/scene/terrainHeight.ts` (keep exports as the desert/legacy field), `src/scene/terrain.ts` (`createTerrainMesh(field, theme)`); Test `tests/scene/terrainField.test.ts`.

**Interfaces:**
- Consumes: `ThemeId`, `Rng`/seed.
- Produces:
```ts
export interface TerrainField { theme: ThemeId; height(x: number, z: number): number; shooter: Vec3; }
export function createTerrainField(theme: ThemeId, seed: number): TerrainField;
export const SECTOR_HALF_ANGLE_RAD: number;   // 12° — gentle ground inside, full relief outside
export const SECTOR_MAX_RANGE: number;        // 1600 m
// terrain.ts
export function createTerrainMesh(field: TerrainField, maxAnisotropy?: number): THREE.Mesh;
```
- Shooter on a rise at the origin (as stage 1). Inside the engagement sector (|bearing| ≤ 12°, range ≤ 1600 m) the ground is gentle (long wavelengths ≥ 60 m, amplitude ≤ 1.5 m) so targets have clear LOS; outside it each theme has its own relief: desert dunes + outcrops (current look), arctic smooth drifts + dark rock outcrops, valley rolling hills (larger, up to ~25 m) + rocks.
- Mesh: vertex spacing ≤ 6 m inside the sector (so mesh and `height()` agree within 0.1 m at any target spot), coarser outside; textures `/textures/sand_albedo.webp` (desert), `/textures/snow_albedo.webp` (arctic), `/textures/grass_albedo.webp` (valley) with the existing flat-colour fallback.
- Every field, including desert and the legacy route, keeps outcrops and strong relief OUTSIDE the sector. Note: four stage-1 `ROCK_OUTCROPS` lie inside ±12° — (72,−790), (−68,−1010), (125,−1190), (−115,−1390) — they must move outside the sector (keep them visible as scenery). `terrainHeight`/`SHOOTER_POS` exports in `terrainHeight.ts` become thin wrappers over `createTerrainField('desert', 1)` so stage-1 tests and the legacy URL still work.

- [ ] **Step 1: Tests:** deterministic per (theme, seed); for each theme and 3 seeds: LOS from `shooter` to a point 1.6 m above ground is clear for bearings −10°, 0°, +10° at ranges 100…1500 step 100 (200 samples, terrain below the line except the last 2 m); inside the sector `|height(p) − height(p + 6 m)| ≤ 0.5 m`; the three themes differ (heights at the same off-sector point not all equal).
- [ ] **Step 2–4:** RED → implement → GREEN; `npm run build`.
- [ ] **Step 5:** Commit `feat(scene): per-theme terrain fields with an engagement sector`.

---

### Task 3: Box colliders and obstacle hits in BulletSystem

**Files:** Modify `src/game/hit.ts`, `src/game/bullets.ts`; Test `tests/game/obstacle.test.ts`.

**Interfaces:**
```ts
// hit.ts
export type ZoneName = 'head' | 'upperTorso' | 'lowerTorso' | 'limbs' | 'engine';
export type Material = 'wall' | 'metal';
export interface Box { center: Vec3; halfSize: Vec3; yaw: number; }   // oriented about Y
export interface Obstacle { id: string; material: Material; box: Box; }
export function segmentBox(a: Vec3, b: Vec3, box: Box): number | null; // first-contact u ∈ [0,1], 0 if a inside, else null
// bullets.ts — options gain:
//   obstacles?: () => Obstacle[]          (default: none)
// ImpactEvent gains:
//   | { bulletId; kind: 'obstacle'; obstacleId: string; material: Material; point: Vec3; time: number }
```
- Per substep the earliest contact among target zones, obstacles and terrain wins (earliest `u`).
- Broad phase: `HitTarget` gains optional `bounds?: { center: Vec3; radius: number }`; when present, BulletSystem skips the target's zones unless the substep segment touches the bounds sphere (10 soldiers × ~66 spheres × several bullets must stay cheap). Same for obstacles via a bounding sphere computed once per Obstacle.

- [ ] **Step 1: Tests:** `segmentBox` axis-aligned hit / miss / start-inside / rotated 45° box hit and miss; a 0.3 m-thick wall (box half-size z 0.15) at 400 m stops a `.308` shot aimed through it — event `obstacle`, `material: 'wall'`, `point.z` within 0.2 m of the wall face; a target sphere placed 2 m behind that wall is NOT hit; a target in front of the wall IS hit; with a frame spike `update(5)` the wall still stops the bullet (no tunnelling); default (no `obstacles` option) behaviour unchanged (existing bullets tests still pass); a target with `bounds` is still hit exactly as without bounds (same event, same zone).
- [ ] **Step 2–4:** RED → implement → GREEN. **Step 5:** Commit `feat(game): oriented box colliders and obstacle impacts`.

---

### Task 4: Seeded mission layout generator (pure)

**Files:** Create `src/mission/layout.ts`, `src/mission/props.ts` (prop dimension constants + collider builders, pure); Test `tests/mission/layout.test.ts`.

**Interfaces:**
```ts
// props.ts — pure dimensions; meshes in Task 5 use the same constants
export type PropKind = 'house' | 'wall' | 'shed' | 'truck' | 'jeep';
export interface PropPlacement { id: string; kind: PropKind; x: number; z: number; yaw: number; }
export interface LocalBox { center: Vec3; halfSize: Vec3; }            // in the prop's local frame (yaw 0, ground at y=0)
export function propBoxes(kind: PropKind): readonly LocalBox[];           // THE dimension source: Task 5 meshes are built from these boxes
export function propColliders(p: PropPlacement, groundY: number): Obstacle[]; // world boxes from propBoxes; houses/sheds/walls → 'wall'; vehicles → 'metal'
export function propFootprintRadius(kind: PropKind): number;
export function vehicleTargetBoxes(kind: 'truck' | 'jeep'): { body: readonly LocalBox[]; engine: LocalBox }; // body boxes exclude the engine block
export function vehicleTargetColliders(v: VehicleTargetPlacement, groundY: number): { body: Obstacle[]; engineCenter: Vec3 };
// layout.ts
export interface SoldierPlacement { id: string; x: number; z: number; yaw: number; range: number; behindCover: boolean; }
export interface VehicleTargetPlacement { id: string; kind: 'truck' | 'jeep'; x: number; z: number; yaw: number; range: number; }
export interface MissionLayout { soldiers: SoldierPlacement[]; vehicleTargets: VehicleTargetPlacement[]; props: PropPlacement[]; }
export function generateLayout(config: MissionConfig, field: TerrainField): MissionLayout;
export function soldierAimPoints(s: SoldierPlacement, field: TerrainField): { head: Vec3; upperTorso: Vec3; lowerTorso: Vec3 }; // world points; heights from the dummy constants (move DUMMY_HEAD / torso centre heights into a pure module, e.g. src/mission/dummyDims.ts, re-exported by target.ts)
export function lineOfSightClear(from: Vec3, to: Vec3, field: TerrainField, obstacles: Obstacle[]): boolean;
```
- Placement algorithm (bounded, deterministic): props first (density → count via rng within the spec ranges), clustered into 1–3 "sites" (compound / camp) inside the sector and the range band ±150 m, with spacing by footprint radius; then vehicle targets (open ground, inside band, LOS to engine centre clear); then soldiers: range uniform in [rangeMin, rangeMax], bearing uniform in ±10°, min 6 m apart; when props exist, ~40% of soldiers are tried behind cover: placed behind a wall or vehicle along the shooter's line, searching the distance behind it (0.5–6 m) for a spot where the **cover predicate** holds — lowerTorso blocked AND head and upperTorso clear (the shooter's eye is ~12 m above the floor, so at short range the soldier must stand closer to the cover); if no spot satisfies it, place the soldier in the open with `behindCover = false`. Accept any soldier only if `lineOfSightClear` to head and upperTorso against terrain, all prop colliders, vehicle-target bodies and the other soldiers' upright bounds (one target must not hide another). Props are placed only at ranges ≥ 100 m, inside the sector (|bearing| ≤ 12°, range ≤ 1600 m), never on the shooter's rise. Up to 200 attempts per entity; if props block too much, drop props (never targets); if a soldier still cannot be placed, relax spacing then bearing (never exceed ±12°).
- Legacy route: one soldier at (0, −range), no props.

- [ ] **Step 1: Tests:** for 30 random configs (seeded): exact soldier and vehicle-target counts; every soldier range within [rangeMin, rangeMax] (±1 m) and bearing within ±12°; every soldier passes `lineOfSightClear` to head and upperTorso against all prop colliders + terrain; for every soldier with `behindCover`, the lowerTorso aim point is blocked and head + upperTorso are clear (test across range bands 100–200, 600–1000 and 1300–1500); with buildings = many and soldiers = 10 in band 600–1000, at least 2 soldiers end up `behindCover`; every prop is at range ≥ 100 m and inside ±12°; no two props' footprints overlap; same config → deep-equal layout; `rangeMin = rangeMax = 800` with 10 soldiers + many/many props completes in < 500 ms and places 10 soldiers.
- [ ] **Step 2–4:** RED → implement → GREEN. **Step 5:** Commit `feat(mission): seeded layout of soldiers, vehicle targets and cover`.

---

### Task 5: Prop and vehicle-target meshes, theme palettes, sparks and smoke

**Files:** Create `src/scene/props.ts` (meshes from `src/mission/props.ts` constants), `src/scene/vehicleTarget.ts`, `src/fx/sparks.ts`, `src/fx/smoke.ts`; Modify `src/scene/target.ts` (`createTargetDummy(position: Vec3, yaw: number)` — keep a `createTargetDummyAtRange(range)` wrapper for tests/legacy), `src/scene/sky.ts` (`createSky(scene, theme)`); Test `tests/scene/props.test.ts`.

**Interfaces:**
```ts
export function createPropMesh(p: PropPlacement, groundY: number, theme: ThemeId): THREE.Group;
export interface VehicleTarget { group: THREE.Group; hitTarget: HitTarget; obstacles: Obstacle[]; disabled: boolean; disable(): void; update(dt: number): void; }
export function createVehicleTarget(v: VehicleTargetPlacement, groundY: number, theme: ThemeId): VehicleTarget; // hitTarget zones: 'engine' spheres covering the engine block; obstacles: body (metal) excluding the engine block region
export class SparkSystem { group: THREE.Group; spawn(p: Vec3): void; update(dt: number): void; }
export class SmokeColumn { /* rising smoke above a disabled vehicle */ }
export function createSky(scene: THREE.Scene, theme: ThemeId): SkySetup; // per-theme sun, fog colour/density
```
- Low-poly, stylised-realistic, built from boxes/cylinders (like the dummy). Palettes per theme (desert mud-brick/tan; arctic dark timber + snow roofs; valley stone/white render + red roofs). Vehicles: truck and jeep, theme-tinted paint.
- Colliders match meshes: each collider box comes from the same constant as its mesh box.

- Meshes are built from `propBoxes(kind)` / `vehicleTargetBoxes(kind)` (Task 4) — no new dimension constants here.
- `createTargetDummy(position, yaw)`: the dummy's hit spheres rotate with its yaw (soldiers face the shooter from up to ±12°); `hitTarget.bounds` is set (Task 3 broad phase).
- [ ] **Step 1: Tests (Node, geometry only, no WebGL):** for each `PropKind`, the mesh boxes in `createPropMesh` equal `propBoxes(kind)` transformed by the placement (centre/half-size within 1 mm); vehicle-target engine spheres lie inside the engine box ± 3 cm and body obstacles don't overlap the engine box; a dummy at bearing 10° with yaw facing the shooter: a real BulletSystem shot at an arm centre registers `limbs`, and a shot 0.1 m outside the arm registers nothing.
- [ ] **Step 2–4:** RED → implement → GREEN; `npm run build`. **Step 5:** Commit `feat(scene): buildings, vehicles, vehicle targets, sparks and smoke`.

---

### Task 6: Mission runtime (multi-target game, rangefinder, results)

**Files:** Create `src/mission/run.ts` (the game loop for one mission, moved from `main.ts`), `src/mission/stats.ts` (pure), `src/game/rangefinder.ts` (pure), `src/ui/results.ts`; Modify `src/main.ts` (route: menu vs mission), `src/ui/hud.ts`; Delete `src/game/config.ts` (+ its test, superseded by Task 1); Test `tests/mission/stats.test.ts`, `tests/game/rangefinder.test.ts`.

**Interfaces:**
```ts
// stats.ts
export interface MissionStats { shots: number; hits: number; headshots: number; targetsDown: number; targetsTotal: number; longestHitM: number; startMs: number; endMs: number | null; }
export function newStats(targetsTotal: number, nowMs: number): MissionStats;
export function recordShot(s: MissionStats): MissionStats;
export function recordImpact(s: MissionStats, e: ImpactEvent, killed: boolean, rangeM: number, nowMs: number): MissionStats; // pure, returns new
export function accuracy(s: MissionStats): number; // hits/shots, 0 when no shots
export function isComplete(s: MissionStats): boolean;
// rangefinder.ts
export function rangeUnderCrosshair(origin: Vec3, dir: Vec3, field: TerrainField, obstacles: Obstacle[], targets: HitTarget[], maxRange?: number): number | null; // first hit along the ray
// run.ts
export function runMission(config: MissionConfig, opts: { legacy: boolean; debug: boolean }): void;
```
- Uses theme atmosphere for both ballistics and sound speed; wind = `windVector(config.windSpeedMps, config.windClock)`; zero from `findZeroElevation(rifle, atmo)`; BulletSystem gets targets = alive soldiers + non-disabled vehicle targets, obstacles = all prop colliders + vehicle bodies.
- Events: soldier hit (any zone, including limbs — in stage 1b a limb hit counts as "wounded = down"; crawling wounded is stage 3) → knock down; vehicle engine hit → disable + smoke; obstacle `metal` → sparks + a metallic ping (reuse impact clip pitched up, or add `impact_metal` later); obstacle `wall` → dust; terrain → dust. HUD shows "HIT – head" style labels (display names, not raw ids), targets left, rangefinder (updated ~10×/s), wind "4.5 m/s from 9 o'clock".
- Completion: all targets down → after 1.5 s show results (`src/ui/results.ts`): shots, hits, accuracy %, headshots, longest hit, time; buttons Restart (reload same URL) and Menu (navigate to `/?last=<encoded config>`). Pointer lock released on results.
- Debug hook kept (`toggleScope, zoom, fire, reload`), plus `state()` returning stats for the smoke check.

- [ ] **Step 1: Tests:** stats: shots/hits/headshots/accuracy/longest/complete for a scripted event sequence; obstacle and terrain events are not hits; rangefinder: flat field at y=0 with ray from (0,10,0) pitched −10° → ≈ 57.6 m; a wall box in front returns the wall distance; a target sphere returns its distance; ray at the sky → null.
- [ ] **Step 2–4:** RED → implement → GREEN; `npm run build`; existing smoke (`?range=800&debug=1`) still passes. **Step 5:** Commit `feat(mission): multi-target missions with cover, rangefinder and results`.

---

### Task 7: Start menu UI + smoke coverage

**Files:** Create `src/ui/menu.ts`, `src/ui/menu.css`; Modify `src/main.ts`, `scripts/smoke.mjs`; uses `public/menu/card_{desert,arctic,valley}.webp` (controller-provided).

- Menu (HTML/CSS overlay, no framework), stylised to fit the game (dark, military-utilitarian, readable): title; 3 theme cards with preview images; range band (two linked sliders with live "600–1000 m" label, min ≤ max enforced); soldiers slider 1–10; vehicle targets 0–3; wind speed slider 0–12 m/s with mph shown; wind direction as a 12-position clock dial (click a position; arrow shows where the wind blows); rifle toggle (.308 / .338); buildings and vehicles as none/few/many segmented controls; **Random mission** button (fills controls from `randomMission`); **Start** → `location.search = '?m=' + encodeMission(config)` with a fresh seed. Pre-fills from `route.last` when coming back from a mission. Keyboard accessible; works at 1280×720 and up.
- Smoke additions: open `/` → screenshot `test-results/menu.png`, assert the Start button exists; click Random then Start (with `&debug=1` appended) → wait for the mission, screenshot `test-results/mission.png`, assert no console errors; for each theme, drive the menu UI (open `/`, click the theme card, click Start with `&debug=1` appended to the resulting URL — e.g. expose `window.__menu.start({debug:true})` or append via the URL after navigation) and assert the canvas is non-blank. `scripts/smoke.mjs` is plain Node: it cannot import TS modules.

- [ ] **Step 1:** Implement menu + routing. **Step 2:** Extend smoke. **Step 3:** `npm test`, `npm run build`, `npm run smoke` → all pass; controller inspects screenshots. **Step 4:** Commit `feat(ui): mission setup menu`.

---

## Controller-side work (parallel)

- Codex: `public/textures/snow_albedo.webp`, `public/textures/grass_albedo.webp` (tileable, 2×2 check), `public/menu/card_{desert,arctic,valley}.webp` (16:9, ~1280×720 + 640 variant). Credits/provenance sidecars as for the sand texture.
