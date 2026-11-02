# Known minor issues (deferred from stage 1 / 1b reviews)

Triaged as 'later' by the final whole-branch reviews. Pick up when touching the area.

- Task 1: minor (deferred): lenient decode — corrupted ?m= with right shape starts default-ish mission (config.ts:160-181)
- Task 1: minor (deferred): windClockLabel(NaN) → "NaN o'clock" (config.ts:230)
- Task 1: minor (deferred): legacy wind quantised to 0.1 and capped at 12 (config.ts:256)
- Task 1: minor (deferred): legacy detection keyed on `range` only (config.ts:273)
- Task 1: minor (deferred): mulberry32 test lacks a literal anchor value (random.test.ts:6-13)
- Task 3: minor (deferred): obstacle radius cache by identity can go stale/churn (hit.ts:128-142)
- Task 3: minor (deferred): broad-phase exact-touch bounds — add tiny slack (hit.ts:74, bullets.ts:159,177); carry to Task 5: bounds margin
- Task 3: minor (deferred): "default unchanged" test compares new vs new (obstacle.test.ts:284)
- Task 2: minor (deferred): height() ~30% slower than stage 1; cheap fast-path in sectorDistance + outcrop bounding reject (terrainField.ts:58-70,202)
- Task 2: minor (deferred): mesh vs height() up to ~0.9 m beyond 1750 m and at outcrop rough noise (terrain.ts) — scenery only
- Task 2: minor (deferred): test gaps — valley "only outside" title overstated; createRocks/per-theme material untested
- Task 2: minor (deferred): legacy desert look changed (art only)
- Task 4: minor (deferred): planProps silently skips after 200 attempts (layout.ts:275); legacy detected by config shape (layout.ts:166,668) → Task 6 must use legacyLayout by route; test gaps (layout.test.ts:74,88-92,199; footprint gap>0 vs PROP_GAP; density test never uses vehicleTargets); report radii misstated (truck 3.67, jeep 2.27); dummyDims generic names
- Task 4: minor (deferred): LAST_RESORT path unreachable in tests (no regression guard / throw path untested) — needs an injectable stage seam
- Task 5: minor (deferred): dummy per-instance material/geometry (target.ts:181,187); yawed dummy edge gaps ≤1.2 cm torso / ≤3.4 cm boot toe at 15° jitter (layout.ts:336 jitter 15° vs brief 12°); foundation skirt above terrain on slopes without collider (props.ts:273-279), vehicles no skirt; overlap test checks engine corners only (props.test.ts:201); valley map-edge haze vs horizon colour (sky.ts:76); spark size ignores DPR (sparks.ts)
- Task 5: minor (deferred): side-face coverage test samples only a diagonal (j used for y and z) — report overclaims 49x49; ENGINE_ZONE_RADIUS unused export
- Task 6: minor (deferred): same-frame double hit counts hits twice (kill once); next-frame second bullet passes through fallen dummy (run.ts:341-354)
- Task 6: minor (deferred): run.ts 488 lines god-file; onImpact untested — split buildMissionWorld/applyImpact/debugHook (run.ts:146-202,321-371,404-433)
- Task 6: minor (deferred): mission time = wall clock incl. idle before first click (run.ts:213,354) — start on first lock/shot
- Task 6: minor (deferred): late in-flight bullets update stats after results snapshot; M mute dead on results screen (run.ts:391,395)
- Task 6: minor (deferred): SmokeColumn falls back to Math.random (run.ts:195, smoke.ts:52) — visuals only
- Task 6: minor (deferred): rangefinder marches to 3000 m when aimed at sky (rangefinder.ts:63-78)
- Task 6: minor (deferred): smoke HOLD_300M hard-coded; cover check depends on seed-5 layout
- Task 6: minor (deferred): no test soldierAimPoints == dummy zone centres; rangefinder tests yaw-0 boxes only; duplicate #app check (main.ts:22)
