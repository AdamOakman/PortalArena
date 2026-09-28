/* ============================================================================
   PORTAL//FLUX — portal physics + Quake/Warsow movement in the browser.
   Files: index.html (UI shell) + game.js (this). Three.js loaded from CDN.

   Mechanics:
   - Portals: LMB = blue (A), RMB = orange (B). They stick to any flat face of
     any angle (floor / ceiling / wall / ramp) provided the whole mouth fits
     inside that single face.
   - Momentum conservation: velocity is rotated by the portal-pair transform,
     so falling into a floor portal and exiting a wall portal flings you
     sideways at your impact speed; magnitude through the pair is preserved.
   - Movement: Quake ground friction + acceleration, air-strafe with a high
     cap (speed can grow far past run speed), bunnyhop (hold jump / autohop V),
     coyote time and jump buffering. Circle-jump to build big speed.
   ============================================================================ */

/* ------------------------------------------------------------------ loader */
function boot() {
  const CDN_ESM = 'https://unpkg.com/three@0.160.0/build/three.module.js';
  const CDNS_UMD = [
    'https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
  ];
  import(CDN_ESM).then(ns => start(ns)).catch(() => {
    let i = 0;
    const tryNext = () => {
      if (i >= CDNS_UMD.length) { showFatal('Could not load three.js from any CDN — check your internet connection.'); return; }
      const s = document.createElement('script');
      s.src = CDNS_UMD[i++];
      s.onload = () => window.THREE ? start(window.THREE) : tryNext();
      s.onerror = tryNext;
      document.head.appendChild(s);
    };
    tryNext();
  });
}
function showFatal(msg) {
  const d = document.createElement('div'); d.id = 'err'; d.textContent = msg; document.body.appendChild(d);
}
if (typeof window !== 'undefined') boot();

/* ------------------------------------------------------------- utilities */
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

/* ==========================================================================
   MAP GENERATION — pure data, no THREE. A long walled corridor with a
   continuous floor (no lethal pits): walls on both sides, ceiling slabs,
   ramps and tilted panels (portalable faces at every orientation), and a
   chain of ledges that climb higher and higher along the route. Some gaps in
   the ledge chain exceed jump height and are solved with momentum launches:
   portal A on the floor below, portal B on an orange launch pad overhead,
   leap from a jump ramp into A — your fall returns as a launch above the pad.
   Solvable by construction; every other route is walk/jump/strafe-jump able.
   ========================================================================== */
export function generateMap(seedStr) {
  const rng = mulberry32(hashSeed(seedStr));
  const rr = (a, b) => a + rng() * (b - a);
  const ri = (a, b) => Math.floor(rr(a, b + 1));
  const pick = arr => arr[Math.floor(rng() * arr.length)];

  const slabs = [];   // {c,s:[sx,sy,sz],kind,ry,rz}
  const hints = [];   // {min:[x,y,z],max:[x,y,z],msg}
  const rings = [];   // decorative floating tori {c:[x,y,z],r,color}
  const lamps = [];   // point lights {c:[x,y,z],color}
  const add = (cx, cy, cz, sx, sy, sz, kind, ry = 0, rz = 0) =>
    slabs.push({ c: [cx, cy, cz], s: [sx, sy, sz], kind, ry, rz });

  const PLAT = 'plat', RAMP = 'ramp', WALL = 'wall', GANTRY = 'gantry';

  /* ---------------- corridor shell: floor + side walls + ceiling ------- */
  const halfW = 7.4, x0 = -24;
  const nSeg = ri(9, 11), segLen = rr(15, 18);
  let endX = x0;
  for (let i = 0; i < nSeg; i++) {
    const cx = endX + segLen / 2;
    add(cx, -0.5, 0, segLen + 0.4, 1.0, halfW * 2, PLAT); // continuous floor
    for (const s of [-1, 1]) {
      if (rng() < 0.22) {
        // low wall segment — open sky above, brighter, portalable up to its lip
        add(cx, rr(3.2, 4.6) / 2, s * (halfW + 0.3), segLen + 0.4, 0, 0.6, WALL); // placeholder replaced below
        slabs.pop();
        const lh = rr(3.2, 4.6);
        add(cx, lh / 2, s * (halfW + 0.3), segLen + 0.4, lh, 0.6, WALL);
      } else {
        const wh = rr(9, 13);
        add(cx, wh / 2, s * (halfW + 0.3), segLen + 0.4, wh, 0.6, WALL);
      }
    }
    if (rng() < 0.5 && cx < x0 + nSeg * segLen * 0.62) { // ceiling slabs (first ~2/3): down-facing portalable surfaces, high enough to clear the chain
      add(cx + rr(-2, 2), rr(13.5, 16), 0, rr(7, 11), 0.5, halfW * 2, WALL);
    }
    lamps.push({ c: [cx + segLen * 0.3, rr(4.5, 6.5), (rng() < 0.5 ? -1 : 1) * (halfW - 0.7)], color: pick([0x9fd8ff, 0xffd9a8]) });
    if (rng() < 0.35) rings.push({ c: [cx + rr(-4, 4), rr(2.5, 6), rr(-3, 3)], r: rr(1.6, 2.8), color: pick([0x2eeaff, 0xb45cff, 0xff9a3d]) });
    endX += segLen;
  }
  add(endX + 0.3, 6, 0, 0.6, 13, halfW * 2, WALL); // end cap
  const spawn = { x: x0 + 4, y: 0.05, z: 0 };

  /* ---------------- tilted portal-test panels near the start ----------- */
  for (let i = 0; i < ri(2, 3); i++) {
    const px = x0 + rr(8, 16), s = pick([-1, 1]), ang = rr(15, 34) * Math.PI / 180;
    add(px, 2.4, s * (halfW - 1.2), 0.5, 5.6, rr(3.5, 5), WALL, 0, ang); // leaning panels: portals on non-axis faces
  }

  /* ---------------- ascending ledge chain ------------------------------- */
  let lx = x0 + rr(11, 14), ly = rr(1.7, 2.2), side = pick([-1, 1]);
  let lz = side * rr(2.5, 4.0);
  let lastLedge = { x: lx, y: ly, z: lz };
  while (lx < endX - 16) {
    add(lx, ly - 0.25, lz, rr(3.8, 5.2), 0.5, rr(3.4, 4.6), PLAT);
    lastLedge = { x: lx, y: ly, z: lz };
    const nextX = lx + rr(8.5, 12.5);
    if (nextX < endX - 14 && rng() < 0.38) {
      // LAUNCH SECTION: orange pad overhead + jump ramp; big rise to next ledge
      const padY = Math.min(ly + rr(5.6, 6.2), 8.9);   // underside; stays clear of ceiling slabs (≥13.25)
      const padX = lx + rr(5.5, 7.5), padZ = -lz * 0.6;
      add(padX, padY + 0.25, padZ, rr(3.4, 4.0), 0.5, rr(3.4, 4.0), GANTRY);
      // jump ramp: from corridor floor up to ~4 m near the pad
      const rlen = 7.5, rang = Math.atan2(rr(3.6, 4.2), rlen);
      add(padX - rr(3.5, 5), Math.tan(rang) * rlen / 2, padZ + rr(-1, 1), rlen / Math.cos(rang), 0.45, rr(2.6, 3.2), RAMP, 0, rang);
      hints.push({ min: [padX - 9, -1, padZ - 8], max: [padX + 9, padY + 6, padZ + 8],
        msg: 'LAUNCH PAD — portal A on the corridor floor below, portal B on the orange pad overhead. Climb the ramp and leap into A: your fall speed comes back as a launch above the pad.' });
      lx = padX + rr(3.5, 5); ly = Math.min(padY + rr(1.6, 2.4), 11.3); // next ledge just above the pad apex zone
    } else {
      lx = nextX; ly += rr(1.05, 1.5);                 // normal climb: jumpable rise
    }
    side = -side; lz = side * rr(2.5, 4.2);
    if (ly > 11.5) { lx = endX - 9; break; }           // chain height cap keeps clear of ceilings
  }

  /* ---------------- exit platform, guaranteed reachable from the chain --- */
  // final approach ledge within jump reach of the last placed ledge, then the
  // golden exit pad just above/behind it — no unreachable floating exits.
  const ax = Math.min(lastLedge.x + rr(3.6, 4.8), endX - 4);
  const az = pick([-1, 1]) * rr(2, 3.5);
  const ay = lastLedge.y + rr(0.7, 1.15);
  add(ax, ay - 0.28, az, rr(4.2, 5.4), 0.55, rr(4, 5), PLAT);
  const ex = ax + rr(2.6, 3.6), ez = az * 0.7, ey = ay + rr(0.8, 1.25);
  add(ex, ey - 0.3, ez, rr(4.6, 5.8), 0.6, rr(4.2, 5.2), GANTRY);
  // support strut down to the floor (visual anchor; not a climbable path)
  add(ex, (ey - 0.6) / 2, ez, 1.2, ey - 0.6, 1.2, WALL);
  const exit = { x: ex, y: ey + 0.05, z: ez };
  hints.push({ min: [ex - 9, ey - 8, ez - 9], max: [ex + 9, ey + 10, ez + 9],
    msg: 'EXIT — the golden pad up ahead. Keep climbing the ledge chain; use launch pads (orange) for the big rises.' });

  hints.push({ min: [x0, -1, -halfW], max: [x0 + 26, 6, halfW],
    msg: 'CORRIDOR TEST — portals stick to walls (vertical), ceiling slabs (down-facing), ramps and the leaning colored panels at odd angles. The ledge chain climbs higher as you go.' });

  /* ---------------- exterior scenery ------------------------------------ */
  const pillars = [];
  for (let s = -1; s <= 1; s += 2) {
    let px = x0 - 6;
    while (px < endX + 14) {
      px += rr(12, 22);
      const pz = s * rr(halfW + 8, halfW + 26);
      const ph = rr(8, 26), ps = rr(2.5, 5);
      pillars.push({ c: [px, -12 + (ph + 12) / 2, pz], s: [ps, ph, ps] });
      if (rng() < 0.5) rings.push({ c: [px, rr(6, 14), pz], r: rr(2, 5), color: pick([0x2eeaff, 0xb45cff]) });
    }
  }

  return { seed: seedStr, slabs, pillars, rings, lamps, hints, spawn, exit };
}

