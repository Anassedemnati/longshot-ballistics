# Desert Sniper — Design

Date: 2026-11-01
Status: draft for approval

## 1. Intent

A 3D first-person sniper simulator that runs in a desktop web browser. The player lies in a firing position overlooking a desert map and engages enemies at long range (400 m up to 1200 m+). The heart of the game is **real external ballistics**: the bullet slows down in the air, drops under gravity, and is pushed by wind, so long shots require the player to read range and wind and compensate. Everything else (terrain, enemies, audio, bullet cam) exists to make that moment of reading and compensating feel real and satisfying.

Why it's special: most browser sniper games fake ballistics (hitscan, or gravity + a constant sideways push). This one simulates the trajectory properly, so a shot at 800 m behaves like a real shot at 800 m.

## 2. Goals

- 3D first-person view over a desert terrain, with two viewing modes:
  - **Naked eye**: wide field of view, used to scan the terrain and spot targets.
  - **Scope**: magnified view with a reticle, used to range, compensate and shoot.
- Physically based bullet trajectory: drag (G7 drag model), gravity, wind, air density. Bullet time of flight is real (≈1.4 s at 800 m for the starter rifle), not instant.
- Visible environment cues for wind (flags, dust, grass/bushes, heat mirage direction).
- Three difficulty levels (see §5).
- Two mission types: patrols, and a single high-value target (HVT). Distances grow over the mission list.
- Bullet cam (slow-motion follow of the bullet on a hit), toggleable in settings.
- Sound delay with distance (supersonic crack, then the rifle's bang arriving at the speed of sound).
- Runs smoothly (target 60 fps) on a mid-range laptop in Chrome/Edge/Firefox/Safari.

## 3. Non-goals (for now)

- Mobile / touch controls.
- Multiplayer.
- Player movement around the map (the player is in a fixed firing position per mission; they can only look around). *Repositioning between pre-set positions may come later.*
- Photo-realistic graphics.
- More than one map in the first version.

## 4. Anti-goals (would make it a failure even if it "works")

- Fake ballistics: hitscan, constant drop, or wind as a constant sideways acceleration. Drop and drift must come from the trajectory simulation.
- Long-range rendering artifacts that break immersion: flickering surfaces far away (z-fighting), targets popping in/out, terrain visibly disappearing at the horizon.
- Bullets passing through targets because they moved more than a target's width in one frame (tunneling).
- A slow, heavy page (more than ~15 s to load on a normal connection).

## 5. Gameplay

### 5.1 Controls (desktop)

| Input | Action |
|---|---|
| Mouse move | Look around (pointer lock) |
| Right mouse | Toggle scope |
| Mouse wheel (in scope) | Change magnification (e.g. 4x–20x) |
| Left mouse | Fire |
| Shift (hold) | Hold breath: sway reduced for ~5 s, then worse sway until recovered |
| R | Cycle bolt / reload (5-round magazine) |
| Arrow keys / W-A-S-D in scope (Hard) | Scope turrets: elevation and windage clicks |
| Esc | Pause / settings |

### 5.2 The shot loop

1. Mission brief tells the player what to look for.
2. Player scans with the naked eye, spots movement.
3. Player goes into the scope, identifies the target.
4. Player determines range and wind (how depends on difficulty).
5. Player compensates: holds over / holds off using the reticle marks, or dials the turrets.
6. Player controls sway (breath hold), fires.
7. The bullet flies on its real trajectory. Bullet cam if enabled and the shot will hit.
8. Feedback: hit reaction, or a dust puff where the bullet lands (so the player can correct their next shot).
9. Enemies react (see §5.4).

### 5.3 Difficulty levels

| | Easy | Normal | Hard |
|---|---|---|---|
| Range to target | Shown | Shown (laser rangefinder key) | Not shown — estimate with the reticle (mil-relation) or terrain markers |
| Wind | Speed and direction shown | Speed and direction shown | Only environmental cues (flags, dust, mirage) |
| Aim help | Marker shows where the bullet will land | None | None |
| Turrets | Not needed | Optional | Available, in MRAD clicks (0.1 mil) |
| Sway | Low | Medium | High |
| Wind changes during the mission | No | Slow | Gusts and variation along the bullet's path |

### 5.4 Missions and enemies

- **Patrol**: several enemies walk set routes around a compound/outpost. A miss that lands near them, or any shot after the first kill, can alert them; alerted enemies run to cover, crouch, or move unpredictably. Mission goal: eliminate N targets before they escape or the timer ends.
- **HVT**: one specific target among several non-targets (identified by clothing/description in the brief). Must be taken out within a time window; hitting a wrong person fails the mission.
- **Progression**: an ordered mission list with growing distance — roughly 400 m → 600 m → 800 m → 1000 m → 1200 m+ — and growing wind complexity. Score per mission (headshots, first-shot hits, time) and stars to unlock the next.
- **Hit zones**: head, upper torso, lower torso, limbs. Headshot/torso = kill; limbs = wounded, enemy goes down/crawls (still counts toward alert).

### 5.5 Rifles

- **Rifle 1 (start)**: .308 Win, 175 gr bullet, G7 BC ≈ 0.243, muzzle velocity ≈ 790 m/s, zero 100 m. Good to ~1000 m.
- **Rifle 2 (unlock)**: .338 Lapua Magnum, 250 gr, G7 BC ≈ 0.322, ≈ 900 m/s. For 1200 m+ missions.
- Rifle data lives in a data file so more can be added without code changes.

## 6. Ballistics

### 6.1 Model

- 3-degree-of-freedom point-mass model, integrated with a fixed small time step (≈1 ms, RK4 or equivalent).
- Forces: gravity; aerodynamic drag from the standard **G7 drag table** scaled by the bullet's ballistic coefficient; drag acts on the bullet's velocity *relative to the air*, which is how wind drift arises.
- Air density from a standard atmosphere adjusted by map temperature/altitude (desert: hot, so slightly thinner air).
- Wind: a 3D vector field that can vary by position along the path (layers/zones) and over time (gusts).
- Optional later: spin drift and Coriolis (small effects; only matter at 1000 m+; Hard mode only).

### 6.2 Validation

The in-game solver must agree with an established ballistics library ([js-ballistics](https://github.com/o-murphy/js-ballistics), G7) within ~2% on drop and drift at 100–1500 m for both rifles. This is checked by automated tests, not in the game itself. **The rifle data in §5.5 plus js-ballistics are the authority**; the values below are rough sanity guides only and are not used as test targets. Tests run under two pinned air conditions: ICAO standard air (15 °C, sea level) and the map's desert air (≈38 °C).

Rough sanity values at 800 m (100 m zero, 10 mph full-value crosswind, spin drift off):

| Load | Air | Time of flight | Drop | Drift |
|---|---|---|---|---|
| .308 | standard | ≈1.47 s | ≈7.5 m | ≈2.0 m |
| .308 | desert (38 °C) | ≈1.41 s | ≈7.0 m | ≈1.8 m |
| .338 Lapua | standard | ≈1.14 s | ≈4.7 m | ≈1.1 m |

The .308 goes subsonic at roughly 880–900 m; missions past ~900 m are designed around the .338 (builder's note, my call).

### 6.3 In-flight behavior

- The bullet is a real moving object in the world for its whole flight (not resolved instantly), so enemies can move during the time of flight and leading moving targets matters.
- Hit detection: each simulation step tests the line segment from the previous to the current bullet position against target hit zones and terrain (swept test, no tunneling).
- The simulation is deterministic (enemy movement and wind gusts are seeded), so the whole flight can be pre-simulated at the moment of firing — this is how the bullet cam knows a shot will hit.
- Impact on terrain spawns a dust puff and a sound at the impact point (delayed by the sound's travel time to the player).

## 7. Presentation

### 7.1 Visual style

Stylized-realistic: realistic lighting, sky, atmospheric haze and terrain; simple low-poly characters, buildings, vehicles and props.

### 7.2 The desert map

- Size ≈ 3 km × 3 km so 1200 m+ shots are possible with terrain beyond.
- Dunes, rock outcrops, a wadi (dry riverbed), a small compound/village, a road, a few vehicles. Terrain features double as range markers on Hard.
- Wind indicators placed around the map: flags, windsock, dust devils, bushes.
- Heat mirage visible in the scope; its lean shows wind direction (a key cue on Hard).
- Time of day: one fixed lighting setup for v1 (e.g. late afternoon).

### 7.3 Long-range rendering requirements

- No visible flicker at distance (use a logarithmic depth buffer or an equivalent technique).
- Terrain with level of detail: full detail near the player and around target areas, coarser further away; horizon never shows a hard edge (fog/haze hides it).
- Targets at 1200 m must be clearly visible and identifiable in the scope at max magnification.

### 7.4 Scope

- Entering the scope: smooth transition, black vignette around a circular view.
- Reticle: MRAD-based (mil-dot or hash-mark ladder) so holds are physically correct at any range; reticle marks drawn in code (not from a generated image, so mil spacing is exact) as an overlay, scaled correctly with magnification (first focal plane behaviour).
- Sway: slow figure-eight drift plus heartbeat pulse; breath hold reduces it.
- Turret readout (elevation/windage in mils) shown in the scope corner when used.

### 7.5 Bullet cam

- Setting: On / Off (default On).
- When on and the shot is going to hit a target, the camera follows the bullet in slow motion, then returns to the scope.
- Misses always stay in the scope view (the player watches the dust).

### 7.6 Audio

- Rifle shot, bolt cycle, breath, heartbeat while scoped.
- Distance-correct timing: impact sound and the target area's reaction arrive delayed; the enemies hear the shot's report after it travels to them.
- Ambient desert wind, its loudness following the wind speed.

### 7.7 UI

- Main menu, mission select (with stars), settings (difficulty, bullet cam, mouse sensitivity, volume), pause, mission brief, mission result.
- HUD varies by difficulty (§5.3).

## 8. Technology (decided)

| Area | Choice |
|---|---|
| Language / build | TypeScript + Vite; output is a static site |
| 3D | Three.js |
| Ballistics | Own small solver (§6) in TypeScript; js-ballistics used only in tests as the reference |
| Hit detection | Swept segment tests; three-mesh-bvh for terrain/mesh intersection |
| Physics engine | None for v1 (Rapier only if ragdolls/props are added later) |
| Audio | Web Audio API |
| 2D art (sky, terrain textures, scope housing/vignette decoration, UI, icons) | Generated with Codex CLI image generation (the reticle's measuring marks are drawn in code) |
| 3D models | Free CC0 packs (e.g. Quaternius, Kenney) for characters/buildings/props; Poly Haven for HDRI sky/textures where useful |
| Hosting | Any static host (e.g. GitHub Pages, Vercel) |

## 9. Delivery stages

Each stage ends with something playable.

1. **One shot**: flat-ish desert terrain, one static target at a chosen distance, naked-eye + scope, correct ballistics with constant wind, dust on miss, hit feedback. Ballistics tests passing against js-ballistics.
2. **The real map**: full 3 km desert terrain, haze, mirage, wind indicators, long-range rendering requirements met.
3. **Living targets**: animated enemies on patrol routes, hit zones, alert behaviour.
4. **Game structure**: missions (patrol + HVT), progression, scoring, menus, difficulty levels, settings.
5. **Polish**: bullet cam, full audio, sway/breath, turrets, second rifle, art pass with Codex-generated assets.

## 10. Left to the builder

- Code architecture, file layout, state management.
- Exact numerical integration method and time step, as long as §6.2 validation passes.
- Exact asset packs, as long as they are CC0/permissive and fit the style.
- Exact mission list content and tuning numbers (sway amounts, alert radius, score values).
- How the Codex image prompts are written and post-processed.
- Testing approach beyond the ballistics validation.

---

# Addendum A — Mission setup (stage 1b)

Date: 2026-11-01. Requested by the user after playing stage 1; approved ("go").

## A.1 Intent

Before each mission the player configures it on a **start menu**: theme, range band, number of targets, wind, rifle, and how many buildings and vehicles. Buildings and vehicles are **real cover** (they stop bullets), some soldiers stand partly behind cover, and some targets can be **vehicles** (disabled by hitting the engine). The mission ends when every target is down, with a results screen.

## A.2 Start menu

| Setting | Values | Default |
|---|---|---|
| Theme | Desert, Arctic, Green valley | Desert |
| Range band | min and max, each 100–1500 m (min ≤ max; equal = all at one range) | 600–1000 m |
| Soldiers | 1–10 | 3 |
| Vehicle targets | 0–3 | 0 |
| Wind speed | 0–12 m/s | 4.5 m/s |
| Wind direction | clock position 1–12 (12 = from downrange/headwind, 3 = from the right, 6 = from behind, 9 = from the left) | 9 |
| Rifle | .308 Win, .338 Lapua Magnum | .308 |
| Buildings | none / few / many | few |
| Scenery vehicles | none / few / many | few |
| Random mission | one button: randomises every setting | — |

A **Start** button launches the mission. The mission's settings (plus a random seed) are carried in the page URL, so **Restart** reloads the same mission and a mission link can be shared. With no mission in the URL the menu is shown. The old `?range=…` URL still works (single target, used by the smoke check).

## A.3 Themes

Each theme sets the look **and the air** the ballistics uses:

| Theme | Terrain | Air (temperature, pressure) | Look |
|---|---|---|---|
| Desert | sand dunes, rock outcrops | 38 °C, 1013.25 hPa | warm late-afternoon light, heat haze |
| Arctic | snowfields, gentle drifts, dark rocks | −15 °C, 1013.25 hPa | cold blue-white light, thicker haze |
| Green valley | grass, rolling hills, rock | 18 °C, 900 hPa (altitude) | clear air, green-brown palette |

Terrain textures (snow, grass) are generated with Codex like the sand texture. Each menu theme card shows a Codex-generated preview image.

## A.4 Targets, buildings and vehicles

- Soldiers stand at distances spread across the range band, and within ±10° left/right of straight downrange. Every soldier's head and upper torso are visible from the shooter's position (clear line of sight past terrain and props).
- When buildings or vehicles exist, about 40 % of soldiers stand partly behind low cover (a wall or a vehicle) so only the upper body shows.
- Buildings: low-poly houses, compound walls (low, ~1.2 m) and sheds/tents, coloured per theme. Scenery vehicles: low-poly truck and jeep. Counts: none = 0; few ≈ 3–5 buildings / 2–3 vehicles; many ≈ 8–12 buildings / 5–7 vehicles.
- **Cover**: every building, wall and vehicle body stops bullets. Walls raise dust; vehicles throw sparks. A bullet stopped by cover is a miss.
- **Vehicle targets**: a vehicle with an engine block hit zone. A hit on the engine disables it (smoke column) and counts as a target down; hits elsewhere on the vehicle are stopped by its metal body.
- Mission layout (positions of everything) is generated from the seed, so the same seed gives the same mission.

## A.5 In-mission HUD and results

- HUD shows targets remaining, wind (speed + clock direction), magnification, rounds, sound, and a **rangefinder** reading: the distance to whatever is under the crosshair (terrain, prop or target).
- When all targets are down: results screen with shots fired, hits, accuracy, headshots, longest hit, mission time; buttons **Restart** and **Menu**.

## A.6 Non-goals for this step

Difficulty levels, moving/alerting enemies, high-value-target objectives, mobile controls, more themes.

---

# Addendum B — Merge of the ChatGPT branch (stage 1c)

Date: 2026-11-02. The user developed a parallel version with ChatGPT (commit 497a2b3 on `stage-1`) and asked to merge both. Base = stage 1b (menu, themes, multi-target layout, cover, results); every ChatGPT feature is ported into it. Source for each feature: `git show 497a2b3:<path>`.

## B.1 Realistic look (from ChatGPT, extended to all themes)
- Real-time sun shadows (`renderer.shadowMap`, PCF) from a directional light whose shadow box follows where the player is looking (aim point when scoped, near field otherwise).
- Terrain material: `MeshStandardMaterial` with a procedural bump relief, slope/height-based rock tint, and world-space geological mottling (ChatGPT's `onBeforeCompile` shader) — tuned per theme (sand / snow / grass).
- High valley walls: eroded ridgelines (55–250 m) enclosing the battlefield on both sides — kept strictly OUTSIDE the engagement sector so no line of sight to any target is ever blocked.
- Instanced ground detail (pebbles/stones; per-theme colours; grass tufts in the valley theme) off the target lane.
- Smoother soldier dummies (rounded boxes, capsules, goggles, scarf); hit spheres unchanged.

## B.2 Firing positions
Menu choice: **Valley floor** (eye ≈ 1.5 m + 0.4), **Rocky ridge** (12 m, current), **Mountain overlook** (85 m — a steep rocky spur, pronounced downhill shots). The terrain field builds the chosen landform; all line-of-sight and cover guarantees hold for every position.

## B.3 First-person rifle and suppressor
- Visible first-person rifle model (ChatGPT `FirstPersonRifle`: .308 olive stock / .338 sand chassis), hidden in the scope; recoil kick, muzzle flash, bolt/reload motion.
- Menu option **Suppressor**: quieter, filtered shot sound, no flash, and enemies detect you more slowly.

## B.4 Enemy snipers (fights back)
- Menu: **Enemy snipers 0–3** (0 = training, no incoming fire). Snipers are extra targets placed by the seeded layout — prone on rooftops, on ridges at the band, or in the open — always with a clear line of sight to the player (they must be findable).
- Each sniper sweeps a scope; its **glint** is visible when it looks toward you and steady once you are detected.
- **Detection** (0–100 %): rises a lot with each unsuppressed shot (+35), a little with suppressed shots (+9), slowly while exposed, and falls while in cover. At ≥ 65 % snipers fire at you every 4 s (−18 health when exposed) and a bombardment is called every 12 s with a 4 s warning (−45 exposed / −5 in cover).
- **Cover (C)**: duck behind your position (screen shows cover; you can't shoot). **Health 100**; at 0 the mission fails (results screen "Mission failed").
- Mission complete = all targets (soldiers, vehicle targets, snipers) down.

## B.5 Aim assists (training aids)
Menu option **Aim assists** (off by default). When enabled, HUD buttons: **T** trajectory preview line, **A** assisted-aim marker (where to aim to hit the selected target, computed from the real trajectory), **P** spotter calls ("hold 1.2 mil high, 0.4 right"). Results show "assists used" when any was on.

## B.6 Menu & HUD
Our menu gains the new controls (firing position, suppressor, enemy snipers, aim assists); ChatGPT's rifle concept art is used in the rifle panel. HUD adopts ChatGPT's panel styling; threat panel (exposed/cover, health, detection, snipers left, incoming fire countdown), damage flash, cover mask.

---

# Addendum C — Realism pass (stage 1d)

Date: 2026-11-02. From a screenshot audit of the merged game (user: "check the graphics you should enhance" → "go implement"). All new art is CC0 from Poly Haven (`public/assets/`, credited in `public/assets/CREDITS.md`): 1k PBR textures (rock/cliff, sand, snow, grass-rock, clay plaster, white plaster, planks, painted metal), 2k HDRI skies (desert late afternoon, arctic overcast snow field, valley partly cloudy), simplified glTF models (2 boulders, dead tree, grass clump; meshopt-compressed).

## C.1 Terrain
Photographic PBR materials blended by slope and height (triplanar on steep faces so walls and the mountain spur read as rock cliffs), macro variation so mid/far ground is not a flat colour, snow caps on high ground (arctic, valley), and baked sun shadowing / ambient occlusion so the walls shade the valley.
## C.2 Sky and light
HDRI sky per theme as background and image-based lighting; sun direction and fog colour matched to the HDRI; tone mapping/exposure per theme; light post-processing (subtle bloom for sun and scope glints, colour grading). Scope image stays crisp.
## C.3 Buildings and vehicles
PBR textures (plaster, planks, painted metal) with world-scale UVs; window and door frames, roof parapets and edges, small rooftop details — decorations stay within 3 cm of the colliders (or below ground), as before.
## C.4 Vegetation, rocks and the firing nest
Trees (procedural low-poly firs in arctic/valley; dead trees in the desert), boulders and shrubs on the slopes and around compounds — never inside the engagement sector lines of sight to any target or sniper; grass clumps near the player in the valley. A firing nest at every position: sandbags and rocks around the shooter, leaving the forward field of view clear.
## C.5 Rifle
PBR finish (metal, polymer), a glass scope lens with reflections, gloved hands holding the rifle.
