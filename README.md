# Portal Arena

A browser portal game with Portal-style momentum physics and Warsow/Quake movement, now with **2-player multiplayer support!** 

## Features

- **Multiplayer**: Jump in with a friend! Player 1 controls Green and Dark Green portals, while Player 2 controls Light Red and Dark Red portals. You can seamlessly travel through each other's portals!
- **Momentum through portals**: Velocity is rotated by the portal-pair transform. Fall into a floor portal, exit a wall portal - your falling speed becomes sideways speed. Speed magnitude is preserved (energy-conserving, like Portal).
- **Portals stick to any flat face**: Floors, ceilings, vertical walls, and ramps of any angle - as long as the whole mouth fits on that one face. Shots that would clip a face edge are refused (buzz sound).
- **Nested portal views**: Portals render recursively — look through one portal and you see through another portal nested in that view (up to 3 levels deep); views too small on screen are culled automatically.
- **Strafe-jump / circle-jump acceleration**: Quake movement model. Ground friction, ground accel capped at run speed, but *air* acceleration with a very high cap. Timing jumps and strafing builds speed far past run speed. The HUD bar goes hot/orange past run speed; FOV widens with speed.
- **Air-strafing**: the classic Quake accidental mechanic. Mid-air, release the forward key, hold A or D, and turn your mouse in that same direction — your flight path curves without losing momentum, so you can steer long jumps and bank around corners at full speed.
- **Grab and throw**: Interact with physics cubes scattered around the map. Pick them up and throw them through portals.
- **Rockets**: Switch to the rocket launcher to blast around — rockets blow holes in the arena walls (the boundary walls are indestructible), and portals anchored to a destroyed wall are cancelled automatically.
- **Portal & instagib audio FX**: three-part positional portal open/close sounds, an instagib shot sound emitted from the shooter, a zap where the beam strikes a wall, plus dark burnt scorch marks that stick to the hit surface for 30 s and fade out over 0.5 s — networked, so every player sees them, including through the portals. All rendered as stereo spatial audio with chamber reverb.
- **Kill feed & event log**: kills, player connects/disconnects, and other events appear in a top-right event log that fades out after a while.

## The Arena

Each match takes place in a procedurally generated 50 × 50 m gothic duel arena: towering walls, high-platform spawns, lava pools that kill on touch, and a night sky with a flat moon, stars, and drifting clouds.

## How to Play (Multiplayer)

The game consists of a Node.js authoritative server and a web client. 

### 1. Install Dependencies
You will need Node.js installed on your machine.
Run the following command in the root directory to install required packages (like `ws` for WebSockets):
```bash
npm install
```

### 2. Launch the Server
Start the multiplayer server which will listen on port 3001 for WebSocket connections:
```bash
node server/server.js
```

### 3. Launch the Client
Serve the web client with the `http-server` npm package (installed with the step 1 `npm install`). Run it from the project root directory:
```bash
npx http-server -p 3000
```
Open your browser and navigate to `http://localhost:3000/client/`. 
To test multiplayer locally, simply open a second tab or window to the same address!

### 4. Duel Rounds (Score System)

The game is a two-player duel that runs in rounds:

1. **Waiting** — a duel only exists when *both* players are connected; until then the top-center scoreboard shows `WAITING FOR OPPONENT`.
2. **Warmup (up to 1 minute)** — both players can move and shoot freely (kills don't score). Press **R** to ready up; the moment *both* players are ready the round starts. If not, it starts automatically after 60 seconds.
3. **Round (5 minutes)** — both players are reset to the map's starting position, then a countdown timer runs at the top center of the screen. Each kill (instagib beam) scores **+1** for the killer, shown next to each player's name on either side of the timer.
4. **Summary** — when the 5 minutes elapse, a panel declares who won (most kills; equal kills = draw), showing each player's kill count and the cumulative rounds-won tally. **N** / *New Universe* or *Replay This Seed* starts the next round (new or same map) straight into warmup.

If a player disconnects mid-round, the round is voided and the scores reset for the next one.

## Controls

| Key | Action |
|---|---|
| Mouse | Look (click to capture pointer) |
| WASD | Move (yaw-relative, air-strafe capable) |
| Space | Jump - hold it and land to bunnyhop |
| 1 / 2 / 3 | Switch weapon (Portal Gun / Rocket Launcher / Instagib) |
| LMB / RMB | Fire Portal 1 / Portal 2 (or Shoot Rocket) |
| RMB (hold) | Zoom (Instagib) |
| E | Grab / Drop physics cube |
| Shift | Walk (precise positioning) |
| C / Ctrl | Crouch |
| F | Fullscreen |
| ESC | Pause Menu |
| [ ] | FOV +5 (starts at 115) |
| R | Ready up (warmup phase) |
| Tab | Stats board — players, ping, accuracy, score (hold) |
| N | New map |
| M | Mute |

## Project Structure

- `server/` - Node.js authoritative server (`server.js`) and global state (`gamestate.js`)
- `client/` - Web client (ES modules):
  - `index.html` - UI shell (menu, HUD, panels)
  - `main.js` - composition root: builds the shared game context `G` and initializes the modules below
  - `engine.js` - renderer, scene, camera, sky
  - `world.js` - map build, colliders, lava/hint zones, destructible walls
  - `portals.js` - portal state, placement, A↔B pair transforms, portal visuals
  - `weapons.js` - portal gun / rockets / instagib + pooled FX (smoke, scorch, gibs)
  - `players.js` - local/remote players, movement stepping, death
  - `input.js` - pointer lock, mouse/keyboard, menu controls
  - `loop.js` - main animation frame
  - `messages.js` - server → client message handling
  - `render_portals.js` - mirrored portal view rendering (render targets)
  - `models.js`, `textures.js`, `hud.js`, `audio.js`, `network.js` - supporting modules
- `shared/` - Shared logic executed by both the server and client (`physics.js`, `constants.js`, `mapgen.js`)

## Development & LLM Guidelines

When working on this codebase (especially when collaborating with AI assistants), the codebase heavily leverages ES Modules and decoupled logic. To avoid subtle bugs, broken imports, or accidental logic deletions during complex refactors, please adhere to the following rule:

**Always run the static analyzer after making significant edits!**
```bash
npm run lint
```

ESLint is configured via `eslint.config.js` to strictly catch:
- Undefined variables (`no-undef`)
- Unused variables and useless assignments
- Basic JavaScript syntax errors

If ESLint returns any errors, you must fix them before attempting to start the client or server. Do not deploy untested code with active linter errors.

## AI Tooling

This project was designed and built with LLM assistance:

- **Qwen3.8-Flash-Next** — the first outline of the project
- **Qwen3.8-27B** — most of the development: adjustments and adding features
- **agy CLI** with **Gemini 3.1 Pro** and **Claude Sonnet/Opus 4.6** — complex fixes, in particular physics edge cases and portal recursion


