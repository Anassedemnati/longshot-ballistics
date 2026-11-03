# Longshot Ballistics

**A long-range sniper simulator that runs in the browser. Every shot is a real ballistic solution.**

Read the wind, hold over for drop and make the shot at 300 to 1,500 m. Every bullet is flown through a G7 drag model and the air of the map you're on. It is not a hitscan ray. And the other side shoots back: a squad that runs for cover, returns fire and calls in mortars, and enemy snipers who spot you for them.

![Desert ridge, first-person view](docs/screenshots/desert-open.jpg)

| Through the 25x scope | Training aids |
|---|---|
| ![A soldier at 140 m through the scope](docs/screenshots/soldier-scope.jpg) | ![Trajectory arc, aim marker and spotter call](docs/screenshots/assists-aim.jpg) |
| **Green valley**, mountain position | **Arctic**, suppressed .338 |
| ![Green valley](docs/screenshots/valley-open.jpg) | ![Arctic](docs/screenshots/arctic-open.jpg) |

## Soldiers that fight back

Fire your first shot and the squad comes alive. They crouch, turn toward the sound and sprint for cover:

![A soldier sprinting for cover, rifle at port arms](docs/screenshots/squad-sprint.jpg)

From behind walls and vehicles they rise, shoulder their rifles, fire a burst and drop back down:

![Kneeling behind a wall to fire, then dropping back into cover](docs/screenshots/squad-cover.jpg)

Through your scope you see the muzzle flash of the man who is shooting at you:

![Return fire through the scope: rise, muzzle flash, drop](docs/screenshots/squad-return-fire.jpg)

- **They have to find you first.** Each of your shots tells them a little more (less with a suppressor or a ghillie suit), and so does every bullet that cracks past one of them and every man that goes down. At first their bursts land far away; once they have you, they land close and hurt while you are exposed.
- **An enemy sniper who has you in his scope calls your position to them.** Take him out first.
- **They move.** After a near miss, when a friend close by goes down, or just after a while in one spot, they sprint to new cover, so you have to hunt them.
- **Mortars.** Once they have you well enough they call them in: you get a four-second warning to get into cover (**C**).
- Switch it off in the menu for a classic static range; the **Soldiers** slider sets how many there are (1 to 10).

![The squad has found you: incoming rounds kick up dust, and a mortar is on its way](docs/screenshots/firefight.jpg)

## Hits that look like hits

Bodies are not planks that tip over. A hit soldier goes limp: a Verlet ragdoll on his skeleton, pushed by the bullet, folds at the knees and waist and settles on the real terrain. Where you hit him decides how he falls (a head shot drops him on the spot, a chest shot staggers him back, a leg shot drops him onto that side), and a man hit at a sprint tumbles forward. The bullet goes through: a puff at the entry, a mist out of the far side, and the round flies on, slower, to kick up dust behind him.

![A chest hit at 140 m: entry and exit, the bullet passes through, the legs give way, down](docs/screenshots/hit-sequence.jpg)

## Features

