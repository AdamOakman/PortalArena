# Portal Arena

A browser portal game with Portal-style momentum physics and Warsow/Quake movement, now with **2-player multiplayer support!** 

## Features

- **Multiplayer & Bot Support**: Jump in with a friend or practice against AI bots! When the server is empty or only one player is connected, bots automatically populate the arena to practice against. When a second human player joins, bots are replaced, and the duel gamestate resets back to warmup.
- **Momentum through portals**: Velocity is rotated by the portal-pair transform. Fall into a floor portal, exit a wall portal - your falling speed becomes sideways speed. Speed magnitude is preserved (energy-conserving, like Portal).
- **Portals stick to any flat face**: Floors, ceilings, vertical walls, and ramps of any angle - as long as the whole mouth fits on that one face. Shots that would clip a face edge, overlap an existing portal, or target a destroyed wall are refused (buzz sound). Portal gun placements have a 0.2s cooldown.
- **Nested portal views**: Portals render recursively — look through one portal and you see through another portal nested in that view (up to 3 levels deep); views too small on screen are culled automatically.
- **Strafe-jump / circle-jump acceleration**: Quake movement model. Ground friction, ground accel capped at run speed. *Air* acceleration with a very high cap applies only while a strafe key (A/D) is held — timing jumps and strafing builds speed far past run speed, while a straight W-only bunnyhop preserves speed with no free gains. The HUD bar goes hot/orange past run speed; FOV widens with speed.
- **Air-strafing**: the classic Quake accidental mechanic. Mid-air, release the forward key, hold A or D, and turn your mouse in that same direction — your flight path curves without losing momentum, so you can steer long jumps and bank around corners at full speed.
- **Grab and throw**: Interact with physics cubes scattered around the map. Pick them up and throw them through portals.
- **Rockets**: Switch to the rocket launcher to blast around — rockets blow holes in thin arena walls (boundary walls and corner towers are indestructible), launch players and bots with explosion knockback impulses, and portals anchored to a destroyed wall are cancelled automatically.
- **Portal & instagib audio FX**: three-part positional portal open/close sounds, an instagib shot sound emitted from the shooter, a zap where the beam strikes a wall, plus dark burnt scorch marks that stick to the hit surface for 30 s and fade out over 0.5 s — networked, so every player sees them, including through the portals. All rendered as stereo spatial audio with chamber reverb.
- **Kill feed & event log**: kills, player connects/disconnects, and other events appear in a top-right event log that fades out after a while.

## The Arena

Each match takes place in a procedurally generated 50 × 50 m gothic duel arena: towering walls, high-platform spawns, lava pools that kill on touch, and a night sky with a flat moon, stars, and drifting clouds.

## How to Play (Multiplayer)

The game consists of a Node.js authoritative server and a high-performance web client.

### 1. Install Dependencies
Run in the root directory:
```bash
npm install
```

### 2. Launch (One Unified Command)
Build the protected client bundle and launch the integrated server in a single step:
```bash
npm start
```
Open your browser and navigate to `http://localhost:3001`.
The command automatically builds `dist/`, serves the protected client, and coordinates the WebSocket duel arena on the same port!

### 3. Dedicated Modes (Optional)
- **Server Only (Fast restart without rebuilding):**
  ```bash
  npm run server
  ```
- **Client Development (Instant Hot Module Replacement):**
  ```bash
  npm run dev
  ```
- **Client Production Preview (Static build only):**
  ```bash
  npm run preview
  ```

### 4. Duel Rounds (Score System)

The game is a duel that runs in rounds:

1. **Waiting** — until at least two combatants (human or bot) are present, the top-center scoreboard displays `WAITING FOR OPPONENT`.
2. **Warmup (up to 1 minute)** — players can move and practice shooting freely. Press **R** to ready up. When both players are ready (or the warmup timer expires), the match initiates a countdown. Any walls destroyed during warmup and all placed portals are cleanly reset.
3. **Countdown (3, 2, 1, FIGHT!)** — a large animated countdown displays in the center of the screen with audio cues. Player movement and weapon firing are temporarily frozen while players aim and prepare.
4. **Round (5 minutes)** — players spawn into active duel positions and the round timer begins. Each instagib kill scores **+1** for the killer (+2 for portal frags; -1 for void/lava suicides), shown next to each player's name on either side of the timer.
5. **Summary** — when the round elapses, a panel declares the winner (most kills; equal kills = draw), showing each player's kill count and the cumulative rounds-won tally. **N** / *New Universe* or *Replay This Seed* starts the next round (new or same map) straight into warmup.

If a human player disconnects mid-round, the round is voided and the scores reset for the next one. Joining when an existing human is playing against a bot smoothly kicks the bot and resets to warmup.

## Controls

