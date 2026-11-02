# Stage 1c "Merge ChatGPT branch" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port every feature of ChatGPT's commit 497a2b3 (realistic look, firing positions, first-person rifle + suppressor, enemy snipers that fight back, aim assists, HUD styling) into the stage-1b architecture.

**Architecture:** Pure decisions stay in `src/mission/**`, `src/scene/terrainField.ts`, `src/game/**` (three-free, seeded). ChatGPT's code is the reference for look and behaviour (`git show 497a2b3:<path>`); it is adapted, not pasted: it assumed one target at `(0, −range)`, a global `terrainHeight`, and `StageConfig`. Before the new features land, `run.ts` (538 lines) is split so each feature has a home.

**Tech Stack:** as stage 1b. Node: `export PATH=$HOME/.nvm/versions/node/v22.22.0/bin:$PATH` (the shell PATH lacks node).

**Spec:** `docs/superpowers/specs/2026-11-01-desert-sniper-design.md` — **Addendum B** (binding), Addendum A and earlier sections still apply.

## Global Constraints

- All stage-1/1b constraints still apply (units, axes, purity, seeded determinism, meshes and colliders from shared constants, LOS guarantee inside the ±12° sector).
- Work only in `/Users/mac/Documents/SnaperSumulatorGame-1b` (branch `stage-1c`). A dev server for the user runs from it on port 5174 — never kill it; never use ports 5173/5174 for smoke/preview. Never touch `/Users/mac/Documents/SnaperSumulatorGame` (ChatGPT's checkout).
- Firing positions (verbatim, spec B.2): valley rise 1.5 m radius 24; ridge 12 m radius 40 (current); mountain 85 m radius 90. Eye = rise top + 0.4 m.
- Encounter numbers (verbatim, spec B.4): detection +35 per unsuppressed shot, +9 suppressed; +4/s exposed, −9/s in cover; snipers fire at ≥ 65 %: every 4 s, −18 health if exposed; bombardment every 12 s with a 4 s warning, −45 exposed / −5 in cover; health 100.
- Enemy snipers 0–3 (default 1); suppressor default off; aim assists default off; firing position default ridge.
- Mission URL codec becomes `v2.` (adds position, suppressed, enemySnipers, assists); `v1.` links still decode (→ ridge, unsuppressed, 0 snipers, no assists).
- Legacy `?range=` route: unchanged behaviour (0 snipers, ridge, no assists).
- Draw calls ≤ 400 for the largest mission (smoke-asserted); shadow map 2048².
- Commits end with the session's Co-Authored-By trailer.

## Review Focus

1. **Valley walls / mountain spur vs line of sight**: no wall, spur or ground detail may block LOS to any target or sniper from any firing position. Test in Task 2.
2. **Enemy sniper fairness**: every sniper has a clear LOS to the player's eye and the player to the sniper's head (it can be found and hit); glint never visible through geometry. Test in Task 5.
3. **Cover state vs input**: in cover the player can't fire, scope is dropped, and returning from cover restores control; pointer-lock loss pauses the encounter clock (no damage while paused). Test in Task 5.
4. **v1 links and legacy URLs** keep working. Test in Task 1.
5. **Performance with shadows + rifle overlay + 13 targets + 3 snipers + ground detail**: ≤ 400 draw calls, no per-frame allocations in the loop. Test in Task 7 (smoke).

---

### Task 0: Split run.ts (no behaviour change)

**Files:** Create `src/mission/world.ts` (build scene/world from config: field, layout, meshes, colliders, targets), `src/mission/impact.ts` (pure `applyImpact(event, state) → { stats, killedTargetId, hud, fx, sound }`), `src/mission/debugHook.ts`; Modify `src/mission/run.ts` (loop + wiring only). Test `tests/mission/impact.test.ts`.
- [ ] `applyImpact` unit tests: soldier hit (once; second hit same frame doesn't double-kill), engine disable once, obstacle metal/wall, terrain, expired; HUD strings as today.
- [ ] Full suite + build + smoke unchanged (SMOKE OK). Commit `refactor(mission): split run.ts into world, impact and debug hook`.

### Task 1: Config v2

**Files:** Modify `src/mission/config.ts`, `tests/mission/config.test.ts`.
- `MissionConfig` += `position: 'valley' | 'ridge' | 'mountain'`, `suppressed: boolean`, `enemySnipers: number` (0–3), `assists: boolean`. `DEFAULT_MISSION`: ridge, false, 1, false. `MISSION_LIMITS.enemySnipers = {min:0,max:3}`.
- Codec `v2.` = v1 fields + `<position v|r|m>.<suppressed 0|1>.<snipers>.<assists 0|1>`; `decodeMission` accepts v1 (defaults above for new fields, snipers 0) and v2. `randomMission` covers the new fields. Legacy route: snipers 0, ridge, unsuppressed, no assists.
- [ ] Tests: v2 round-trip for DEFAULT + 50 random; a known v1 string decodes with the new defaults; clamp of snipers (−1→0, 9→3); legacy route fields. Commit `feat(mission): config v2 — position, suppressor, enemy snipers, assists`.

### Task 2: Terrain field — firing positions and valley walls (pure)

**Files:** Modify `src/scene/terrainField.ts` (`createTerrainField(theme, seed, position = 'ridge')`), callers; Test `tests/scene/terrainField.test.ts`.
- Rise per position (spec B.2): ridge = current smoothstep rise; valley/mountain = `height · max(0, 1 − r/radius)²` (ChatGPT's profile), mountain gets rocky roughness on its flanks (outside a 6 m flat summit pad).
- Valley walls (ChatGPT's "eroded ridgelines": `55 + ridgeNoise·190 + strata`, per-theme amplitude: desert dunes/rock, arctic snowy ridges, valley green hills) faded in by `sectorDistance` starting ≥ 60 m outside the sector edge, so the sector is untouched.
- [ ] Tests: for every theme × position × 3 seeds, LOS from `field.shooter` to points 1.6 m above ground at bearings −10/0/+10° and ranges 100…1500 is clear; walls reach ≥ 80 m height somewhere at |bearing| ≥ 30°, range 600; mountain eye ≈ 85.4 m; `height()` inside the sector unchanged vs today for the ridge position (regression). Commit `feat(scene): firing positions and valley walls`.

### Task 3: Realistic look — shadows, terrain material, ground detail, smoother dummies

**Files:** Modify `src/scene/renderer.ts`, `src/scene/terrain.ts`, `src/scene/sky.ts`, `src/scene/target.ts` (mesh only); Create `src/scene/detail.ts` (port ChatGPT `sandRelief` → per-theme `groundRelief(theme)`, `createGroundDetail(field, theme, layout)`), `src/scene/shadows.ts` (`createShadowLight(scene, theme) → { update(focus: Vec3) }`).
- Shadows: PCF, 2048², a directional light from the theme sun; shadow frustum (±30 m box) re-centred each frame on the rangefinder point when scoped, on the area 40 m in front when not. Props, dummies, vehicles, snipers cast + receive; terrain receives.
- Terrain material: `MeshStandardMaterial` + bump relief + slope/height rock tint + world-space mottling shader (port ChatGPT's `onBeforeCompile`), palette per theme.
- Ground detail: one `InstancedMesh` of pebbles/stones per theme (≤ 1200 instances), plus grass tufts (≤ 1500, simple crossed quads) in the valley theme; placed off the target lane and never inside a prop footprint or within 2 m of a target; instances are visual only (no colliders).
- Dummies: ChatGPT's rounded boxes/capsules, goggles, scarf — mesh only; `dummyHitSpheres` and dims unchanged (existing coverage tests must still pass).
- [ ] Node tests: ground-detail placement avoids props/targets/lane; shadow focus helper (pure) picks the right centre. Build + smoke + `scripts/visual-check.mjs` screenshots per theme × position (controller inspects). Commit(s) `feat(scene): shadows, realistic terrain material, ground detail, smoother soldiers`.

### Task 4: First-person rifle and suppressor

**Files:** Create `src/player/rifle.ts` (port ChatGPT `FirstPersonRifle`: own scene + camera rendered after the world with depth cleared; hidden while scoped; `fire()` recoil + muzzle flash (no flash when suppressed), `reload()` motion, `update(dt)`); Modify `src/mission/run.ts` (render pass), `src/audio/sounds.ts` (`playShot(e, rifleId, suppressed)` — ChatGPT's 0.22 level + 1400 Hz low-pass).
- [ ] Tests (Node): rifle model builds for both rifles and suppressed/unsuppressed without WebGL (geometry counts), flash disabled when suppressed. Smoke: unscoped screenshot shows the rifle; scoped hides it. Commit `feat(player): first-person rifle, recoil, muzzle flash, suppressor`.

### Task 5: Enemy snipers that fight back

**Files:** Create `src/game/encounter.ts` (port ChatGPT `Encounter`, pure, numbers from Global Constraints; `update(dt, alive, covered, paused)`), `src/scene/sniper.ts` (port `createSniper(position: Vec3, yaw, id)`: prone mesh, hit zones from shared local constants, glint sprite; `scan(time, detected, covered, eye)`; `knockDown`; `dispose`), `src/ui/threat.ts` (threat panel, damage flash, cover mask); Modify `src/mission/layout.ts` (`SniperPlacement {id, x, y, z, yaw, site: 'roof' | 'ridge' | 'open', range}`; `MissionLayout.snipers`), `src/mission/props.ts` (rooftop spot per house kind), `src/mission/world.ts`, `run.ts`, `impact.ts`, `stats.ts` (targets total includes snipers; "Mission failed" when health 0), `src/ui/results.ts` (failed variant).
- Placement: `config.enemySnipers` snipers inside the band ± 150 m and the sector; prefer house rooftops when houses exist, else ridge-like high ground at the sector edge, else open ground; accept only if LOS player-eye ↔ sniper head is clear both ways (terrain + colliders) and the sniper is not inside any collider; deterministic from the seed.
- Behaviour: as spec B.4. Cover (C) toggles cover: drops the scope, blocks firing, shows the cover mask. Encounter clock pauses while the pointer is unlocked. Sniper fire / bombardment effects: dust near the player, impact sound, damage flash, HUD threat line with countdowns.
- [ ] Tests: `Encounter` (detection math, firing cadence, bombardment warning → damage, cover halves damage, paused = no change, ended when health 0 or no snipers); sniper placement (count, LOS both ways, not inside colliders, rooftop when houses, determinism); sniper hit zones cover the prone mesh (real shots at head/torso → target event); stats with snipers; results failed variant. Smoke: mission with 2 snipers — glint present, `state()` exposes detection/health; force detection via debug hook → health drops when exposed, not in cover; kill all targets → complete. Commit(s) `feat(mission): enemy snipers, detection, cover and health`.

### Task 6: Aim assists

**Files:** Create `src/game/assistance.ts` (port `predict` / `solveAim` with pure `Vec3` math — no three — using `step` and `muzzleLaunch`), `src/ui/assists.ts` (T/A/P buttons, trajectory line, aim marker ◇, spotter text "hold 1.2 mil high, 0.4 mil right"); Modify `run.ts`, `stats.ts`/`results.ts` ("assists used").
- Only available when `config.assists`; selected target = the alive target nearest the crosshair.
- [ ] Tests: `solveAim` converges so a real BulletSystem shot along the solved direction hits the target's chest at 300/800/1200 m with wind; spotter mils match the solved offset; assists unavailable when disabled. Commit `feat(assist): trajectory preview, aim marker and spotter`.

### Task 7: Menu, HUD styling, smoke

**Files:** Modify `src/ui/menu.ts`, `src/ui/menuModel.ts`, `src/ui/menu.css`, `index.html` (HUD panel styling from ChatGPT), `scripts/smoke.mjs`, `scripts/visual-check.mjs`.
- Menu: new controls — Firing position (3 options with ChatGPT's one-line descriptions), Suppressor toggle, Enemy snipers 0–3, Aim assists toggle; rifle panel shows the rifle concept art (`/references/rifle-concept.png`, cropped per rifle). Random covers them.
- HUD: ChatGPT's panel look (`.hud-panel`), threat panel, assist panel.
- [ ] Smoke: menu sets every new control by real input → mission reflects them (`state()`); per position × theme the canvas is non-blank; draw calls ≤ 400 for 10 soldiers + 3 vehicles + 3 snipers + many/many; v1 link still starts. Screenshots inspected by the controller. Commit `feat(ui): menu and HUD for the merged features`.
