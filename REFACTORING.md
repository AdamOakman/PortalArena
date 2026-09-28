# Refactoring plan: split `game.js` into modules

**Goal.** Break the 1,020-line `game.js` into small, single-purpose ES modules with
explicit dependencies, while keeping the project **zero-build** (open
`index.html`, three.js from CDN) and **behavior-identical** (same controls,
sounds, DOM ids, visuals, map layouts).

---

## 1. Current state

| Block | Lines | Notes |
|---|---|---|
| Loader | 17–40 | `boot()`: ESM import of three@0.160 → UMD fallback chain → `showFatal`. Module-scope self-call guarded by `typeof window`. |
| Utils | 43–58 | `hashSeed`, `mulberry32` (pure) |
| Map generation | 60–178 | `generateMap(seed)` — pure data, the **only** export. Returns `{seed, slabs, pillars, rings, lamps, hints, spawn, exit}`. |
| `start(ns)` closure | 185–1020 | Everything else. One function, ~835 lines, all shared state by closure capture. |

Inside `start(ns)`, by section:

| Section | Lines | Shared state it owns/uses |
|---|---|---|
| Renderer / scene / camera / lights / env map | 189–230 | `renderer`, `scene`, `camera`, `baseFov` |
| Sky dome, stars, abyss floor | 231–265 | `skyGroup`, `gridTexture` |
| Audio | 267–279 | `ac`, `muted`, `tone()` |
| Textures | 281–310 | `gridTexture()`, `makeSlabMat()` |
| World build | 312–388 | `worldGroup`, `obbs`, `exitPos`, `spawnPt`, `hintZones`, `ringMeshes`, `beacon` |
| Player config + input + menu wiring | 390–475 | `CFG`, `pl`, `autohop`, `started`, `won`, `nowT`, `runTime`, `timerOn`, `portalsFired`, `keys`, `pointerLocked`, all DOM listeners & buttons |
| Portals | 477–608 | `PORT`, `portals[2]`, meshes+lights, `frameFor`, `R_AB`/`R_BA`, `updatePair`, `tryPlace`, `raycast`, `firePortal` |
| Movement / collision / teleport | 610–780 | `wishDir`, `accelerate`, `applyFriction`, `physStep`, `capsuleSamples`, `collide`, `teleportCheck`, `doTeleport`, `respawn`, `landingThump`, `tpGrace*` |
| Gun model | 782–810 | `gun`, `muzzleT`, `muzzleFlash` |
| Portal rendering | 812–888 | `rts`, `rtParity`, `makeRTs`, `clipPlane`, `vcam`, `rig`, `renderPortalViews`, `parkClip`, `placePortalVisuals` |
| Map loading | 890–914 | `currentSeed`, `loadMap`, `newMap` |
| HUD | 916–954 | DOM refs, `lastHintMsg`, `updateHUD` (contains the win check) |
| Main loop / resize | 956–1019 | `last`, `frame`, resize handler, initial `loadMap` + `rAF` |

**Cross-dependencies (instance level, today via closure):**
- `collide` punches portal holes → needs portals; `teleportCheck`/`doTeleport` → need pair matrices `R_AB/R_BA` + `PORT`.
- `raycast` → needs `world.obbs`. `firePortal` → needs camera, sfx, gun flash.
- `renderPortalViews` → needs portal meshes/uniforms, camera, `baseFov`, renderer, scene.
- `updateHUD` → needs player, world (exit/hints), portals (placed state + raycast for aim ring), camera, session timer, sfx (win fanfare).
- `loadMap` → resets world, portals, player, HUD, panels.
- Nothing is import-circular; all coupling is shared-closure state. That is the whole problem.

**Repo state:** no git. Plan starts with `git init` so every phase is a committable,
diff-able step.

---

## 2. Constraints & principles

1. **Zero build.** Plain ES modules; `index.html` keeps `<script type="module" src="./game.js">` unchanged. No bundler, no TS.
2. **Behavior-identical.** Same DOM ids, keys, sounds, FOV curve, physics constants, map generation (including the deliberately unseeded `Math.random()` in decor ring rotation — see §6).
3. **Explicit dependency injection.** Each class receives what it uses in its constructor. No global mutable context object; one small indirection for the three.js namespace (needed because of the ESM-vs-UMD loader).
4. **No per-frame allocations introduced.** Keep the existing scratch-vector style; module-level scratch vectors are fine.
5. **One phase = one committable, verified step.** After every phase the game must run unchanged in the browser.

