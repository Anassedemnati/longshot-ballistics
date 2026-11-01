# Stage 1 "One Shot" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A playable browser scene: the player is on a desert rise, sees one standing target at a chosen range (default 800 m), looks with the naked eye or through a magnified mil-reticle scope, fires, and the bullet flies a real G7 point-mass trajectory with constant wind; a hit knocks the target down, a miss raises dust where the bullet lands.

**Architecture:** A pure-TypeScript ballistics core (`src/ballistics/`, no Three.js imports, SI units) is validated against js-ballistics through a committed JSON fixture. A pure `BulletSystem` (`src/game/`) steps bullets with a fixed-substep accumulator and swept hit tests against an analytic terrain height function and sphere hit zones. Three.js code (`src/scene/`, `src/player/`, `src/fx/`, `src/ui/`) only renders and feeds input into those pure modules.

**Tech Stack:** TypeScript (strict), Vite 8, Vitest, three@0.187.0, js-ballistics@3.1.0 (devDependency, tests only), Codex CLI (sand texture), playwright-core (smoke check).

**Spec:** `docs/superpowers/specs/2026-11-01-desert-sniper-design.md` (stage 1 = §9 item 1; ballistics = §6; scope = §7.4; rifles = §5.5)

## Global Constraints

- Units everywhere in game code: meters, seconds, radians, m/s, kg/m³, °C for temperature input, hPa for pressure input.
- World axes (Three.js): **Y up, downrange = −Z, shooter's right = +X**. Shooter stands near the origin.
- `src/ballistics/**` and `src/game/**` must not import `three` (pure, unit-testable in Node).
- js-ballistics is a **devDependency only**; it is used by `scripts/gen-reference.mjs`, never imported by `src/`.
- Rifle data (verbatim from spec §5.5): `.308 Win` G7 BC 0.243, 175 gr, MV 790 m/s; `.338 Lapua Magnum` G7 BC 0.322, 250 gr, MV 900 m/s. Both: sight height 0.04 m, zero 100 m, magazine 5.
- Gravity 9.80665 m/s². Standard density ρ0 = 1.225 kg/m³. Speed of sound c = 20.0467·√T_K. Dry-air density ρ = P_Pa / (287.05·T_K).
- Air presets: STANDARD = 15 °C, 1013.25 hPa; DESERT = 38 °C, 1013.25 hPa. Humidity 0, altitude 0.
- No spin drift, no Coriolis in stage 1.
- Naked-eye vertical FOV 60°. Scope magnification 4×–20×, `vfov = 2·atan(tan(30°)/mag)`.
- Render with `logarithmicDepthBuffer: true`. Target 60 fps on a mid-range laptop.
- Commit after every task (local repo, branch `stage-1`). Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Frame-time spike** (tab switch, GC pause): one `update(5.0)` must not tunnel a bullet through a target nor spin the accumulator for seconds — frame dt is clamped to 0.1 s. Test in Task 4.
2. **Shot that hits nothing** (fired at the sky or over the horizon): bullet is removed after 6 s of flight and reports `expired`; a bullet below terrain reports a `terrain` impact. Test in Task 4.
3. **Firing again while a bullet is in flight**: both bullets simulate and report independently. Test in Task 4.
4. **Window resize / devicePixelRatio change**: reticle mil spacing is computed from CSS pixels and current vfov, and redrawn on resize. Test in Task 5.
5. **Pointer lock lost (Esc) then regained**: no looking or firing while unlocked; the click that re-acquires lock does not fire. Test in Task 6.

---

### Task 1: Project scaffold + reference fixture

**Files:**
- Create: `.gitignore`, `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.ts` (placeholder), `scripts/gen-reference.mjs`, `tests/fixtures/reference.json` (generated), `src/ballistics/g7.ts` (generated), `tests/smoke.test.ts`

**Interfaces:**
- Produces: `npm run dev`, `npm run build`, `npm test` (vitest run), `npm run gen:reference`.
- Produces `tests/fixtures/reference.json` with shape:
  ```ts
  { cases: Array<{ rifle: '308' | '338'; air: 'standard' | 'desert'; windFromLeftMps: number;
      samples: Array<{ range: number; time: number; height: number; windage: number; velocity: number; mach: number; densityRatio: number }> }> }
  ```
  where `height` = meters relative to line of sight (negative = below), `windage` = meters, positive = toward shooter's right, ranges 100..1500 step 100.
