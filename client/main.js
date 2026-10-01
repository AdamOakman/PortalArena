/* ============================================================================
   PORTAL//FLUX — portal physics + Quake/Warsow movement in the browser.
   Files: index.html (UI shell) + game.js (this). Three.js loaded from CDN.

   Mechanics:
   - Portals: LMB = Primary, RMB = Secondary. They stick to any flat face of
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
import { generateMap } from '../shared/mapgen.js?v=2';
import { CFG, PORT } from '../shared/constants.js';
import { initPhysics } from '../shared/physics.js?v=2';
import { AudioSys } from './audio.js';
import { initTextures } from './textures.js';
import { initHUD } from './hud.js';
import { initEngine } from './engine.js';
import { initNetwork } from './network.js';
import { initModels } from './models.js';
import { initPortalRendering } from './render_portals.js';

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
  const { renderer, scene, camera, skyGroup } = initEngine(TH, canvas);
  let baseFov = 115;
  let worldGroup = null; // rebuilt on new map

  /* --------------------------------------------------------------- audio */
  /* ------------------------------------------------------------- textures */
  const { getSlabMat, gridTexture } = initTextures(TH);

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


  const pl = { pos: new V3(), vel: new V3(), yaw: 0, pitch: 0, viewOffset: null, grounded: false, groundNormal: new V3(0, 1, 0), groundT: -1, jumpBuf: -1, cp: new V3(), maxSpeed: 0, crouchT: 0 };

  let activeWeapon = 1; // 1 = Portal Gun, 2 = Rocket Launcher, 3 = Instagib
  let isZooming = false;
  let isConnected = false;
  let lastIp = null, lastPass = null, lastName = null;
  let zoomAmt = 0;
  let autohop = true, started = false, won = false;
  let nowT = 0, match = null, localReady = false, statsOpen = false, nextPingT = 0, lastPingMs = 0;
  const keys = {};
  let pointerLocked = false;
  
  const grabCubes = [];
  let grabbedCube = null;
  let instCubeMesh = null, instCubeEdges = null;

  const dom = id => document.getElementById(id);
  const startPanel = dom('startpanel'), menuPanel = dom('menupanel'), winPanel = dom('winpanel');

  function addEventLog(msg) {
    const logDiv = document.getElementById('eventlog');
    if (!logDiv) return;
    const el = document.createElement('div');
    el.className = 'event';
    el.innerText = msg;
    logDiv.appendChild(el);
    while (logDiv.children.length > 5) {
      logDiv.removeChild(logDiv.firstChild);
    }
    setTimeout(() => {
      if (el.parentNode === logDiv) logDiv.removeChild(el);
    }, 15000);
  }

  function requestLock() { canvas.requestPointerLock && canvas.requestPointerLock(); }
  document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === canvas;
    if (pointerLocked) menuPanel.classList.add(String.fromCharCode(104,105,100,100,101,110));

  });
  canvas.addEventListener('click', () => { AudioSys.ensure(); if (started && !pointerLocked && !won) requestLock(); });

  document.addEventListener('mousemove', e => {
    if (!pointerLocked || document.pointerLockElement !== canvas) return;
    if (Math.abs(e.movementX) > 100 || Math.abs(e.movementY) > 100) return;
    const sens = 0.0023 * (camera.fov / baseFov);
    pl.yaw -= e.movementX * sens;
    pl.pitch = Math.max(-1.55, Math.min(1.55, pl.pitch - e.movementY * sens));
  });

  document.addEventListener('mousedown', e => {
    if (!pointerLocked || won || isDead) return;
    AudioSys.ensure();
    if (e.button === 0) {
      if (grabbedCube) {
         // Throw cube
         const dir = new TH.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
         grabbedCube.vel.copy(dir).multiplyScalar(22).add(pl.vel);
         grabbedCube.rotVel.set(Math.random()-0.5, Math.random()-0.5, Math.random()-0.5).multiplyScalar(15);
         Network.send({
               type: 'throw_cube',
               idx: grabCubes.indexOf(grabbedCube),
               pos: grabbedCube.pos.toArray(),
               vel: grabbedCube.vel.toArray()
            });
         grabbedCube = null;
      } else {
         if (activeWeapon === 1) firePortal(localPlayerIndex * 2);
         else if (activeWeapon === 2) fireRocket();
         else if (activeWeapon === 3) fireInstagib();
      }
    }
    else if (e.button === 2) {
      if (activeWeapon === 1 && !grabbedCube) firePortal(localPlayerIndex * 2 + 1);
      else if (activeWeapon === 3) isZooming = true;
    }
  });
  document.addEventListener('mouseup', e => {
    if (e.button === 2) isZooming = false;
  });
  document.addEventListener('contextmenu', e => e.preventDefault());

  document.addEventListener('wheel', () => {
    if (!pointerLocked || won || !started) return;
    activeWeapon = (activeWeapon === 1) ? 2 : 1;
    if (activeWeapon === 1) { gun.visible = true; rocketGun.visible = false; }
    else { gun.visible = false; rocketGun.visible = true; }
  });

  document.addEventListener('keydown', e => {
    if (e.code === 'Enter') {
      if (!started && !dom('startpanel').classList.contains('hidden')) {
        dom('btnstart').click();
        return;
      }
    }
    if (e.target.tagName === 'INPUT') return;
    const c = e.code;
    if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'ControlLeft', 'BracketLeft', 'BracketRight', 'Digit1', 'Digit2', 'Digit3'].includes(c)) e.preventDefault();
    keys[c] = true;
    if (c === 'Tab') { e.preventDefault(); statsOpen = started; }
    if (!started || isDead) return;
    if (c === 'Digit1') { activeWeapon = 1; gun.visible = true; rocketGun.visible = false; instagibGun.visible = false; }
    if (c === 'Digit2') { activeWeapon = 2; gun.visible = false; rocketGun.visible = true; instagibGun.visible = false; }
    if (c === 'Digit3') { activeWeapon = 3; gun.visible = false; rocketGun.visible = false; instagibGun.visible = true; }
    if (c === 'Space') pl.jumpBuf = nowT;
    
    if (c === 'KeyF') toggleFullscreen();
    if (c === String.fromCharCode(69,115,99,97,112,101)) { if (started && !won) menuPanel.classList.toggle(String.fromCharCode(104,105,100,100,101,110)); }
    if (c === 'KeyR' && !e.repeat) {
      if (match && (match.phase === 'warmup' || match.phase === 'waiting')) {
        localReady = !localReady;
        Network.send({ type: 'ready', ready: localReady });
      }
    }
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
    if (c === 'KeyM') { AudioSys.toggleMute(); dom('muteinf').textContent = AudioSys.muted ? 'off' : 'on'; syncMuteBtn(); }
    if (c === 'BracketLeft') setFov(baseFov - 5);
    if (c === 'BracketRight') setFov(baseFov + 5);
  });
  document.addEventListener('keyup', e => { keys[e.code] = false; if (e.code === 'Tab') statsOpen = false; });

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
  
  function syncMuteBtn() { const b = dom('btnmute'); if (b) b.textContent = 'SOUND: ' + (AudioSys.muted ? 'OFF' : 'ON'); const i = dom('muteinf'); if (i) i.textContent = AudioSys.muted ? 'off' : 'on'; }
  
  dom('btnmute').addEventListener('click', () => { AudioSys.toggleMute(); syncMuteBtn(); });
  dom('btnfs').addEventListener('click', toggleFullscreen);

  
  const Network = initNetwork({
    onMessage: (data) => {
      if (data.type === 'init') {
        localPlayerId = data.playerId;
        localPlayerIndex = data.playerIndex % 2;
        
        const localColor = localPlayerIndex === 0 ? 0x33ff33 : 0xff3333;
        const bMesh = playerModel.children.find(c => c.name === 'bodyMesh');
        if (bMesh) bMesh.material.color.setHex(localColor);
        const headGroup = playerModel.children.find(c => c.name === 'headGroup');
        if (headGroup) { const hMesh = headGroup.children.find(c => c.name === 'headMesh'); if (hMesh) hMesh.material.color.setHex(localColor); }
        
        gun.userData.core.material.emissive.setHex(portals[localPlayerIndex * 2].color);
        gun.userData.ring.material.emissive.setHex(portals[localPlayerIndex * 2].color);
        
        started = true; startPanel.classList.add('hidden');
        if (currentSeed !== data.seed) loadMap(data.seed);
        isConnected = true;
        if (data.match) {
          match = data.match;
          const me = match.players[localPlayerId];
          localReady = me ? !!me.ready : false;
          won = (match.phase === 'summary');
          if (won) showSummary();
        }
        if (!pointerLocked) requestLock();
      } else if (data.type === 'player_connected') {
        addEventLog(data.name + ' has just connected');
      } else if (data.type === 'player_disconnected') {
        addEventLog(data.name + ' dropped from the game');
      } else if (data.type === 'map_change') {
        loadMap(data.seed);
      } else if (data.type === 'state') {
        if (data.match) {
          match = data.match;
          const me = match.players[localPlayerId];
          localReady = me ? !!me.ready : false;
          won = (match.phase === 'summary');
          if (won) { if (winPanel.classList.contains('hidden')) showSummary(); }
          else if (!winPanel.classList.contains('hidden')) winPanel.classList.add('hidden');
        }
        for (const pid in data.players) {
           if (pid === localPlayerId) {
             continue;
           }
           const oldRp = remotePlayers[pid];
           remotePlayers[pid] = data.players[pid];
           if (oldRp && oldRp.predictedDeadUntil) remotePlayers[pid].predictedDeadUntil = oldRp.predictedDeadUntil;
        }
        for (const pid in remotePlayers) {
           if (!data.players[pid]) {
               delete remotePlayers[pid];
               if (remotePlayerMeshes[pid]) {
                   scene.remove(remotePlayerMeshes[pid]);
                   delete remotePlayerMeshes[pid];
               }
           }
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
        if (data.playerId !== localPlayerId && remotePlayerMeshes[data.playerId]) remotePlayerMeshes[data.playerId].userData.muzzleT = 1;
        spawnBeam(portals[data.pi].color, new V3(...data.start), new V3(...data.end));
      } else if (data.type === 'fire_rocket') {
        if (data.playerId !== localPlayerId && remotePlayerMeshes[data.playerId]) remotePlayerMeshes[data.playerId].userData.muzzleT = 1;
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
        rockets.push({ pos: new V3(...data.pos), vel: new V3(...data.vel), mesh: rMesh, life: 5, isLocal: false });
        AudioSys.tone(300, 150, 0.3, 'sawtooth', 0.1, 0, new V3(...data.pos));
      } else if (data.type === 'fire_instagib') {
        if (data.playerId !== localPlayerId && remotePlayerMeshes[data.playerId]) remotePlayerMeshes[data.playerId].userData.muzzleT = 1;
        const pts = data.pts.map(a => new V3(...a));
        if (data.playerId !== localPlayerId && remotePlayerMeshes[data.playerId]) {
           const rm = remotePlayerMeshes[data.playerId];
           if (rm.userData.mirrorInstagibGun) {
             rm.updateMatrixWorld(true);
             rm.userData.mirrorInstagibGun.updateMatrixWorld(true);
             pts[0].set(0, 0, -0.4).applyMatrix4(rm.userData.mirrorInstagibGun.matrixWorld);
           }
        }
        for (let i = 0; i < pts.length; i += 2) spawnInstagibBeam(pts[i], pts[i+1]);
        AudioSys.tone(150, 40, 0.8, 'square', 0.4);
        AudioSys.tone(800, 150, 0.5, 'sawtooth', 0.2);
        
        if (data.hitPlayerId === localPlayerId) {
           die(data.playerId);
        }
      } else if (data.type === 'player_died') {
        const pos = new V3(...data.pos);
        spawnDeathAnimation(pos, data.color);
      } else if (data.type === 'respawn') {
        isDead = false;
        playerModel.visible = true;
        if (activeWeapon === 1) gun.visible = true;
        if (activeWeapon === 2) rocketGun.visible = true;
        if (activeWeapon === 3) instagibGun.visible = true;
        pl.pos.fromArray(data.pos);
        pl.vel.set(0, 0, 0);
        pl.yaw = -Math.PI / 2; pl.pitch = 0; pl.viewOffset = null;
        AudioSys.tone(120, 60, 0.4, 'sawtooth', 0.08);
      } else if (data.type === 'pong') {
        lastPingMs = Math.max(0, Math.round(performance.now() - data.t));
      } else if (data.type === 'round_over') {
        match = data.match;
        won = true;
        showSummary();
      }
    },
    onError: () => {},
    onClose: () => {
      isConnected = false;
      if (started) {
         setTimeout(() => { if (lastIp) Network.connect(lastIp, lastPass, lastName); }, 1000);
      }
    }
  });
    
  let localPlayerId = null;
  let localPlayerIndex = 0;
  const remotePlayers = {}; // { id: { pos, vel, yaw, pitch } }
  const remotePlayerMeshes = {};

  dom('btnstart').addEventListener('click', () => {
    const ipInput = document.getElementById('ipinput');
    const passInput = document.getElementById('passinput');
    const ip = (ipInput && ipInput.value.trim()) ? ipInput.value.trim() : 'host:3001';
    const pass = (passInput && passInput.value.trim()) ? passInput.value.trim() : 'secret';
    const nameInput = document.getElementById('nameinput');
    const actualIp = ip || 'host:3001';
    
    lastIp = actualIp; lastPass = pass;
    lastName = (nameInput && nameInput.value.trim()) ? nameInput.value.trim() : 'Guest';
    Network.connect(actualIp, pass, lastName);

  });
  dom('btnresume').addEventListener('click', requestLock);
  dom('btnnewmap').addEventListener('click', () => {
    const s = dom('seedinput2').value.trim() || String(Math.floor(Math.random() * 1e9));
    newMap(s);
  });
  dom('btnagain').addEventListener('click', () => newMap(String(Math.floor(Math.random() * 1e9))));
  dom('btnsame').addEventListener('click', () => {
    Network.send({ type: 'new_map', seed: currentSeed });
    winPanel.classList.add('hidden'); requestLock(); 
  });

  function showSummary() {
    if (!match) return;
    let title, sub;
    if (match.winner === 'tie') { title = 'DRAW'; sub = 'THE CHAMBER BALANCES — NO FAVOR GIVEN'; }
    else {
      const w = match.winner && match.players[match.winner];
      title = (w ? w.name : 'PLAYER') + ' WINS';
      sub = 'THE ROUND IS DECIDED';
    }
    const t = dom('winTitle'), s = dom('winSub');
    if (t) t.textContent = title;
    if (s) s.textContent = sub;
    winPanel.classList.remove('hidden');
  }

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
    const core = new TH.Mesh(new TH.TorusGeometry(1, 0.02, 8, 64), new TH.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
    const glow1 = new TH.Mesh(new TH.TorusGeometry(1, 0.08, 8, 64), new TH.MeshBasicMaterial({ color: portals[i].color, transparent: true, opacity: 0.8, blending: TH.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
    const glow2 = new TH.Mesh(new TH.TorusGeometry(1, 0.25, 8, 64), new TH.MeshBasicMaterial({ color: portals[i].color, transparent: true, opacity: 0.35, blending: TH.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
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
      transparent: true, side: TH.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4,
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
        AudioSys.tone(220, 120, 0.15, 'square', 0.06); 
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
          if (du < PORT.hw * 2 + 0.35 && dv < PORT.hh * 2 + 0.35) { AudioSys.tone(220, 120, 0.15, 'square', 0.06); return false; }
        }
      }
    }
    P.placed = true; P.c.copy(c); P.n.copy(n); P.r.copy(f.r); P.u.copy(f.u); P.openTime = performance.now() / 1000;
    Network.send({
        type: 'portal_place', pi,
        c: P.c.toArray(), n: P.n.toArray(), r: P.r.toArray(), u: P.u.toArray()
      });
    updatePair();
    AudioSys.tone(700, 1400, 0.09, 'sine', 0.08); AudioSys.tone(1400, 2400, 0.12, 'triangle', 0.05, 0.03);
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
    Network.send({ type: 'fire_beam', pi, start: gunPos.toArray(), end: target.toArray() });
    
    muzzleFlash(pi);
    if (!hit) { AudioSys.tone(180, 90, 0.1, 'square', 0.05); return; }
    tryPlace(pi, hit);
  }

  /* =======================================================================
     MOVEMENT & COLLISION (capsule vs OBB)
     ======================================================================= */


  let landingThump = 0;
  let tpGracePortal = null, tpGraceT = -1;
  const _tpFlash = document.getElementById('flash');

  // Safety fallback only (falling out of the world) — no longer bound to a key
  function respawn() {
    pl.pos.copy(spawnPt); pl.vel.set(0, 0, 0);
    pl.yaw = -Math.PI / 2; pl.pitch = 0; pl.viewOffset = null;
    AudioSys.tone(120, 60, 0.4, 'sawtooth', 0.08);
  }

  function physStep(dt, activeKeys) {
    const k = isDead ? {} : activeKeys;
    const tpState = { nowT, tpGracePortal, tpGraceT, R_AB, R_BA };
    const events = {
      onJumppad: () => { AudioSys.tone(200, 600, 0.4, 'sine', 0.15); },
      onLand: (vol) => { landingThump = vol; },
      onJump: () => { AudioSys.tone(340, 520, 0.06, 'triangle', 0.04); },
      onTeleport: () => { _tpFlash.classList.remove('fadeflash'); void _tpFlash.offsetWidth; _tpFlash.classList.add('fadeflash'); }
    };
    physics.physStep(pl, k, autohop, dt, obbs, portals, grabCubes, grabbedCube, tpState, events);
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


  /* =======================================================================
     MODELS (Gun & Player)
     ======================================================================= */
  const { gun, rocketGun, instagibGun, createPlayerModel } = initModels(TH, camera, scene);
  
  
  let muzzleT = 0;
  function muzzleFlash(pi) {
    muzzleT = 1;
    const hex = portals[pi].color;
    gun.userData.core.material.emissive.setHex(hex);
    gun.userData.ring.material.emissive.setHex(hex);
  }
  
  
  

  const rockets = [];
  let lastRocketTime = -999;
  function fireRocket() {
    const t = performance.now() / 1000;
    if (t - lastRocketTime < 0.5) return;
    muzzleT = 1;
    lastRocketTime = t;
    
    AudioSys.tone(300, 150, 0.3, 'sawtooth', 0.1);
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
    
    rockets.push({ pos: pos.clone(), vel: dir.multiplyScalar(70), mesh: rMesh, life: 5, isLocal: true });
    Network.send({ type: 'fire_rocket', pos: pos.toArray(), vel: dir.toArray() });
  }

  function spawnInstagibBeam(start, end) {
    const d = end.clone().sub(start);
    const len = d.length();
    if (len < 0.001) return;
    const beamGroup = new TH.Group();
    beamGroup.position.copy(start);
    beamGroup.quaternion.setFromUnitVectors(new TH.Vector3(0, 0, 1), d.clone().normalize());
    const coreGeo = new TH.CylinderGeometry(0.015, 0.015, len, 8);
    coreGeo.translate(0, len / 2, 0); coreGeo.rotateX(Math.PI / 2);
    const coreMat = new TH.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1.0 });
    const core = new TH.Mesh(coreGeo, coreMat);
    beamGroup.add(core);
    const glowGeo = new TH.CylinderGeometry(0.08, 0.08, len, 8);
    glowGeo.translate(0, len / 2, 0); glowGeo.rotateX(Math.PI / 2);
    const glowMat = new TH.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.6, blending: TH.AdditiveBlending, depthWrite: false });
    const glow = new TH.Mesh(glowGeo, glowMat);
    beamGroup.add(glow);
    const pCount = Math.min(300, Math.floor(len * 6));
    const pGeo = new TH.BufferGeometry();
    const pos = new Float32Array(pCount * 3);
    const vel = [];
    for (let i = 0; i < pCount; i++) {
       const t = Math.random() * len;
       pos[i*3] = 0; pos[i*3+1] = 0; pos[i*3+2] = t;
       const ang = Math.random() * Math.PI * 2;
       const speed = Math.random() * 8 + 4;
       vel.push(new V3(Math.cos(ang) * speed, Math.sin(ang) * speed, (Math.random()-0.5) * 8));
    }
    pGeo.setAttribute('position', new TH.BufferAttribute(pos, 3));
    const pMat = new TH.PointsMaterial({ color: 0xff6666, size: 0.08, transparent: true, opacity: 1.0, blending: TH.AdditiveBlending, depthWrite: false });
    const points = new TH.Points(pGeo, pMat);
    beamGroup.add(points);
    scene.add(beamGroup);
    animObjects.push({ type: 'instagib_beam2', obj: beamGroup, core: core, glow: glow, points: points, vel: vel, life: 1.0 });
  }

  let lastInstagibTime = -999;
  function fireInstagib() {
    if (nowT - lastInstagibTime < 1.0) return;
    muzzleT = 1;
    lastInstagibTime = nowT;
    AudioSys.tone(150, 40, 0.8, 'square', 0.4);
        AudioSys.tone(800, 150, 0.5, 'sawtooth', 0.2);
    camera.updateMatrixWorld(true);
    instagibGun.updateMatrixWorld(true);
    
    let curPos = camera.position.clone();
    let curDir = new TH.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    let remaining = 300;
    const pts = [];
    let curStart = new TH.Vector3(0, 0, -0.4).applyMatrix4(instagibGun.matrixWorld);

    for (let iter = 0; iter < 4; iter++) {
        let hit = raycast(curPos, curDir, remaining);
        let bestPortal = null, bestT = hit ? hit.distance : remaining;
        
        for (let i = 0; i < portals.length; i++) {
           const P = portals[i];
           if (!P.placed) continue;
           const denom = curDir.dot(P.n);
           if (denom < -0.001) {
              const pt = P.c.clone().sub(curPos).dot(P.n) / denom;
              if (pt > 0.01 && pt < bestT) {
                 const hitPt = curPos.clone().addScaledVector(curDir, pt);
                 const d = hitPt.clone().sub(P.c);
                 if (Math.abs(d.dot(P.r)) < 2.3 && Math.abs(d.dot(P.u)) < 3.2) {
                    bestT = pt;
                    bestPortal = i;
                 }
              }
           }
        }
        
        let hitPlayerId = null;
        let hitPlayerT = bestT;
        for (const id in remotePlayers) {
            const rp = remotePlayers[id];
            const rpPos = new TH.Vector3().fromArray(rp.pos);
            const box = new TH.Box3();
            box.min.copy(rpPos).add(new TH.Vector3(-0.4, 0, -0.4));
            box.max.copy(rpPos).add(new TH.Vector3(0.4, CFG.H, 0.4));
            const ray = new TH.Ray(curPos, curDir);
            const playerHit = ray.intersectBox(box, new TH.Vector3());
            if (playerHit) {
               const dist = curPos.distanceTo(playerHit);
               if (dist < hitPlayerT) {
                   hitPlayerT = dist;
                   hitPlayerId = id;
               }
            }
        }
        
        if (iter > 0 && !won && !isDead) {
            const box = new TH.Box3();
            box.min.copy(pl.pos).add(new TH.Vector3(-0.4, 0, -0.4));
            box.max.copy(pl.pos).add(new TH.Vector3(0.4, CFG.H, 0.4));
            const ray = new TH.Ray(curPos, curDir);
            const playerHit = ray.intersectBox(box, new TH.Vector3());
            if (playerHit) {
               const dist = curPos.distanceTo(playerHit);
               if (dist < hitPlayerT) {
                   hitPlayerT = dist;
                   hitPlayerId = localPlayerId;
               }
            }
        }

        if (iter > 0 && !won && !isDead) {
            const box = new TH.Box3();
            box.min.copy(pl.pos).add(new TH.Vector3(-0.4, 0, -0.4));
            box.max.copy(pl.pos).add(new TH.Vector3(0.4, CFG.H, 0.4));
            const ray = new TH.Ray(curPos, curDir);
            const playerHit = ray.intersectBox(box, new TH.Vector3());
            if (playerHit) {
               const dist = curPos.distanceTo(playerHit);
               if (dist < hitPlayerT) {
                   hitPlayerT = dist;
                   hitPlayerId = localPlayerId;
               }
            }
        }
        
        if (hitPlayerId !== null) {
            bestT = hitPlayerT;
            const trueHitPt = curPos.clone().addScaledVector(curDir, bestT);
            pts.push(curStart, trueHitPt);
            Network.send({ type: 'fire_instagib', pts: pts.map(p => p.toArray()), hitPlayerId });
            if (hitPlayerId === localPlayerId) { die(localPlayerId); } else if (remotePlayers[hitPlayerId]) {
               remotePlayers[hitPlayerId].isDead = true;
               remotePlayers[hitPlayerId].predictedDeadUntil = nowT + 3.0;
            }
            AudioSys.tone(600, 600, 0.5, 'sine', 0.3);
            if (remotePlayerMeshes[hitPlayerId]) remotePlayerMeshes[hitPlayerId].visible = false;
            for (let i = 0; i < pts.length; i += 2) spawnInstagibBeam(pts[i], pts[i+1]);
            return;
        }
        
        const hitPt = curPos.clone().addScaledVector(curDir, bestT);
        pts.push(curStart, hitPt);
        
        if (bestPortal !== null) {
           const other = portals[bestPortal ^ 1];
           if (other.placed) {
              const local = hitPt.clone().sub(portals[bestPortal].c);
              const lx = local.dot(portals[bestPortal].r), ly = local.dot(portals[bestPortal].u);
              curPos = other.c.clone().addScaledVector(other.r, -lx).addScaledVector(other.u, ly).addScaledVector(other.n, 0.02);
              
              const m = new TH.Matrix4().makeBasis(portals[bestPortal].r, portals[bestPortal].u, portals[bestPortal].n);
              const inv = m.clone().invert();
              const om = new TH.Matrix4().makeBasis(other.r.clone().negate(), other.u, other.n.clone().negate());
              curDir.applyMatrix4(inv).applyMatrix4(om).normalize();
              curStart = curPos.clone();
              remaining -= bestT;
              continue;
           }
        }
        break;
    }
    
    for (let i = 0; i < pts.length; i += 2) spawnInstagibBeam(pts[i], pts[i+1]);
    
    Network.send({ type: 'fire_instagib', pts: pts.map(p => p.toArray()) });
  }

  function spawnDeathAnimation(pos, color) {
    const gibColor = color || 0xaa0000;
    AudioSys.tone(200, 500, 0.5, 'square', 0.1);
    for (let i = 0; i < 20; i++) {
       const geo = new TH.BoxGeometry(0.2, 0.2, 0.2);
       const mat = new TH.MeshStandardMaterial({ color: gibColor, transparent: true });
       const mesh = new TH.Mesh(geo, mat);
       mesh.position.copy(pos).add(new TH.Vector3((Math.random()-0.5)*0.6, Math.random()*1.5, (Math.random()-0.5)*0.6));
       scene.add(mesh);
       const vel = new TH.Vector3((Math.random()-0.5)*10, Math.random()*6+2, (Math.random()-0.5)*10);
       animObjects.push({ type: 'gib', obj: mesh, vel, life: 3.0 });
    }
    const sparkColor = new TH.Color(gibColor).lerp(new TH.Color(0xffffff), 0.5);
    for (let i = 0; i < 30; i++) {
       const geo = new TH.SphereGeometry(0.04 + Math.random() * 0.04, 4, 4);
       const mat = new TH.MeshBasicMaterial({ color: sparkColor, transparent: true, opacity: 1.0 });
       const mesh = new TH.Mesh(geo, mat);
       mesh.position.copy(pos).add(new TH.Vector3((Math.random()-0.5)*0.4, Math.random()*1.2+0.3, (Math.random()-0.5)*0.4));
       scene.add(mesh);
       const vel = new TH.Vector3((Math.random()-0.5)*14, Math.random()*10+4, (Math.random()-0.5)*14);
       animObjects.push({ type: 'spark', obj: mesh, vel, life: 1.5 + Math.random() });
    }
  }

  let isDead = false;
  let deathCamPos = new TH.Vector3();
  let deathCamTarget = new TH.Vector3();
  function die(killerId) {
     if (!started || won || isDead) return;
     isDead = true;
     const myColor = localPlayerIndex === 0 ? 0x33ff33 : 0xff3333;
     Network.send({ type: 'player_died', pos: pl.pos.toArray(), color: myColor, killerId: killerId || null });
     spawnDeathAnimation(pl.pos, myColor);
     
     gun.visible = false; rocketGun.visible = false; instagibGun.visible = false;
     playerModel.visible = false;
     const offset = new TH.Vector3(0, 2, 4).applyAxisAngle(new TH.Vector3(0, 1, 0), pl.yaw);
     deathCamPos.copy(pl.pos).add(offset);
     deathCamTarget.copy(pl.pos);
     
     // Server will send 'respawn' after 3 seconds
  }

  function explosion(pos, isLocal) {
    AudioSys.tone(100, 40, 0.4, 'square', 0.2, 0, pos);
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
    const blasted = [];
    for (let i = 0; i < grabCubes.length; i++) {
      const c = grabCubes[i];
      if (c === grabbedCube) continue;
      const v = c.pos.clone().sub(pos);
      const cd = v.length();
      if (cd < 15.0) {
        const force = (15.0 - cd) * 1.5;
        c.vel.add(v.normalize().multiplyScalar(force));
        c.vel.y += force * 0.4;
        c.rotVel.set(Math.random()-0.5, Math.random()-0.5, Math.random()-0.5).multiplyScalar(force);
        if (isLocal) {
           blasted.push({ idx: i, vel: c.vel.toArray(), rotVel: c.rotVel.toArray() });
        }
      }
    }
    if (isLocal && blasted.length > 0) {
        Network.send({ type: 'blast_cubes', cubes: blasted });
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
    const rr = (min, max) => min + Math.random() * (max - min);
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
  const playerClipPlane = new TH.Plane(new V3(0, 1, 0), 1e6);
  
  
  const playerModel = createPlayerModel(0x4a86e8, 1, playerClipPlane);
  scene.add(playerModel);
    
  // Assign global to be used in frame()
  window.playerClipPlane = playerClipPlane;
  
  // The real player model on Layer 1 is sufficient for portals to render you.

  /* =======================================================================
     PORTAL RENDERING (Extracted)
     ======================================================================= */
  const { renderPortalViews, placePortalVisuals, makeRTs } = initPortalRendering({ TH, innerWidth, innerHeight, renderer, camera, scene, portals, PORT, R_AB, R_BA, frames, sparkles, quads, quadMats, glowLights, skyGroup });

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
    won = false; localReady = false; lastInstagibTime = -999; lastRocketTime = -999;
    winPanel.classList.add('hidden');
    dom('seedinfo').textContent = seedStr;
  }
  function newMap(s) { 
    Network.send({ type: 'new_map', seed: s });
    menuPanel.classList.add('hidden'); 
    requestLock(); 
  }

  /* =======================================================================
     HUD
     ======================================================================= */
  const { updateHUD } = initHUD(document);

  /* =======================================================================
     MAIN LOOP
     ======================================================================= */
  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    let dt = Math.min(0.05, (now - last) / 1000); last = now;
    AudioSys.listenerPos = pl.pos;
    nowT += dt;
    if (started && isConnected && localPlayerId != null && nowT >= nextPingT) {
      Network.send({ type: 'ping', t: performance.now(), ping: lastPingMs });
      nextPingT = nowT + 5;
    }

    if (!started) { // idle preview orbit while at menu
      const t = now * 0.00012;
      camera.position.set(-20 + Math.cos(t) * 14, 8, Math.sin(t) * 14);
      camera.lookAt(-20, 2, 0);
    } else if (!won) {

      const activeKeys = pointerLocked ? keys : { KeyW: false, KeyA: false, KeyS: false, KeyD: false, Space: false, ShiftLeft: false, KeyC: false, ControlLeft: false };
      const isCrouching = activeKeys.KeyC || activeKeys.ControlLeft;
      pl.crouchT = Math.max(0, Math.min(1, pl.crouchT + (isCrouching ? dt * 10 : -dt * 10)));

        
      if (localPlayerId != null) { Network.send({
          type: 'input',
          dt: dt,
          keys: {
            KeyW: activeKeys.KeyW, KeyA: activeKeys.KeyA, KeyS: activeKeys.KeyS, KeyD: activeKeys.KeyD, Space: activeKeys.Space, ShiftLeft: activeKeys.ShiftLeft
          },
          yaw: pl.yaw,
          pitch: pl.pitch,
          autohop: autohop, crouch: isCrouching, crouchT: pl.crouchT,
          jumpBuf: pl.jumpBuf,
          pos: pl.pos.toArray(),
          vel: pl.vel.toArray(),
          activeWeapon: activeWeapon,
          isDead: isDead, grabbedCubeIdx: grabbedCube ? grabCubes.indexOf(grabbedCube) : undefined, grabbedCubePos: grabbedCube ? grabbedCube.pos.toArray() : undefined, grabbedCubeVel: grabbedCube ? grabbedCube.vel.toArray() : undefined });
      }

      let rem = isConnected ? dt : 0;
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
        if (rp.predictedDeadUntil && nowT < rp.predictedDeadUntil) rp.isDead = true;
        m.visible = !rp.isDead;
        m.position.set(rp.pos[0], rp.pos[1], rp.pos[2]);
        m.rotation.y = rp.yaw;
        const rpCT = rp.crouchT || 0;
        const rpBody = m.children.find(c => c.name === 'bodyMesh');
        if (rpBody) { rpBody.scale.y = 1 - rpCT * 0.4; rpBody.position.y = -rpCT * 0.25; }
        m.userData.headGroup.rotation.x = rp.pitch;
        m.userData.headGroup.position.y = 1.5 - rpCT * 0.7;
        m.userData.mirrorGun.visible = (rp.activeWeapon === 1 || !rp.activeWeapon);
        m.userData.mirrorRocketGun.visible = (rp.activeWeapon === 2);
        if (m.userData.mirrorInstagibGun) m.userData.mirrorInstagibGun.visible = (rp.activeWeapon === 3);
        if (m.userData.muzzleT !== undefined) {
           m.userData.muzzleT = Math.max(0, m.userData.muzzleT - dt * 6);
           const mt = m.userData.muzzleT;
           const rScale = 1 + mt * 0.12;
           const rZ = -0.4 + mt * 0.15;
           const rRot = mt * 0.3;
           m.userData.mirrorGun.scale.setScalar(1); m.userData.mirrorGun.position.z = -0.4; m.userData.mirrorGun.rotation.x = 0;
           m.userData.mirrorRocketGun.scale.setScalar(1); m.userData.mirrorRocketGun.position.z = -0.4; m.userData.mirrorRocketGun.rotation.x = 0;
           if (m.userData.mirrorInstagibGun) { m.userData.mirrorInstagibGun.scale.setScalar(1); m.userData.mirrorInstagibGun.position.z = -0.4; m.userData.mirrorInstagibGun.rotation.x = 0; }
           const aw = rp.activeWeapon || 1;
           const activeMir = aw === 1 ? m.userData.mirrorGun : (aw === 2 ? m.userData.mirrorRocketGun : m.userData.mirrorInstagibGun);
           if (activeMir) { activeMir.scale.setScalar(rScale); activeMir.position.z = rZ; activeMir.rotation.x = rRot; }
        } else { m.userData.muzzleT = 0; }
      }
    }

    for (let i = 0; i < 4; i++) {
      quadMats[i].uniforms.uTime.value = now * 0.001;
    }
    placePortalVisuals();
    renderPortalViews();

    muzzleT = Math.max(0, muzzleT - dt * 6);
    const mt = muzzleT;
    const scale = 1 + mt * 0.12;
    const lZ = -0.5 + mt * 0.2;
    const lRot = mt * 0.4;

    gun.scale.setScalar(1); gun.position.z = -0.5; gun.rotation.x = 0;
    rocketGun.scale.setScalar(1); rocketGun.position.z = -0.5; rocketGun.rotation.x = 0;
    instagibGun.scale.setScalar(1); instagibGun.position.z = -0.5; instagibGun.rotation.x = 0;
    
    const pM = playerModel.userData;
    if (pM.mirrorGun) { pM.mirrorGun.scale.setScalar(1); pM.mirrorGun.position.z = -0.4; pM.mirrorGun.rotation.x = 0; }
    if (pM.mirrorRocketGun) { pM.mirrorRocketGun.scale.setScalar(1); pM.mirrorRocketGun.position.z = -0.4; pM.mirrorRocketGun.rotation.x = 0; }
    if (pM.mirrorInstagibGun) { pM.mirrorInstagibGun.scale.setScalar(1); pM.mirrorInstagibGun.position.z = -0.4; pM.mirrorInstagibGun.rotation.x = 0; }

    const aw = activeWeapon || 1;
    const actHUD = aw === 1 ? gun : (aw === 2 ? rocketGun : instagibGun);
    const actMir = aw === 1 ? pM.mirrorGun : (aw === 2 ? pM.mirrorRocketGun : pM.mirrorInstagibGun);

    actHUD.scale.setScalar(scale); actHUD.position.z = lZ; actHUD.rotation.x = lRot;
    if (aw === 1 && gun.userData.core) gun.userData.core.material.emissiveIntensity = 2.2 + mt * 6;
    if (actMir) { actMir.scale.setScalar(1 + mt * 0.12); actMir.position.z = -0.4 + mt * 0.15; actMir.rotation.x = mt * 0.3; }

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
          explosion(hit ? hit.point : r.pos, r.isLocal);
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
      if (isDead) {
        camera.position.lerp(deathCamPos, Math.min(1, dt * 5));
        const m = new TH.Matrix4().lookAt(camera.position, deathCamTarget, new TH.Vector3(0, 1, 0));
        camera.quaternion.slerp(new TH.Quaternion().setFromRotationMatrix(m), Math.min(1, dt * 5));
      } else {
      camera.position.copy(pl.pos);
      camera.position.y += (CFG.H - (CFG.H - CFG.CROUCH_H) * pl.crouchT) - 0.12; // pl.pos is the feet point — eyes near top of capsule
      let bob = 0;
      if (pl.grounded && sp > 1) bob = Math.sin(now * 0.012 * Math.min(2, sp / 7)) * 0.03 * Math.min(1, sp / CFG.GMAX);
      landingThump = Math.max(0, landingThump - dt * 4);
      camera.position.y += bob - landingThump * 0.18;
      camera.rotation.order = 'YXZ';
      camera.quaternion.setFromEuler(new TH.Euler(pl.pitch, pl.yaw, 0, 'YXZ'));
      }
      
      playerModel.position.copy(pl.pos);
      playerModel.rotation.set(0, pl.yaw, 0, 'YXZ');
      // Crouch animation: squish body, lower head
      const cBody = playerModel.children.find(c => c.name === 'bodyMesh');
      if (cBody) { cBody.scale.y = 1 - pl.crouchT * 0.4; cBody.position.y = -pl.crouchT * 0.25; }
      if (playerModel.userData.headGroup) {
        playerModel.userData.headGroup.rotation.x = pl.pitch;
        playerModel.userData.headGroup.position.y = 1.5 - pl.crouchT * 0.7;
      }
      if (playerModel.userData.mirrorGun) {
        playerModel.userData.mirrorGun.visible = (activeWeapon === 1);
        playerModel.userData.mirrorRocketGun.visible = (activeWeapon === 2);
        if (playerModel.userData.mirrorInstagibGun) playerModel.userData.mirrorInstagibGun.visible = (activeWeapon === 3);
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
      if (activeWeapon === 3 && isZooming) {
         zoomAmt = Math.min(1.0, zoomAmt + dt / 0.1);
      } else {
         zoomAmt = Math.max(0.0, zoomAmt - dt / 0.1);
      }
      const spFov = Math.min(baseFov + 16, baseFov + Math.max(0, (sp - CFG.GMAX) * 0.5));
      const zoomedFov = baseFov * 0.4;
      const wantFov = spFov * (1 - zoomAmt) + zoomedFov * zoomAmt;
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
          
          const teleported = physics.teleportCube(c, dt, portals, R_AB, R_BA);
          if (!teleported) {
             c.pos.add(step);
             collideCube(c, c.rad);
             if (c.vel.lengthSq() < 0.001) {
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
       let scl;
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
      } else if (a.type === 'instagib_beam2') {
        a.life -= dt * 2.5;
        if (a.life <= 0) {
           scene.remove(a.obj);
           a.core.material.dispose(); a.core.geometry.dispose();
           a.glow.material.dispose(); a.glow.geometry.dispose();
           a.points.material.dispose(); a.points.geometry.dispose();
           animObjects.splice(i, 1);
        } else {
           a.core.material.opacity = a.life;
           a.glow.material.opacity = a.life * 0.6;
           a.points.material.opacity = a.life;
           // a.core.scale.set(a.life, 1, a.life);
           // a.glow.scale.set(a.life, 1, a.life);
           const posAttr = a.points.geometry.attributes.position;
           for (let j = 0; j < a.vel.length; j++) {
             posAttr.array[j*3] += a.vel[j].x * dt;
             posAttr.array[j*3+1] += a.vel[j].y * dt;
             posAttr.array[j*3+2] += a.vel[j].z * dt;
             a.vel[j].multiplyScalar(0.9);
           }
           posAttr.needsUpdate = true;
        }
      } else if (a.type === 'gib') {
        a.life -= dt;
        if (a.life <= 0) {
           scene.remove(a.obj);
           a.obj.material.dispose(); a.obj.geometry.dispose();
           animObjects.splice(i, 1);
        } else {
           a.vel.y -= 25.0 * dt; // gravity CFG.G is usually ~25
           a.obj.position.addScaledVector(a.vel, dt);
           
           if (a.obj.position.y < 0.15 && a.vel.y < 0) {
              a.obj.position.y = 0.15;
              a.vel.y *= -0.6;
              a.vel.x *= 0.8;
              a.vel.z *= 0.8;
           }
           
           if (a.life < 1.5) {
              a.obj.material.opacity = a.life / 1.5;
              a.obj.scale.setScalar(0.5 + (a.life / 3.0) * 0.5);
           }
        }
      } else if (a.type === 'spark') {
        a.life -= dt;
        if (a.life <= 0) {
           scene.remove(a.obj);
           a.obj.material.dispose(); a.obj.geometry.dispose();
           animObjects.splice(i, 1);
        } else {
           a.vel.y -= 25.0 * dt;
           a.obj.position.addScaledVector(a.vel, dt);
           a.vel.multiplyScalar(1 - 1.5 * dt);
           if (a.obj.position.y < 0.05 && a.vel.y < 0) {
              a.vel.y *= -0.3;
              a.vel.x *= 0.5;
              a.vel.z *= 0.5;
           }
           a.obj.material.opacity = Math.min(1, a.life);
           a.obj.scale.setScalar(0.5 + a.life * 0.5);
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

    let msg = '';
    if (match && match.phase === 'warmup') {
      msg = localReady ? 'READY — WAITING FOR OPPONENT' : 'PRESS R TO READY UP';
    } else if (match && match.phase === 'waiting' && Object.keys(match.players).length < 2) {
      msg = 'WAITING FOR OPPONENT — PRESS R WHEN READY';
    }
    if (!msg) {
      for (const h of hintZones) {
         if (pl.pos.x >= h.min.x && pl.pos.x <= h.max.x && pl.pos.y >= h.min.y && pl.pos.y <= h.max.y && pl.pos.z >= h.min.z && pl.pos.z <= h.max.z) {
            msg = h.msg;
            break;
         }
      }
    }
    camera.updateMatrixWorld(true);
    const aimDir = new TH.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    const hit = raycast(camera.getWorldPosition(new TH.Vector3()), aimDir, 140);

    updateHUD({ pl, CFG, currentSeed, exitPos, hit, msg: !isConnected ? "RECONNECTING..." : msg, match, localReady, localIndex: localPlayerIndex, statsOpen, localPid: localPlayerId });
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
  camera.updateMatrixWorld();
  const camPos = new TH.Vector3();
  const camDir = new TH.Vector3();
  camera.getWorldPosition(camPos);
  camera.getWorldDirection(camDir);
  if (camDir.lengthSq() < 0.1) camDir.set(0, 0, -1);
  
  portals.forEach(p => { 
    p.placed = true; 
    p.c.copy(camPos).add(camDir.clone().multiplyScalar(2));
    p.n.copy(camDir).multiplyScalar(-1);
    const f = frameFor(p.n);
    p.r.copy(f.r);
    p.u.copy(f.u);
  });

  updatePair();
  placePortalVisuals();
  quads.forEach(q => q.visible = true);
  renderPortalViews();
  renderer.render(scene, camera);
  portals.forEach(p => p.placed = false);
  placePortalVisuals();
  quads.forEach(q => q.visible = false);
  renderer.clear();
  
  requestAnimationFrame(frame);
}

































































