### The three.js indirection

The loader can hand us either a module namespace (ESM path) or `window.THREE`
(UMD fallback). One file solves it for all modules:

```js
// src/three.js
let ns = null;
export function bindTH(n) { ns = n; }
export function getTH() {
  if (!ns) throw new Error('three.js not bound — call bindTH() first');
  return ns;
}
```

`game.js` calls `bindTH(ns)` as the first line of `start()`. Every other module
does `const TH = getTH()` **inside constructors/methods** (module top level runs
at import time, before binding — never at module scope).

---

## 3. Target structure

```
index.html             unchanged
game.js                ~230 lines  loader + composition root + session state + main loop
src/
  three.js             ~12         bindTH / getTH
  rng.js               ~18         hashSeed, mulberry32
  mapgen.js            ~120        generateMap (pure data, exported)
  constants.js         ~15         CFG, PORT, portal colors (0x2eeaff / 0xff9a3d)
  audio.js             ~30         Sfx
  textures.js          ~35         gridTexture, makeSlabMat
  environment.js       ~75         lights, PMREM env, sky dome, stars, abyss floor
  world.js             ~100        World
  portals.js           ~130        Portals
  portalRender.js      ~90         PortalRender
  player.js            ~150        Player
  gun.js               ~35         Gun
  hud.js               ~60         Hud
  input.js             ~110        Input
test/
  mapgen.test.mjs      ~50         node --test: determinism + invariants
```

Import graph (all acyclic): `game.js` → everything; `mapgen.js` → `rng.js`;
`world.js`, `environment.js` → `textures.js`, `three.js`; `portals.js`,
`player.js`, `portalRender.js`, `gun.js`, `hud.js` → `three.js`,
`constants.js`; `input.js` → nothing (pure DOM).

### Module APIs

