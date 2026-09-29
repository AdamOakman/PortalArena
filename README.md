# PORTAL//FLUX

A browser portal game with Portal-style momentum physics and Warsow/Quake movement, now with **2-player multiplayer support!** 

## Features

- **Multiplayer**: Jump in with a friend! Player 1 controls Light Blue and Dark Blue portals, while Player 2 controls Orange and Red portals. You can seamlessly travel through each other's portals!
- **Momentum through portals**: Velocity is rotated by the portal-pair transform. Fall into a floor portal, exit a wall portal - your falling speed becomes sideways speed. Speed magnitude is preserved (energy-conserving, like Portal).
- **Portals stick to any flat face**: Floors, ceilings, vertical walls, and ramps of any angle - as long as the whole mouth fits on that one face. Shots that would clip a face edge are refused (buzz sound).
- **Strafe-jump / circle-jump acceleration**: Quake movement model. Ground friction, ground accel capped at run speed, but *air* acceleration with a very high cap. Timing jumps and strafing builds speed far past run speed. The HUD bar goes hot/orange past run speed; FOV widens with speed.
- **Grab and throw**: Interact with physics cubes scattered around the map. Pick them up and throw them through portals.
- **Rockets**: Switch to the rocket launcher to bounce around!

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
Serve the web client with the `http-server` npm package (installed with the step 1 `npm install`). Run it **from the `client/` directory** so its relative asset paths (`./main.js`) resolve:
```bash
cd client
npx http-server -p 3000
```
Open your browser and navigate to `http://localhost:3000`. 
To test multiplayer locally, simply open a second tab or window to the same address!

## Controls

| Key | Action |
|---|---|
| Mouse | Look (click to capture pointer) |
| WASD | Move (yaw-relative, air-strafe capable) |
| Space | Jump - hold it and land to bunnyhop |
| 1 / 2 | Switch weapon (Portal Gun / Rocket Launcher) |
| LMB / RMB | Fire Portal 1 / Portal 2 (or Shoot Rocket) |
| E | Grab / Drop physics cube |
| Shift | Walk (precise positioning) |
| V | Toggle autohop (on by default) |
| F | Fullscreen |
| ESC | Pause Menu |
| [ ] | FOV +5 (starts at 115) |
| R | Respawn |
| N | New map |
| M | Mute |

## Project Structure

- `server/` - Node.js authoritative server (`server.js`) and global state (`gamestate.js`)
- `client/` - Web client (`index.html`) and game engine / renderer (`main.js`)
- `shared/` - Shared logic executed by both the server and client (`physics.js`, `constants.js`, `mapgen.js`)
