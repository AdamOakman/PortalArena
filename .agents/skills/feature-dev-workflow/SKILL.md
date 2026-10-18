---
name: feature-dev-workflow
description: Mandatory workflow whenever asked to develop a new feature or fix a bug in this repo. Run lint and build verification after code changes; static verification (lint + build) is the only gate (no smoke tests of any kind, no e2e/browser testing), and finish with a commit-message summary of all changes.
---

# Feature Development / Bug-Fix Workflow

Apply this workflow for **every** request to develop a feature or fix a bug in this repository.

## Architecture & Project Structure

- **Client**: Vite-based modular OOP application.
  - Root: `client/`
  - Build output: `dist/` (bundled via `npm run build`)
  - Subsystems:
    - `client/core/`: `GameEngine` (composition root), `EventBus` (pub/sub), `ObjectPool`
    - `client/entities/`: `Entity`, `EntityManager`, `PlayerController` (local player), `RemotePlayer`
    - `client/weapons/`: `Weapon`, `WeaponManager`, `PortalGun`, `RocketLauncher`, `InstagibRifle`
    - `client/projectiles/`: `RocketProjectile`
    - `client/portals/`: `PortalManager` (teleportation logic & recursive portal camera rendering)
    - `client/rendering/`: `RenderManager`, `TextureFactory`, `ModelFactory`
    - `client/world/`: `WorldManager` (map geometry, collision meshes, BSP/BVH)
    - `client/ui/`: `HUDController` (DOM-based HUD, crosshairs, leaderboards)
    - `client/audio/`: `AudioController` (positional audio, Web Audio API synthesis)
    - `client/network/`: `NetworkManager` (WebSocket client, message dispatch, snapshot interpolation)
    - `client/input/`: `InputManager` (keyboard, mouse, pointer lock)
    - `client/state/`: `StateMachine`, `MatchStateMachine`
- **Server**:
  - `server/server.js`: Node.js server serving static assets strictly from `dist/` and hosting WebSockets on port 3001.
  - `server/core/GameServer.js`: Server lifecycle & network synchronization.
  - `server/match/MatchSession.js`: Match state, timer, player registry, and scoring.
  - `server/bots/BotAgent.js`: Server-side bot navigation and combat AI.
- **Shared**:
  - `shared/constants.js`: Common game constants, physics values, and protocol packet types.

## Rules

1. **Verify after code changes (`lint` + `build`)**
   - After editing files (or a batch of related edits), run:
     ```bash
     npm run lint
     npm run build
     ```
     *(Note: On Windows PowerShell, execute via `cmd.exe /c "npm run lint"` and `cmd.exe /c "npm run build"` or `npm.cmd` to avoid PowerShell execution policy restrictions).*
   - Both commands must exit with code 0:
     - `npm run lint`: Validates code style and syntax across `client/`, `server/`, and `shared/`.
     - `npm run build`: Validates Vite ES module resolution, bundling, and asset pipelines into `dist/`.
   - If either command reports errors: fix them immediately, re-run, and only move on once both pass cleanly.
   - Never leave a known violation or build break behind.

2. **No smoke tests of any kind — static verification is the only gate**
   - `npm run lint` and `npm run build` are the **sole** verification gates for this workflow. Do not perform any runtime verification.
   - Do **not** run the app, launch servers/clients, exercise the UI, or interact with a running build to "check it works".
   - Do **not** write or run throwaway/scratch scripts, one-off test harnesses, or ad-hoc smoke checks.
   - Do **not** spin up browser-based end-to-end tests (no Playwright, Puppeteer, or manual browser sessions).
   - If a change is clean per `lint` and `build`, it is done — do not add extra verification to "be safe".

3. **Finish with a commit-message summary**
   - When the whole task is done (all changes made, lint and build passing), present a commit-message-style summary of the work:
     - **Title**: a short, imperative summary of the change (e.g. `Add portal cooldown indicator`).
     - **Body**: a detailed description of exactly what was changed — which files, which classes/methods, and why — so the summary can be used verbatim as a commit message.

## Example summary format

```
Fix portal cooldown desync between clients

- client/portals/PortalManager.js: reset cooldown timer on server snapshot to prevent
  stale cooldowns after reconnection
- shared/constants.js: add PORTAL_COOLDOWN_MS shared constant
- npm run lint passes clean
- npm run build passes clean
```