```js
// src/rng.js
export function hashSeed(str)
export function mulberry32(a)

// src/mapgen.js
import { hashSeed, mulberry32 } from './rng.js';
export function generateMap(seedStr)   // unchanged signature & output shape

// src/constants.js
export const CFG = { G:24, R:0.34, H:1.7, GMAX:7.6, WALK:3.4, AIRCAP:42,
                     AACC:12, GACC:60, FR:7, JUMPV:8.6, COYOTE:0.09, BUFFER:0.11 };
export const PORT = { hw: 0.85, hh: 1.15 };
export const PORTAL_COLORS = [0x2eeaff, 0xff9a3d];

// src/audio.js
export class Sfx {
  constructor()            // lazy AudioContext (ensure())
  ensure()
  tone(f0, f1, dur, type='sine', vol=0.12, when=0)
  setMuted(b); toggleMute(); muted
}

// src/textures.js   (functions, not a class — stateless factories)
export function gridTexture(TH, base, line, glow, alpha)
export function makeSlabMat(TH, kind)   // { mat, edge }

// src/environment.js
export function buildEnvironment(TH, renderer, scene)
  // adds: hemisphere/sun/rim/ambient lights, PMREM env scene,
  // sky dome + stars (skyGroup), abyss floor. Returns nothing; scene-owned.

// src/world.js
export class World {
  constructor(TH, scene, textures)
  group                // TH.Group, rebuilt per map
  obbs                 // [{c,he,ax,rad}]
  exitPos, spawnPt     // V3
  hintZones            // [{min,max,msg}] V3
  ringMeshes           // spinning decorative tori
  beacon               // {ring, ring2, beam}
  clear()              // dispose group + materials (old clearWorld)
  build(map)           // slabs + decor + exit fx; sets all state above
  spinDecor(dt)        // old per-frame ring rotation (was in frame())
  pulseBeacon(now)     // old per-frame beacon pulse
}

// src/portals.js
export class Portals {
  constructor(TH, scene, world, sfx)
  items                // [{placed,c,n,r,u,color}]
  R_AB, R_BA           // pair transform matrices (updated on placement)
  fire(pi, camPos, camDir)   // raycast + tryPlace; returns bool; plays sfx
  tryPlace(pi, hit)
  raycast(origin, dir, maxDist)
  frameFor(n)
  updatePair()
  reset()              // placed=false for both (used by loadMap)
}
// Portal meshes (quads/shader mats/frames/glow lights) stay in this module:
// built in constructor, positioned by PortalRender.placeVisuals().

// src/portalRender.js
export class PortalRender {
  constructor(TH, renderer, scene, camera, portals)
  resize()             // rebuild RTs (old makeRTs)
  placeVisuals()       // position quad/frame/light from portal state
  render(baseFov)      // ping-pong passes, clip plane, uTex/uTime updates
}

// src/player.js
export class Player {
  constructor(TH, sfx, world, portals, onTeleport, onRespawn)
  pos, vel, yaw, pitch, grounded, cp, maxSpeed
  landingThump         // read by game loop for camera dip
  step(dt, nowT, keys, autohop)   // old physStep: input→friction→jump→integrate→collide→teleport
  collide()            // capsule vs OBB, portal-hole punch, landing thump
  teleportCheck(prevHeights)      // grace logic internal
  doTeleport(R, P, Q, si)         // calls onTeleport()
  respawn()            // → onRespawn()
}

// src/gun.js
export class Gun {
  constructor(TH, camera)   // builds model, attaches to camera
  flash(pi)                 // muzzle color
  update(dt)                // recoil decay
}

// src/hud.js
export class Hud {
  constructor(TH, sfx, onWin)   // caches all HUD DOM ids
  update(dt, { camera, player, world, portals, session })
    // speed bar, exit distance + compass, timer, hint zones,
    // aim ring (via portals.raycast), win check → onWin(stats)
  flashTeleport()          // #flash re-trigger
}

// src/input.js
export class Input {
  constructor(canvas, { onLook, onFire, onAction, onLockChange, onMenu, sfx })
  keys                   // e.code → bool
  pointerLocked
  attach() / detach()
}
// onAction(action) for: 'V' 'F' 'R' 'M' '[' ']'
// onMenu(event) for button events: start/resume/newmap/again/same/hop/mute/fs
//   + fov slider input (value passed with the event)

// game.js (composition root)
import { bindTH } from './src/three.js';
import { generateMap } from './src/mapgen.js';   // re-export for test/back-compat
...
function start(ns) {
  bindTH(ns);
  // renderer, scene, camera, baseFov
  buildEnvironment(...);
  const world = new World(...), portals = new Portals(...),
        player = new Player(...), gun = new Gun(...),
        portalRender = new PortalRender(...), hud = new Hud(...);
  const input = new Input(canvas, {...});
  const session = { started, won, nowT, runTime, timerOn, portalsFired,
                    autohop: true, pointerLocked: false, currentSeed: '' };
  function loadMap(seedStr) { ... }   // orchestrates world/portals/player/hud
  function frame(now) { ... }         // same flow as today, calling the classes
  // resize handler, initial loadMap, rAF
}
```

### State ownership table (every closure variable → new owner)

| Closure variable | New owner |
|---|---|
| `TH`, `V3`, `M4` | `src/three.js` (`bindTH`/`getTH`); each class captures `TH` in its constructor |
| `canvas`, `renderer`, `scene`, `camera`, `baseFov` | `game.js` (passed to constructors) |
| `skyGroup` | `environment.js` (internal) |
| `worldGroup`, `obbs`, `exitPos`, `spawnPt`, `hintZones`, `ringMeshes`, `beacon` | `World` |
| `clearWorld`, `addSlabRec`, `buildExitFx`, `buildDecor` | `World` methods |
| `ac`, `muted`, `ensureAudio`, `tone` | `Sfx` |
| `gridTexture`, `makeSlabMat` | `textures.js` (TH passed as arg) |
| `CFG`, `PORT` | `constants.js` |
| `pl` | `Player` |
| `autohop`, `started`, `won`, `nowT`, `runTime`, `timerOn`, `portalsFired`, `currentSeed` | `session` object owned by `game.js`, passed by reference to `Player.step`, `Hud.update`, `Input` callbacks |
| `keys`, `pointerLocked` | `Input` (lock state mirrored to `session.pointerLocked` via `onLockChange`) |
| `requestLock`, `toggleFullscreen`, `setFov`, `sync*Btn` | `Input` (+ `onAction`/`onMenu` callbacks reach `game.js`) |
| `portals[2]`, `frameFor`, `R_AB`, `R_BA`, `updatePair`, `tryPlace` | `Portals` |
| portal meshes/lights, `portalShaderMat` | `Portals` (positioned by `PortalRender`) |
| `raycast`, `firePortal` | `Portals.raycast` / `Portals.fire` |
| `wishDir`, `accelerate`, `applyFriction`, `physStep`, `capsuleSamples`, `collide`, `teleportCheck`, `doTeleport`, `respawn`, `landingThump`, `tpGrace*` | `Player` |
| `gun`, `muzzleT`, `muzzleFlash` | `Gun` |
| `rts`, `rtParity`, `makeRTs`, `clipPlane`, `vcam`, `rig`, `renderPortalViews`, `parkClip`, `placePortalVisuals` | `PortalRender` |
| `loadMap`, `newMap` | `game.js` |
| HUD DOM refs, `lastHintMsg`, `updateHUD` (incl. win check) | `Hud` (win fanfare via `Sfx`, panel via `onWin`) |
| `last`, `frame`, resize handler | `game.js` |
| `boot`, `showFatal` | `game.js` (unchanged) |

