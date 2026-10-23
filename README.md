# Portal Arena

A fast-paced browser multiplayer FPS combining Portal momentum physics with classic Quake/Warsow movement, recursive portal rendering, and destructible arenas.

## Features

- **Quake Movement**: Strafe-jumping, bunnyhopping, coyote time, and air-strafing with speed-dependent dynamic FOV and HUD speedometer.
- **Portal Mechanics**: Energy-conserving velocity transformation through portal pairs, seamless transition avatars, and recursive multi-depth portal views with frustum culling.
- **Weapon Arsenal**:
  - **Portal Gun**: Primary/secondary portals that stick to legal flat surfaces with alignment validation and cooldown gating.
  - **Rocket Launcher**: Explosive knockback impulses that blow holes through destructible arena walls.
  - **Instagib Railgun**: Hitscan beam weapon with scorch decals and instant frags.
- **Dynamic Arena**: Procedural 50 × 50 m gothic arena with high spawns, jump pads, interactive physics cubes, and lethal lava pools.
- **Multiplayer, Bots & Spectating**: Authoritative WebSocket server hosting 1v1 duel matches with round progression (Warmup, Countdown, Round, Summary), automatic AI bot fill, and freefly / POV / chase spectator modes.
- **Positional Audio**: Positional 3D audio synthesis via Web Audio API with spatial portal sound and weapon SFX.

## Quickstart

### 1. Install & Run
```bash
npm install
npm start
```
Open [http://localhost:3001](http://localhost:3001). `npm start` automatically builds `dist/` and runs the integrated server.

### 2. Development Commands
- `npm run dev` — Launch Vite with instant Hot Module Replacement (client only)
- `npm run server` — Run WebSocket & static server without rebuilding
- `npm run verify` — Run parallel verification suite (`test`, `lint`, `build`, `knip`)
- `npm test` — Run fast headless Node.js unit tests (`node:test`)

## Controls

| Key | Action |
|---|---|
| **Mouse** | Aim / Look (click to lock cursor) |
| **WASD** | Move (air-strafe capable) |
| **Space** | Jump / Bunnyhop (hold on landing) |
| **1 / 2 / 3** | Equip Portal Gun / Rocket Launcher / Instagib |
| **LMB / RMB** | Primary / Secondary Portal (or Fire Weapon) |
| **RMB / Shift / Z** | Zoom scope |
| **E** | Pick up / throw physics cube |
| **C / Ctrl** | Crouch |
| **R** | Ready up (warmup phase) |
| **Tab** | Match stats & scoreboard |
| **F / ESC / M** | Fullscreen / Pause Menu / Mute |

## Project Structure

- `client/` — Vite-based modular OOP frontend:
  - `core/` — `PortalClient` entry, `GameEngine` loop, `EventBus`, and `ObjectPool`
  - `entities/` — Local `PlayerController` (movement & view), `RemotePlayer`, and `EntityManager`
  - `portals/` — `PortalManager` (placement, pair transforms, recursive camera rendering, transition avatars)
  - `weapons/` & `projectiles/` — Strategy-based weapon classes (`PortalGun`, `RocketLauncher`, `InstagibRifle`, `RocketProjectile`)
  - `rendering/` & `world/` — `RenderManager`, procedural asset/model factories, and `WorldManager` (mapgen & OBB colliders)
  - `ui/`, `audio/`, `network/` — DOM HUD, Web Audio synth, and WebSocket client
- `server/` — Node.js authoritative duel backend:
  - `core/GameServer.js` — WebSocket orchestration, snapshot sync, and game loop
  - `match/MatchSession.js` — Match state machine, duel round timers, and scoring
  - `bots/BotAgent.js` — AI combat bots with pathing, strafing, and portal navigation
- `shared/` — Deterministic physics constants, Quake movement math, and mapgen
- `test/unit/` — Headless Node.js unit tests (`node:test`) for physics, portals, weapons, and state machines

## AI Tooling

Designed and developed with LLM assistance:
- **Qwen3.8-Flash-Next** & **Qwen3.8-27B** — Initial prototypes, features, and mapgen
- **Gemini 3.8 Flash** & **Gemini 3.1 Pro** — Gameplay mechanics, bug fixes, and test suites
- **Claude Sonnet/Opus 4.6** — Architecture refactoring, OOP modularization, and recursive portal rendering