- Produces `src/ballistics/g7.ts`: `export const G7_TABLE: ReadonlyArray<{ mach: number; cd: number }>` (84 rows, copied from `DragTables.G7`, header comment crediting js-ballistics, ISC license).

- [ ] **Step 1:** `git init`, `git checkout -b stage-1`, `.gitignore` (node_modules, dist, .DS_Store, `test-results/`).
- [ ] **Step 2:** Scaffold Vite vanilla-TS by hand (no interactive CLI): deps `three@0.187.0`; devDeps `typescript`, `vite`, `vitest`, `@types/three`, `js-ballistics@3.1.0`. `tsconfig` strict, `"module": "ESNext"`, `"moduleResolution": "bundler"`. Scripts: `dev`, `build` (`tsc --noEmit && vite build`), `test` (`vitest run`), `gen:reference` (`node scripts/gen-reference.mjs`).
- [ ] **Step 3:** Write `scripts/gen-reference.mjs`. Base it on this verified snippet (it already runs against js-ballistics 3.1.0):
  ```js
  const shot = new Shot({ weapon: new Weapon({ sightHeight: UNew.Centimeter(4) }),
    ammo: new Ammo({ dm: new DragModel({ bc, dragTable: DragTables.G7, weight: grains, diameter: inches }), mv: UNew.MPS(mv) }),
    atmo, winds: [new Wind({ velocity: UNew.MPS(windFromLeftMps), directionFrom: UNew.Degree(90) })] });
  const calc = new Calculator();
  await calc.setWeaponZero(shot, UNew.Meter(100));
  const hit = await calc.fire({ shot, trajectoryRange: UNew.Meter(1500), trajectoryStep: UNew.Meter(100) });
  // p.time, p.height.In(Distance.Meter), p.windage.In(Distance.Meter), p.velocity.In(Velocity.MPS), p.mach, p.densityRatio
  ```
  Desert atmo: `new Atmo({ altitude: UNew.Meter(0), temperature: UNew.Celsius(38), pressure: UNew.hPa(1013.25), humidity: 0 })`; standard: `Atmo.standard()`. Cases: rifles {308, 338} × air {standard, desert} × wind {0, 4.4704}. `directionFrom: 90` = wind from the shooter's left, pushing right (positive windage) — verified. Script also writes `src/ballistics/g7.ts` from `DragTables.G7` (`{Mach, CD}` → `{mach, cd}`). Drop the 0 m sample.
- [ ] **Step 4:** Run `npm run gen:reference`. Expected sanity: `.308/standard/wind 4.47` at 800 m → time ≈ 1.472, height ≈ −7.47, windage ≈ 2.05.
- [ ] **Step 5:** `tests/smoke.test.ts`: fixture has 8 cases × 15 samples; `G7_TABLE.length === 84`; `G7_TABLE[0]` equals `{ mach: 0, cd: 0.1198 }`. `npm test` → PASS. `npm run build` → succeeds.
- [ ] **Step 6:** Commit `chore: scaffold vite+ts project and ballistics reference fixture`.

---

### Task 2: Atmosphere, drag and rifle data

**Files:**
- Create: `src/ballistics/types.ts`, `src/ballistics/atmosphere.ts`, `src/ballistics/drag.ts`, `src/ballistics/rifles.ts`
- Test: `tests/ballistics/atmosphere.test.ts`, `tests/ballistics/drag.test.ts`