---

## 4. Phased migration

Every phase ends with: `git commit` + the verification gate (§5). Phases are
ordered so each one is *mechanical* and independently revertible.

### Phase 0 — Baseline & safety net
1. `git init`; commit the current state.
2. Add `test/mapgen.test.mjs` run by `node --test` (Node ≥ 18; no deps):
   - `generateMap` is import-safe in Node (module-scope `boot()` call is
     `typeof window`-guarded — verify this first).
   - **Determinism:** `JSON.stringify(generateMap(s))` equal across two calls.
   - **Sensitivity:** different seeds → different slab data.
   - **Shape invariants:** `spawn`/`exit` finite; `slabs` non-empty; all `kind`
     ∈ {plat, ramp, wall, gantry}; `hints` non-empty with `msg`;
     **floor continuity:** union of floor-slab x-ranges (center y = −0.5,
     size y = 1.0) covers the whole corridor `[x0, endX]`.
3. Browser baseline with fixed seed `20260928`: screenshots of (a) menu
   preview, (b) fresh game, (c) two portals placed, (d) mid-teleport flash,
   (e) win panel; plus console dump of slab count / exit coords. Save to
   `baseline/` (gitignored or kept — decide at commit time).

### Phase 1 — Pure core (zero risk)
- Create `src/rng.js` (lines 43–58) and `src/mapgen.js` (lines 60–178,
  imports rng). `game.js` imports `generateMap`; keep
  `export { generateMap } from './src/mapgen.js'` in `game.js`.
- Point the Node test at `src/mapgen.js`.
- **Gate:** `node --test` green; browser: menu renders, start with
  `20260928` → same slab count as baseline; screenshot diff of (a)+(b) identical.

### Phase 2 — THREE-adjacent helpers
- `src/three.js` (bind), `src/audio.js` (`Sfx`), `src/textures.js`,
  `src/environment.js`. `start()` becomes: `bindTH(ns)` → construct `Sfx` →
  `buildEnvironment(...)`.
- **Gate:** browser smoke — visuals identical to baseline (same seed),
  all SFX audible (placement, jump, teleport, win), mute button works.

### Phase 3 — Domain classes (the real split)
- `src/constants.js`, then `World`, `Portals`, `Player`, `Gun`,
  `PortalRender`, `Hud`, `Input`, each per the API sketches above.
- `game.js` keeps only: loader, renderer/scene/camera construction, `session`,
  `loadMap`/`newMap`, `frame()`, resize. `frame()` flow is unchanged in
  order: idle-orbit → physics substeps (120 Hz) → checkpoint → portal
  uniforms → `placeVisuals` → `renderPortalViews` → gun update → camera
  follow (bob, thump, speed-FOV) → decor spin → beacon pulse →
  `hud.update` → main render.