| Key | Action |
|---|---|
| Mouse | Look (click to capture pointer) |
| WASD | Move (yaw-relative, air-strafe capable) |
| Space | Jump - hold it and land to bunnyhop |
| 1 / 2 / 3 | Switch weapon (Portal Gun / Rocket Launcher / Instagib) |
| LMB / RMB | Fire Portal 1 / Portal 2 (or Shoot Rocket) |
| RMB (hold) | Zoom (Rocket / Instagib) |
| Z (hold) | Zoom (all weapons) |
| E | Grab / Drop physics cube |
| Shift | Walk (precise positioning) + Zoom (all weapons, left shift) |
| C / Ctrl | Crouch |
| F | Fullscreen |
| ESC | Pause Menu |
| [ ] | FOV +5 (starts at 115) |
| R | Ready up (warmup phase) |
| Tab | Stats board — players, ping, accuracy, score (hold) |
| N | New map |
| M | Mute |

## Project Structure & OOP Architecture

The codebase is organized into an Object-Oriented, modular architecture with secure production bundling and strict separation of concerns:

- `dist/` - Production build directory (only this folder is served statically to web clients, preventing server or repository code exposure)
- `server/` - Node.js authoritative server:
  - `server.js` - Integrated HTTP static asset server and WebSocket server entry point (port 3001)
  - `core/GameServer.js` - Server lifecycle management and network synchronization
  - `match/MatchSession.js` - Duel match state machine, round timers, player registry, and scoring
  - `bots/BotAgent.js` - AI bot navigation, state updates, combat behavior, and portal management
- `client/` - Web client:
  - `main.js` - `PortalClient`: Application orchestrator, composition root, loading screen coordination, and connection lifecycle
  - `core/` - Foundational subsystems:
    - `GameEngine.js` - Main animation frame loop coordinator and subsystem registry
    - `EventBus.js` - Publish-subscribe event bus for decoupled communication
    - `ObjectPool.js` - High-performance reusable object pool for particles and entities
  - `entities/` - Entity hierarchy:
    - `Entity.js` - Base game entity
    - `EntityManager.js` - Lifecycle, updates, and spatial queries
    - `PlayerController.js` - Local player movement, Quake/Warsow physics, and prediction
    - `RemotePlayer.js` - Network interpolation and remote player rendering
  - `weapons/` - Weapon Strategy pattern:
    - `Weapon.js` - Base weapon class
    - `WeaponManager.js` - Weapon slots, active switching, inventory, and weapon viewmodels
    - `PortalGun.js` - Primary and secondary portal placement strategy
    - `RocketLauncher.js` - Rocket firing, blast knockback, and wall destruction
    - `InstagibRifle.js` - Hitscan railgun strategy with scorch marks and audio FX
  - `projectiles/` - Dynamic physics projectiles:
    - `RocketProjectile.js` - Server/client rocket trajectory and impact handling
  - `portals/` - Portal mechanics:
    - `PortalManager.js` - Portal placement validation, pair transformations, teleportation, and recursive camera rendering
  - `world/` - Arena geography:
    - `WorldManager.js` - Procedural map builder, destructible wall meshes, and oriented bounding boxes (OBBs)
  - `rendering/` - Visual pipelines:
    - `RenderManager.js` - Three.js WebGL renderer, perspective camera, and skybox
    - `TextureFactory.js` - Procedural canvas textures and materials
    - `ModelFactory.js` - Procedural gun and player 3D models
  - `input/` - Hardware controls:
    - `InputManager.js` - Pointer lock capture, keyboard/mouse input bindings, and menu controls
  - `ui/` - Interface layer:
    - `HUDController.js` - DOM-based HUD, crosshairs, speedometer, killfeed, and tab stats
    - `LoadingScreen.js` - 3D gothic loading overlay with font and map readiness gating
  - `audio/` - Positional sound:
    - `AudioController.js` - Web Audio API spatial audio, portal sounds, and weapon SFX
  - `network/` - Multiplayer client:
    - `NetworkManager.js` - WebSocket client, snapshot interpolation, and message routing
  - `state/` - State machines:
    - `StateMachine.js` - Generic hierarchical state machine
    - `MatchStateMachine.js` - Client duel match states (waiting, warmup, countdown, round, summary)
- `shared/` - Shared deterministic logic:
  - `constants.js` - Protocol messages, physics constants, dimensions, and limits
  - `physics.js` - Shared deterministic Quake movement, friction, collision, and portal math
  - `mapgen.js` - Shared deterministic seed-based arena geometry generator

## Build & Verification Workflow

The project uses Vite 8 with Rolldown bundling and automated chunk splitting:
- `vite.config.js`: Separates the `three` runtime into a cached vendor chunk (`dist/assets/three-*.js`), keeping application bundles lean and load times fast.

When making modifications, always run static verification gates:
```bash
npm run lint
npm run build
npm run knip
```

- **`npm run lint`**: Validates syntax, module imports, and code style via ESLint across `client/`, `server/`, and `shared/`.
- **`npm run build`**: Validates Vite / Rolldown module resolution, asset pipelines, and production bundle generation into `dist/`.
- **`npm run knip`**: Validates that there are no unused files, dependencies, or exports.

All commands must exit with code 0 before code is considered complete.

## AI Tooling

This project was designed and built with LLM assistance:

- **Qwen3.8-Flash-Next** — the first outline of the project
- **Qwen3.8-27B** and **Gemini 3.8 Flash** — most of the development: adjustments and adding features
- **Gemini 3.1 Pro** and **Claude Sonnet/Opus 4.6** — architecture refactoring, OOP migration, Quake physics fidelity, and portal recursion


