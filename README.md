# PORTAL//FLUX

A browser portal game with Portal-style momentum physics and Warsow/Quake movement.
Open `index.html` in any modern browser (needs internet on first load for the three.js CDN).

## Controls

| Key | Action |
|---|---|
| Mouse | Look (click to capture pointer) |
| WASD | Move (yaw-relative, air-strafe capable) |
| Space | Jump — hold it and land to bunnyhop |
| LMB / RMB | Fire blue / orange portal |
| Shift | Walk (precise positioning) |
| V | Toggle autohop (on by default) |
| F | Fullscreen · ESC menu |
| [ ] | FOV ±5 (starts at 115) |
| R | Respawn · N new map · M mute |

## The physics

- **Momentum through portals**: velocity is rotated by the portal-pair transform.
  Fall into a floor portal, exit a wall portal — your falling speed becomes sideways
  speed. Speed magnitude is preserved (energy-conserving, like Portal).
- **Portals stick to any flat face** — floors, ceilings, vertical walls, and ramps of
  any angle — as long as the whole mouth fits on that one face. Shots that would clip
  a face edge are refused (buzz sound).
- **Strafe-jump / circle-jump acceleration**: Quake movement model — ground friction,
  ground accel capped at run speed, but *air* acceleration with a very high cap, so
  timing jumps and strafing (turn the mouse opposite your strafe while airborne)
  builds speed far past run speed. The HUD bar goes hot/orange past run speed; FOV
  widens with speed.

## Reading the course

The map is a long walled corridor with a continuous floor — nothing can kill you
by falling. Side walls, ceiling slabs, ramps and leaning colored panels are all
portalable (a portal-logic testbed: vertical, down-facing, and angled surfaces).
A chain of ledges climbs higher and higher along the route; occasional big rises
are solved at **orange launch pads**: portal A on the corridor floor below,
portal B on the pad overhead, climb the jump ramp and leap into A — your fall
returns as a launch above the pad (loop it from higher up to gain more height).
- Cyan platforms are ledges/path; violet slabs are ramps/leaning panels; orange
  slabs are launch pads; the golden ring + beam marks the exit pad at the top.
- The corridor is bright and lit by warm/cool lamps; open-sky segments let light in.
- Seed is shown bottom-right of HUD; type one in the menu to replay a layout.

## Files

- `index.html` — UI shell (HUD, menus)
- `game.js` — engine: seeded map generator, capsule/OBB collision, portal RT rendering
  (render-target pair per portal + clipping planes), movement model, WebAudio SFX
