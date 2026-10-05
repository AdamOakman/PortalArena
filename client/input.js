import { AudioSys } from './audio.js';

/* ============================================================================
   INPUT — pointer lock, mouse/keyboard handling, weapon switching, FOV,
   fullscreen, mute, and the start/menu/victory panel buttons.
   ============================================================================ */

/* Default server: the host the client page was served from, game port 3001. */
function defaultServer() { return window.location.hostname + ':3001'; }

export function initInput(G) {
  const { camera } = G;

  G.keys = {};
  let pointerLocked = false;
  const menuPanel = G.menuPanel, winPanel = G.winPanel;


  function addEventLog(msg, hot) {
    const logDiv = document.getElementById('eventlog');
    if (!logDiv) return;
    const el = document.createElement('div');
    el.className = hot ? 'event hot' : 'event';
    el.innerText = msg;
    logDiv.appendChild(el);
    while (logDiv.children.length > 5) {
      logDiv.removeChild(logDiv.firstChild);
    }
    setTimeout(() => {
      if (el.parentNode === logDiv) logDiv.removeChild(el);
    }, 15000);
  }

  function requestLock() { G.canvas.requestPointerLock && G.canvas.requestPointerLock(); }
  document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === G.canvas;
    G.pointerLocked = pointerLocked;
    if (pointerLocked) menuPanel.classList.add(String.fromCharCode(104,105,100,100,101,110));

  });
  G.canvas.addEventListener('click', () => { AudioSys.ensure(); if (G.started && !pointerLocked && !G.won) requestLock(); });

  document.addEventListener('mousemove', e => {
    if (!pointerLocked || document.pointerLockElement !== G.canvas) return;
    if (Math.abs(e.movementX) > 100 || Math.abs(e.movementY) > 100) return;
    const sens = 0.0023 * (camera.fov / G.baseFov);
    G.pl.yaw -= e.movementX * sens;
    G.pl.pitch = Math.max(-1.55, Math.min(1.55, G.pl.pitch - e.movementY * sens));
  });

  document.addEventListener('mousedown', e => {
    if (!pointerLocked || G.won || G.isDead) return;
    AudioSys.ensure();
    if (e.button === 0) {
      if (G.grabbedCube) {
         // Throw cube
         const dir = new G.TH.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
         G.grabbedCube.vel.copy(dir).multiplyScalar(22).add(G.pl.vel);
         G.grabbedCube.rotVel.set(Math.random()-0.5, Math.random()-0.5, Math.random()-0.5).multiplyScalar(15);
         G.Network.send({
               type: 'throw_cube',
               idx: G.grabCubes.indexOf(G.grabbedCube),
               pos: G.grabbedCube.pos.toArray(),
               vel: G.grabbedCube.vel.toArray()
            });
         G.grabbedCube = null;
      } else {
         if (G.activeWeapon === 1) G.firePortal(G.localPlayerIndex * 2);
         else if (G.activeWeapon === 2) G.fireRocket();
         else if (G.activeWeapon === 3) G.fireInstagib();
      }
    }
    else if (e.button === 2) {
      if (G.activeWeapon === 1 && !G.grabbedCube) G.firePortal(G.localPlayerIndex * 2 + 1);
      else if (G.activeWeapon === 3) G.isZooming = true;
    }
  });
  document.addEventListener('mouseup', e => {
    if (e.button === 2) G.isZooming = false;
  });
  document.addEventListener('contextmenu', e => e.preventDefault());

  document.addEventListener('wheel', () => {
    if (!pointerLocked || G.won || !G.started) return;
    G.activeWeapon = (G.activeWeapon === 1) ? 2 : 1;
    if (G.activeWeapon === 1) { G.gun.visible = true; G.rocketGun.visible = false; }
    else { G.gun.visible = false; G.rocketGun.visible = true; }
  });

  document.addEventListener('keydown', e => {
    if (e.code === 'Enter') {
      if (!G.started && !G.dom('startpanel').classList.contains('hidden')) {
        G.dom('btnstart').click();
        return;
      }
    }
    if (e.target.tagName === 'INPUT') return;
    const c = e.code;
    if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'ControlLeft', 'BracketLeft', 'BracketRight', 'Digit1', 'Digit2', 'Digit3'].includes(c)) e.preventDefault();
    G.keys[c] = true;
    if (c === 'Tab') { e.preventDefault(); G.statsOpen = G.started; }
    if (!G.started || G.isDead) return;
    if (c === 'Digit1') { G.activeWeapon = 1; G.gun.visible = true; G.rocketGun.visible = false; G.instagibGun.visible = false; }
    if (c === 'Digit2') { G.activeWeapon = 2; G.gun.visible = false; G.rocketGun.visible = true; G.instagibGun.visible = false; }
    if (c === 'Digit3') { G.activeWeapon = 3; G.gun.visible = false; G.rocketGun.visible = false; G.instagibGun.visible = true; }
    if (c === 'Space') G.pl.jumpBuf = G.nowT;

    if (c === 'KeyF') toggleFullscreen();
    if (c === String.fromCharCode(69,115,99,97,112,101)) { if (G.started && !G.won) menuPanel.classList.toggle(String.fromCharCode(104,105,100,100,101,110)); }
    if (c === 'KeyR' && !e.repeat) {
      if (G.match && (G.match.phase === 'warmup' || G.match.phase === 'waiting')) {
        G.localReady = !G.localReady;
        G.Network.send({ type: 'ready', ready: G.localReady });
      }
    }
    if (c === 'KeyN') G.newMap(String(Math.floor(Math.random() * 1e9)));
    if (c === 'KeyE') {
      if (G.grabbedCube) {
         G.grabbedCube.vel.copy(G.pl.vel);
         G.grabbedCube = null;
      } else {
         camera.updateMatrixWorld(true);
         const pos = camera.getWorldPosition(new G.TH.Vector3());
         const dir = new G.TH.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
         let bestC = null, bestT = 7.0;
         for (const cb of G.grabCubes) {
            const v = cb.pos.clone().sub(pos);
            const dist = v.length();
            if (dist > 7.0) continue;
            v.normalize();
            if (v.dot(dir) > 0.9) {
               if (dist < bestT) { bestT = dist; bestC = cb; }
            }
         }
         if (bestC) G.grabbedCube = bestC;
      }
    }
    if (c === 'KeyM') { AudioSys.toggleMute(); G.dom('muteinf').textContent = AudioSys.muted ? 'off' : 'on'; syncMuteBtn(); }
    if (c === 'BracketLeft') setFov(G.baseFov - 5);
    if (c === 'BracketRight') setFov(G.baseFov + 5);
  });
  document.addEventListener('keyup', e => { G.keys[e.code] = false; if (e.code === 'Tab') G.statsOpen = false; });

  function toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen();
  }
  function setFov(f) {
    G.baseFov = Math.max(90, Math.min(135, Math.round(f)));
    G.dom('fovinf').textContent = G.baseFov;
    G.dom('fovslider').value = G.baseFov; G.dom('fovval').textContent = G.baseFov;
    G.dom('fovslider2').value = G.baseFov; G.dom('fovval2').textContent = G.baseFov;
  }
  G.dom('fovslider').addEventListener('input', e => setFov(+e.target.value));
  G.dom('fovslider2').addEventListener('input', e => setFov(+e.target.value));

  function syncMuteBtn() { const b = G.dom('btnmute'); if (b) b.textContent = 'SOUND: ' + (AudioSys.muted ? 'OFF' : 'ON'); const i = G.dom('muteinf'); if (i) i.textContent = AudioSys.muted ? 'off' : 'on'; }

  G.dom('btnmute').addEventListener('click', () => { AudioSys.toggleMute(); syncMuteBtn(); });
  G.dom('btnfs').addEventListener('click', toggleFullscreen);

  G.dom('ipinput').placeholder = defaultServer();
  G.dom('btnstart').addEventListener('click', () => {
    const ipInput = document.getElementById('ipinput');
    const passInput = document.getElementById('passinput');
    const ip = (ipInput && ipInput.value.trim()) ? ipInput.value.trim() : defaultServer();
    const pass = (passInput && passInput.value.trim()) ? passInput.value.trim() : 'secret';
    const nameInput = document.getElementById('nameinput');
    const actualIp = ip || defaultServer();

    G.lastIp = actualIp; G.lastPass = pass;
    G.lastName = (nameInput && nameInput.value.trim()) ? nameInput.value.trim() : 'Guest';
    G.Network.connect(actualIp, pass, G.lastName);

  });
  G.dom('btnresume').addEventListener('click', requestLock);
  G.dom('btnnewmap').addEventListener('click', () => {
    const s = G.dom('seedinput2').value.trim() || String(Math.floor(Math.random() * 1e9));
    G.newMap(s);
  });
  G.dom('btnagain').addEventListener('click', () => G.newMap(String(Math.floor(Math.random() * 1e9))));
  G.dom('btnsame').addEventListener('click', () => {
    G.Network.send({ type: 'new_map', seed: G.currentSeed });
    winPanel.classList.add('hidden'); requestLock();
  });

  function showSummary() {
    if (!G.match) return;
    let title, sub;
    if (G.match.winner === 'tie') { title = 'DRAW'; sub = 'THE CHAMBER BALANCES — NO FAVOR GIVEN'; }
    else {
      const w = G.match.winner && G.match.players[G.match.winner];
      title = (w ? w.name : 'PLAYER') + ' WINS';
      sub = 'THE ROUND IS DECIDED';
    }
    const t = G.dom('winTitle'), s = G.dom('winSub');
    if (t) t.textContent = title;
    if (s) s.textContent = sub;
    winPanel.classList.remove('hidden');
  }

  G.addEventLog = addEventLog;
  G.requestLock = requestLock;
  G.showSummary = showSummary;
}