/* ==========================================================================
   GAME — THREE runtime
   ========================================================================== */
let TH = null; // three namespace

function start(ns) {
  TH = ns;
  const V3 = TH.Vector3, M4 = TH.Matrix4;

  /* ------------------------------------------------ renderer / scene core */
  const canvas = document.getElementById('gl');
  const renderer = new TH.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  if ('outputColorSpace' in renderer) renderer.outputColorSpace = TH.SRGBColorSpace;
  else if (TH.sRGBEncoding) renderer.outputEncoding = TH.sRGBEncoding;
  renderer.toneMapping = TH.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;

  const scene = new TH.Scene();
  scene.fog = new TH.FogExp2(0x1c2a44, 0.008);

  const camera = new TH.PerspectiveCamera(115, innerWidth / innerHeight, 0.05, 900);
  let baseFov = 115;

  const skyGroup = new TH.Group(); scene.add(skyGroup);
  let worldGroup = null; // rebuilt on new map

  /* lights */
  scene.add(new TH.HemisphereLight(0x8fb4e8, 0x3a4a66, 1.1));
  const sun = new TH.DirectionalLight(0xfff2dc, 1.9); sun.position.set(36, 64, 22); scene.add(sun);
  const rimL = new TH.DirectionalLight(0x7fa8ff, 0.8); rimL.position.set(-48, 18, -34); scene.add(rimL);
  scene.add(new TH.AmbientLight(0x9fb8ff, 0.35));

  /* environment reflections (procedural) */
  try {
    const pmrem = new TH.PMREMGenerator(renderer);
    const envScene = new TH.Scene();
    const g = new TH.BoxGeometry(1, 1, 1);
    const addEnv = (col, pos, sc) => {
      const m = new TH.Mesh(g, new TH.MeshBasicMaterial({ color: col }));
      m.position.set(...pos); m.scale.set(...sc); envScene.add(m);
    };
    addEnv(0x0a1428, [0, 0, 0], [400, 400, 400]);
    addEnv(0x2eeaff, [-60, 90, -40], [120, 0.5, 120]);
    addEnv(0xff9a3d, [70, 40, 60], [80, 0.5, 80]);
    addEnv(0x8f6bff, [0, -80, 0], [200, 0.5, 200]);
    scene.environment = pmrem.fromScene(envScene, 0.04).texture;
    pmrem.dispose();
  } catch (e) { /* older three: skip env map */ }

  /* sky dome + stars */
  {
    const domeMat = new TH.ShaderMaterial({
      side: TH.BackSide, depthWrite: false, fog: false,
      vertexShader: `varying vec3 vP; void main(){ vP=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
      fragmentShader: `varying vec3 vP;
        void main(){
          float h = vP.y*0.5+0.5;
          vec3 lo = vec3(0.060,0.095,0.170);
          vec3 mid= vec3(0.130,0.230,0.420);
          vec3 hi = vec3(0.045,0.070,0.140);
          vec3 col = mix(lo, mid, smoothstep(0.35,0.5,h));
          col = mix(col, hi, smoothstep(0.55,1.0,h));
          gl_FragColor = vec4(col,1.0);
        }`
    });
    skyGroup.add(new TH.Mesh(new TH.SphereGeometry(620, 24, 12), domeMat));
    const n = 1300, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u) * 580;
      pos[i * 3] = Math.cos(a) * r; pos[i * 3 + 1] = Math.abs(u) * r; pos[i * 3 + 2] = Math.sin(a) * r;
    }
    const stGeo = new TH.BufferGeometry();
    stGeo.setAttribute('position', new TH.BufferAttribute(pos, 3));
    skyGroup.add(new TH.Points(stGeo, new TH.PointsMaterial({ color: 0xcfe4ff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.85 })));
  }

  /* abyss floor (visual only) */
  {
    const tex = gridTexture(0x04060c, 0x1a3a55, 0x2eeaff, 0.12);
    tex.repeat.set(90, 90);
    const m = new TH.Mesh(new TH.PlaneGeometry(700, 700),
      new TH.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0x1a4a66, emissiveIntensity: 0.35, metalness: 0.2, roughness: 0.9 }));
    m.rotation.x = -Math.PI / 2; m.position.y = -12.5; skyGroup.add(m);
  }

  /* --------------------------------------------------------------- audio */
  let ac = null, muted = false;
  function ensureAudio() { if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} } }
  function tone(f0, f1, dur, type = 'sine', vol = 0.12, when = 0) {
    if (!ac || muted) return;
    const t0 = ac.currentTime + when;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(ac.destination); o.start(t0); o.stop(t0 + dur + 0.02);
  }

  /* ------------------------------------------------------------- textures */
  function gridTexture(base, line, glow, alpha) {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = base; g.fillRect(0, 0, 512, 512);
    g.strokeStyle = line; g.lineWidth = 3; g.globalAlpha = 0.9;
    for (let i = 0; i <= 8; i++) { const p = i * 64 + 0.5; g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 512); g.moveTo(0, p); g.lineTo(512, p); g.stroke(); }
    g.globalAlpha = 0.35; g.lineWidth = 1;
    for (let i = 0; i <= 32; i++) { const p = i * 16 + 0.5; g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 512); g.moveTo(0, p); g.lineTo(512, p); g.stroke(); }
    g.globalAlpha = alpha; g.fillStyle = glow;
    for (let i = 0; i <= 8; i++) { const p = i * 64 - 1.5; g.fillRect(p, 0, 3, 512); g.fillRect(0, p, 512, 3); }
    const t = new TH.CanvasTexture(c);
    t.wrapS = t.wrapT = TH.RepeatWrapping;
    if ('colorSpace' in t) t.colorSpace = TH.SRGBColorSpace;
    return t;
  }

  function makeSlabMat(kind) {
    const defs = {
      plat:   { base: '#1a2f4d', line: '#3f86c4', glow: '#4df0ff', emissive: 0x2fb4dd, edge: 0x2eeaff },
      ramp:   { base: '#2b2547', line: '#7a63b8', glow: '#c98cff', emissive: 0x9a5df0, edge: 0xb45cff },
      wall:   { base: '#22314e', line: '#4d6ea0', glow: '#7ab4ff', emissive: 0x4a86e8, edge: 0x4a9aff },
      gantry: { base: '#3a2b22', line: '#a0763f', glow: '#ffb45c', emissive: 0xf08c32, edge: 0xff9a3d },
      tower:  { base: '#16304e', line: '#3f7fa8', glow: '#4df0ff', emissive: 0x28a0d8, edge: 0x6adfff },
    };
    const d = defs[kind] || defs.plat;
    const tex = gridTexture(d.base, d.line, d.glow, 0.22);
    tex.repeat.set(2.5, 2.5);
    return { mat: new TH.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: d.emissive, emissiveIntensity: 0.85, metalness: 0.45, roughness: 0.3, envMapIntensity: 1.3 }), edge: d.edge };
  }

  /* =======================================================================
     WORLD BUILD from map data
     ======================================================================= */
  let obbs = [];        // colliders {c:V3, he:[hx,hy,hz], ax:[X,Y,Z], rad}
  const exitPos = new V3(), spawnPt = new V3();
  let hintZones = [], ringMeshes = [], beacon = null;

  function clearWorld() {
    if (!worldGroup) return;
    scene.remove(worldGroup);
    worldGroup.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { for (const k of ['map', 'emissiveMap']) if (m[k]) m[k].dispose(); m.dispose(); });
    });
    worldGroup = null; obbs = []; ringMeshes = [];
  }

  function addSlabRec(rec) {
    const [sx, sy, sz] = rec.s;
    const geo = new TH.BoxGeometry(sx, sy, sz);
    const { mat, edge } = makeSlabMat(rec.kind);
    const mesh = new TH.Mesh(geo, mat);
    mesh.position.set(...rec.c);
    mesh.rotation.order = 'YZX';
    mesh.rotation.set(0, rec.ry || 0, rec.rz || 0);
    worldGroup.add(mesh);
    const eg = new TH.LineSegments(new TH.EdgesGeometry(geo),
      new TH.LineBasicMaterial({ color: edge, transparent: true, opacity: 0.42 }));
    eg.position.copy(mesh.position); eg.rotation.copy(mesh.rotation);
    worldGroup.add(eg);
    const e = new TH.Euler(0, rec.ry || 0, rec.rz || 0, 'YZX');
    const q = new TH.Quaternion().setFromEuler(e);
    const ax = [new V3(1, 0, 0).applyQuaternion(q), new V3(0, 1, 0).applyQuaternion(q), new V3(0, 0, 1).applyQuaternion(q)];
    const rad = Math.hypot(sx, sy, sz) / 2 + 3; // broad-phase radius incl. player
    obbs.push({ c: new V3(...rec.c), he: [sx / 2, sy / 2, sz / 2], ax, rad });
  }

  function buildExitFx(ex) {
    const col = 0xffc24d;
    const ringM = new TH.Mesh(new TH.TorusGeometry(1.35, 0.09, 10, 48),
      new TH.MeshStandardMaterial({ color: 0x222222, emissive: col, emissiveIntensity: 2.6, metalness: 0.4, roughness: 0.3 }));
    ringM.rotation.x = Math.PI / 2; ringM.position.set(ex.x, ex.y + 0.12, ex.z);
    worldGroup.add(ringM);
    const ringM2 = ringM.clone(); ringM2.scale.set(0.55, 0.55, 0.55); worldGroup.add(ringM2);
    const beamMat = new TH.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.16, blending: TH.AdditiveBlending, depthWrite: false });
    const beam = new TH.Mesh(new TH.CylinderGeometry(0.14, 0.32, 70, 10, 1, true), beamMat);
    beam.position.set(ex.x, ex.y + 35, ex.z); worldGroup.add(beam);
    const pl = new TH.PointLight(col, 2.6, 14); pl.position.set(ex.x, ex.y + 1.2, ex.z); worldGroup.add(pl);
    beacon = { ring: ringM, ring2: ringM2, beam };
  }

  function buildDecor(map) {
    const pillarTex = gridTexture('#14203a', '#2c4d78', '#4df0ff', 0.16); pillarTex.repeat.set(2, 4);
    const matP = new TH.MeshStandardMaterial({ color: 0x1a2b48, metalness: 0.5, roughness: 0.45, map: pillarTex });
    for (const p of map.pillars) {
      const m = new TH.Mesh(new TH.BoxGeometry(...p.s), matP);
      m.position.set(...p.c); worldGroup.add(m);
    }
    // corridor lamps: emissive fixture + warm/cool point light (bounded for perf)
    const lampGeo = new TH.SphereGeometry(0.16, 10, 8);
    let litCount = 0;
    for (const l of map.lamps) {
      const lm = new TH.Mesh(lampGeo, new TH.MeshStandardMaterial({ color: 0x000000, emissive: l.color, emissiveIntensity: 3.4 }));
      lm.position.set(...l.c); worldGroup.add(lm);
      if (litCount < 12) { // cap dynamic lights
        const pl = new TH.PointLight(l.color, 2.4, 20, 1.6);
        pl.position.set(...l.c); worldGroup.add(pl); litCount++;
      }
    }
    for (const r of map.rings) {
      const m = new TH.Mesh(new TH.TorusGeometry(r.r, 0.07, 8, 56),
        new TH.MeshStandardMaterial({ color: 0x111111, emissive: r.color, emissiveIntensity: 2.2, metalness: 0.3, roughness: 0.4 }));
      m.position.set(...r.c); m.rotation.set(Math.random() * 0.6 - 0.3, Math.random() * Math.PI, Math.random() * 0.6 - 0.3);
      m.userData.spin = (Math.random() < 0.5 ? -1 : 1) * (0.05 + Math.random() * 0.12);
      worldGroup.add(m); ringMeshes.push(m);
    }
  }

  /* =======================================================================
     PLAYER & INPUT
     ======================================================================= */
  const CFG = {
    G: 24, R: 0.34, H: 1.7,
    GMAX: 7.6, WALK: 3.4, AIRCAP: 42,
    AACC: 12, GACC: 60, FR: 7, JUMPV: 8.6,
    COYOTE: 0.09, BUFFER: 0.11,
  };
  const pl = { pos: new V3(), vel: new V3(), yaw: 0, pitch: 0, grounded: false, groundT: -1, jumpBuf: -1, cp: new V3(), maxSpeed: 0 };

  let autohop = true, started = false, won = false;
  let nowT = 0, runTime = 0, timerOn = false, portalsFired = 0;
  const keys = {};
  let pointerLocked = false;

  const dom = id => document.getElementById(id);
  const startPanel = dom('startpanel'), menuPanel = dom('menupanel'), winPanel = dom('winpanel');

  function requestLock() { canvas.requestPointerLock && canvas.requestPointerLock(); }
  document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === canvas;
    if (!pointerLocked && started && !won) menuPanel.classList.remove('hidden');
    else menuPanel.classList.add('hidden');
  });
  canvas.addEventListener('click', () => { ensureAudio(); if (started && !pointerLocked && !won) requestLock(); });

  document.addEventListener('mousemove', e => {
    if (!pointerLocked) return;
    pl.yaw -= e.movementX * 0.0023;
    pl.pitch = Math.max(-1.55, Math.min(1.55, pl.pitch - e.movementY * 0.0023));
  });

  document.addEventListener('mousedown', e => {
    if (!pointerLocked || won) return;
    ensureAudio();
    if (e.button === 0) firePortal(0);
    else if (e.button === 2) firePortal(1);
  });
  document.addEventListener('contextmenu', e => e.preventDefault());

  document.addEventListener('keydown', e => {
    const c = e.code;
    if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'BracketLeft', 'BracketRight'].includes(c)) e.preventDefault();
    keys[c] = true;
    if (!started) return;
    if (c === 'Space') pl.jumpBuf = nowT;
    if (c === 'KeyV') { autohop = !autohop; dom('hopinf').textContent = autohop ? 'on' : 'off'; syncHopBtn(); }
    if (c === 'KeyF') toggleFullscreen();
    if (c === 'KeyR') respawn(false);
    if (c === 'KeyN') newMap(String(Math.floor(Math.random() * 1e9)));
    if (c === 'KeyM') { muted = !muted; dom('muteinf').textContent = muted ? 'off' : 'on'; syncMuteBtn(); }
    if (c === 'BracketLeft') setFov(baseFov - 5);
    if (c === 'BracketRight') setFov(baseFov + 5);
  });
  document.addEventListener('keyup', e => { keys[e.code] = false; });

  function toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen();
  }
  function setFov(f) {
    baseFov = Math.max(90, Math.min(135, Math.round(f)));
    dom('fovinf').textContent = baseFov;
    dom('fovslider').value = baseFov; dom('fovval').textContent = baseFov;
    dom('fovslider2').value = baseFov; dom('fovval2').textContent = baseFov;
  }
  dom('fovslider').addEventListener('input', e => setFov(+e.target.value));
  dom('fovslider2').addEventListener('input', e => setFov(+e.target.value));
  function syncHopBtn() { const b = dom('btnhop'); if (b) b.textContent = 'AUTOHOP: ' + (autohop ? 'ON' : 'OFF'); }
  function syncMuteBtn() { const b = dom('btnmute'); if (b) b.textContent = 'SOUND: ' + (muted ? 'OFF' : 'ON'); const i = dom('muteinf'); if (i) i.textContent = muted ? 'off' : 'on'; }
  dom('btnhop').addEventListener('click', () => { autohop = !autohop; syncHopBtn(); dom('hopinf').textContent = autohop ? 'on' : 'off'; });
  dom('btnmute').addEventListener('click', () => { muted = !muted; syncMuteBtn(); });
  dom('btnfs').addEventListener('click', toggleFullscreen);
  dom('btnstart').addEventListener('click', () => {
    const s = dom('seedinput').value.trim() || String(Math.floor(Math.random() * 1e9));
    started = true; startPanel.classList.add('hidden');
    loadMap(s); requestLock();
  });
  dom('btnresume').addEventListener('click', requestLock);
  dom('btnnewmap').addEventListener('click', () => {
    const s = dom('seedinput2').value.trim() || String(Math.floor(Math.random() * 1e9));
    loadMap(s); menuPanel.classList.add('hidden'); requestLock();
  });
  dom('btnagain').addEventListener('click', () => newMap(String(Math.floor(Math.random() * 1e9))));
  dom('btnsame').addEventListener('click', () => { loadMap(currentSeed); winPanel.classList.add('hidden'); requestLock(); });

  /* =======================================================================
     PORTALS
     ======================================================================= */
  const PORT = { hw: 0.85, hh: 1.15 }; // mouth half-extents -> 1.7 x 2.3 m
  const portals = [mkPortal(0x2eeaff), mkPortal(0xff9a3d)];
  function mkPortal(color) { return { placed: false, c: new V3(), n: new V3(), r: new V3(), u: new V3(), color }; }

  const portalGroup = new TH.Group(); scene.add(portalGroup);
  const quadMats = [], quads = [], frames = [], glowLights = [];
  for (let i = 0; i < 2; i++) {
    const m = portalShaderMat(portals[i].color);
    quadMats.push(m);
    const q = new TH.Mesh(new TH.PlaneGeometry(PORT.hw * 2, PORT.hh * 2), m);
    q.renderOrder = 5; quads.push(q); portalGroup.add(q);
    const fr = new TH.Mesh(new TH.TorusGeometry(1, 0.035, 8, 64),
      new TH.MeshBasicMaterial({ color: portals[i].color, transparent: true, opacity: 0.9, blending: TH.AdditiveBlending, depthWrite: false }));
    fr.scale.set(PORT.hw + 0.05, PORT.hh + 0.05, 1);
    frames.push(fr); portalGroup.add(fr);
    const lt = new TH.PointLight(portals[i].color, 2.4, 9); glowLights.push(lt); portalGroup.add(lt);
  }

  function portalShaderMat(color) {
    return new TH.ShaderMaterial({
      transparent: true, side: TH.DoubleSide, depthWrite: false,
      uniforms: { uTex: { value: null }, uColor: { value: new TH.Color(color) }, uTime: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `
        uniform sampler2D uTex; uniform vec3 uColor; uniform float uTime; varying vec2 vUv;
        void main(){
          vec2 p = vUv*2.0-1.0;
          float e = length(p);
          if(e>1.0) discard;
          vec4 tex = texture2D(uTex, vUv);
          float rim  = smoothstep(1.0, 0.72, e);
          float edge = smoothstep(0.86, 1.0, e);
          float ang = atan(p.y, p.x);
          float arcs = 0.5+0.5*sin(ang*3.0 + uTime*4.0 + sin(e*10.0-uTime*6.0)*2.0);
          float pulse = 0.85 + 0.15*sin(uTime*7.0);
          vec3 col = tex.rgb;
          col += uColor * edge * (1.6+arcs) * pulse;
          col += uColor * pow(1.0-e,2.0) * 0.10;
          float alpha = rim*0.98 + edge*0.6;
          gl_FragColor = vec4(col, clamp(alpha,0.0,1.0));
        }`
    });
  }

  function frameFor(n) {
    const r = new V3();
    const ref = Math.abs(n.y) > 0.98 ? new V3(0, 0, 1) : new V3(0, 1, 0);
    r.crossVectors(ref, n).normalize();
    if (r.lengthSq() < 1e-8) r.set(1, 0, 0);
    const u = new V3().crossVectors(n, r);
    return { r, u };
  }

  /* pair transform matrices A->B and B->A (orthonormal rotations) */
  let R_AB = new M4(), R_BA = new M4();
  function updatePair() {
    const fA = frameFor(portals[0].n), fB = frameFor(portals[1].n);
    const mA = new M4().makeBasis(fA.r, fA.u, portals[0].n);
    const mB = new M4().makeBasis(fB.r, fB.u, portals[1].n);
    R_AB = new M4().multiplyMatrices(mB, new M4().copy(mA).transpose());
    R_BA = new M4().copy(R_AB).transpose();
  }

  function tryPlace(pi, hit) {
    const P = portals[pi];
    const n = hit.normal.clone().normalize();
    const c = hit.point.clone().addScaledVector(n, 0.02);
    const f = frameFor(n);
    /* the whole mouth must fit on the hit face: half-extent of the rotated
       rectangle along each OBB axis must stay inside that face */
    let ok = true;
    for (let k = 0; k < 3 && ok; k++) {
      const ext = PORT.hw * Math.abs(f.r.dot(hit.obb.ax[k])) + PORT.hh * Math.abs(f.u.dot(hit.obb.ax[k]));
      if (ext > hit.obb.he[k] - 0.04) ok = false;
    }
    if (!ok) { tone(220, 120, 0.15, 'square', 0.06); return false; }
    /* no overlapping placement on the same face */
    const Q = portals[1 - pi];
    if (Q.placed) {
      const sameFace = Math.abs(n.dot(Q.n)) > 0.999 && Math.abs(c.clone().sub(Q.c).dot(n)) < 0.08;
      if (sameFace) {
        const d = c.clone().sub(Q.c);
        const du = Math.abs(d.dot(f.r)), dv = Math.abs(d.dot(f.u));
        if (du < PORT.hw * 2 + 0.35 && dv < PORT.hh * 2 + 0.35) { tone(220, 120, 0.15, 'square', 0.06); return false; }
      }
    }
    P.placed = true; P.c.copy(c); P.n.copy(n); P.r.copy(f.r); P.u.copy(f.u);
    updatePair();
    tone(700, 1400, 0.09, 'sine', 0.08); tone(1400, 2400, 0.12, 'triangle', 0.05, 0.03);
    return true;
  }

  /* ray vs all OBBs -> nearest {point, normal, obb} */
  function raycast(origin, dir, maxDist) {
    let best = null, bestT = maxDist;
    for (const obb of obbs) {
      if (origin.distanceTo(obb.c) - obb.rad > maxDist) continue;
      const ox = origin.x - obb.c.x, oy = origin.y - obb.c.y, oz = origin.z - obb.c.z;
      let tmin = -1e9, tmax = 1e9, hitAxis = -1, hitSign = 0, par = false;
      for (let k = 0; k < 3; k++) {
        const a = obb.ax[k];
        const o = ox * a.x + oy * a.y + oz * a.z;
        const vd = dir.dot(a);
        if (Math.abs(vd) < 1e-7) {
          if (Math.abs(o) > obb.he[k]) { par = true; break; }
        } else {
          let t0 = (-obb.he[k] - o) / vd, t1 = (obb.he[k] - o) / vd, s = -1;
          if (t0 > t1) { const tt = t0; t0 = t1; t1 = tt; s = 1; }
          if (t0 > tmin) { tmin = t0; hitAxis = k; hitSign = s * Math.sign(vd); }
          if (t1 < tmax) tmax = t1;
          if (tmin > tmax) { par = true; break; }
        }
      }
      if (par || hitAxis < 0 || tmin < 0.02 || tmin > bestT) continue;
      const point = origin.clone().addScaledVector(dir, tmin);
      const normal = obb.ax[hitAxis].clone().multiplyScalar(-hitSign);
      best = { point, normal, obb }; bestT = tmin;
    }
    return best;
  }

  function firePortal(pi) {
    const dir = new V3(); camera.getWorldDirection(dir);
    const hit = raycast(camera.position.clone(), dir, 140);
    if (!hit) { tone(180, 90, 0.1, 'square', 0.05); return; }
    portalsFired++;
    tryPlace(pi, hit);
    muzzleFlash(pi);
  }

  /* =======================================================================
     MOVEMENT & COLLISION (capsule vs OBB)
     ======================================================================= */
  function wishDir() {
    const f = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
    const s = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    if (!f && !s) return null;
    const fwd = new V3(-Math.sin(pl.yaw), 0, -Math.cos(pl.yaw));
    const right = new V3(-fwd.z, 0, fwd.x);
    const w = fwd.multiplyScalar(f).add(right.multiplyScalar(s));
    if (w.lengthSq() < 1e-6) return null;
    return w.normalize();
  }

  function accelerate(v, wish, acc, maxs, dt) {
    if (!wish) return;
    const cur = v.dot(wish);
    const add = Math.max(0, maxs - cur);
    if (add <= 0) return;
    v.addScaledVector(wish, Math.min(add, acc * dt));
  }

  function applyFriction(v, dt) {
    if (!pl.grounded) return;
    const speed = Math.hypot(v.x, v.z);
    if (speed < 0.02) { v.x = 0; v.z = 0; return; }
    const f = Math.max(0, speed - speed * CFG.FR * dt) / speed;
    v.x *= f; v.z *= f;
  }

  function physStep(dt) {
    if (pl.grounded) pl.groundT = nowT;
    const wish = wishDir();
    applyFriction(pl.vel, dt);
    const wantWalk = keys.ShiftLeft || keys.ShiftRight;
    if (pl.grounded) accelerate(pl.vel, wish, CFG.GACC, wantWalk ? CFG.WALK : CFG.GMAX, dt);
    else if (wish) accelerate(pl.vel, wish, CFG.AACC, CFG.AIRCAP, dt);

    const canJump = pl.grounded || (nowT - pl.groundT) < CFG.COYOTE;
    const buffered = pl.jumpBuf >= 0 && (nowT - pl.jumpBuf) < CFG.BUFFER;
    const holdJump = autohop && keys.Space && pl.grounded;
    if ((buffered || holdJump) && canJump) {
      pl.vel.y = CFG.JUMPV;
      pl.grounded = false; pl.groundT = -1; pl.jumpBuf = -1;
      tone(340, 520, 0.06, 'triangle', 0.04);
    }

    pl.vel.y -= CFG.G * dt;
    if (pl.vel.y < -60) pl.vel.y = -60;

    const prev = capsuleSamples();
    pl.pos.addScaledVector(pl.vel, dt);
    collide();
    teleportCheck(prev);

    const sp = Math.hypot(pl.vel.x, pl.vel.z);
    if (sp > pl.maxSpeed) pl.maxSpeed = sp;
  }

  function capsuleSamples() {
    return [pl.pos.y + CFG.R, pl.pos.y + CFG.H * 0.5, pl.pos.y + CFG.H - CFG.R]; // sample heights
  }

  let landingThump = 0;

  function collide() {
    pl.grounded = false;
    const p = pl.pos;
    const hs = capsuleSamples();
    for (const obb of obbs) {
      if ((p.x - obb.c.x) ** 2 + (p.y - obb.c.y) ** 2 + (p.z - obb.c.z) ** 2 > obb.rad * obb.rad) continue;
      for (let si = 0; si < 3; si++) {
        const sy = hs[si];
        // local coords of sample
        const dx = p.x - obb.c.x, dy = sy - obb.c.y, dz = p.z - obb.c.z;
        const lc = [dx * obb.ax[0].x + dy * obb.ax[0].y + dz * obb.ax[0].z,
                    dx * obb.ax[1].x + dy * obb.ax[1].y + dz * obb.ax[1].z,
                    dx * obb.ax[2].x + dy * obb.ax[2].y + dz * obb.ax[2].z];
        const inside = Math.abs(lc[0]) < obb.he[0] && Math.abs(lc[1]) < obb.he[1] && Math.abs(lc[2]) < obb.he[2];
        let n, depth;
        if (inside) {
          // deepest-penetration axis (least of the negatives) -> push out to surface + R
          let kBest = 0, best = -Infinity;
          for (let k = 0; k < 3; k++) { const over = Math.abs(lc[k]) - obb.he[k]; if (over > best) { best = over; kBest = k; } }
          n = obb.ax[kBest].clone().multiplyScalar(Math.sign(lc[kBest]) || 1);
          depth = obb.he[kBest] - Math.abs(lc[kBest]) + CFG.R;
        } else {
          // closest point on box surface
          const q = new V3();
          for (let k = 0; k < 3; k++) q.addScaledVector(obb.ax[k], Math.max(-obb.he[k], Math.min(obb.he[k], lc[k])));
          const cp = obb.c.clone().add(q);
          const dvec = new V3(p.x - cp.x, sy - cp.y, p.z - cp.z);
          const dist = dvec.length();
          if (dist >= CFG.R || dist < 1e-7) continue;
          n = dvec.divideScalar(dist);
          depth = CFG.R - dist;
        }
        /* portal holes punch through the contact */
        let hole = false;
        for (const P of portals) {
          if (!P.placed || Math.abs(n.dot(P.n)) < 0.8) continue;
          const du = Math.abs((p.x - P.c.x) * P.r.x + (sy - P.c.y) * P.r.y + (p.z - P.c.z) * P.r.z);
          const dv = Math.abs((p.x - P.c.x) * P.u.x + (sy - P.c.y) * P.u.y + (p.z - P.c.z) * P.u.z);
          const dn = Math.abs((p.x - P.c.x) * P.n.x + (sy - P.c.y) * P.n.y + (p.z - P.c.z) * P.n.z);
          if (du < PORT.hw - 0.12 && dv < PORT.hh - 0.12 && dn < 0.9) { hole = true; break; }
        }
        if (hole) continue;
        p.addScaledVector(n, depth + 0.0005);
        const vn = pl.vel.dot(n);
        if (vn < 0) pl.vel.addScaledVector(n, -vn);
        if (n.y > 0.5) {
          if (!pl.grounded && vn < -6) landingThump = Math.min(1, -vn / 24);
          pl.grounded = true;
        }
      }
    }
    if (p.y < -13.5) respawn(true);
  }

  let tpGracePortal = null, tpGraceT = -1; // ignore re-crossings at the portal we just exited (brief)
  function teleportCheck(prevHeights) {
    const p0 = portals[0], p1 = portals[1];
    if (!(p0.placed && p1.placed)) return;
    const hsNow = capsuleSamples();
    for (let pi = 0; pi < 2; pi++) {
      const P = pi === 0 ? p0 : p1, Q = pi === 0 ? p1 : p0;
      if (tpGracePortal === P && nowT - tpGraceT < 0.12) continue;
      for (let si = 0; si < 3; si++) {
        const yA = prevHeights[si], yB = hsNow[si];
        // signed distance of sample point to plane P along P.n
        const dx0 = pl.pos.x - P.c.x, dz0 = pl.pos.z - P.c.z;
        const base = dx0 * P.n.x + dz0 * P.n.z;
        const a = base + (yA - P.c.y) * P.n.y;
        const b = base + (yB - P.c.y) * P.n.y;
        if ((a > 0) !== (b > 0)) {
          const t = Math.max(0, Math.min(1, a / (a - b)));
          const cy = yA + (yB - yA) * t;
          // crossing point uses current x,z (substep displacement is small)
          const du = Math.abs((pl.pos.x - P.c.x) * P.r.x + (cy - P.c.y) * P.r.y + (pl.pos.z - P.c.z) * P.r.z);
          const dv = Math.abs((pl.pos.x - P.c.x) * P.u.x + (cy - P.c.y) * P.u.y + (pl.pos.z - P.c.z) * P.u.z);
          if (du <= PORT.hw - 0.05 && dv <= PORT.hh - 0.05) {
            doTeleport(pi === 0 ? R_AB : R_BA, P, Q, si);
            return; // one teleport per substep
          }
        }
      }
    }
  }

  const _tpFlash = document.getElementById('flash');
  function doTeleport(R, P, Q, si) {
    // velocity rotated by the pair transform: magnitude preserved, direction becomes the exit mouth's frame
    pl.vel.applyMatrix4(R);
    // position mapped through the same rotation about the portal centers
    const rel = new V3().subVectors(pl.pos, P.c).applyMatrix4(R);
    pl.pos.copy(Q.c).add(rel);
    // the crossing sample sits exactly on the exit plane; push the capsule so that
    // sample clears the mouth — otherwise (e.g. floor->floor) you emerge inside the
    // slab and fall out under the map instead of looping back through the pair
    const offset = [CFG.R, CFG.H * 0.5, CFG.H - CFG.R][si] + 0.05;
    pl.pos.addScaledVector(Q.n, offset);
    tpGracePortal = Q; tpGraceT = nowT;
    tone(280 + Math.random() * 60, 900, 0.22, 'sine', 0.10);
    tone(900, 300, 0.25, 'triangle', 0.06, 0.02);
    _tpFlash.classList.remove('fadeflash'); void _tpFlash.offsetWidth; _tpFlash.classList.add('fadeflash');
  }

  function respawn() {
    pl.pos.copy(pl.cp); pl.vel.set(0, 0, 0);
    tone(120, 60, 0.4, 'sawtooth', 0.08);
  }

  /* =======================================================================
     GUN MODEL attached to camera
     ======================================================================= */
  const gun = new TH.Group();
  {
    const bodyMat = new TH.MeshStandardMaterial({ color: 0x1a2230, metalness: 0.85, roughness: 0.25 });
    const glowA = new TH.MeshStandardMaterial({ color: 0x0affff, emissive: 0x2eeaff, emissiveIntensity: 2.2 });
    const glowB = new TH.MeshStandardMaterial({ color: 0xff8a2a, emissive: 0xff9a3d, emissiveIntensity: 2.2 });
    const body = new TH.Mesh(new TH.BoxGeometry(0.16, 0.14, 0.42), bodyMat);
    const barrel = new TH.Mesh(new TH.CylinderGeometry(0.055, 0.075, 0.3, 12), bodyMat);
    barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.02, -0.3);
    const core = new TH.Mesh(new TH.SphereGeometry(0.045, 12, 8), glowA);
    core.position.set(0, 0.06, -0.05);
    const ring = new TH.Mesh(new TH.TorusGeometry(0.07, 0.012, 8, 24), glowB);
    ring.position.set(0, 0.02, -0.42);
    const prong1 = new TH.Mesh(new TH.BoxGeometry(0.03, 0.16, 0.05), bodyMat); prong1.position.set(-0.09, 0.08, -0.2);
    const prong2 = prong1.clone(); prong2.position.x = 0.09;
    gun.add(body, barrel, core, ring, prong1, prong2);
    gun.userData.core = core; gun.userData.ring = ring;
    gun.position.set(0.3, -0.26, -0.5);
    camera.add(gun); scene.add(camera);
  }
  let muzzleT = 0;
  function muzzleFlash(pi) {
    muzzleT = 1;
    const hex = pi === 0 ? 0x2eeaff : 0xff9a3d;
    gun.userData.core.material.emissive.setHex(hex);
    gun.userData.ring.material.emissive.setHex(hex);
  }

  /* =======================================================================
     PORTAL RENDERING — render target + virtual camera + clip plane
     ======================================================================= */
  /* ping-pong render targets per portal: quad i samples the previous parity's
     texture while the current one is written — no read/write feedback */
  let rts = [[null, null], [null, null]], rtParity = 0;
  function makeRTs() {
    const w = Math.max(256, Math.floor(innerWidth * 0.7)), h = Math.max(256, Math.floor(innerHeight * 0.7));
    for (let i = 0; i < 2; i++) for (let p = 0; p < 2; p++) {
      if (rts[i][p]) rts[i][p].dispose();
      rts[i][p] = new TH.WebGLRenderTarget(w, h, { minFilter: TH.LinearFilter, magFilter: TH.LinearFilter });
    }
  }
  makeRTs();

  /* one persistent global clip plane (parked far away when unused) so shader
     programs compile once; during a portal pass it clips the half-space whose
     preimage would be behind the entry portal — removing ghost geometry */
  const clipPlane = new TH.Plane(new V3(0, 1, 0), 1e6);
  renderer.clippingPlanes = [clipPlane];

  const vcam = new TH.PerspectiveCamera(115, 1, 0.06, 900);
  const rig = new TH.Group(); rig.matrixAutoUpdate = false; scene.add(rig);
  rig.add(vcam);

  function renderPortalViews() {
    if (!(portals[0].placed && portals[1].placed)) return;
    rtParity ^= 1;
    for (let k = 0; k < 2; k++) quadMats[k].uniforms.uTex.value = rts[k][rtParity ^ 1].texture; // stale-safe during passes
    const camPos = camera.position;
    for (let i = 0; i < 2; i++) {
      const P = portals[i], Q = portals[1 - i]; // rt[i] shows the view from portal Q seen through portal i
      const R = i === 0 ? R_AB : R_BA;
      const o = new V3().subVectors(camPos, P.c).applyMatrix4(R).add(Q.c);
      o.addScaledVector(Q.n, 0.12);
      const m = rig.matrix.elements;
      m[0] = Q.r.x; m[4] = Q.u.x; m[8] = -Q.n.x; m[12] = o.x;
      m[1] = Q.r.y; m[5] = Q.u.y; m[9] = -Q.n.y; m[13] = o.y;
      m[2] = Q.r.z; m[6] = Q.u.z; m[10] = -Q.n.z; m[14] = o.z;
      m[3] = 0; m[7] = 0; m[11] = 0; m[15] = 1;
      rig.updateMatrixWorld(true);
      // clip plane: keep the side of entry portal P that the real camera is on, mapped into Q space
      const w = P.n.clone().applyMatrix4(R);
      const dP = (camPos.x - P.c.x) * P.n.x + (camPos.y - P.c.y) * P.n.y + (camPos.z - P.c.z) * P.n.z;
      if (Math.abs(dP) > 0.18) {
        const s = dP >= 0 ? 1 : -1;
        clipPlane.normal.copy(w).multiplyScalar(s);
        clipPlane.constant = -s * w.dot(Q.c) + 0.02;
      } else { parkClip(); }
      quads[0].visible = true; quads[1].visible = true;
      quads[1 - i].visible = false; // hide the quad sitting at the virtual camera (no recursion)
      vcam.fov = baseFov; vcam.aspect = camera.aspect;
      vcam.updateProjectionMatrix();
      renderer.setRenderTarget(rts[i][rtParity]);
      renderer.render(scene, vcam);
    }
    quads[0].visible = portals[0].placed; quads[1].visible = portals[1].placed;
    for (let k = 0; k < 2; k++) quadMats[k].uniforms.uTex.value = rts[k][rtParity].texture; // fresh for main render
    parkClip();
  }
  function parkClip() { clipPlane.normal.set(0, 1, 0); clipPlane.constant = 1e6; }

  function placePortalVisuals() {
    for (let i = 0; i < 2; i++) {
      const P = portals[i];
      if (!P.placed) { quads[i].visible = false; frames[i].visible = false; glowLights[i].intensity = 0; continue; }
      frames[i].visible = true;
      const q = quads[i], f = frames[i], lt = glowLights[i];
      q.position.copy(P.c).addScaledVector(P.n, 0.015);
      const m = new M4().makeBasis(P.r, P.u, P.n);
      q.quaternion.setFromRotationMatrix(m);
      f.position.copy(q.position).addScaledVector(P.n, 0.02);
      f.quaternion.copy(q.quaternion);
      lt.position.copy(P.c).addScaledVector(P.n, 0.5);
      lt.intensity = 2.4;
    }
  }

  /* =======================================================================
     MAP LOADING / RESET
     ======================================================================= */
  let currentSeed = '';
  function loadMap(seedStr) {
    currentSeed = seedStr;
    clearWorld();
    for (const P of portals) P.placed = false;
    placePortalVisuals();
    const map = generateMap(seedStr);
    worldGroup = new TH.Group(); scene.add(worldGroup);
    for (const rec of map.slabs) addSlabRec(rec);
    buildDecor(map);
    buildExitFx(map.exit);
    exitPos.set(map.exit.x, map.exit.y, map.exit.z);
    spawnPt.set(map.spawn.x, map.spawn.y, map.spawn.z);
    hintZones = map.hints.map(h => ({ min: new V3(...h.min), max: new V3(...h.max), msg: h.msg }));
    pl.pos.copy(spawnPt); pl.vel.set(0, 0, 0); pl.cp.copy(spawnPt);
    pl.yaw = -Math.PI / 2; // forward = +x down the course
    pl.pitch = 0; pl.maxSpeed = 0; pl.grounded = false; pl.jumpBuf = -1;
    won = false; runTime = 0; timerOn = false; portalsFired = 0;
    winPanel.classList.add('hidden');
    dom('seedinfo').textContent = seedStr;
  }
  function newMap(s) { loadMap(s); menuPanel.classList.add('hidden'); requestLock(); }

  /* =======================================================================
     HUD
     ======================================================================= */
  const hud = { speed: dom('speedval'), fill: dom('barfill'), hint: dom('hint'), dist: dom('exitdist'), compass: dom('compass'), timer: dom('timer'), aim: dom('aimring') };
  let lastHintMsg = '';
  function updateHUD(dt) {
    const sp = Math.hypot(pl.vel.x, pl.vel.z);
    hud.speed.innerHTML = Math.round(sp * 10) + '<span>u/s</span>';
    hud.fill.style.width = Math.min(100, (sp / 34) * 100) + '%';
    hud.fill.classList.toggle('hot', sp > CFG.GMAX + 2);
    const d = pl.pos.distanceTo(exitPos);
    hud.dist.textContent = Math.round(d);
    const tAng = Math.atan2(exitPos.x - pl.pos.x, exitPos.z - pl.pos.z);
    const fAng = Math.atan2(-Math.sin(pl.yaw), -Math.cos(pl.yaw));
    let rel = tAng - fAng; while (rel > Math.PI) rel -= 2 * Math.PI; while (rel < -Math.PI) rel += 2 * Math.PI;
    hud.compass.style.transform = 'rotate(' + (-rel) + 'rad)';
    if (timerOn && !won) runTime += dt;
    const t = runTime, mm = String(Math.floor(t / 60)).padStart(2, '0'), ss = String(Math.floor(t % 60)).padStart(2, '0'), ms = Math.floor((t * 10) % 10);
    hud.timer.textContent = `${mm}:${ss}.${ms}`;
    let msg = '';
    for (const z of hintZones) {
      if (pl.pos.x > z.min.x && pl.pos.x < z.max.x && pl.pos.y > z.min.y && pl.pos.y < z.max.y && pl.pos.z > z.min.z && pl.pos.z < z.max.z) msg = z.msg;
    }
    if (!msg) {
      if (!portals[0].placed && !portals[1].placed) msg = 'FIRE PORTALS: LMB = blue, RMB = orange — they stick to any flat face (floor / ceiling / wall / ramp).';
      else if (!(portals[0].placed && portals[1].placed)) msg = 'Place the second portal. Speed is conserved through a pair: what falls in, flies out.';
      else msg = 'Hold SPACE and land to bunnyhop — strafe + turn (circle-jump) to build speed past run speed.';
    }
    if (msg !== lastHintMsg) { hud.hint.textContent = msg; lastHintMsg = msg; }
    const dir = new V3(); camera.getWorldDirection(dir);
    const hit = raycast(camera.position.clone(), dir, 140);
    hud.aim.classList.toggle('valid', !!hit);
    if (!won && Math.abs(pl.pos.x - exitPos.x) < 1.9 && Math.abs(pl.pos.z - exitPos.z) < 1.9 && Math.abs((pl.pos.y + CFG.H / 2) - exitPos.y) < 2.4) {
      won = true; document.exitPointerLock();
      tone(523, 523, 0.12, 'triangle', 0.1); tone(659, 659, 0.12, 'triangle', 0.1, 0.12); tone(784, 784, 0.12, 'triangle', 0.1, 0.24); tone(1046, 1046, 0.3, 'triangle', 0.12, 0.36);
      dom('winstats').innerHTML = `time <b>${hud.timer.textContent}</b> · max speed <b>${Math.round(pl.maxSpeed * 10)} u/s</b> · portals fired <b>${portalsFired}</b> · seed <b>${currentSeed}</b>`;
      winPanel.classList.remove('hidden');
    }
  }

  /* =======================================================================
     MAIN LOOP
     ======================================================================= */
  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    let dt = Math.min(0.05, (now - last) / 1000); last = now;
    nowT += dt;

    if (!started) { // idle preview orbit while at menu
      const t = now * 0.00012;
      camera.position.set(-20 + Math.cos(t) * 14, 8, Math.sin(t) * 14);
      camera.lookAt(-20, 2, 0);
    } else if (!won) {
      if (pointerLocked) {
        if ((keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD) && !timerOn) timerOn = true;
        let rem = dt;
        while (rem > 1e-4) { const s = Math.min(rem, 1 / 120); physStep(s); rem -= s; }
      }
      if (pl.grounded && Math.abs(pl.vel.y) < 5) pl.cp.copy(pl.pos); // checkpoint when standing safely
    }

    for (let i = 0; i < 2; i++) {
      quadMats[i].uniforms.uTime.value = now * 0.001;
      // uTex handled inside renderPortalViews (ping-pong)
    }
    placePortalVisuals();
    renderPortalViews();

    muzzleT = Math.max(0, muzzleT - dt * 6);
    gun.scale.setScalar(1 + muzzleT * 0.08);
    gun.userData.core.material.emissiveIntensity = 2.2 + muzzleT * 6;

    if (started) {
      const sp = Math.hypot(pl.vel.x, pl.vel.z);
      camera.position.copy(pl.pos);
      camera.position.y += CFG.H - 0.12; // pl.pos is the feet point — eyes near top of capsule
      let bob = 0;
      if (pl.grounded && sp > 1) bob = Math.sin(now * 0.012 * Math.min(2, sp / 7)) * 0.03 * Math.min(1, sp / CFG.GMAX);
      landingThump = Math.max(0, landingThump - dt * 4);
      camera.position.y += bob - landingThump * 0.18;
      camera.rotation.order = 'YXZ';
      camera.rotation.set(pl.pitch, pl.yaw, 0);
      const wantFov = Math.min(baseFov + 16, baseFov + Math.max(0, (sp - CFG.GMAX) * 0.5));
      if (Math.abs(camera.fov - wantFov) > 0.05) { camera.fov = wantFov; camera.updateProjectionMatrix(); }
    }

    for (const r of ringMeshes) r.rotation.z += r.userData.spin * dt;
    if (beacon) { const s = 1 + 0.06 * Math.sin(now * 0.004); beacon.ring.scale.set(s, s, s); }

    updateHUD(dt);
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  }

  window.addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    makeRTs();
  });

  /* first map (preview behind menu) */
  loadMap(String(Math.floor(Math.random() * 1e9)));
  requestAnimationFrame(frame);
}