**Interfaces:**
- Consumes: `G7_TABLE` (Task 1), fixture.
- Produces:
  ```ts
  // types.ts
  export interface Vec3 { x: number; y: number; z: number }
  export interface BulletState { pos: Vec3; vel: Vec3; t: number }
  export interface Rifle { id: '308' | '338'; name: string; bcG7: number; muzzleVelocity: number; sightHeight: number; zeroRange: number; magazine: number }
  export interface Atmosphere { temperatureC: number; pressureHPa: number; density: number; densityRatio: number; speedOfSound: number }
  export type WindField = (pos: Vec3, t: number) => Vec3; // air velocity in world frame, m/s
  // atmosphere.ts
  export function makeAtmosphere(temperatureC: number, pressureHPa: number): Atmosphere;
  export const STANDARD_ATMO: Atmosphere; export const DESERT_ATMO: Atmosphere;
  // drag.ts
  export function g7Cd(mach: number): number;          // interpolated, clamped at table ends
  export function dragFactor(bcG7: number): number;     // ρ0·π / (8 · bcG7 · 703.0696)  [1/m]
  // rifles.ts
  export const RIFLES: Record<'308' | '338', Rifle>;
  ```

- [ ] **Step 1:** Tests: `STANDARD_ATMO.densityRatio` ≈ 1.000 (±0.001); `DESERT_ATMO.densityRatio` within 0.3% of fixture desert `densityRatio` at 100 m; speed of sound (`velocity/mach` from fixture at 100 m) within 0.3% for both airs; `g7Cd` hits table rows exactly at table Mach values, is between neighbours mid-way, clamps below 0 and above last Mach; `RIFLES['308']` values equal Global Constraints.
- [ ] **Step 2:** Run → FAIL (modules missing).
- [ ] **Step 3:** Implement. Drag acceleration used later is `a = −densityRatio · dragFactor(bc) · g7Cd(M) · |v_rel| · v_rel` (v_rel = bullet velocity − wind). Interpolation over Mach: monotone cubic (PCHIP); linear is acceptable only if Task 3 validation passes.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(ballistics): atmosphere, G7 drag and rifle data`.

---

### Task 3: Integrator, zeroing, validation against js-ballistics

**Files:**
- Create: `src/ballistics/integrator.ts`, `src/ballistics/trajectory.ts`
- Test: `tests/ballistics/validation.test.ts`, `tests/ballistics/integrator.test.ts`

**Interfaces:**
- Consumes: Task 2 exports.
- Produces:
  ```ts
  // integrator.ts — the ONE stepping function used by validation, in-game flight and (stage 5) bullet cam
  export const DEFAULT_DT = 0.001;
  export function step(s: BulletState, dt: number, bcG7: number, atmo: Atmosphere, wind: WindField): BulletState; // RK4, gravity −Y
  // trajectory.ts
  export interface RangeSample { range: number; time: number; height: number; windage: number; velocity: number }
  export function findZeroElevation(rifle: Rifle, atmo: Atmosphere): number; // radians above line of sight; bore starts sightHeight below LOS; no wind
  export function simulateToRanges(rifle: Rifle, atmo: Atmosphere, wind: WindField, elevationRad: number, ranges: number[]): RangeSample[];
  ```
  `simulateToRanges` fires from `(0, −sightHeight, 0)` along −Z pitched up by `elevationRad`, LOS = the line y=0, interpolates linearly between steps at each downrange distance `−z = range`. `height = y`, `windage = x`.

- [ ] **Step 1:** `integrator.test.ts`: vacuum check (atmo with `densityRatio: 0`) — after 1 s from v=(0,0,−800) at origin, `pos.y` = −4.903 (±1 mm), `pos.z` = −800 (±1 mm); wind physics check — wind `(+5,0,0)`, after 1 s in STANDARD air, `pos.x > 0` (drift goes with the wind).
- [ ] **Step 2:** `validation.test.ts`: for every fixture case and every sample, using `findZeroElevation` + `simulateToRanges` with wind `() => ({ x: windFromLeftMps, y: 0, z: 0 })`:
  - `|height − ref.height| ≤ max(0.02·|ref.height|, 0.01)`
  - `|windage − ref.windage| ≤ max(0.02·|ref.windage|, 0.01)`
  - `|time − ref.time| ≤ 0.01·ref.time`
  - `|velocity − ref.velocity| ≤ 0.01·ref.velocity`
  On failure print the case, range and both values.
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** Implement. `findZeroElevation`: bisection/secant on elevation so `height` at `zeroRange` = 0 (±0.1 mm).
- [ ] **Step 5:** Run → PASS. If a case fails only at 1300–1500 m (transonic) for `.308`, switch `g7Cd` to PCHIP before touching tolerances; tolerances are not to be widened.
- [ ] **Step 6:** Commit `feat(ballistics): RK4 point-mass solver validated against js-ballistics`.

---

### Task 4: BulletSystem (flight, hits, cleanup)

**Files:**
- Create: `src/game/bullets.ts`, `src/game/hit.ts`
- Test: `tests/game/bullets.test.ts`, `tests/game/hit.test.ts`

**Interfaces:**
- Consumes: `step`, `DEFAULT_DT`, types.
- Produces:
  ```ts
  // hit.ts
  export type ZoneName = 'head' | 'upperTorso' | 'lowerTorso' | 'limbs';
  export interface HitZone { name: ZoneName; center: Vec3; radius: number }
  export interface HitTarget { id: string; zones: HitZone[] }
  export type TerrainHeight = (x: number, z: number) => number;
  export function segmentSphere(a: Vec3, b: Vec3, center: Vec3, radius: number): number | null; // param u∈[0,1] of first contact, or null
  // bullets.ts
  export type ImpactEvent =
    | { bulletId: number; kind: 'target'; targetId: string; zone: ZoneName; point: Vec3; time: number }
    | { bulletId: number; kind: 'terrain'; point: Vec3; time: number }
    | { bulletId: number; kind: 'expired'; time: number };
  export interface BulletSystemOptions { atmo: Atmosphere; wind: WindField; terrainHeight: TerrainHeight; targets: () => HitTarget[]; dt?: number; maxFlightTime?: number; maxFrameDt?: number } // defaults 0.001, 6, 0.1
  export class BulletSystem {
    constructor(opts: BulletSystemOptions);
    fire(origin: Vec3, velocity: Vec3, bcG7: number): number;           // returns bulletId
    update(frameDt: number): ImpactEvent[];                              // clamps frameDt to maxFrameDt, then fixed substeps
    readonly active: ReadonlyArray<{ id: number; state: BulletState }>;
  }
  ```
  Each substep tests segment (prev→next) against all zones of all targets (earliest `u` wins) and against terrain (sample `terrainHeight` at segment end; if below, bisect the segment to find the crossing to ±1 cm). A bullet is removed on its first event.

- [ ] **Step 1:** `hit.test.ts`: segment through sphere returns entry `u`; segment missing returns null; segment starting inside returns 0.
- [ ] **Step 2:** `bullets.test.ts` (flat terrain `() => -100` unless stated):
  - **zero check**: fired with `findZeroElevation` from `(0,−0.04,0)`, no wind, a target with one 0.1 m sphere at `(0,0,−100)` → `target` event.
  - **long shot**: `.308`, STANDARD, wind 0, sphere radius 0.25 at `(0, ref.height@800, −800)` (fixture) → `target` event, `time` within 1% of fixture 800 m time.
  - **tunneling / dt spike**: same shot, call `update(5.0)` repeatedly — still a `target` event; a single `update(5.0)` advances simulated time by at most 0.1 s.
  - **sky shot**: fired at 45° up, terrain −1000 → `expired` at `time` 6 s (±dt).
  - **terrain**: fired 2° down from y=1.5 over flat terrain `() => 0` → `terrain` event, `point.y` within 0.01 of 0.
  - **two bullets**: fire two bullets 0.05 s apart at two targets → two `target` events with different `bulletId`s.
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement. **Step 5:** Run → PASS.
- [ ] **Step 6:** Commit `feat(game): bullet system with swept hit tests`.

---

### Task 5: Aim math and scope reticle

**Files:**
- Create: `src/game/aim.ts`, `src/player/reticle.ts`
- Test: `tests/game/aim.test.ts`

**Interfaces:**
- Consumes: types, `Rifle`.
- Produces:
  ```ts
  // aim.ts (pure)
  export const NAKED_VFOV_RAD: number;               // 60° in radians
  export function magnificationToVfov(mag: number): number;   // 2·atan(tan(NAKED/2)/mag)
  export function milToPixels(mils: number, vfovRad: number, viewportHeightCss: number): number; // tan(mils·0.001)/tan(vfov/2)·h/2
  export function muzzleLaunch(eye: Vec3, forward: Vec3, up: Vec3, rifle: Rifle, zeroElevationRad: number): { origin: Vec3; velocity: Vec3 };
  // reticle.ts (DOM)
  export function drawReticle(ctx: CanvasRenderingContext2D, cssWidth: number, cssHeight: number, vfovRad: number, dpr: number): void;
  ```
  `muzzleLaunch`: origin = eye − up·sightHeight; velocity = muzzleVelocity · (forward rotated toward `up` by zeroElevationRad about right = forward×up).
  Reticle (first focal plane, MRAD): thin black cross hairs; hash every 1 mil to ±10 mil on both axes, half-mil ticks to ±5, numbers 2/4/6/8/10 below centre; thick posts outside 10 mil. All positions via `milToPixels`; canvas backing size = css × dpr.

- [ ] **Step 1:** Tests: `magnificationToVfov(1)` = 60° in rad; `magnificationToVfov(10)` ≈ 6.09° in rad (±0.01°); `milToPixels(1, magnificationToVfov(10), 1000)` ≈ 9.40 (±0.05) and doubles when viewport height doubles (**resize case**); `muzzleLaunch` with eye (0,1,0), forward (0,0,−1), up (0,1,0), elev e → origin.y = 0.96, velocity = mv·(0, sin e, −cos e) within 1e-9; integration check — launch from `muzzleLaunch` with `findZeroElevation(RIFLES['308'], STANDARD_ATMO)` crosses y = eye.y at range 100 ± 0.5 m.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(aim): scope optics math, muzzle launch and mil reticle`.