- **Real external ballistics**
  - A point-mass trajectory with G7 drag, integrated with RK4.
  - Air density and the speed of sound come from each map's temperature and pressure.
  - Bullet drop, wind drift and time of flight all emerge from the simulation; nothing is faked.
  - Checked against [js-ballistics](https://www.npmjs.com/package/js-ballistics) in the test suite.
- **Two rifles**
  - .308 Win: G7 BC 0.243 at 790 m/s.
  - .338 Lapua: G7 BC 0.322 at 900 m/s.
  - Each has an optional suppressor: no muzzle flash, a quieter report and slower detection.
- **5-25x scope** with a mil reticle, mouse-wheel zoom and a moving bolt. The picture is sharpened while you look through it, so a man at 600 m stays a man and not a smudge.
  - Sound travels at the speed of sound: at long range you hear the impact well after the shot.
- **Realistic enemies**: soldiers in camo with helmets, plate carriers, packs and rifles held in both hands; snipers prone in ghillie suits behind scoped rifles on bipods. Procedural models and textures, one draw call each.
- **Optional ghillie suit** (a switch in the menu)
  - While you hold fire the enemy cannot pick you out: lying still in plain view never builds more than 30 % detection.
  - Your sleeves wear the map's camouflage.
  - Your shots still give you away, though the muzzle report counts for less.

  ![Ghillie suit in the green valley: the enemy is still unaware](docs/screenshots/ghillie.jpg)
- **Enemy counter-snipers**
  - They start out unaware of you. Without a ghillie suit, a few seconds in the open is enough to make them search.
  - A shot gives you away twice: by the muzzle report, and by the crack and dust of the bullet, which point back at you when it ends near one of them. A suppressor only quiets the first.
  - Once they are searching their scopes narrow in on you and glint more often. Keep exposed and they find you, shoot back and call in bombardments.
  - They hide with some thought: every mission each one picks, from the spots that give him a clear shot at you, one that is well concealed (a backdrop behind him, hard cover close by, away from the soldiers, on a flank, sometimes a rooftop), so the hides change with the seed.
  - Press **C** to duck into cover.
- **Mission setup menu**
  - Three themes: desert, arctic and green valley.
  - A range band from 100 to 1,500 m.
  - 1 to 10 soldiers (that fight back, or stand still), vehicle targets, and 0 to 3 enemy snipers.
  - Wind speed and clock direction.
  - Firing position: valley floor, ridge or mountain top.
  - Density of buildings and scenery vehicles.
  - Every mission is a shareable URL.
- **Optional training aids** (toggled with T, A and P): a live trajectory arc, an aim-point marker, and a spotter who calls the hold in mils.
- **Realistic rendering**
  - HDRI skies with image-based lighting and a triplanar PBR terrain.
  - Baked sun and ambient occlusion, plus instanced vegetation.
  - Bloom and colour grading.
  - Real recorded sounds.
- **Fullscreen** with **F** or the button on the menu and in the game.
- **Runs on modest GPUs**
  - Quality levels and dynamic resolution.
  - About 120 draw calls in the busiest mission.

![Mission setup menu](docs/screenshots/menu.jpg)

## Quick start

You need Node 22 or later.

```bash
git clone https://github.com/Anassedemnati/longshot-ballistics.git
cd longshot-ballistics
npm install
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173), set up a mission and press **Start mission**.

## Controls

| Input | Action |
|---|---|
| Click | Take aim (locks the mouse) |
| Left click | Fire |
| Right click | Scope in / out |
| Mouse wheel | Zoom the scope |
| R | Reload |
| C | Duck into cover / come back up |
| T / A / P | Trajectory / aim marker / spotter (when training aids are on) |
| M | Mute |
| F | Fullscreen on / off (also a button on the start menu and in the in-game bar) |
| Esc | Release the mouse |

## URL options

| Parameter | Effect |
|---|---|
| `?m=v4.…` | A full mission, as written by the menu (the last two fields are the ghillie-suit flag and the soldiers-fight-back flag). Copy it to share a mission. Older `v3.…`, `v2.…` and `v1.…` links still open, with the newer options off (their soldiers stand still). |
| `?quality=auto\|high\|medium\|low` | Render quality. `auto` (the default) is `medium` plus dynamic resolution. |
| `?post=low` | The cheapest post-processing: no bloom, no MSAA. |
| `?debug=1` | Exposes `window.__game`: `aimAt`, `fire`, `toggleScope`, `zoom`, `state()` and more. Used by the tests. |

## Development

```bash
npm test         # unit tests (Vitest): ballistics, mission logic, encounter rules, models
npm run build    # type-check and production build into dist/
npm run smoke    # build, then drive the game in headless Chrome and check it end to end
```

`npm run smoke` needs a local Google Chrome; it drives it through `playwright-core`.

### Project layout

| Folder | What lives there |
|---|---|
| `src/ballistics/` | G7 drag table, atmosphere, RK4 integrator, rifle data and trajectory solver. Pure TypeScript, no three.js. |
| `src/game/` | Weapon state, bullets in flight, hit tests, rangefinder, aim assists, the enemy-sniper encounter, the soldiers' squad brain (`squad.ts`). |
| `src/mission/` | Mission config and URL codec, seeded layout of targets and props, the game loop (`run.ts`). |
| `src/scene/` | Terrain and its material, HDRI sky, post-processing, vegetation, buildings, vehicles, soldiers. |
| `src/player/` | First-person view, input, scope reticle and the procedural rifle model. |
| `src/audio/` | Web Audio engine, recorded clips and sound-delay maths. |
| `src/ui/` | Mission menu, HUD, threat bar, results screen. |
| `src/fx/` | Dust, sparks, smoke, blood mist and the enemies' muzzle flashes. |
| `tests/` | Vitest suites, mirroring `src/`. |
| `scripts/` | The headless smoke test and visual-check tools. |

Gameplay rules, terrain and layout are seeded and pure, so they unit-test in Node without WebGL.

## Contributing

Issues and pull requests are welcome. Some ideas:
- more scenarios (convoy ambush, high-value target, defend a position);
- animated vehicle models;
- spin drift and Coriolis;
- ragdolls that collide with cover;
- mobile and touch controls.

Run `npm test` and `npm run smoke` before you open a PR.

## Credits

- **Textures, HDRI skies and 3D models:** [Poly Haven](https://polyhaven.com), CC0. See [`public/assets/CREDITS.md`](public/assets/CREDITS.md).
- **Sounds:** the Free Firearm Sound Library and freesound.org contributors, all CC0. See [`public/sounds/CREDITS.md`](public/sounds/CREDITS.md).
- **AI-generated images:** the menu artwork and the rifle reference sheet. Their prompts are stored next to the files.
- **Libraries:** [three.js](https://threejs.org), [Vite](https://vite.dev) and [Vitest](https://vitest.dev).

## License

[MIT](LICENSE)
