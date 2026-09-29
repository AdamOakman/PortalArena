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
import { generateMap } from '../shared/mapgen.js';
import { CFG, PORT } from '../shared/constants.js';
import { initPhysics } from '../shared/physics.js';

/* ==========================================================================
   GAME — THREE runtime
   ========================================================================== */
let TH = null; // three namespace
let physics = null;

function start(ns) {
  TH = ns;
  physics = initPhysics(TH, CFG, PORT);
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
  renderer.localClippingEnabled = true;

  const scene = new TH.Scene();
  scene.fog = new TH.Fog(0x1c2a44, 100, 300);

  const camera = new TH.PerspectiveCamera(115, innerWidth / innerHeight, 0.001, 300);
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

  // Match background perfectly to fog color to hide clip planes
  scene.background = new TH.Color(0x1c2a44);

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
     WORLD BUILD from map data (Batched for Performance)
     ======================================================================= */
  let obbs = [];        // colliders {c:V3, he:[hx,hy,hz], ax:[X,Y,Z], rad}
  const exitPos = new V3(), spawnPt = new V3();
  let hintZones = [], animObjects = [], beacon = null;

  function clearWorld() {
    if (!worldGroup) return;
    scene.remove(worldGroup);
    worldGroup.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { for (const k of ['map', 'emissiveMap']) if (m[k]) m[k].dispose(); m.dispose(); });
    });
    worldGroup = null; obbs = []; animObjects = [];
  }

  const matCache = {};
  function getSlabMat(kind) {
    if (matCache[kind]) return matCache[kind];
    const defs = {
      plat:   { base: '#1a2f4d', line: '#3f86c4', glow: '#4df0ff', emissive: 0x2fb4dd, edge: 0x2eeaff },
      ramp:   { base: '#2b2547', line: '#7a63b8', glow: '#c98cff', emissive: 0x9a5df0, edge: 0xb45cff },
      wall:   { base: '#22314e', line: '#4d6ea0', glow: '#7ab4ff', emissive: 0x4a86e8, edge: 0x4a9aff },
      gantry: { base: '#3a2b22', line: '#a0763f', glow: '#ffb45c', emissive: 0xf08c32, edge: 0xff9a3d },
      tower:  { base: '#16304e', line: '#3f7fa8', glow: '#4df0ff', emissive: 0x28a0d8, edge: 0x6adfff },
      jumppad:{ base: '#1a4d1a', line: '#3fc43f', glow: '#4dff4d', emissive: 0x2fdd2f, edge: 0x2eff2e },
    };
    const d = defs[kind] || defs.plat;
    const tex = gridTexture(d.base, d.line, d.glow, 0.22);
    tex.repeat.set(2.5, 2.5);
    const mat = new TH.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: d.emissive, emissiveIntensity: 0.85, metalness: 0.45, roughness: 0.3, envMapIntensity: 1.3 });
    const edgeMat = new TH.LineBasicMaterial({ color: d.edge, transparent: true, opacity: 0.42 });
    matCache[kind] = { mat, edgeMat };
    return matCache[kind];
  }

  function mergeBufferGeometries(geometries, useNormalsAndUVs) {
    if (geometries.length === 0) return null;
    let vertCount = 0, indexCount = 0;
    for (const g of geometries) {
      vertCount += g.attributes.position.count;
      indexCount += g.index ? g.index.count : g.attributes.position.count;
    }
    const posArray = new Float32Array(vertCount * 3);
    const normArray = useNormalsAndUVs ? new Float32Array(vertCount * 3) : null;
    const uvArray = useNormalsAndUVs ? new Float32Array(vertCount * 2) : null;
    const indexArray = vertCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);

    let vOffset = 0, iOffset = 0;
    for (const g of geometries) {
      const vLen = g.attributes.position.count;
      posArray.set(g.attributes.position.array, vOffset * 3);
      if (useNormalsAndUVs) {
        if (g.attributes.normal) normArray.set(g.attributes.normal.array, vOffset * 3);
        if (g.attributes.uv) uvArray.set(g.attributes.uv.array, vOffset * 2);
      }
      if (g.index) {
        const idx = g.index.array;
        for (let i = 0; i < idx.length; i++) indexArray[iOffset++] = idx[i] + vOffset;
      } else {
        for (let i = 0; i < vLen; i++) indexArray[iOffset++] = i + vOffset;
      }
      vOffset += vLen;
    }
    
    const merged = new TH.BufferGeometry();
    merged.setAttribute('position', new TH.BufferAttribute(posArray, 3));
    if (useNormalsAndUVs) {
      merged.setAttribute('normal', new TH.BufferAttribute(normArray, 3));
      merged.setAttribute('uv', new TH.BufferAttribute(uvArray, 2));
    }
    merged.setIndex(new TH.BufferAttribute(indexArray, 1));
    return merged;
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

  /* =======================================================================
     PLAYER & INPUT
     ======================================================================= */


  const pl = { pos: new V3(), vel: new V3(), yaw: 0, pitch: 0, viewOffset: null, grounded: false, groundNormal: new V3(0, 1, 0), groundT: -1, jumpBuf: -1, cp: new V3(), maxSpeed: 0 };

  let activeWeapon = 1; // 1 = Portal Gun, 2 = Rocket Launcher
  let autohop = true, started = false, won = false;
  let nowT = 0, runTime = 0, timerOn = false, portalsFired = 0;
  const keys = {};
  let pointerLocked = false;
  
  const grabCubes = [];
  let grabbedCube = null;
  let instCubeMesh = null, instCubeEdges = null;

  const dom = id => document.getElementById(id);
  const startPanel = dom('startpanel'), menuPanel = dom('menupanel'), winPanel = dom('winpanel');

  function requestLock() { canvas.requestPointerLock && canvas.requestPointerLock(); }
  document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === canvas;
    if (pointerLocked) menuPanel.classList.add(String.fromCharCode(104,105,100,100,101,110));

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
    if (e.button === 0) {
      if (grabbedCube) {
         // Throw cube
         const dir = new TH.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
         grabbedCube.vel.copy(dir).multiplyScalar(22).add(pl.vel);
         grabbedCube.rotVel.set(Math.random()-0.5, Math.random()-0.5, Math.random()-0.5).multiplyScalar(15);
         grabbedCube = null;
      } else {
         if (activeWeapon === 1) firePortal(localPlayerIndex * 2);
         else fireRocket();
      }
    }
    else if (e.button === 2 && activeWeapon === 1 && !grabbedCube) {
      firePortal(localPlayerIndex * 2 + 1);
    }
  });
  document.addEventListener('contextmenu', e => e.preventDefault());

  document.addEventListener('wheel', e => {
    if (!pointerLocked || won || !started) return;
    activeWeapon = (activeWeapon === 1) ? 2 : 1;
    if (activeWeapon === 1) { gun.visible = true; rocketGun.visible = false; }
    else { gun.visible = false; rocketGun.visible = true; }
  });

  document.addEventListener('keydown', e => {
    const c = e.code;
    if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'BracketLeft', 'BracketRight', 'Digit1', 'Digit2'].includes(c)) e.preventDefault();
    keys[c] = true;
    if (!started) return;
    if (c === 'Digit1') { activeWeapon = 1; gun.visible = true; rocketGun.visible = false; }
    if (c === 'Digit2') { activeWeapon = 2; gun.visible = false; rocketGun.visible = true; }
    if (c === 'Space') pl.jumpBuf = nowT;
    if (c === 'KeyV') { autohop = !autohop; dom('hopinf').textContent = autohop ? 'on' : 'off'; syncHopBtn(); }
    if (c === 'KeyF') toggleFullscreen();
    if (c === String.fromCharCode(69,115,99,97,112,101)) { if (started && !won) menuPanel.classList.toggle(String.fromCharCode(104,105,100,100,101,110)); }
    if (c === 'KeyR') respawn(false);
    if (c === 'KeyN') newMap(String(Math.floor(Math.random() * 1e9)));
    if (c === 'KeyE') {
      if (grabbedCube) {
         grabbedCube.vel.copy(pl.vel);
         grabbedCube = null;
      } else {
         camera.updateMatrixWorld(true);
         const pos = camera.getWorldPosition(new TH.Vector3());
         const dir = new TH.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
         let bestC = null, bestT = 7.0;
         for (const cb of grabCubes) {
            const v = cb.pos.clone().sub(pos);
            const dist = v.length();
            if (dist > 7.0) continue;
            v.normalize();
            if (v.dot(dir) > 0.9) {
               if (dist < bestT) { bestT = dist; bestC = cb; }
            }
         }
         if (bestC) grabbedCube = bestC;
      }
    }
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

  let ws = null;
  let localPlayerId = null;
  let localPlayerIndex = 0;
  const remotePlayers = {}; // { id: { pos, vel, yaw, pitch } }
  const remotePlayerMeshes = {};

  dom('btnstart').addEventListener('click', () => {
    const ipInput = document.getElementById('ipinput');
    const passInput = document.getElementById('passinput');
    const ip = (ipInput && ipInput.value.trim()) ? ipInput.value.trim() : 'localhost:3001';
    const pass = (passInput && passInput.value.trim()) ? passInput.value.trim() : 'secret';
    const actualIp = ip || 'localhost:3001';
    ws = new WebSocket('ws://' + actualIp);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', password: pass }));
    };
    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      if (data.type === 'init') {
        localPlayerId = data.playerId;
        localPlayerIndex = data.playerIndex;
        
        const localColor = localPlayerIndex === 0 ? 0x33ff33 : 0xff3333;
        const bMesh = playerModel.children.find(c => c.name === 'bodyMesh');
        if (bMesh) bMesh.material.color.setHex(localColor);
        
        gun.userData.core.material.emissive.setHex(portals[localPlayerIndex * 2].color);
        gun.userData.ring.material.emissive.setHex(portals[localPlayerIndex * 2].color);
        
        started = true; startPanel.classList.add('hidden');
        loadMap(data.seed);
        requestLock();
      } else if (data.type === 'map_change') {
        loadMap(data.seed);
      } else if (data.type === 'state') {
        for (const pid in data.players) {
           if (pid === localPlayerId) {
             if (!pointerLocked) {
               pl.pos.fromArray(data.players[pid].pos);
               pl.vel.fromArray(data.players[pid].vel);
             }
             continue;
           }
           remotePlayers[pid] = data.players[pid];
        }
        

        for (let i = 0; i < 4; i++) {
          const sp = data.portals[i];
          const P = portals[i];
          P.placed = sp.placed;
          if (P.placed) {
             P.c.fromArray(sp.c); P.n.fromArray(sp.n); P.r.fromArray(sp.r); P.u.fromArray(sp.u);
          }
        }
        updatePair();
        for (let i = 0; i < data.cubes.length; i++) {
          if (grabCubes[i]) {
            if (grabCubes[i] === grabbedCube) continue;
            grabCubes[i].pos.fromArray(data.cubes[i].pos);
            grabCubes[i].vel.fromArray(data.cubes[i].vel);
          }
        }
      } else if (data.type === 'fire_beam') {
        spawnBeam(portals[data.pi].color, new V3(...data.start), new V3(...data.end));
      } else if (data.type === 'fire_rocket') {
        const rMesh = new TH.Group();
        const bGeo = new TH.CylinderGeometry(0.06, 0.06, 0.4, 8);
        const bMat = new TH.MeshStandardMaterial({ color: 0x222222 });
        const body = new TH.Mesh(bGeo, bMat);
        const tGeo = new TH.ConeGeometry(0.06, 0.2, 8);
        const tMat = new TH.MeshStandardMaterial({ color: 0xff0000 });
        const tip = new TH.Mesh(tGeo, tMat);
        tip.position.y = 0.3;
        rMesh.add(body, tip);
        rMesh.rotation.order = 'YXZ';
        rMesh.quaternion.setFromUnitVectors(new V3(0, 0, -1), new V3(...data.vel).normalize());
        rMesh.rotateX(Math.PI / 2);
        rMesh.position.fromArray(data.pos);
        scene.add(rMesh);
        rockets.push({ pos: new V3(...data.pos), vel: new V3(...data.vel), mesh: rMesh, life: 5 });
        tone(300, 150, 0.3, 'sawtooth', 0.1);
      }
    };
    ws.onerror = (e) => {
      console.error('Connection error', e);
      showFatal('Could not connect to server at ' + actualIp);
    };
    ws.onclose = () => {
      showFatal('Connection lost to server.');
    };
  });
  dom('btnresume').addEventListener('click', requestLock);
  dom('btnnewmap').addEventListener('click', () => {
    const s = dom('seedinput2').value.trim() || String(Math.floor(Math.random() * 1e9));
    newMap(s);
  });
  dom('btnagain').addEventListener('click', () => newMap(String(Math.floor(Math.random() * 1e9))));
  dom('btnsame').addEventListener('click', () => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'new_map', seed: currentSeed }));
    winPanel.classList.add('hidden'); requestLock(); 
  });

  /* =======================================================================
     PORTALS
     ======================================================================= */

  const portals = [mkPortal(0x33ff33), mkPortal(0x00aa00), mkPortal(0xff5555), mkPortal(0xaa0000)];
  function mkPortal(color) { return { placed: false, c: new V3(), n: new V3(), r: new V3(), u: new V3(), color }; }

  const portalGroup = new TH.Group(); scene.add(portalGroup);
  const quadMats = [], quads = [], frames = [], glowLights = [], sparkles = [];
  for (let i = 0; i < 4; i++) {
    const m = portalShaderMat(portals[i].color);
    quadMats.push(m);
    const q = new TH.Mesh(new TH.PlaneGeometry(PORT.hw * 2, PORT.hh * 2), m);
    q.renderOrder = 5; quads.push(q); portalGroup.add(q);
    
    const frameGrp = new TH.Group();
    const core = new TH.Mesh(new TH.TorusGeometry(1, 0.02, 8, 64), new TH.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false }));
    const glow1 = new TH.Mesh(new TH.TorusGeometry(1, 0.08, 8, 64), new TH.MeshBasicMaterial({ color: portals[i].color, transparent: true, opacity: 0.8, blending: TH.AdditiveBlending, depthWrite: false }));
    const glow2 = new TH.Mesh(new TH.TorusGeometry(1, 0.25, 8, 64), new TH.MeshBasicMaterial({ color: portals[i].color, transparent: true, opacity: 0.35, blending: TH.AdditiveBlending, depthWrite: false }));
    frameGrp.add(core, glow1, glow2);
    frameGrp.scale.set(PORT.hw + 0.05, PORT.hh + 0.05, 1);
    frames.push(frameGrp); portalGroup.add(frameGrp);
    
    const lt = new TH.PointLight(portals[i].color, 5.0, 15); glowLights.push(lt); portalGroup.add(lt);
    
    const sparkGeo = new TH.BufferGeometry();
    const sparkPos = new Float32Array(300);
    const sparkVel = [];
    const sparkLife = new Float32Array(100);
    for (let j = 0; j < 100; j++) {
        sparkPos[j*3] = 0; sparkPos[j*3+1] = 0; sparkPos[j*3+2] = 0;
        sparkVel.push(new V3()); sparkLife[j] = 0;
    }
    sparkGeo.setAttribute('position', new TH.BufferAttribute(sparkPos, 3));
    sparkGeo.setAttribute('life', new TH.BufferAttribute(sparkLife, 1));
    const sparkMat = new TH.ShaderMaterial({
        uniforms: { uColor: { value: new TH.Color(portals[i].color) } },
        transparent: true, blending: TH.AdditiveBlending, depthWrite: false,
        vertexShader: `attribute float life; varying float vLife; void main() { vLife = life; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = life * 12.0; }`,
        fragmentShader: `uniform vec3 uColor; varying float vLife; void main() { vec2 p = gl_PointCoord - 0.5; float d = length(p); if (d > 0.5) discard; gl_FragColor = vec4(uColor * (1.0 - d*2.0), vLife); }`
    });
    const sparkMesh = new TH.Points(sparkGeo, sparkMat);
    sparkMesh.frustumCulled = false;
    portalGroup.add(sparkMesh);
    sparkles.push({ mesh: sparkMesh, pos: sparkPos, vel: sparkVel, life: sparkLife });
  }

  function portalShaderMat(color) {
    return new TH.ShaderMaterial({
      transparent: true, side: TH.DoubleSide, depthWrite: false,
      uniforms: { uTex: { value: null }, uColor: { value: new TH.Color(color) }, uTime: { value: 0 } },
      vertexShader: `varying vec2 vUv; varying vec4 vScreenPos; 
        void main(){ 
          vUv=uv; 
          vec4 pos = projectionMatrix*modelViewMatrix*vec4(position,1.0);
          vScreenPos = pos;
          gl_Position = pos; 
        }`,
        fragmentShader: `
        uniform sampler2D uTex; uniform vec3 uColor; uniform float uTime; 
        varying vec2 vUv; varying vec4 vScreenPos;
        vec4 sRGBTransfer( vec4 value ) {
            vec3 safeRgb = max( value.rgb, vec3( 0.0 ) );
            vec3 low = safeRgb * 12.92;
            vec3 high = pow( safeRgb, vec3( 0.41666 ) ) * 1.055 - vec3( 0.055 );
            return vec4( mix( high, low, step( safeRgb, vec3( 0.0031308 ) ) ), value.a );
        }
        void main(){
          vec2 p = vUv*2.0-1.0;
          float e = length(p);
          if(e>1.0) discard;
          
          vec2 screenUv = (vScreenPos.xy / vScreenPos.w) * 0.5 + 0.5;
          vec4 tex = texture2D(uTex, screenUv);
          
          gl_FragColor = sRGBTransfer(vec4(tex.rgb, 1.0));
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
  let R_AB = [new M4(), new M4()], R_BA = [new M4(), new M4()];
  function updatePair() {
    for (let idx = 0; idx < 2; idx++) {
      const offset = idx * 2;
      if (!portals[offset] || !portals[offset+1]) continue;
      const fA = frameFor(portals[offset].n), fB = frameFor(portals[offset+1].n);
      const mA = new M4().makeBasis(fA.r, fA.u, portals[offset].n);
      const mB = new M4().makeBasis(fB.r.clone().multiplyScalar(-1), fB.u, portals[offset+1].n.clone().multiplyScalar(-1));
      R_AB[idx] = new M4().multiplyMatrices(mB, new M4().copy(mA).transpose());
      R_BA[idx] = new M4().copy(R_AB[idx]).transpose();
    }
  }

  function tryPlace(pi, hit) {
    const P = portals[pi];
    const n = hit.normal.clone().normalize();
    const f = frameFor(n);
    let c = hit.point.clone();
    const dvec = new TH.Vector3().subVectors(c, hit.obb.c);
    
    // Clamp to face boundaries
    for (let k = 0; k < 3; k++) {
      const ax = hit.obb.ax[k];
      if (Math.abs(n.dot(ax)) > 0.99) continue; // Skip normal axis
      
      const ext = PORT.hw * Math.abs(f.r.dot(ax)) + PORT.hh * Math.abs(f.u.dot(ax));
      const limit = hit.obb.he[k] - ext - 0.02;
      
      if (limit < 0) {
        // Platform is physically too small for this portal
        tone(220, 120, 0.15, 'square', 0.06); 
        return false; 
      }
      
      let proj = dvec.dot(ax);
      if (proj > limit) proj = limit;
      if (proj < -limit) proj = -limit;
      
      const oldProj = dvec.dot(ax);
      dvec.addScaledVector(ax, proj - oldProj);
    }
    
    // Reconstruct c and offset slightly
    c.copy(hit.obb.c).add(dvec).addScaledVector(n, 0.02);
    /* no overlapping placement on the same face */
    for (let i = 0; i < portals.length; i++) {
      if (i === pi) continue;
      const Q = portals[i];
      if (Q.placed) {
        const sameFace = Math.abs(n.dot(Q.n)) > 0.999 && Math.abs(c.clone().sub(Q.c).dot(n)) < 0.08;
        if (sameFace) {
          const d = c.clone().sub(Q.c);
          const du = Math.abs(d.dot(f.r)), dv = Math.abs(d.dot(f.u));
          if (du < PORT.hw * 2 + 0.35 && dv < PORT.hh * 2 + 0.35) { tone(220, 120, 0.15, 'square', 0.06); return false; }
        }
      }
    }
    P.placed = true; P.c.copy(c); P.n.copy(n); P.r.copy(f.r); P.u.copy(f.u); P.openTime = performance.now() / 1000;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'portal_place', pi,
        c: P.c.toArray(), n: P.n.toArray(), r: P.r.toArray(), u: P.u.toArray()
      }));
    }
    updatePair();
    tone(700, 1400, 0.09, 'sine', 0.08); tone(1400, 2400, 0.12, 'triangle', 0.05, 0.03);
    return true;
  }

  /* ray vs all OBBs -> nearest {point, normal, obb} */
  function raycast(origin, dir, maxDist, minDist = 0.02) {
    return physics.raycast(origin, dir, maxDist, obbs, minDist);
  }

  const activeBeams = [];
  const beamGeo = new TH.CylinderGeometry(0.04, 0.04, 1, 8);
  beamGeo.translate(0, 0.5, 0);
  beamGeo.rotateX(Math.PI / 2);
  
  const helixGeo = new TH.BufferGeometry();
  const helixPts = [];
  const hSegs = 150, hTurns = 12;
  for (let i = 0; i <= hSegs; i++) {
    const t = i / hSegs;
    const ang = t * Math.PI * 2 * hTurns;
    const r = 0.14;
    helixPts.push(Math.cos(ang) * r, Math.sin(ang) * r, t);
  }
  helixGeo.setAttribute('position', new TH.BufferAttribute(new Float32Array(helixPts), 3));

  function spawnBeam(colorHex, start, end) {
    const dist = start.distanceTo(end);
    
    const coreMat = new TH.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, blending: TH.AdditiveBlending, depthWrite: false });
    const coreMesh = new TH.Mesh(beamGeo, coreMat);
    coreMesh.position.copy(start); coreMesh.lookAt(end);
    coreMesh.scale.set(0.6, 0.6, dist);
    scene.add(coreMesh);
    
    const hMat = new TH.LineBasicMaterial({ color: colorHex, transparent: true, opacity: 0.8, blending: TH.AdditiveBlending, depthWrite: false });
    const hMesh = new TH.Line(helixGeo, hMat);
    hMesh.position.copy(start); hMesh.lookAt(end);
    hMesh.scale.set(1, 1, dist);
    scene.add(hMesh);
    
    const pCount = 50;
    const pGeo = new TH.BufferGeometry();
    const pos = new Float32Array(pCount * 3);
    const vel = [];
    for (let i = 0; i < pCount; i++) {
      const t = Math.random();
      const p = new V3().lerpVectors(start, end, t);
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      vel.push(new V3((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6));
    }
    pGeo.setAttribute('position', new TH.BufferAttribute(new Float32Array(pos), 3));
    const pMat = new TH.PointsMaterial({ color: colorHex, size: 0.04, transparent: true, opacity: 1.0, blending: TH.AdditiveBlending, depthWrite: false });
    const points = new TH.Points(pGeo, pMat);
    scene.add(points);
    
    activeBeams.push({ coreMesh, hMesh, points, vel, life: 1.0 });
  }

  function firePortal(pi) {
    camera.updateMatrixWorld(true);
    const dir = new V3(); camera.getWorldDirection(dir);
    const hit = raycast(camera.position.clone(), dir, 140);
    
    gun.updateMatrixWorld(true);
    const gunPos = new V3(0, 0.02, -0.45).applyMatrix4(gun.matrixWorld);
    const target = hit ? hit.point : camera.position.clone().addScaledVector(dir, 140);
    spawnBeam(portals[pi].color, gunPos, target);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'fire_beam', pi, start: gunPos.toArray(), end: target.toArray() }));
    }
    
    if (!hit) { tone(180, 90, 0.1, 'square', 0.05); return; }
    portalsFired++;
    tryPlace(pi, hit);
    muzzleFlash(pi);
  }

  /* =======================================================================
     MOVEMENT & COLLISION (capsule vs OBB)
     ======================================================================= */


  let landingThump = 0;
  let tpGracePortal = null, tpGraceT = -1;
  const _tpFlash = document.getElementById('flash');

  function physStep(dt, activeKeys) {
    const tpState = { nowT, tpGracePortal, tpGraceT, R_AB, R_BA };
    const events = {
      onJumppad: () => { tone(200, 600, 0.4, 'sine', 0.15); },
      onLand: (vol) => { landingThump = vol; },
      onJump: () => { tone(340, 520, 0.06, 'triangle', 0.04); },
      onTeleport: () => { _tpFlash.classList.remove('fadeflash'); void _tpFlash.offsetWidth; _tpFlash.classList.add('fadeflash'); }
    };
    physics.physStep(pl, activeKeys, autohop, dt, obbs, portals, grabCubes, grabbedCube, tpState, events);
    tpGracePortal = tpState.tpGracePortal;
    tpGraceT = tpState.tpGraceT;
    if (pl.pos.y < -40.5) respawn();
  }

  function collideCube(c, radius) {
    physics.collideCube(c, obbs, portals, radius);
  }

  function resolveCubeCollisions() {
    physics.resolveCubeCollisions(grabCubes, grabbedCube);
  }


  function respawn() {
    pl.pos.copy(spawnPt); pl.vel.set(0, 0, 0);
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
    const hex = portals[pi].color;
    gun.userData.core.material.emissive.setHex(hex);
    gun.userData.ring.material.emissive.setHex(hex);
  }
  
  const rocketGun = new TH.Group();
  {
    const bodyMat = new TH.MeshStandardMaterial({ color: 0x2e3532, metalness: 0.9, roughness: 0.2 });
    const barrel = new TH.Mesh(new TH.CylinderGeometry(0.12, 0.12, 0.8, 12), bodyMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0, -0.2);
    const handle = new TH.Mesh(new TH.BoxGeometry(0.08, 0.2, 0.1), bodyMat);
    handle.position.set(0, -0.15, 0.1);
    rocketGun.add(barrel, handle);
    rocketGun.position.set(0.3, -0.26, -0.5);
    rocketGun.visible = false;
    camera.add(rocketGun);
  }

  const rockets = [];
  let lastRocketTime = 0;
  function fireRocket() {
    const t = performance.now() / 1000;
    if (t - lastRocketTime < 0.5) return;
    lastRocketTime = t;
    
    tone(300, 150, 0.3, 'sawtooth', 0.1);
    camera.updateMatrixWorld(true);
    const pos = camera.getWorldPosition(new TH.Vector3());
    const dir = new TH.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    
    const rMesh = new TH.Group();
    const bGeo = new TH.CylinderGeometry(0.06, 0.06, 0.4, 8);
    const bMat = new TH.MeshStandardMaterial({ color: 0x222222 });
    const body = new TH.Mesh(bGeo, bMat);
    const tGeo = new TH.ConeGeometry(0.06, 0.2, 8);
    const tMat = new TH.MeshStandardMaterial({ color: 0xff0000 });
    const tip = new TH.Mesh(tGeo, tMat);
    tip.position.y = 0.3;
    rMesh.add(body, tip);
    
    rMesh.rotation.order = 'YXZ';
    rMesh.quaternion.copy(camera.quaternion);
    rMesh.rotateX(Math.PI / 2);
    rMesh.position.copy(pos);
    scene.add(rMesh);
    
    rockets.push({ pos: pos.clone(), vel: dir.multiplyScalar(70), mesh: rMesh, life: 5 });
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'fire_rocket', pos: pos.toArray(), vel: dir.toArray() }));
    }
  }

  function explosion(pos) {
    tone(100, 40, 0.4, 'square', 0.2);
    const expl = new TH.Mesh(new TH.SphereGeometry(3.5, 16, 16), new TH.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 1 }));
    expl.position.copy(pos);
    scene.add(expl);
    animObjects.push({ type: 'expl', obj: expl, life: 1.0 });
    
    const pCenter = pl.pos.clone(); pCenter.y += CFG.H / 2;
    const dvec = new TH.Vector3().subVectors(pCenter, pos);
    const dist = dvec.length();
    
    if (dist < 12) {
       dvec.normalize();
       const force = (12 - dist) * 2.25;
       pl.vel.add(dvec.multiplyScalar(force));
       pl.grounded = false;
    }
    
    // Blast cubes
    for (const c of grabCubes) {
      if (c === grabbedCube) continue;
      const v = c.pos.clone().sub(pos);
      const cd = v.length();
      if (cd < 15.0) {
        const force = (15.0 - cd) * 1.5;
        c.vel.add(v.normalize().multiplyScalar(force));
        c.vel.y += force * 0.4;
        c.rotVel.set(Math.random()-0.5, Math.random()-0.5, Math.random()-0.5).multiplyScalar(force);
      }
    }
  }

  function addRuntimeSlab(cx, cy, cz, sx, sy, sz, kind) {
    const sMat = getSlabMat(kind);
    const mesh = new TH.Mesh(new TH.BoxGeometry(sx, sy, sz), sMat.mat);
    mesh.position.set(cx, cy, cz);
    if (worldGroup) worldGroup.add(mesh);
    else scene.add(mesh);
    
    const obb = { 
      c: new V3(cx, cy, cz), 
      ax: [new V3(1,0,0), new V3(0,1,0), new V3(0,0,1)], 
      he: [sx/2, sy/2, sz/2], 
      rad: Math.hypot(sx/2, sy/2, sz/2), 
      kind, 
      mesh 
    };
    obbs.push(obb);
  }

  function destroyWall(obb, point, normal) {
    if (obb.kind !== 'wall') return;
    if (Math.abs(obb.ax[1].y) < 0.99) return;
    if (obb.he[0] > 2.5) return; // Only destroy thin vertical walls
    
    if (obb.mesh) {
      if (worldGroup) worldGroup.remove(obb.mesh);
      else scene.remove(obb.mesh);
      
      obb.mesh.traverse(o => {
        if (o.geometry) o.geometry.dispose();
      });
    }
    
    // Remove from physics
    const idx = obbs.indexOf(obb);
    if (idx > -1) obbs.splice(idx, 1); 
    
    for (let i = 0; i < 4; i++) {
       const P = portals[i];
       if (P.placed && P.c.distanceTo(obb.c) < obb.rad + 1) {
          if (Math.abs(P.n.dot(obb.ax[0])) > 0.99) P.placed = false;
       }
    }
    
    const R = 4.8;
    const stripW = 1.2;
    const minY = obb.c.y - obb.he[1], maxY = obb.c.y + obb.he[1];
    const minZ = obb.c.z - obb.he[2], maxZ = obb.c.z + obb.he[2];
    
    const startZ = point.z - R;
    const endZ = point.z + R;
    
    const pieces = [];
    
    if (startZ > minZ + 0.1) pieces.push({ cy: obb.c.y, sy: obb.he[1]*2, cz: (minZ + startZ)/2, sz: startZ - minZ });
    if (endZ < maxZ - 0.1) pieces.push({ cy: obb.c.y, sy: obb.he[1]*2, cz: (endZ + maxZ)/2, sz: maxZ - endZ });
    
    const stripMinZ = Math.max(minZ, startZ);
    const stripMaxZ = Math.min(maxZ, endZ);
    
    for (let z = stripMinZ; z < stripMaxZ; z += stripW) {
       const s_sz = Math.min(stripW, stripMaxZ - z);
       const stripZ = z + s_sz / 2;
       
       const distZ = Math.abs(stripZ - point.z);
       let holeH = 0;
       if (distZ < R) holeH = Math.sqrt(R*R - distZ*distZ);
       
       const holeBottom = point.y - holeH;
       if (holeBottom > minY + 0.1) {
           pieces.push({ cy: (minY + holeBottom)/2, sy: holeBottom - minY, cz: stripZ, sz: s_sz });
       }
       const holeTop = point.y + holeH;
       if (holeTop < maxY - 0.1) {
           pieces.push({ cy: (holeTop + maxY)/2, sy: maxY - holeTop, cz: stripZ, sz: s_sz });
       }
    }
    
    for (const p of pieces) {
      addRuntimeSlab(obb.c.x, p.cy, p.cz, obb.he[0]*2, p.sy, p.sz, 'wall');
    }

    // Spawn physical debris chunks
    const mMat = getSlabMat('wall');
    const blastNormal = normal ? normal.clone() : new V3(0, 1, 0);
    
    for (let i = 0; i < 24; i++) {
      const bs = rr(0.9, 2.2);
      const bGeo = new TH.BoxGeometry(bs, bs, bs);
      const bMesh = new TH.Group();
      bMesh.add(new TH.Mesh(bGeo, mMat.mat));
      bMesh.add(new TH.LineSegments(new TH.EdgesGeometry(bGeo), mMat.edgeMat));
      
      const offset = new V3(rr(-3, 3), rr(-3, 3), rr(-3, 3));
      bMesh.position.copy(point).add(offset);
      scene.add(bMesh);
      
      // Fly outward from the wall along the normal, plus some scatter
      const scatter = offset.clone().normalize().multiplyScalar(rr(4, 12));
      const vel = blastNormal.clone().multiplyScalar(rr(15, 35)).add(scatter);
      vel.y += rr(5, 15); // always pop up a bit
      
      const rot = new V3(rr(-15, 15), rr(-15, 15), rr(-15, 15));
      animObjects.push({ type: 'debris', obj: bMesh, vel, rot, life: 4.0 });
    }
  }

  /* =======================================================================
     PLAYER MODEL (Visible in portals only)
     ======================================================================= */
  const playerClipPlane = new TH.Plane(new V3(0, 1, 0), 1e6);
  function createPlayerModel(color, layer, clipPlane) {
    const model = new TH.Group();
    
    const bodyGeo = new TH.CylinderGeometry(0.3, 0.3, 1.2, 16);
    bodyGeo.translate(0, 0.6, 0);
    const bodyMat = new TH.MeshStandardMaterial({ color: color, metalness: 0.2, roughness: 0.7 });
    const bodyMesh = new TH.Mesh(bodyGeo, bodyMat);
    bodyMesh.name = 'bodyMesh';
    model.add(bodyMesh);
    
    const headGroup = new TH.Group();
    headGroup.position.set(0, 1.58, 0);
    
    const headGeo = new TH.SphereGeometry(0.25, 16, 16);
    const headMat = new TH.MeshStandardMaterial({ color: 0xffd9a8, metalness: 0.1, roughness: 0.8 });
    const headMesh = new TH.Mesh(headGeo, headMat);
    
    const visorGeo = new TH.BoxGeometry(0.35, 0.12, 0.15);
    const visorMat = new TH.MeshStandardMaterial({ color: 0x111111, metalness: 0.8, roughness: 0.2 });
    const visorMesh = new TH.Mesh(visorGeo, visorMat);
    visorMesh.position.set(0, 0, -0.22);
    
    const mirrorGun = gun.clone();
    mirrorGun.position.set(0.35, -0.38, -0.4);
    mirrorGun.rotation.set(-0.1, 0, 0);
    const mirrorRocketGun = rocketGun.clone();
    mirrorRocketGun.position.set(0.35, -0.38, -0.4);
    mirrorRocketGun.rotation.set(-0.1, 0, 0);
    
    headGroup.add(headMesh, visorMesh, mirrorGun, mirrorRocketGun);
    mirrorRocketGun.visible = false;
    model.add(headGroup);
    
    model.userData = { mirrorGun, mirrorRocketGun, headGroup };
    
    model.traverse(c => { 
      if (c.isMesh) { 
        c.material = c.material.clone();
        if (clipPlane) c.material.clippingPlanes = [clipPlane];
        if (layer !== undefined) c.layers.set(layer); 
      } 
    });
    
    return model;
  }
  
  const playerModel = createPlayerModel(0x4a86e8, 1, playerClipPlane);
  scene.add(playerModel);
    
  // Assign global to be used in frame()
  window.playerClipPlane = playerClipPlane;
  
  // The real player model on Layer 1 is sufficient for portals to render you.

  /* =======================================================================
     PORTAL RENDERING — render target + virtual camera + clip plane
     ======================================================================= */
  const MAX_DEPTH = 3;
  const portalRTs = [];
  function makeRTs() {
    const w = Math.max(256, Math.floor(innerWidth * 0.7)), h = Math.max(256, Math.floor(innerHeight * 0.7));
    for (let d = 0; d < MAX_DEPTH; d++) {
      const dw = Math.max(64, Math.floor(w / (d + 1)));
      const dh = Math.max(64, Math.floor(h / (d + 1)));
      if (!portalRTs[d]) portalRTs[d] = [null, null, null, null];
      for (let i = 0; i < 4; i++) {
        if (portalRTs[d][i]) portalRTs[d][i].dispose();
        portalRTs[d][i] = new TH.WebGLRenderTarget(dw, dh, { minFilter: TH.LinearFilter, magFilter: TH.LinearFilter });
      }
    }
  }
  makeRTs();

  const clipPlane = new TH.Plane(new V3(0, 1, 0), 1e6);
  renderer.clippingPlanes = [clipPlane];

  const vcam = new TH.PerspectiveCamera(115, 1, 0.001, 300);
  vcam.matrixAutoUpdate = false;
  vcam.layers.enable(1); // allow virtual camera to see the player model

  const _frustum = new TH.Frustum(), _projScreen = new TH.Matrix4();
  function renderPortalRecursive(i, parentCamMatrix, depth) {
    const pairIdx = Math.floor(i / 2);
    const qIdx = i % 2 === 0 ? i + 1 : i - 1;
    const P = portals[i], Q = portals[qIdx];
    
    vcam.matrixWorld.copy(parentCamMatrix);
    vcam.matrixWorldInverse.copy(parentCamMatrix).invert();
    vcam.fov = camera.fov; vcam.aspect = camera.aspect;
    vcam.updateProjectionMatrix();
    
    const parentPos = new V3().setFromMatrixPosition(parentCamMatrix);
    const dot = new V3().subVectors(parentPos, P.c).dot(P.n);
    if (dot <= 0.01) return null; // Camera is behind or flush with the portal plane
    
    _projScreen.multiplyMatrices(vcam.projectionMatrix, vcam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);
    const maxRad = Math.hypot(PORT.hw, PORT.hh) + 0.5;
    if (!_frustum.intersectsSphere(new TH.Sphere(P.c, maxRad))) return null;

    const R = i % 2 === 0 ? R_AB[pairIdx] : R_BA[pairIdx];
    if (!R) return null;
    const T1 = new M4().makeTranslation(-P.c.x, -P.c.y, -P.c.z);
    const T2 = new M4().makeTranslation(Q.c.x, Q.c.y, Q.c.z);
    const camMatrix = new M4().multiplyMatrices(T2, new M4().multiplyMatrices(R, new M4().multiplyMatrices(T1, parentCamMatrix)));
    
    let texs = [null, null, null, null];
    if (depth < PORT.recursion) {
      for (let j = 0; j < 4; j++) {
        if (portals[j].placed && portals[j%2 === 0 ? j+1 : j-1].placed) {
          texs[j] = renderPortalRecursive(j, camMatrix, depth + 1);
        }
      }
    }
    
    vcam.matrixAutoUpdate = false;
    vcam.matrixWorld.copy(camMatrix);
    vcam.matrixWorldInverse.copy(camMatrix).invert();
    vcam.fov = camera.fov; vcam.aspect = camera.aspect;
    vcam.updateProjectionMatrix();
    
    const dP = (parentPos.x - P.c.x) * P.n.x + (parentPos.y - P.c.y) * P.n.y + (parentPos.z - P.c.z) * P.n.z;
    if (Math.abs(dP) > 0.05) {
      const s = dP >= 0 ? 1 : -1;
      clipPlane.normal.copy(Q.n).multiplyScalar(s);
      clipPlane.constant = -s * Q.n.dot(Q.c) + 0.02;
    } else { parkClip(); }
    
    const exitIdx = qIdx;
    const oldFrameVis = frames[exitIdx].visible;
    const oldSparkVis = sparkles[exitIdx].mesh.visible;
    const oldQuadVis = quads[exitIdx].visible;
    frames[exitIdx].visible = false;
    sparkles[exitIdx].mesh.visible = false;
    quads[exitIdx].visible = false;
    
    for (let j = 0; j < 4; j++) {
      if (quadMats[j]) quadMats[j].uniforms.uTex.value = texs[j];
    }
    
    const rt = portalRTs[depth][i];
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(scene, vcam);
    renderer.setRenderTarget(null);
    
    frames[exitIdx].visible = oldFrameVis;
    sparkles[exitIdx].mesh.visible = oldSparkVis;
    quads[exitIdx].visible = oldQuadVis;
    return rt.texture;
  }

  function renderPortalViews() {
    camera.updateMatrixWorld(true);
    let texs = [null, null, null, null];
    for (let i = 0; i < 4; i++) {
       const qIdx = i % 2 === 0 ? i + 1 : i - 1;
       if (portals[i].placed && portals[qIdx].placed) {
          texs[i] = renderPortalRecursive(i, camera.matrixWorld, 0);
       }
    }
    for (let i = 0; i < 4; i++) {
       if (quadMats[i]) {
          quadMats[i].uniforms.uTex.value = texs[i];
          quads[i].visible = portals[i].placed;
       }
    }
    parkClip();
  }
  function parkClip() { clipPlane.normal.set(0, 1, 0); clipPlane.constant = 1e6; }

  function placePortalVisuals() {
    for (let i = 0; i < 4; i++) {
      const P = portals[i];
      if (!P.placed) { quads[i].visible = false; frames[i].visible = false; glowLights[i].intensity = 0; sparkles[i].mesh.visible = false; continue; }
      frames[i].visible = true;
      const q = quads[i], f = frames[i], lt = glowLights[i];
      q.position.copy(P.c).addScaledVector(P.n, 0.015);
      const m = new M4().makeBasis(P.r, P.u, P.n);
      q.quaternion.setFromRotationMatrix(m);
      f.position.copy(q.position).addScaledVector(P.n, 0.02);
      f.quaternion.copy(q.quaternion);
      lt.position.copy(P.c).addScaledVector(P.n, 0.5);
      lt.intensity = 5.0;
      sparkles[i].mesh.visible = true;
      sparkles[i].mesh.position.copy(q.position);
      sparkles[i].mesh.quaternion.copy(q.quaternion);
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
    
    // --- Batched World Build ---
    const geoBatches = {}, edgeBatches = {};
    for (const rec of map.slabs) {
      const [sx, sy, sz] = rec.s;
      const baseGeo = new TH.BoxGeometry(sx, sy, sz);
      const edgeGeo = new TH.EdgesGeometry(baseGeo);
      const m = new TH.Matrix4().compose(
        new V3(...rec.c),
        new TH.Quaternion().setFromEuler(new TH.Euler(0, rec.ry || 0, rec.rz || 0, 'YZX')),
        new V3(1, 1, 1)
      );
      baseGeo.applyMatrix4(m);
      edgeGeo.applyMatrix4(m);
      const kind = rec.kind || 'plat';
      
      let meshObj = null;
      if (kind === 'wall') {
        const mMat = getSlabMat('wall');
        meshObj = new TH.Group();
        meshObj.add(new TH.Mesh(baseGeo, mMat.mat));
        meshObj.add(new TH.LineSegments(edgeGeo, mMat.edgeMat));
        worldGroup.add(meshObj);
      } else {
        if (!geoBatches[kind]) geoBatches[kind] = [];
        if (!edgeBatches[kind]) edgeBatches[kind] = [];
        geoBatches[kind].push(baseGeo);
        edgeBatches[kind].push(edgeGeo);
      }

      const q = new TH.Quaternion().setFromRotationMatrix(m);
      const ax = [new V3(1, 0, 0).applyQuaternion(q), new V3(0, 1, 0).applyQuaternion(q), new V3(0, 0, 1).applyQuaternion(q)];
      const rad = Math.hypot(sx, sy, sz) / 2 + 3;
      obbs.push({ c: new V3(...rec.c), he: [sx / 2, sy / 2, sz / 2], ax, rad, kind, mesh: meshObj });
    }

    for (const kind in geoBatches) {
      const mergedGeo = mergeBufferGeometries(geoBatches[kind], true);
      const mergedEdges = mergeBufferGeometries(edgeBatches[kind], false);
      if (!mergedGeo) continue;
      const mats = getSlabMat(kind);
      worldGroup.add(new TH.Mesh(mergedGeo, mats.mat));
      worldGroup.add(new TH.LineSegments(mergedEdges, mats.edgeMat));
    }
    
    const pillarGeos = [];
    for (const p of map.pillars) {
      const baseGeo = new TH.BoxGeometry(...p.s);
      baseGeo.translate(...p.c);
      pillarGeos.push(baseGeo);
    }
    if (pillarGeos.length > 0) {
      const pillarTex = gridTexture('#14203a', '#2c4d78', '#4df0ff', 0.16); pillarTex.repeat.set(2, 4);
      const matP = new TH.MeshStandardMaterial({ color: 0x1a2b48, metalness: 0.5, roughness: 0.45, map: pillarTex });
      worldGroup.add(new TH.Mesh(mergeBufferGeometries(pillarGeos, true), matP));
    }

    const lampGeo = new TH.SphereGeometry(0.16, 10, 8);
    let litCount = 0;
    for (const l of map.lamps) {
      const lm = new TH.Mesh(lampGeo, new TH.MeshStandardMaterial({ color: 0x000000, emissive: l.color, emissiveIntensity: 3.4 }));
      lm.position.set(...l.c); worldGroup.add(lm);
      if (litCount < 12) {
        const pl = new TH.PointLight(l.color, 2.4, 20, 1.6);
        pl.position.set(...l.c); worldGroup.add(pl); litCount++;
      }
    }
    for (const ln of map.lanterns) {
      const g = new TH.Group();
      g.position.set(...ln.c);
      const shell = new TH.Mesh(new TH.CylinderGeometry(0.5, 0.2, 1.5, 6), new TH.MeshStandardMaterial({ color: 0x111122, metalness: 0.8, roughness: 0.2 }));
      const core = new TH.Mesh(new TH.CylinderGeometry(0.3, 0.1, 1.4, 6), new TH.MeshStandardMaterial({ color: 0x000000, emissive: ln.color, emissiveIntensity: 2.5 }));
      g.add(shell, core);
      const wire = new TH.Mesh(new TH.CylinderGeometry(0.05, 0.05, 20), new TH.MeshStandardMaterial({ color: 0x050505 }));
      wire.position.y = 10.7;
      g.add(wire);
      worldGroup.add(g);
      animObjects.push({ obj: g, type: 'lantern', phase: Math.random() * 10 });
    }
    
    for (const h of map.holograms) {
      const m = new TH.Mesh(
        new TH.OctahedronGeometry(1.8, 0),
        new TH.MeshBasicMaterial({ color: h.color, wireframe: true, transparent: true, opacity: 0.8, blending: TH.AdditiveBlending })
      );
      m.position.set(...h.c);
      worldGroup.add(m);
      animObjects.push({ obj: m, type: 'holo' });
    }
    
    for (const pc of map.powerCores) {
      const g = new TH.Group();
      g.position.set(...pc.c);
      const base = new TH.Mesh(new TH.BoxGeometry(2, 1, 2), new TH.MeshStandardMaterial({ color: 0x222233, metalness: 0.6, roughness: 0.5 }));
      base.position.y = 0.5;
      const ring1 = new TH.Mesh(new TH.TorusGeometry(0.8, 0.1, 4, 16), new TH.MeshStandardMaterial({ color: 0x000000, emissive: 0xff3300, emissiveIntensity: 2 }));
      ring1.rotation.x = Math.PI / 2; ring1.position.y = 1.5;
      const ring2 = new TH.Mesh(new TH.TorusGeometry(0.6, 0.08, 4, 16), new TH.MeshStandardMaterial({ color: 0x000000, emissive: 0x00aaff, emissiveIntensity: 2 }));
      ring2.rotation.x = Math.PI / 2; ring2.position.y = 1.5;
      g.add(base, ring1, ring2);
      worldGroup.add(g);
      animObjects.push({ type: 'core', ring: ring1, ring2: ring2 });
    }
    // --- End Batched World Build ---
    
    grabCubes.length = 0;
    grabbedCube = null;
    const cubeGeo = new TH.BoxGeometry(1.5, 1.5, 1.5, 4, 4, 4);
    const cubePos = cubeGeo.attributes.position;
    for (let i = 0; i < cubePos.count; i++) {
        let x = cubePos.getX(i), y = cubePos.getY(i), z = cubePos.getZ(i);
        const hw = 0.75 - 0.25; 
        let cx = Math.max(-hw, Math.min(hw, x));
        let cy = Math.max(-hw, Math.min(hw, y));
        let cz = Math.max(-hw, Math.min(hw, z));
        const dx = x - cx, dy = y - cy, dz = z - cz;
        const len = Math.hypot(dx, dy, dz);
        if (len > 0.001) {
           x = cx + (dx / len) * 0.25;
           y = cy + (dy / len) * 0.25;
           z = cz + (dz / len) * 0.25;
           cubePos.setXYZ(i, x, y, z);
        }
    }
    cubeGeo.computeVertexNormals();
    const cubeEdgeGeo = new TH.EdgesGeometry(cubeGeo, 15);
    const cMat = new TH.MeshStandardMaterial({ color: 0x334455, emissive: 0x0088ff, emissiveIntensity: 0.6, metalness: 0.2, roughness: 0.4 });
    const eMat = new TH.LineBasicMaterial({ color: 0x00ffff });
    
    instCubeMesh = new TH.InstancedMesh(cubeGeo, cMat, map.grabCubes.length);
    // LineSegments can't directly be InstancedMesh in some versions without InstancedBufferGeometry, but standard InstancedMesh supports it in r117+!
    instCubeEdges = new TH.InstancedMesh(cubeEdgeGeo, eMat, map.grabCubes.length);
    instCubeMesh.instanceMatrix.setUsage(TH.DynamicDrawUsage);
    instCubeEdges.instanceMatrix.setUsage(TH.DynamicDrawUsage);
    worldGroup.add(instCubeMesh, instCubeEdges);
    
    for (let i = 0; i < map.grabCubes.length; i++) {
      const hc = map.grabCubes[i];
      const pos = new TH.Vector3(...hc.c);
      grabCubes.push({ pos: pos.clone(), vel: new TH.Vector3(0, 0, 0), rotVel: new TH.Vector3(0, 0, 0), rad: 0.75, id: i, quat: new TH.Quaternion() });
    }
    buildExitFx(map.exit);
    exitPos.set(map.exit.x, map.exit.y, map.exit.z);
    spawnPt.set(map.spawn.x, map.spawn.y, map.spawn.z);
    hintZones = map.hints.map(h => ({ min: new V3(...h.min), max: new V3(...h.max), msg: h.msg }));
    pl.pos.copy(spawnPt); pl.vel.set(0, 0, 0); pl.cp.copy(spawnPt);
    pl.yaw = -Math.PI / 2; // forward = +x down the course
    pl.pitch = 0; pl.viewOffset = null; pl.maxSpeed = 0; pl.grounded = false; pl.jumpBuf = -1;
    won = false; runTime = 0; timerOn = false; portalsFired = 0;
    winPanel.classList.add('hidden');
    dom('seedinfo').textContent = seedStr;
  }
  function newMap(s) { 
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'new_map', seed: s }));
    menuPanel.classList.add('hidden'); 
    requestLock(); 
  }

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
      const offset = localPlayerIndex * 2;
      if (!portals[offset].placed && !portals[offset+1].placed) msg = 'FIRE PORTALS: LMB = blue, RMB = orange — they stick to any flat face (floor / ceiling / wall / ramp).';
      else if (!(portals[offset].placed && portals[offset+1].placed)) msg = 'Place the second portal. Speed is conserved through a pair: what falls in, flies out.';
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

      const activeKeys = pointerLocked ? keys : { KeyW: false, KeyA: false, KeyS: false, KeyD: false, Space: false, ShiftLeft: false };

      if (pointerLocked) {
        if ((keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD) && !timerOn) timerOn = true;
      }
        
      if (ws && ws.readyState === 1 && localPlayerId != null) {
        ws.send(JSON.stringify({
          type: 'input',
          dt: dt,
          keys: {
            KeyW: activeKeys.KeyW, KeyA: activeKeys.KeyA, KeyS: activeKeys.KeyS, KeyD: activeKeys.KeyD, Space: activeKeys.Space, ShiftLeft: activeKeys.ShiftLeft
          },
          yaw: pl.yaw,
          pitch: pl.pitch,
          autohop: autohop,
          jumpBuf: pl.jumpBuf,
          pos: pointerLocked ? pl.pos.toArray() : undefined,
          vel: pointerLocked ? pl.vel.toArray() : undefined,
          activeWeapon: activeWeapon,
        }));
      }

      let rem = dt;
      while (rem > 1e-4) { const s = Math.min(rem, 1 / 120); physStep(s, activeKeys); rem -= s; }
      
      // Render remote players
      for (const pid in remotePlayers) {
        if (!remotePlayerMeshes[pid]) {
          const remoteIndex = 1 - localPlayerIndex;
          const remoteColor = remoteIndex === 0 ? 0x33ff33 : 0xff3333;
          const mesh = createPlayerModel(remoteColor, 0); // Correct color, layer 0
          scene.add(mesh);
          remotePlayerMeshes[pid] = mesh;
        }
        const rp = remotePlayers[pid];
        const m = remotePlayerMeshes[pid];
        m.position.set(rp.pos[0], rp.pos[1], rp.pos[2]);
        m.rotation.y = rp.yaw;
        m.userData.headGroup.rotation.x = rp.pitch;
        m.userData.mirrorGun.visible = (rp.activeWeapon === 1 || !rp.activeWeapon);
        m.userData.mirrorRocketGun.visible = (rp.activeWeapon === 2);
      }
    }

    for (let i = 0; i < 4; i++) {
      quadMats[i].uniforms.uTime.value = now * 0.001;
    }
    placePortalVisuals();
    renderPortalViews();

    muzzleT = Math.max(0, muzzleT - dt * 6);
    gun.scale.setScalar(1 + muzzleT * 0.08);
    gun.userData.core.material.emissiveIntensity = 2.2 + muzzleT * 6;

    for (let i = activeBeams.length - 1; i >= 0; i--) {
      const b = activeBeams[i];
      b.life -= dt;
      if (b.life <= 0) {
        scene.remove(b.coreMesh); scene.remove(b.hMesh); scene.remove(b.points);
        b.coreMesh.material.dispose(); b.hMesh.material.dispose(); b.points.material.dispose();
        b.points.geometry.dispose();
        activeBeams.splice(i, 1);
        continue;
      }
      b.coreMesh.material.opacity = b.life * 0.9;
      b.coreMesh.scale.x = b.life * 0.6;
      b.coreMesh.scale.y = b.life * 0.6;
      
      b.hMesh.material.opacity = b.life * 0.8;
      b.hMesh.rotateZ(dt * 15);
      
      b.points.material.opacity = b.life;
      const pos = b.points.geometry.attributes.position.array;
      for (let j = 0; j < b.vel.length; j++) {
        pos[j*3] += b.vel[j].x * dt;
        pos[j*3+1] += b.vel[j].y * dt;
        pos[j*3+2] += b.vel[j].z * dt;
      }
      b.points.geometry.attributes.position.needsUpdate = true;
    }

    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i];
      r.life -= dt;
      const step = r.vel.clone().multiplyScalar(dt);
      
      let teleported = false;
      for (let pairIdx = 0; pairIdx < 2; pairIdx++) {
         if (teleported) break;
         const offset = pairIdx * 2;
         if (portals[offset].placed && portals[offset+1].placed) {
            const nextPos = r.pos.clone().add(step);
            for (let idx = 0; idx < 2; idx++) {
               const pi = offset + idx;
               const P = portals[pi], Q = portals[offset + (1 - idx)];
               const a = (r.pos.x - P.c.x) * P.n.x + (r.pos.y - P.c.y) * P.n.y + (r.pos.z - P.c.z) * P.n.z;
               const b = (nextPos.x - P.c.x) * P.n.x + (nextPos.y - P.c.y) * P.n.y + (nextPos.z - P.c.z) * P.n.z;
               if ((a > 0) !== (b > 0)) {
                  const t = Math.max(0, Math.min(1, a / (a - b)));
                  const cx = r.pos.x + (nextPos.x - r.pos.x) * t;
                  const cy = r.pos.y + (nextPos.y - r.pos.y) * t;
                  const cz = r.pos.z + (nextPos.z - r.pos.z) * t;
                  const du = Math.abs((cx - P.c.x) * P.r.x + (cy - P.c.y) * P.r.y + (cz - P.c.z) * P.r.z);
                  const dv = Math.abs((cx - P.c.x) * P.u.x + (cy - P.c.y) * P.u.y + (cz - P.c.z) * P.u.z);
                  if (du <= PORT.hw - 0.2 && dv <= PORT.hh - 0.2) {
                     const R = idx === 0 ? R_AB[pairIdx] : R_BA[pairIdx];
                     r.vel.applyMatrix4(R);
                     const rel = new V3(cx, cy, cz).sub(P.c).applyMatrix4(R);
                     r.pos.copy(Q.c).add(rel).addScaledVector(r.vel, dt * (1 - t));
                     r.mesh.quaternion.setFromRotationMatrix(R).multiply(r.mesh.quaternion);
                     teleported = true;
                     break;
                  }
               }
            }
         }
      }
      
      if (!teleported) {
        const hit = raycast(r.pos, r.vel.clone().normalize(), step.length(), 0.0);
        if (hit || r.life <= 0) {
          explosion(hit ? hit.point : r.pos);
          if (hit) destroyWall(hit.obb, hit.point, hit.normal);
          scene.remove(r.mesh);
          r.mesh.traverse(o => { if(o.material) o.material.dispose(); if(o.geometry) o.geometry.dispose(); });
          rockets.splice(i, 1);
          continue;
        }
        r.pos.add(step);
      }
      r.mesh.position.copy(r.pos);
      
      const smoke = new TH.Mesh(new TH.BoxGeometry(0.3, 0.3, 0.3), new TH.MeshBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.8 }));
      smoke.position.copy(r.pos);
      smoke.rotation.set(Math.random(), Math.random(), Math.random());
      scene.add(smoke);
      animObjects.push({ type: 'smoke', obj: smoke, life: 1.0 });
    }

    if (started) {
      const sp = Math.hypot(pl.vel.x, pl.vel.z);
      camera.position.copy(pl.pos);
      camera.position.y += CFG.H - 0.12; // pl.pos is the feet point — eyes near top of capsule
      let bob = 0;
      if (pl.grounded && sp > 1) bob = Math.sin(now * 0.012 * Math.min(2, sp / 7)) * 0.03 * Math.min(1, sp / CFG.GMAX);
      landingThump = Math.max(0, landingThump - dt * 4);
      camera.position.y += bob - landingThump * 0.18;
      camera.rotation.order = 'YXZ';
      camera.quaternion.setFromEuler(new TH.Euler(pl.pitch, pl.yaw, 0, 'YXZ'));
      
      playerModel.position.copy(pl.pos);
      playerModel.rotation.set(0, pl.yaw, 0, 'YXZ');
      if (playerModel.userData.headGroup) {
        playerModel.userData.headGroup.rotation.x = pl.pitch;
      }
      if (playerModel.userData.mirrorGun) {
        playerModel.userData.mirrorGun.visible = (activeWeapon === 1);
        playerModel.userData.mirrorRocketGun.visible = (activeWeapon === 2);
      }

      let closestPortal = -1, minDist = 3.5;
      for (let i = 0; i < 4; i++) {
        if (!portals[i].placed) continue;
        const d = pl.pos.distanceTo(portals[i].c);
        if (d < minDist) { minDist = d; closestPortal = i; }
      }
      if (closestPortal !== -1) {
        const P = portals[closestPortal];
        playerClipPlane.normal.copy(P.n);
        playerClipPlane.constant = -P.n.dot(P.c);
      } else {
        playerClipPlane.normal.set(0, 1, 0);
        playerClipPlane.constant = 1e6;
      }

      if (pl.viewOffset) {
        const id = new TH.Quaternion();
        pl.viewOffset.slerp(id, Math.min(1, dt * 5));
        if (pl.viewOffset.angleTo(id) < 0.001) pl.viewOffset = null;
        else camera.quaternion.multiply(pl.viewOffset);
      }
      const wantFov = Math.min(baseFov + 16, baseFov + Math.max(0, (sp - CFG.GMAX) * 0.5));
      if (Math.abs(camera.fov - wantFov) > 0.05) { camera.fov = wantFov; camera.updateProjectionMatrix(); }

      let canGrab = false;
      if (!grabbedCube) {
         camera.updateMatrixWorld(true);
         const pos = camera.getWorldPosition(new TH.Vector3());
         const dir = new TH.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
         for (const cb of grabCubes) {
            const v = cb.pos.clone().sub(pos);
            const dist = v.length();
            if (dist < 7.0 && v.normalize().dot(dir) > 0.9) { canGrab = true; break; }
         }
      }
      const ch = dom('crosshair');
      if (canGrab) ch.classList.add('grab');
      else ch.classList.remove('grab');
    }

    for (const c of grabCubes) {
       if (c === grabbedCube) {
          const t = new TH.Vector3(0.5, -0.4, -1.2).applyQuaternion(camera.quaternion);
          const wantPos = camera.position.clone().add(t);
          if (c.pos.distanceTo(wantPos) > 5.0) c.pos.copy(wantPos); // snap if teleported
          else c.pos.lerp(wantPos, dt * 15);
          c.vel.set(0, 0, 0);
          const qSpin = new TH.Quaternion().setFromEuler(new TH.Euler(dt * 2, dt * 3, 0));
          c.quat.multiply(qSpin);
       } else {
          c.vel.y -= CFG.G * dt;
          const step = c.vel.clone().multiplyScalar(dt);
          
          // Portal Check
          let teleported = false;
          for (let pairIdx = 0; pairIdx < 2; pairIdx++) {
             if (teleported) break;
             const offset = pairIdx * 2;
             if (portals[offset].placed && portals[offset+1].placed) {
                const nextPos = c.pos.clone().add(step);
                for (let idx = 0; idx < 2; idx++) {
                   const pi = offset + idx;
                   const P = portals[pi], Q = portals[offset + (1 - idx)];
                   const a = (c.pos.x - P.c.x) * P.n.x + (c.pos.y - P.c.y) * P.n.y + (c.pos.z - P.c.z) * P.n.z;
                   const b = (nextPos.x - P.c.x) * P.n.x + (nextPos.y - P.c.y) * P.n.y + (nextPos.z - P.c.z) * P.n.z;
                   if ((a > 0) !== (b > 0)) {
                      const t = Math.max(0, Math.min(1, a / (a - b)));
                      const cx = c.pos.x + (nextPos.x - c.pos.x) * t;
                      const cy = c.pos.y + (nextPos.y - c.pos.y) * t;
                      const cz = c.pos.z + (nextPos.z - c.pos.z) * t;
                      const du = Math.abs((cx - P.c.x) * P.r.x + (cy - P.c.y) * P.r.y + (cz - P.c.z) * P.r.z);
                      const dv = Math.abs((cx - P.c.x) * P.u.x + (cy - P.c.y) * P.u.y + (cz - P.c.z) * P.u.z);
                      if (du <= PORT.hw && dv <= PORT.hh) {
                         const R = idx === 0 ? R_AB[pairIdx] : R_BA[pairIdx];
                         c.vel.applyMatrix4(R);
                         const rel = new V3(cx, cy, cz).sub(P.c).applyMatrix4(R);
                         c.pos.copy(Q.c).add(rel).addScaledVector(c.vel, dt * (1 - t));
                         teleported = true;
                         break;
                      }
                   }
                }
             }
          }
          
          if (!teleported) {
             c.pos.add(step);
             collideCube(c, c.rad);
             if (c.vel.lengthSq() < 0.25) {
                c.vel.set(0, 0, 0); // sleep when very slow
                c.rotVel.multiplyScalar(0.8);
                const eu = new TH.Euler().setFromQuaternion(c.quat);
                const snap = Math.PI / 2;
                c.rotVel.x += (Math.round(eu.x / snap) * snap - eu.x) * dt * 30;
                c.rotVel.y += (Math.round(eu.y / snap) * snap - eu.y) * dt * 30;
                c.rotVel.z += (Math.round(eu.z / snap) * snap - eu.z) * dt * 30;
             }
             
             const qSpin = new TH.Quaternion().setFromEuler(new TH.Euler(c.rotVel.x * dt, c.rotVel.y * dt, c.rotVel.z * dt));
             c.quat.multiply(qSpin);
          }
       }
    }
    
    resolveCubeCollisions();
    // Update mesh positions again after resolution
    const dummy = new TH.Object3D();
    for (const c of grabCubes) {
       dummy.position.copy(c.pos);
       dummy.quaternion.copy(c.quat);
       dummy.updateMatrix();
       instCubeMesh.setMatrixAt(c.id, dummy.matrix);
       instCubeEdges.setMatrixAt(c.id, dummy.matrix);
    }
    instCubeMesh.instanceMatrix.needsUpdate = true;
    instCubeEdges.instanceMatrix.needsUpdate = true;
    
    for (let i = 0; i < 4; i++) {
       const P = portals[i];
       const sp = sparkles[i];
       if (!sp.mesh.visible) continue;
       
       const age = (performance.now() / 1000) - (P.openTime || 0);
       let scl = Math.min(1.0, age / 0.3); // open quickly
       // overshoot elastic bounce
       if (age < 0.5) {
           const t = age / 0.5;
           scl = 1.0 + Math.sin(t * Math.PI * 3.0) * (1.0 - t) * 0.3;
       } else {
           scl = 1.0 + Math.sin(age * 3.0) * 0.02; // breathing
       }
       
       quads[i].scale.setScalar(scl);
       frames[i].scale.set((PORT.hw + 0.05) * scl, (PORT.hh + 0.05) * scl, 1);
       glowLights[i].intensity = 5.0 * scl;
       
       for (let j = 0; j < 100; j++) {
          if (sp.life[j] <= 0) {
             if (Math.random() < 0.2) {
                const ang = Math.random() * Math.PI * 2;
                const ex = Math.cos(ang) * PORT.hw;
                const ey = Math.sin(ang) * PORT.hh;
                sp.pos[j*3] = ex; sp.pos[j*3+1] = ey; sp.pos[j*3+2] = (Math.random() - 0.5) * 0.2;
                sp.vel[j].set(ex, ey, 0).normalize().multiplyScalar(Math.random() * 2.0 + 1.0);
                sp.vel[j].z = (Math.random() - 0.5) * 3.0;
                sp.life[j] = 0.5 + Math.random() * 1.0;
             }
          } else {
             sp.life[j] -= dt * 1.2;
             sp.pos[j*3] += sp.vel[j].x * dt;
             sp.pos[j*3+1] += sp.vel[j].y * dt;
             sp.pos[j*3+2] += sp.vel[j].z * dt;
          }
       }
       sp.mesh.geometry.attributes.position.needsUpdate = true;
       sp.mesh.geometry.attributes.life.needsUpdate = true;
    }

    for (let i = animObjects.length - 1; i >= 0; i--) {
      const a = animObjects[i];
      if (a.type === 'lantern') {
        a.obj.position.y += Math.sin(nowT * 2 + a.phase) * 0.01;
        a.obj.rotation.y += dt * 0.5;
      } else if (a.type === 'holo') {
        a.obj.rotation.x += dt * 0.8;
        a.obj.rotation.y += dt * 1.2;
      } else if (a.type === 'core') {
        a.ring.rotation.z -= dt * 2;
        a.ring2.rotation.z += dt * 3;
      } else if (a.type === 'expl') {
        a.life -= dt * 3;
        if (a.life <= 0) {
           scene.remove(a.obj);
           a.obj.material.dispose(); a.obj.geometry.dispose();
           animObjects.splice(i, 1);
        } else {
           a.obj.scale.setScalar(1 + (1 - a.life) * 1.5);
           a.obj.material.opacity = Math.max(0, a.life);
        }
      } else if (a.type === 'smoke') {
        a.life -= dt * 2.5;
        if (a.life <= 0) {
           scene.remove(a.obj);
           a.obj.material.dispose(); a.obj.geometry.dispose();
           animObjects.splice(i, 1);
        } else {
           a.obj.scale.setScalar(a.life * 1.5);
           a.obj.material.opacity = a.life * 0.4;
           a.obj.position.y += dt * 0.5;
           a.obj.rotation.x += dt;
           a.obj.rotation.y += dt;
        }
      } else if (a.type === 'debris') {
        a.life -= dt;
        if (a.life <= 0) {
           scene.remove(a.obj);
           a.obj.traverse(o => { if (o.geometry) o.geometry.dispose(); });
           animObjects.splice(i, 1);
        } else {
           a.vel.y -= CFG.G * dt; // Gravity
           a.obj.position.addScaledVector(a.vel, dt);
           a.obj.rotation.x += a.rot.x * dt;
           a.obj.rotation.y += a.rot.y * dt;
           a.obj.rotation.z += a.rot.z * dt;
           
           // Floor bounce
           if (a.obj.position.y < -0.1 && a.vel.y < 0) {
              a.obj.position.y = -0.1;
              a.vel.y *= -0.5;
              a.vel.x *= 0.6;
              a.vel.z *= 0.6;
              a.rot.multiplyScalar(0.5);
           }
           
           // Fade out at end
           if (a.life < 1.0) {
             a.obj.scale.setScalar(a.life);
           }
        }
      }
    }
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
  
  // Pre-warm the renderer to prevent stutter on first portal pair placement
  portals.forEach(p => { p.placed = true; p.n.set(0, 1, 0); });

  updatePair();
  quads.forEach(q => q.visible = true);
  renderPortalViews();
  portals.forEach(p => p.placed = false);
  quads.forEach(q => q.visible = false);
  renderer.clear();
  
  requestAnimationFrame(frame);
}