---

### Task 6: Desert scene, target, player view, firing (playable)

**Files:**
- Create: `src/scene/renderer.ts`, `src/scene/terrain.ts`, `src/scene/sky.ts`, `src/scene/target.ts`, `src/player/input.ts`, `src/player/view.ts`, `src/fx/dust.ts`, `src/ui/hud.ts`, `src/game/config.ts`
- Modify: `src/main.ts`, `index.html`
- Test: `tests/scene/terrain.test.ts`, `tests/player/input.test.ts`, `tests/game/config.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```ts
  // terrain.ts
  export const SHOOTER_POS: Vec3;                          // eye position, prone: rise top + 0.4 m
  export function terrainHeight(x: number, z: number): number; // deterministic, seeded; also used by BulletSystem
  export function createTerrainMesh(): THREE.Mesh;          // 4 km × 4 km, finer grid near the range lane
  // target.ts
  export function createTargetDummy(range: number): { group: THREE.Group; hitTarget: HitTarget; knockDown(): void };
  // config.ts — from URL query
  export interface StageConfig { range: number; windFromLeftMps: number; rifle: '308' | '338'; air: 'standard' | 'desert' }
  export function parseConfig(search: string): StageConfig; // defaults 800, 4.4704, '308', 'desert'; range clamped 100..1500
  // input.ts — pure state machine, DOM wiring separate
  export class InputState { locked: boolean; onLockChange(locked: boolean): void; onMouseDown(button: number): 'fire' | 'toggleScope' | 'requestLock' | null; onMouseMove(dx: number, dy: number, sensitivity: number): void; yaw: number; pitch: number }
  ```
- Terrain: gentle dunes (seeded value/simplex noise, amplitude ~3–6 m) plus a 12 m rise around the shooter; target area flattened near `(0, *, −range)`; a few rock outcrops. Line of sight from `SHOOTER_POS` to the target's chest must be clear for all ranges 100–1500.
- Target dummy: low-poly humanoid ~1.8 m from boxes/capsules, sand-khaki colour; zones head r 0.12 @1.65 m, upperTorso r 0.22 @1.35 m, lowerTorso r 0.2 @1.0 m, limbs r 0.15 @0.5 m. `knockDown` tips it backwards over 0.4 s.
- Sky: `three/examples/jsm/objects/Sky` (late-afternoon sun), `FogExp2` so the horizon fades but a 1500 m target is visible in the scope.
- View: naked vfov 60°; right-click toggles scope; wheel ×1.25 per notch within 4–20×; mouse sensitivity divided by magnification; pitch clamped ±80°. Scope overlay = full-screen black with circular hole (CSS) + reticle canvas (Task 5), redrawn on resize/mag change.
- Fire: left-click when scoped or not, 5-round magazine, `R` reloads (1.5 s), fire uses `muzzleLaunch` + `BulletSystem.fire`.
- Wind: constant `{ x: windFromLeftMps, y: 0, z: 0 }`.
- Feedback: on `target` → `knockDown()` + HUD "HIT – <zone> – <time> s"; on `terrain` → dust puff (sprite cloud ~1.5 m, 1.5 s fade, visible at 1500 m at 20×) + HUD "MISS"; on `expired` → HUD "MISS".
- HUD (Easy-style for stage 1): range to target, wind speed/direction arrow, magnification, rounds left, last shot result.

- [ ] **Step 1:** Tests: `terrainHeight` deterministic (same input → same output); LOS clear — for ranges 100,200,…,1500 sample 200 points between `SHOOTER_POS` and `(0, terrainHeight(0,−r)+1.35, −r)` and assert terrain is below the line at all but the last 2 m; `parseConfig('')` → defaults; `parseConfig('?range=5000')` → 1500; `InputState`: while unlocked, `onMouseDown(0)` → `'requestLock'` and mouse move does nothing; after `onLockChange(true)`, the first `onMouseDown(0)` → `'fire'`, `onMouseDown(2)` → `'toggleScope'`; `onLockChange(false)` → `onMouseDown(0)` → `'requestLock'` (**pointer-lock case**).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement scene, wire `main.ts` game loop (`requestAnimationFrame`, `BulletSystem.update(dt)`, events → fx/hud, render). **Step 4:** Run tests → PASS; `npm run build` → succeeds.
- [ ] **Step 5:** Commit `feat: playable desert range with scope and real ballistics`.

---

### Task 7: Sand texture via Codex (runs in parallel with Tasks 2–5)

**Files:** Create `public/textures/sand_albedo.webp` (+ provenance sidecar per the `codex-image-gen` skill).

- [ ] **Step 1:** Using the `codex-image-gen` skill, generate a seamless, tileable, top-down desert sand texture (fine ripples, warm beige, no objects, no shadows from objects), 1024×1024, WebP.
- [ ] **Step 2:** Check tiling (2×2 contact sheet shows no seams).
- [ ] **Step 3:** Task 6 terrain uses it as a repeating detail map (repeat so one tile ≈ 4 m), falling back to flat colour if missing.
- [ ] **Step 4:** Commit `art: tileable sand texture (Codex)`.

---

### Task 8: Headless smoke check

**Files:** Create `scripts/smoke.mjs`; add `"smoke": "node scripts/smoke.mjs"`.

- [ ] **Step 1:** `scripts/smoke.mjs` with `playwright-core` (devDep) launching the locally installed Chrome (`channel: 'chrome'`): run `vite preview`, open `/?range=800`, wait 3 s, assert no console errors and a non-blank canvas (sampled pixels not all one colour), screenshot `test-results/naked.png`; dispatch the scope toggle via a debug hook `window.__game.toggleScope()` (exposed only when `import.meta.env.DEV` or `?debug=1`), screenshot `test-results/scope.png`; call `window.__game.fire()` and wait 2 s, assert HUD shows `HIT` or `MISS`.
- [ ] **Step 2:** `npm run build && npm run smoke` → exits 0; screenshots exist and are inspected by the controller.
- [ ] **Step 3:** Commit `test: headless smoke check`.

---

## Later stages (outline only — each gets its own plan)

2. **The real map**: 3 km authored desert (wadi, compound, road, vehicles), terrain LOD, mirage shader, wind indicators (flags, dust).
3. **Living targets**: animated low-poly enemies (CC0 Quaternius/Kenney), patrol paths, hit-zone mapping to skeleton, alert behaviour; seeded determinism.
4. **Game structure**: missions (patrol + HVT), progression 400→1200 m+, scoring/stars, menus, difficulty levels (§5.3), settings, saving.
5. **Polish**: bullet cam (pre-simulation via the same `step`), audio with sound-delay, sway + breath, turrets in 0.1 mil, `.338` unlock, Codex art pass.
