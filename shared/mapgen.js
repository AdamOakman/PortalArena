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
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateMap(seedStr) {
  const rng = mulberry32(hashSeed(seedStr));
  const rr = (a, b) => a + rng() * (b - a);
  const ri = (a, b) => Math.floor(rr(a, b + 1));
  const pick = arr => arr[Math.floor(rng() * arr.length)];

  const slabs = [];
  const hints = [];
  const lanterns = [];
  const holograms = [];
  const powerCores = [];
  const lamps = [];
  const add = (cx, cy, cz, sx, sy, sz, kind, ry = 0, rz = 0) =>
    slabs.push({ c: [cx, cy, cz], s: [sx, sy, sz], kind, ry, rz });

  const PLAT = 'plat', RAMP = 'ramp', WALL = 'wall', GANTRY = 'gantry';

  const halfW = 22.2, x0 = -24;
  const nSeg = ri(90, 110), segLen = rr(15, 18);
  let endX = x0;
  for (let i = 0; i < nSeg; i++) {
    const cx = endX + segLen / 2;
    add(cx, -0.5, 0, segLen + 0.4, 1.0, halfW * 2, PLAT);
    for (const s of [-1, 1]) {
      if (rng() < 0.22) {
        const lh = rr(9.6, 13.8);
        add(cx, lh / 2, s * (halfW + 0.3), segLen + 0.4, lh, 0.6, WALL);
      } else {
        const wh = rr(27, 39);
        add(cx, wh / 2, s * (halfW + 0.3), segLen + 0.4, wh, 0.6, WALL);
      }
    }
    if (rng() < 0.5 && cx < x0 + nSeg * segLen * 0.62) {
      add(cx + rr(-2, 2), rr(40.5, 48), 0, rr(7, 11), 0.5, halfW * 2, WALL);
    }
    lamps.push({ c: [cx + segLen * 0.3, rr(4.5, 6.5), (rng() < 0.5 ? -1 : 1) * (halfW - 0.7)], color: pick([0x9fd8ff, 0xffd9a8]) });
    if (rng() < 0.35) lanterns.push({ c: [cx + rr(-4, 4), rr(6, 12), pick([-1, 1]) * rr(halfW - 4, halfW - 1)], color: pick([0x2eeaff, 0xb45cff, 0xff9a3d]) });
    if (rng() < 0.3) holograms.push({ c: [cx + rr(-6, 6), rr(5, 15), rr(-6, 6)], color: pick([0x0affff, 0xff0a55, 0x55ff0a]) });
    if (rng() < 0.25) powerCores.push({ c: [cx + rr(-8, 8), 0.5, pick([-1, 1]) * rr(halfW - 6, halfW - 2)] });
    endX += segLen;
  }
  add(endX + 0.3, 6, 0, 0.6, 39, halfW * 2, WALL);

  let wx = x0 + 40;
  while (wx < endX - 40) {
    wx += rr(45, 90);
    const type = ri(0, 2);
    if (type === 0) {
      const side = pick([-1, 1]);
      const wWidth = rr(halfW * 0.8, halfW * 1.5);
      add(wx, 20, side * (halfW - wWidth / 2), 2, 40, wWidth, WALL);
      add(wx - rr(8, 14), 0.05, side * rr(halfW * 0.2, halfW * 0.7), 5.5, 0.1, 5.5, 'jumppad');
    } else if (type === 1) {
      const wHeight = rr(12, 22);
      add(wx, wHeight / 2 - 0.5, 0, 2, wHeight, 2 * halfW, WALL);
      add(wx - rr(8, 14), 0.05, rr(-halfW * 0.4, halfW * 0.4), 5.5, 0.1, 5.5, 'jumppad');
    } else {
      const wHeight = rr(15, 28);
      add(wx, 40 - wHeight / 2, 0, 2, wHeight, 2 * halfW, WALL);
      add(wx - rr(8, 14), 0.05, rr(-halfW * 0.4, halfW * 0.4), 5.5, 0.1, 5.5, 'jumppad');
    }
  }

  for (let px = x0 + 30; px < endX - 30; px += rr(20, 35)) {
    if (rng() < 0.7) {
      add(px, 0.05, rr(-halfW * 0.7, halfW * 0.7), 5.5, 0.1, 5.5, 'jumppad');
    }
  }

  const spawn = { x: x0 + 4, y: 0.05, z: 0 };
  for (let i = 0; i < ri(2, 3); i++) {
    const px = x0 + rr(8, 16), s = pick([-1, 1]), ang = rr(15, 34) * Math.PI / 180;
    add(px, 3.4, s * (halfW - 1.2), 0.5, 7.0, rr(5.0, 6.5), WALL, 0, ang);
  }

  let lx = x0 + rr(11, 14), ly = rr(1.7, 2.2), side = pick([-1, 1]);
  let lz = side * rr(halfW * 0.35, halfW * 0.55);
  let lastLedge = { x: lx, y: ly, z: lz };
  while (lx < endX - 16) {
    add(lx, ly - 0.25, lz, rr(6.8, 8.2), 0.5, rr(6.8, 8.2), PLAT);
    lastLedge = { x: lx, y: ly, z: lz };
    const nextX = lx + rr(8.5, 12.5);
    
    if (nextX < endX - 14 && rng() < 0.22) {
      add(lx + rr(3.5, 6), 0.05, lz + rr(-1, 1), 5.5, 0.1, 5.5, 'jumppad');
      lx = nextX + rr(4, 7); ly = rr(18, 28);
    } else if (nextX < endX - 20 && rng() < 0.55) {
      let startY = rng() < 0.4 ? 0 : ly; 
      const dy = rr(10, 22);
      const dx = dy * rr(2.2, 3.8);
      const rang = Math.atan2(dy, dx);
      add(lx + dx / 2, startY + dy / 2 - 0.25, lz, dx / Math.cos(rang), 0.6, rr(8.0, 14.0), RAMP, 0, rang);
      lx += dx; ly = startY + dy;
      
      const padW = rr(8, 12);
      add(lx + padW / 2, ly - 0.25, lz, padW, 0.5, rr(8.0, 14.0), PLAT);
      lx += padW + rr(2, 4);
    } else if (nextX < endX - 14 && rng() < 0.4) {
      const padY = Math.min(ly + rr(16.8, 18.6), 26.7);
      const padX = lx + rr(5.5, 7.5), padZ = -lz * 0.6;
      add(padX, padY + 0.25, padZ, rr(6.8, 7.5), 0.5, rr(6.8, 7.5), GANTRY);
      const rlen = 7.5, rang = Math.atan2(rr(3.6, 4.2), rlen);
      add(padX - rr(3.5, 5), Math.tan(rang) * rlen / 2, padZ + rr(-1, 1), rlen / Math.cos(rang), 0.45, rr(5.0, 6.0), RAMP, 0, rang);
      lx = padX + rr(3.5, 5); ly = Math.min(padY + rr(4.8, 7.2), 33.9);
    } else {
      lx = nextX; ly += rr(1.05, 1.5);
    }
    side = -side; lz = side * rr(halfW * 0.35, halfW * 0.55);
    if (ly > 34.5) { ly = rr(2.0, 4.0); }
  }

  const ax = Math.min(lastLedge.x + rr(8, 12), endX - 4);
  const az = -Math.sign(lastLedge.z) * rr(4, 8);
  add(lastLedge.x + rr(2, 6), 0.05, lastLedge.z, 5.5, 0.1, 5.5, 'jumppad');
  const ay = rr(18, 28);
  add(ax, ay - 0.28, az, rr(6.8, 8.5), 0.55, rr(6.8, 8.5), PLAT);
  const ex = ax + rr(2.6, 3.6), ez = az * 0.7, ey = ay + rr(0.8, 1.25);
  add(ex, ey - 0.3, ez, rr(6.6, 7.6), 0.6, rr(6.6, 7.6), GANTRY);
  add(ex, (ey - 0.6) / 2, ez, 1.2, ey - 0.6, 1.2, WALL);
  const exit = { x: ex, y: ey + 0.05, z: ez };

  const pillars = [];
  for (let s = -1; s <= 1; s += 2) {
    let px = x0 - 6;
    while (px < endX + 14) {
      px += rr(12, 22);
      const pz = s * rr(halfW + 8, halfW + 26);
      const ph = rr(8, 26), ps = rr(2.5, 5);
      pillars.push({ c: [px, -12 + (ph + 12) / 2, pz], s: [ps, ph, ps] });
      if (rng() < 0.5) holograms.push({ c: [px, rr(6, 14), pz], color: pick([0x2eeaff, 0xb45cff]) });
    }
  }

  const grabCubes = [];
  const cDia = 1.5;
  let pyramidCount = 0;
  for (const slab of slabs) {
     if (slab.kind !== 'plat' && slab.kind !== 'gantry' && slab.kind !== 'start') continue;
     if (rng() > 0.4) continue;
     
     const bw = Math.floor(rr(2, 5.99));
     const totalW = bw * cDia;
     if (slab.s[0] < totalW + 1 || slab.s[2] < totalW + 1) continue;
     
     const ox = slab.c[0] + rr(-slab.s[0]/2 + totalW/2, slab.s[0]/2 - totalW/2);
     const oz = slab.c[2] + rr(-slab.s[2]/2 + totalW/2, slab.s[2]/2 - totalW/2);
     const oy = slab.c[1] + slab.s[1]/2 + cDia/2 + 0.05;
     
     for (let lvl = 0; lvl < bw; lvl += 2) {
        const lw = bw - lvl;
        const startX = ox - (lw * cDia)/2 + cDia/2;
        const startZ = oz - (lw * cDia)/2 + cDia/2;
        const y = oy + (lvl/2) * cDia;
        
        for (let ix = 0; ix < lw; ix++) {
           for (let iz = 0; iz < lw; iz++) {
              grabCubes.push({ c: [startX + ix * cDia, y, startZ + iz * cDia] });
           }
        }
     }
     pyramidCount++;
     if (pyramidCount >= 15) break;
  }

  return { seed: seedStr, slabs, pillars, lanterns, holograms, powerCores, lamps, hints, spawn, exit, grabCubes };
}