- Wiring details that must be preserved exactly:
  - `firePortal` currently: raycast → miss tone / `portalsFired++` →
    `tryPlace` → `muzzleFlash`. New: `if (portals.fire(pi, pos, dir)) { gun.flash(pi); }`; `portalsFired++` stays on the game side (it feeds win stats).
  - `collide`'s `respawn(true)` call (arg unused today) → `onRespawn` →
    `player.respawn()` (sfx inside).
  - `doTeleport` flash DOM trigger → `onTeleport` → `hud.flashTeleport()`.
  - Key `M` toggles `sfx.muted` + HUD label (both via `Input` callbacks).
  - Win check: `Hud.update` detects exit proximity → `onWin(stats)` → game
    shows `#winpanel` with stats string (exact format preserved).
  - Resize: `renderer.setSize` + `camera.aspect` + `portalRender.resize()`.
- **Gate:** full scripted playthrough (§5).

### Phase 4 — Cleanup
- Delete leftover closure code; confirm `game.js` ≤ ~250 lines.
- Update README "Files" section to the new layout.
- Remove throwaway debug hooks (e.g. a temporary `window.__game` handle used
  during Phase 3 verification, if added).
- Final full verification (§5) + commit.

---

## 5. Verification

**Automated:** `node --test` (mapgen determinism + invariants) after every phase.

**Browser smoke (fixed seed `20260928`, scripted via the actual page):**
1. Menu: preview orbit renders; seed input accepts value; Start loads the map.
2. In-game vs baseline screenshots: identical layout at same camera poses.
3. Aim ring: cyan when aiming at a surface, red when aiming at sky.
4. Fire LMB then RMB at corridor walls: placement tones, frames + glow lights
   appear at correct orientation; overlap buzz when firing a second portal on
   the same spot.
5. Teleport: floor portal + opposite wall portal near spawn → walk through →
   flash fires, position jumps across, velocity rotated (observe speed change).
6. Movement: hold Space → bunnyhop; strafe-jump → speed bar goes hot past
   7.6 u/s; FOV widens with speed; `[` / `]` change FOV; Shift walk is slower.
7. `V` toggles autohop (button label + `#hopinf`), `M` mutes (audible +
   `#muteinf`), `F` fullscreen, `R` respawns at checkpoint, `N` regenerates
   map (new seed shown in `#seedinfo`), window resize → portal render
   unaffected.
8. Reach the exit pad → win panel with time / max speed / portals fired / seed.
9. UMD fallback path: reload with the ESM CDN blocked (devtools →
   block `unpkg.com`) → game still boots via the jsDelivr r128 fallback.

**Behavior-preservation note:** decor ring rotation/spin uses unseeded
`Math.random()` today, so per-load ring *orientations* already differ across
refreshes. Visual diffs therefore compare layout, not exact ring poses.

---

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Closure state under-specified → missing coupling after split | §3 ownership table maps **every** closure variable; each phase's constructor takes exactly the injected deps listed |
| THREE namespace indirection breaks the UMD fallback | `bindTH` accepts either namespace shape; UMD path explicitly tested (§5.9) |
| Construction-order bugs (e.g. portals before world) | `game.js` composes in the original top-to-bottom order; constructors only store refs, cross-calls happen at runtime after all exist |
| Behavior drift (off-by-one in a moved constant) | Constants move verbatim to `constants.js`; fixed-seed replay + scripted playthrough per phase |
| Per-frame allocation creep during the move | Keep scratch vectors module-local, as the closure does today; the 120 Hz substep loop must stay allocation-free of `new V3()` per call (the existing code allocates a few — preserve exactly, don't add) |
| `node --test` import side effects | `boot()` is `typeof window`-guarded — verify in Phase 0; if it leaks, guard the import path before any other phase |

## 7. Out of scope (possible follow-ups)

- Seeding the decor `Math.random()` from the map's RNG (changes behavior —
  deliberate exclusion here).
- Unit tests for `raycast`/capsule collision (worth adding once `Portals`/
  `Player` are modules — they'd then be importable without a browser).
- Replacing the CDN loader with a local three.js copy.
- Any tuning/feature work: the plan touches structure only.

## 8. Definition of done

- `index.html` unchanged; `game.js` ≤ ~250 lines; every `src/*` file ≤ ~150 lines.
- `node --test` green; §5 checklist passes against the Phase 0 baseline with seed `20260928`.
- README "Files" section updated; no dead code, no shims, no `TODO`s.
- Every phase is its own git commit; the whole refactor is revertible phase-by-phase.
