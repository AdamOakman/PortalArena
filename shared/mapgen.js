function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^ (h >>> 16)) >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(a ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/*
 * Dark medieval gothic duel arena, 50m x 50m.
 * No exit: the round is decided by kills only.
 * Everything is reachable on foot (steps <= 0.6m, ramp slopes <= 0.25),
 * no rocket jumps or portals required.
 *
 * Authored in a 100 x 100 design space below, then uniformly scaled by
 * MAP_SCALE (0.5) at the end so every proportion, height and reachability
 * is preserved — the map simply reads as a 50 x 50 arena.
 *
 * Layout (final, scaled):
 *   - 50 x 50 floor, boundary walls (36m), corner towers (80m)
 *   - two concentric wall rings with gate gaps (passages) + gothic arches
 *   - central keep: 3 levels + a long ramp out to a spire platform (~6m)
 *   - 4 boundary vantages: long wall-hugging ramps up to mid + high
 *     platforms attached to the boundary walls (tops at ~9m)
 *   - 4 corner outposts (2 levels)
 *   - 12 rimmed lava pools (instant death, like the void)
 *   - cover: crates, low walls
 *   - 6 spawn points (4 corners + 2 edge)
 *   - decor: torches, banners, arches, obelisks, braziers, crosses, skulls
 */
export function generateMap(seedStr) {
  const rng = mulberry32(hashSeed(seedStr));
  const rr = (a, b) => a + rng() * (b - a);
  const pick = arr => arr[Math.floor(rng() * arr.length)];

  const slabs = [];
  const decor = [];
  const lava = [];
  const spawns = [];
  const add = (cx, cy, cz, sx, sy, sz, kind, ry = 0, rz = 0, boundary = false) => {
    const rec = { c: [cx, cy, cz], s: [sx, sy, sz], kind, ry, rz };
    if (boundary) rec.boundary = true; // indestructible by rockets
    slabs.push(rec);
  };

  const PLAT = 'plat', RAMP = 'ramp', WALL = 'wall', LAVA = 'lava';
  const HALF = 50; // arena is 100 x 100

  // ------------------------------------------------------------- floor
  add(0, -0.5, 0, HALF * 2, 1, HALF * 2, PLAT);

  // --------------------------------------------------- reserved-space tracking
  const reservedR = []; // {x1, z1, x2, z2}
  const reservedC = []; // {x, z, r}
  const reserveRect = (cx, cz, sx, sz) =>
    reservedR.push({ x1: cx - sx / 2, z1: cz - sz / 2, x2: cx + sx / 2, z2: cz + sz / 2 });
  const reserveCircle = (x, z, r) => reservedC.push({ x, z, r });
  const isFree = (x, z, m) => {
    for (const r of reservedR) if (x > r.x1 - m && x < r.x2 + m && z > r.z1 - m && z < r.z2 + m) return false;
    for (const c of reservedC) { const dx = x - c.x, dz = z - c.z; if (dx * dx + dz * dz < (c.r + m) * (c.r + m)) return false; }
    return true;
  };

  // ------------------------------------------------------------- boundary
  const BW = 72; // boundary walls
  add(0, BW / 2, -(HALF + 0.75), HALF * 2 + 3, BW, 1.5, WALL, 0, 0, true);
  add(0, BW / 2, HALF + 0.75, HALF * 2 + 3, BW, 1.5, WALL, 0, 0, true);
  add(-(HALF + 0.75), BW / 2, 0, 1.5, BW, HALF * 2, WALL, 0, 0, true);
  add(HALF + 0.75, BW / 2, 0, 1.5, BW, HALF * 2, WALL, 0, 0, true);
  const TOWER_H = 160;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    add(sx * HALF, TOWER_H / 2, sz * HALF, 14, TOWER_H, 14, WALL); // corner towers
    reserveRect(sx * HALF, sz * HALF, 18, 18);
    decor.push({ t: 'skull', c: [sx * (HALF - 9), 0, sz * (HALF - 9)], ry: rng() * 6.28, s: rr(1.2, 1.6) });
    decor.push({ t: 'torch', c: [sx * HALF, TOWER_H, sz * HALF] }); // torch on the tower top
  }


  // ------------------------------------------------------------- wall rings
  // 4 walls around a square at ±size with random gate gaps (passages).
  function ring(size, h, gapsPerSide, gapW, lit) {
    for (let side = 0; side < 4; side++) {
      const n = gapsPerSide;
      const gaps = [];
      for (let g = 0; g < n; g++) {
        const span = (2 * size) / n;
        gaps.push(-size + span * (g + 0.5) + rr(-0.25, 0.25) * span);
      }
      gaps.sort((a, b) => a - b);
      let cur = -size;
      for (const gc of gaps) {
        const b = gc - gapW / 2;
        if (b - cur > 2.5) {
          if (side === 0) add((cur + b) / 2, h / 2, -size, b - cur, h, 1.2, WALL);
          else if (side === 1) add(size, h / 2, (cur + b) / 2, 1.2, h, b - cur, WALL);
          else if (side === 2) add((cur + b) / 2, h / 2, size, b - cur, h, 1.2, WALL);
          else add(-size, h / 2, (cur + b) / 2, 1.2, h, b - cur, WALL);
        }
        decor.push({ t: 'arch', c: [side === 1 ? size : side === 3 ? -size : gc, 0, side === 0 ? -size : side === 2 ? size : gc], ry: side % 2 === 0 ? 0 : Math.PI / 2, s: h / 6.95 });
        if (lit) decor.push({ t: 'torch', c: [side === 1 ? size : side === 3 ? -size : gc, 5.2, side === 0 ? -size : side === 2 ? size : gc] });
        cur = gc + gapW / 2;
      }
      if (size - cur > 2.5) {
        if (side === 0) add((cur + size) / 2, h / 2, -size, size - cur, h, 1.2, WALL);
        else if (side === 1) add(size, h / 2, (cur + size) / 2, 1.2, h, size - cur, WALL);
        else if (side === 2) add((cur + size) / 2, h / 2, size, size - cur, h, 1.2, WALL);
        else add(-size, h / 2, (cur + size) / 2, 1.2, h, size - cur, WALL);
      }
      reserveRect(side % 2 === 0 ? 0 : (side === 1 ? size : -size), side % 2 === 0 ? (side === 0 ? -size : size) : 0,
        side % 2 === 0 ? size * 2 : 1.2, side % 2 === 0 ? 1.2 : size * 2);
    }
  }
  ring(32, 8.2, 3, rr(4, 6), true);
  ring(16, 5, 2, rr(4, 5));
  for (const [bx, bz] of [[32, 0], [-32, 0], [0, 32], [0, -32]])
    decor.push({ t: 'brazier', c: [bx, 0, bz] });                        // ring-1 midpoints

  // ------------------------------------------------------------- ramps / steps
  // dir: 0 = rises toward +x, 1 = +z, 2 = -x, 3 = -z. Slope kept <= 0.25.
  // y0: height of the LOW end of the ramp (default 0 = floor).
  function ramp(cx, cz, dir, len, rise, width, y0 = 0) {
     const totalRise = rise + 0.25;                     // low end sinks 0.25 in, high end flush at y0+rise
     const pitch = Math.atan2(totalRise, len);
     const sl = len / Math.cos(pitch) + 0.4;
     const cy = y0 + rise / 2 - 0.125;
    const ry = dir === 0 ? 0 : dir === 1 ? -Math.PI / 2 : dir === 2 ? Math.PI : Math.PI / 2;
    add(cx, cy, cz, sl, 0.6, width, RAMP, ry, pitch);
  }

  // ------------------------------------------------------------- central keep
  const K = 7.5; // base half-size
  add(0, 1, 0, K * 2, 2, K * 2, PLAT);                       // base, top y=2
   ramp(0, -(K + 3.5), 1, 9, 2.0, 6);                   // 4 ramps, all rising toward the keep
   ramp(0, K + 3.5, 3, 9, 2.0, 6);
   ramp(K + 3.5, 0, 2, 9, 2.0, 6);
   ramp(-(K + 3.5), 0, 0, 9, 2.0, 6);
  add(0, 3.1, 0, 12, 2.2, 12, PLAT);                          // level 2, top y=4.2
  add(0, 2.4, -5.5, 5, 0.8, 3, PLAT);                         // steps N (2.0->2.8->3.8->4.2)
  add(0, 3.4, -3.5, 5, 0.8, 3, PLAT);
  add(0, 5.2, 0, 6, 2, 6, PLAT);                              // crown, top y=6.2
  add(0, 4.7, 3.25, 4, 1.0, 2.5, PLAT);                       // step S (4.2->5.2->6.2)
  reserveRect(0, 0, 17, 17);
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    add(sx * 5.25, 2.75, sz * 5.25, 1.5, 1.5, 1.5, WALL);     // crates on the base
  for (const sx of [-1, 1])
    add(sx * 2.25, 4.95, -2.25, 1.5, 1.5, 1.5, WALL);         // crates on level 2
  decor.push({ t: 'brazier', c: [0, 6.2, 0], s: 1.4 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    decor.push({ t: 'torch', c: [sx * 1.5, 6.2, sz * 1.5] }); // crown torches
  decor.push({ t: 'cross', c: [2.5, 4.2, 2.25], ry: Math.PI, s: 1.1 });
  decor.push({ t: 'cross', c: [-2.5, 4.2, 2.25], ry: Math.PI, s: 1.1 });
  for (const sx of [-1, 1])
    decor.push({ t: 'skull', c: [sx * 1.5, 4.2, -3], ry: rng() * 6.28, s: rr(0.9, 1.2) });

  // --------------------------------------- keep spire: long ramp to a high platform
   ramp(16, 0, 0, 21, 5, 5, 4.2);                       // from level 2, over the ring-2 wall
  add(30, 8.7, 0, 10, 1, 10, PLAT);                           // floating platform, top 9.2
  add(28, 9.7, 3.5, 4, 1, 3, PLAT);                           // steps 9.2->10.2->11.2
  add(28, 10.7, 2, 4, 1, 3, PLAT);
  add(30, 11.7, 0, 8, 1, 8, PLAT);                            // spire top, 12.2
  reserveRect(30, 0, 14, 12);
  decor.push({ t: 'brazier', c: [30, 12.2, 0], s: 1.2 });
  decor.push({ t: 'torch', c: [27, 12.2, -3] });
  decor.push({ t: 'torch', c: [33, 12.2, -3] });

  // ------------------------------------------------------------- boundary vantages
  // Each side: long floor ramp (40m, slope 0.25) to a mid platform (9.8)
  // stuck to the boundary wall, then a second ramp (32m) to a high
  // platform (17.7). Bidirectional: walk back down the ramps.
  function vantage(side) {
    // side 0 = north (z -50), 1 = east (x +50), 2 = south (z +50), 3 = west (x -50)
    if (side === 0) {
       ramp(-17.1, -44.5, 0, 40.2, 9.8, 11, 0);                // floor -> 9.8, x -37..3 (flush, z -50..-39, =mid width)
      add(10, 9.3, -44.5, 14, 1, 11, PLAT);                     // mid, top 9.8 (z -50..-39)
       ramp(-14, -47.25, 2, 37.5, 8, 5.5, 9.8);             // mid -> 17.7, x -33.4..5.4 (extended to shifted high, half width)
      add(-37, 17.2, -45, 12, 1, 10, PLAT);                   // high, top 17.7 (x -43..-31 touches NW column, z -50..-40 flush wall)
      reserveRect(-6, -44, 46, 14);
      reserveRect(10, -44, 18, 12);
      reserveRect(-37, -44, 16, 12);
      decor.push({ t: 'torch', c: [10, 9.8, -44] });
      decor.push({ t: 'brazier', c: [-33, 17.7, -44] });
    } else if (side === 1) {
       ramp(44.5, -17.1, 1, 40.2, 9.8, 11, 0);                 // floor -> 9.8, z -37..3 (flush, x 39..50, =mid width)
      add(44.5, 9.3, 10, 11, 1, 14, PLAT);                      // mid, top 9.8 (x 39..50)
       ramp(47.25, -14, 3, 37.5, 8, 5.5, 9.8);               // mid -> 17.7, z -33.4..5.4 (extended to shifted high, half width)
      add(45, 17.2, -37, 10, 1, 12, PLAT);                    // high, top 17.7 (z -43..-31 touches NE column, x 40..50 flush wall)
      reserveRect(44, -6.67, 14, 46);
      reserveRect(44, 10, 14, 18);
      reserveRect(44, -37, 12, 16);
      decor.push({ t: 'torch', c: [44, 9.8, 10] });
      decor.push({ t: 'brazier', c: [44, 17.7, -33] });
    } else if (side === 2) {
       ramp(17.1, 44.5, 2, 40.2, 9.8, 11, 0);                  // floor -> 9.8, x 37..-3 (flush, z 39..50, =mid width)
      add(-10, 9.3, 44.5, 14, 1, 11, PLAT);                     // mid, top 9.8 (z 39..50)
       ramp(-22.8, 47.25, 2, 33, 8, 5.5, 9.8);               // mid -> 17.7, x -40..-5.6 (repositioned to shifted high, half width)
      add(-37, 17.2, 45, 12, 1, 10, PLAT);                   // high, top 17.7 (x -43..-31 touches SW column, z 40..50 flush wall)
      reserveRect(6, 44, 46, 14);
      reserveRect(-10, 44, 18, 12);
      reserveRect(-37, 44, 16, 12);
      decor.push({ t: 'torch', c: [-10, 9.8, 44] });
      decor.push({ t: 'brazier', c: [-33, 17.7, 44] });
    } else {
       ramp(-44.5, 17.1, 3, 40.2, 9.8, 11, 0);                 // floor -> 9.8, z 37..-3 (flush, x -50..-39, =mid width)
      add(-44.5, 9.3, -10, 11, 1, 14, PLAT);                    // mid, top 9.8 (x -50..-39)
       ramp(-47.25, 9, 1, 47.5, 8, 5.5, 9.8);                // mid -> 17.7, z -15.3..33.3 (extended to shifted high, half width)
      add(-45, 17.2, 37, 10, 1, 12, PLAT);                    // high, top 17.7 (z 31..43 touches SW column, x -50..-40 flush wall)
      reserveRect(-44, 6.67, 14, 46);
      reserveRect(-44, -10, 14, 18);
      reserveRect(-44, 37, 12, 16);
      decor.push({ t: 'torch', c: [-44, 9.8, -10] });
      decor.push({ t: 'brazier', c: [-44, 17.7, 33] });
    }
  }
  for (let side = 0; side < 4; side++) vantage(side);

  // ------------------------------------------------------------- corner outposts
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const cx = sx * 24, cz = sz * 24;
     add(cx, 0.75, cz, 12, 1.5, 12, PLAT);                    // base, top 1.5
       ramp(cx - sx * 5.5, cz, sx < 0 ? 2 : 0, 7, 1.5, 5); // ramp facing arena center
     add(cx - sx * 3, 2.1, cz, 4, 1.0, 4, PLAT);              // step 1.5->2.6
     add(cx, 2.5, cz, 7, 1.8, 7, PLAT);                       // top, 3.4
     add(cx, 4.15, cz, 1.5, 1.5, 1.5, WALL);                  // crate
     reserveRect(cx, cz, 14, 14);
     decor.push({ t: 'brazier', c: [cx, 3.4, cz] });          // outpost bowl
  }

  // ------------------------------------------------------------- lava pools
  function lavaPool(x, z, r) {
    const rim = 0.5; // low lip: easy to hop over accidentally, straight into the lava
    add(x, rim / 2, z - r - 0.5, 2 * r + 2, rim, 1, WALL);
    add(x, rim / 2, z + r + 0.5, 2 * r + 2, rim, 1, WALL);
    add(x - r - 0.5, rim / 2, z, 1, rim, 2 * r + 1, WALL);
    add(x + r + 0.5, rim / 2, z, 1, rim, 2 * r + 1, WALL);
    add(x, 0.02, z, 2 * r, 0.16, 2 * r, LAVA);                // surface at y=0.10
    lava.push({ x, z, r: r + 0.4, y: 0.1 });
    reserveCircle(x, z, r + 2);
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) lavaPool(sx * 10, sz * 10, 2.5);
  for (const s of [-1, 1]) { lavaPool(s * 24, 0, 2.75); lavaPool(0, s * 24, 2.75); }
  for (const [x, z] of [[42, 14], [-42, -14], [14, -42], [-14, 42]]) lavaPool(x + rr(-2, 2), z + rr(-2, 2), 3);

  // ------------------------------------------------------------- scattered cover
  const groundAnchors = [[-36, -36], [36, 36], [36, -36], [-36, 36]];
  for (const [ax, az] of groundAnchors) reserveCircle(ax, az, 8); // keep spawn zones clear
  let placed = 0, tries = 0;
  while (placed < 30 && tries < 500) {
    tries++;
    const outer = rng() < 0.5;
    const band = outer ? rr(34, 47) : rr(18, 29);
    const ax = rr(-band, band), az = rr(-band, band);
    const x = Math.sign(ax) * Math.max(Math.abs(ax), Math.abs(az) * rr(0.4, 1));
    const z = Math.sign(az) * band;
    if (!isFree(x, z, 4)) continue;
    if (rng() < 0.45) {
      const len = rr(3, 6), h = rr(1.4, 1.9), t = 0.9;
      const ry = pick([0, 0, Math.PI / 2, Math.PI / 4]);
      add(x, h / 2, z, len, h, t, WALL, ry);
      reserveRect(x, z, len + 1, t + 1);
    } else {
      const s = rr(1.5, 2.2);
      add(x, s / 2, z, s, s, s, WALL, rng() < 0.5 ? 0 : Math.PI / 4);
      reserveCircle(x, z, s / 2 + 1.2);
    }
    placed++;
  }

  // ------------------------------------------------------------- spawns (6)
  // 4 ground corners + 2 high vantage platforms (east & west — a 180-deg
  // symmetric pair for a fair duel). Ground spawns sit in the gaps left by
  // the boundary vantage ramps; high spawns are fixed on the vantage tops.
  // Every spawn faces the arena center.
  for (const [ax, az] of groundAnchors) {
    let x = ax, z = az, ok = false;
    for (let i = 0; i < 24 && !ok; i++) {
      x = ax + (i ? rr(-4, 4) : 0); z = az + (i ? rr(-4, 4) : 0);
      ok = isFree(x, z, 5);
    }
    const yaw = Math.atan2(-x, -z);
    spawns.push({ x, y: 0.05, z, yaw });
  }
  // High-platform spawns: fixed exactly on the east/west vantage platforms.
  for (const [hx, hz] of [[44, -33], [-44, 33]])
    spawns.push({ x: hx, y: 17.75, z: hz, yaw: Math.atan2(-hx, -hz) });

  // ------------------------------------------------------------- gothic decor
  // torches: boundary walls + ring corners
  for (let side = 0; side < 4; side++) {
    for (let i = 0; i < 10; i++) {
      const p = -HALF + 6 + i * 10 + rr(-2, 2);
      if (side === 0) decor.push({ t: 'torch', c: [p, 0, -HALF + 0.7] });
      else if (side === 1) decor.push({ t: 'torch', c: [HALF - 0.7, 0, p] });
      else if (side === 2) decor.push({ t: 'torch', c: [p, 0, HALF - 0.7] });
      else decor.push({ t: 'torch', c: [-HALF + 0.7, 0, p] });
    }
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    decor.push({ t: 'torch', c: [sx * 33, 0, sz * 33] });
    decor.push({ t: 'torch', c: [sx * 17, 0, sz * 17] });
  }
  // banners on the boundary
  for (let side = 0; side < 4; side++) {
    for (let k = 0; k < 3; k++) {
      const p = -30 + k * 30 + rr(-6, 6);
      if (side === 0) decor.push({ t: 'banner', c: [p, 7, -HALF + 0.8], ry: 0 });
      else if (side === 1) decor.push({ t: 'banner', c: [HALF - 0.8, 7, p], ry: Math.PI / 2 });
      else if (side === 2) decor.push({ t: 'banner', c: [p, 7, HALF + 0.8], ry: Math.PI });
      else decor.push({ t: 'banner', c: [-HALF + 0.8, 7, p], ry: -Math.PI / 2 });
    }
  }
  // obelisks in the outer band
  for (let i = 0; i < 6; i++) {
    const a = rng() * Math.PI * 2, R = rr(43, 47);
    const x = Math.cos(a) * R, z = Math.sin(a) * R;
    if (isFree(x, z, 4)) decor.push({ t: 'obelisk', c: [x, 0, z], ry: rng() * 6.28, s: rr(0.9, 1.3) });
  }
  // braziers + a lone cross on the outer ground
  decor.push({ t: 'brazier', c: [20, 0, 0], s: 1.2 });
  decor.push({ t: 'brazier', c: [0, 0, -20], s: 1.2 });
  decor.push({ t: 'cross', c: [0, 0, -48.5], ry: 0, s: 1.8 });
  // skulls around lava pools
  for (const pool of lava) {
    if (rng() < 0.75) {
      const a = rng() * Math.PI * 2;
      decor.push({ t: 'skull', c: [pool.x + Math.cos(a) * (pool.r + 1.2), 0.1, pool.z + Math.sin(a) * (pool.r + 1.2)], ry: rng() * 6.28, s: rr(0.8, 1.2) });
    }
  }

  // ------------------------------------------------------------------ scale
  // Authored in a 100 x 100 design space (HALF = 50) above; ship at half
  // size. Uniformly scale every position, dimension, radius and height by
  // MAP_SCALE so all proportions and reachability are preserved. Angles
  // (ry, rz, yaw) are untouched.
  const MAP_SCALE = 0.5;
  const sc3 = v => [v[0] * MAP_SCALE, v[1] * MAP_SCALE, v[2] * MAP_SCALE];
  for (const sl of slabs) { sl.c = sc3(sl.c); sl.s = sc3(sl.s); }
  for (const d of decor) { d.c = sc3(d.c); d.s = (d.s || 1) * MAP_SCALE; }
  for (const l of lava) { l.x *= MAP_SCALE; l.z *= MAP_SCALE; l.r *= MAP_SCALE; l.y *= MAP_SCALE; }
  for (const sp of spawns) { sp.x *= MAP_SCALE; sp.z *= MAP_SCALE; sp.y *= MAP_SCALE; }
  return { seed: seedStr, slabs, spawns, lava, decor, grabCubes: [], hints: [] };
}
