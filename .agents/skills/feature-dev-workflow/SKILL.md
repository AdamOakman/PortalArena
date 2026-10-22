---
name: feature-dev-workflow
description: Mandatory workflow whenever asked to develop a new feature or fix a bug in this repo. Focus on minimal viable solutions, strong performance, and proactive reduction/removal of unnecessary surrounding code. Run parallel verification (npm run verify) running test, lint, build, and knip after code changes; fast verification is the only gate (no smoke tests of any kind, no e2e/browser testing), and finish with a commit-message summary of all changes.
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
- **Tests**:
  - `test/unit/`: Fast, headless Node.js unit tests (`node:test`) validating pure math, subsystem interface contracts, physics boundaries, and state machines.
- **Scripts**:
  - `scripts/verify.sh`: Parallel verification script executing `test`, `lint`, `build`, and `knip` concurrently and printing ordered logs on failure.

## Rules

1. **Verify after code changes (`npm run verify`)**
   - After editing files (or a batch of related edits), run:
     ```bash
     npm run verify
     ```
     *(Note: On Windows PowerShell, execute via `npm.cmd run verify` or `cmd.exe /c "npm run verify"` to avoid PowerShell execution policy restrictions).*
   - `npm run verify` runs all four checks in parallel and reports ordered results:
     - `test`: Validates pure math, angle normalization, cooldown mechanics, interface contracts, and regression tests via headless `node --test` in sub-second time.
     - `lint`: Validates code style and syntax across `client/`, `server/`, `shared/`, and `test/`.
     - `build`: Validates Vite ES module resolution, bundling, and asset pipelines into `dist/`.
     - `knip`: Validates that there are no unused files, dependencies, or exports.
   - Alternatively, individual checks can be run directly via `npm test`, `npm run lint`, `npm run build`, and `npm run knip`.
   - All checks must pass with exit code 0.
   - If any check reports errors: fix them immediately, re-run, and only move on once verification passes completely.
   - Never leave a known violation, build break, or dead/unused code behind.

2. **No smoke tests of any kind — verification suite is the only gate**
   - `npm run verify` (or the underlying `test`, `lint`, `build`, and `knip`) is the **sole** verification gate for this workflow. Do not perform any manual or browser runtime verification.
   - Do **not** run the app, launch servers/clients, exercise the UI, or interact with a running build to "check it works".
   - Do **not** write or run throwaway/scratch scripts, ad-hoc smoke checks, or manual playtesting.
   - Do **not** spin up browser-based end-to-end tests (no Playwright, Puppeteer, or manual browser sessions).
   - If `npm run verify` passes clean, it is done — do not add extra manual verification to "be safe".

3. **Minimal viable solution, strong performance focus & proactive code reduction**
   - **Minimal Viable Solution (MVS)**:
     - Implement the most direct, concise solution that satisfies the task requirements without overengineering.
     - Avoid speculative abstractions, unnecessary indirection layers, unneeded parameters, or unasked-for features.
     - Solve the exact problem cleanly with minimal code footprint.
   - **Strong Focus on Performance**:
     - Keep performance paramount across both client and server, especially in hot paths (per-frame animation loops, physics steps, raycasts, matrix math, rendering, and network synchronization).
     - Eliminate heap allocations and garbage collection overhead in tick loops: reuse scratch vectors, quaternions, and matrices rather than allocating new instances every frame.
     - Avoid redundant calculations, costly iterations over large collections, or unnecessary DOM/canvas operations.
   - **Notice and Reduce/Strip Unnecessary Code**:
     - Actively inspect surrounding code in any files being read or modified.
     - Look for opportunities to shrink, consolidate, or completely remove unnecessary surrounding code (e.g. dead branches, obsolete fallbacks, duplicate helpers, verbose boilerplate, overcomplicated logic) without altering or losing any intended functionality.
     - Never leave dead exports, unused variables, or orphan references behind; ensure `knip` remains completely clean.

4. **Finish with a commit-message summary**
   - When the whole task is done (all changes made, lint, build, and knip passing), present a commit-message-style summary of the work:
     - **Title**: a short, imperative summary of the change (e.g. `Add portal cooldown indicator`).
     - **Body**: a detailed description of exactly what was changed — which files, which classes/methods, and why — so the summary can be used verbatim as a commit message.

## Example summary format

```
Fix portal cooldown desync between clients

- client/portals/PortalManager.js: reset cooldown timer on server snapshot to prevent
  stale cooldowns after reconnection
- shared/constants.js: add PORTAL_COOLDOWN_MS shared constant
- npm run verify passes clean (test, lint, build, knip)
```
