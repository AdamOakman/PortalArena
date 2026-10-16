/* ============================================================================
   Portal Arena — portal physics + Quake/Warsow movement in the browser.
   Files: index.html (UI shell) + main.js (this, the composition root).

   The game is split into modules, each an init*(G) function that registers
   its state and functions on the shared game context G:
     world.js      — map building, colliders, destructible walls
     portals.js    — portal state, placement, pair transforms, visuals
     weapons.js    — portal gun / rockets / instagib + FX pools
     players.js    — local/remote players, movement, death
     input.js      — pointer lock, mouse/keyboard, menu controls
     loop.js       — the main animation frame
     messages.js   — server → client message handling

   Mechanics:
   - Portals: LMB = Primary, RMB = Secondary. They stick to any flat face of
     any angle (floor / ceiling / wall / ramp) provided the whole mouth fits
     inside that single face.
   - Momentum conservation: velocity is rotated by the portal-pair transform,
     so falling into a floor portal and exiting a wall portal flings you
     sideways at your impact speed; magnitude through the pair is preserved.
   - Movement: Quake ground friction + acceleration, air-strafe with a high
     cap (speed can grow far past run speed), bunnyhop (hold jump),
     coyote time and jump buffering. Circle-jump to build big speed.
   ============================================================================ */

import { CFG, PORT } from '../shared/constants.js';
import { initPhysics } from '../shared/physics.js?v=2';
import { initEngine } from './engine.js';
import { initTextures } from './textures.js';
import { initModels } from './models.js';
import { initHUD } from './hud.js';
import { initNetwork } from './network.js';
import { initPortalRendering } from './render_portals.js';
import { initWorld } from './world.js';
import { initPortals } from './portals.js';
import { initWeapons } from './weapons.js';
import { initPlayers } from './players.js';
import { initInput } from './input.js';
import { initLoop } from './loop.js';
import { onMessage, onNetworkClose } from './messages.js';
import { LoadingScreen } from './loading-screen.js';

/* ------------------------------------------------------------------ loader */
let loading = null;
function boot() {
  // The loading overlay fades in (0.3 s) on the dark background straight
  // away; its 3-D animation starts as soon as three.js arrives.
  // TEMP (preview): artificial 5 s minimum display so the animation can be
  // watched as if loading took longer — remove delayMs for release.
  loading = new LoadingScreen({ delayMs: 5000 });

  // Fonts gate — the page fonts (Cinzel / IM Fell English) are "loaded" once
  // the browser settles font loading for the initial stylesheets.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready
      .then(() => loading.markReady('fonts'))
      .catch(() => loading.markReady('fonts'));
  } else {
    loading.markReady('fonts');
  }
  const CDN_ESM = 'https://unpkg.com/three@0.160.0/build/three.module.js';
  const CDNS_UMD = [
    'https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
  ];
  import(CDN_ESM).then(ns => start(ns, loading)).catch(() => {
    let i = 0;
    const tryNext = () => {
      if (i >= CDNS_UMD.length) { showFatal('Could not load three.js from any CDN — check your internet connection.'); return; }
      const s = document.createElement('script');
      s.src = CDNS_UMD[i++];
      s.onload = () => window.THREE ? start(window.THREE, loading) : tryNext();
      s.onerror = tryNext;
      document.head.appendChild(s);
    };
    tryNext();
  });
}
function showFatal(msg) {
  if (loading) loading.dispose(); // let the fatal error show
  const d = document.createElement('div'); d.id = 'err'; d.textContent = msg; document.body.appendChild(d);
}
if (typeof window !== 'undefined') boot();

/* ==========================================================================
   GAME — THREE runtime: build the shared context G, init the modules in
   dependency order, and start the loop.
   ========================================================================== */
function start(ns, loading) {
  const TH = ns;
  if (loading) {
    loading.injectThree(TH);            // loading animation can start at once
    loading.markReady('three');
  }
  const G = {
    TH,
    V3: TH.Vector3,
    M4: TH.Matrix4,
    physics: initPhysics(TH, CFG, PORT),
    CFG, PORT,
    canvas: document.getElementById('gl'),
    dom: id => document.getElementById(id),
    // --- session state ---
    baseFov: 115,
    started: false, won: false, isDead: false,
    match: null, localReady: false, statsOpen: false,
    nowT: 0, nextPingT: 0, lastPingMs: 0,
    isConnected: false,
    activeWeapon: 1, isZooming: false, zoomAmt: 0,
    autohop: true,
    pointerLocked: false,
    lastIp: null, lastPass: null, lastName: null,
    localPlayerId: null, localPlayerIndex: 0,
    isSpectator: true,
    spectatorMode: 'freefly',
    followPerspective: 'pov',
    spectateTargetPid: null,
    specPos: new TH.Vector3(0, 10, 20),
    specYaw: 0,
    specPitch: -0.2,
  };

  /* ------------------------------------------------ renderer / scene core */
  Object.assign(G, initEngine(TH, G.canvas));

  /* ------------------------------------------------------------- textures */
  Object.assign(G, initTextures(TH));

  /* ------------------------------------------------ MODELS (Gun & Player) */
  Object.assign(G, initModels(TH, G.camera, G.scene));

  /* --------------------------------------------------------------- panels */
  G.startPanel = G.dom('startpanel');
  G.menuPanel = G.dom('menupanel');
  G.winPanel = G.dom('winpanel');

  /* ------------------------------------------------------ game subsystems */
  G.requestJoin = () => {
    if (G.Network) G.Network.send({ type: 'join_game' });
  };
  G.requestSpectate = () => {
    if (G.Network) G.Network.send({ type: 'spectate_game' });
  };
  G.cycleSpectatorTarget = (dir = 1) => {
    const activePids = Object.keys(G.remotePlayers);
    if (activePids.length === 0) {
      G.spectatorMode = 'freefly';
      G.spectateTargetPid = null;
      return;
    }
    if (G.spectatorMode === 'freefly') {
      G.spectatorMode = 'follow';
      G.spectateTargetPid = activePids[dir > 0 ? 0 : activePids.length - 1];
    } else {
      const idx = activePids.indexOf(G.spectateTargetPid);
      if (idx === -1) {
        G.spectateTargetPid = activePids[0];
      } else {
        const nextIdx = idx + dir;
        if (nextIdx >= activePids.length || nextIdx < 0) {
          G.spectatorMode = 'freefly';
          G.spectateTargetPid = null;
        } else {
          G.spectateTargetPid = activePids[nextIdx];
        }
      }
    }
  };
  G.toggleFollowPerspective = () => {
    if (G.spectatorMode === 'follow') {
      G.followPerspective = (G.followPerspective === 'pov') ? 'chase' : 'pov';
    } else {
      G.cycleSpectatorTarget(-1);
    }
  };

  /* ------------------------------------------------ connection & overlay */
  G.showConnectOverlay = (text) => {
    const el = document.getElementById('connect-overlay');
    const title = document.getElementById('connect-overlay-title');
    if (title) title.textContent = text;
    if (el) el.classList.remove('hidden');
  };

  G.hideConnectOverlay = () => {
    const el = document.getElementById('connect-overlay');
    if (el) el.classList.add('hidden');
  };

  G.onConnectionTimeout = (msg) => {
    if (G.connectionTimeout) {
      clearTimeout(G.connectionTimeout);
      G.connectionTimeout = null;
    }
    if (G.reconnectRetryTimer) {
      clearTimeout(G.reconnectRetryTimer);
      G.reconnectRetryTimer = null;
    }
    G.isConnecting = false;
    G.isReconnecting = false;
    if (G.Network && G.Network.disconnect) G.Network.disconnect();
    G.hideConnectOverlay();
    if (document.exitPointerLock) document.exitPointerLock();
    G.pointerLocked = false;
    G.started = false;
    G.isConnected = false;
    G.isDead = false;
    G.isSpectator = true;
    G.spectatorMode = 'freefly';
    G.spectateTargetPid = null;
    if (G.gun) G.gun.visible = false;
    if (G.rocketGun) G.rocketGun.visible = false;
    if (G.instagibGun) G.instagibGun.visible = false;
    if (G.playerModel) G.playerModel.visible = false;
    if (G.portals) {
      for (const p of G.portals) {
        p.placed = false;
        p.closing = false;
      }
    }
    if (G.remotePlayerMeshes) {
      for (const pid in G.remotePlayerMeshes) {
        if (G.remotePlayerMeshes[pid]) {
          G.scene.remove(G.remotePlayerMeshes[pid]);
          G.remotePlayerMeshes[pid].traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
          });
        }
      }
      G.remotePlayerMeshes = {};
    }
    G.remotePlayers = {};
    const hud = document.getElementById('hud');
    if (hud) hud.classList.add('hidden');
    const menu = document.getElementById('menupanel');
    if (menu) menu.classList.add('hidden');
    const win = document.getElementById('winpanel');
    if (win) win.classList.add('hidden');
    const startPanel = document.getElementById('startpanel');
    if (startPanel) {
      startPanel.classList.remove('hidden');
      startPanel.style.opacity = '1';
    }
    const connStatus = document.getElementById('connstatus');
    if (connStatus) {
      connStatus.textContent = msg || 'Connection timed out after 30 seconds';
      connStatus.classList.remove('hidden');
    }
    if (G.addEventLog) {
      G.addEventLog(msg || 'Connection timed out after 30 seconds', true);
    }
  };

  G.startConnection = (ip, pass, name) => {
    G.lastIp = ip;
    G.lastPass = pass;
    G.lastName = name;
    G.isConnecting = true;
    G.isReconnecting = false;
    const connStatus = document.getElementById('connstatus');
    if (connStatus) connStatus.classList.add('hidden');
    G.showConnectOverlay('Connecting...');
    if (G.connectionTimeout) clearTimeout(G.connectionTimeout);
    G.connectionTimeout = setTimeout(() => {
      G.onConnectionTimeout('Connecting timed out after 30 seconds');
    }, 30000);
    G.Network.connect(ip, pass, name);
  };

  G.onConnectionSuccess = () => {
    G.isConnecting = false;
    G.isReconnecting = false;
    if (G.connectionTimeout) {
      clearTimeout(G.connectionTimeout);
      G.connectionTimeout = null;
    }
    if (G.reconnectRetryTimer) {
      clearTimeout(G.reconnectRetryTimer);
      G.reconnectRetryTimer = null;
    }
    G.hideConnectOverlay();
  };

  initWorld(G);
  initPortals(G);
  initWeapons(G);
  initPlayers(G);
  initInput(G);

  /* PORTAL RENDERING (needs the portal visuals from initPortals) */
  Object.assign(G, initPortalRendering({ TH, innerWidth, innerHeight, renderer: G.renderer, camera: G.camera, scene: G.scene, portals: G.portals, PORT, R_AB: G.R_AB, R_BA: G.R_BA, frames: G.frames, sparkles: G.sparkles, quads: G.quads, quadMats: G.quadMats, glowLights: G.glowLights, skyGroup: G.skyGroup }));

  /* ------------------------------------------------------------------ HUD */
  Object.assign(G, initHUD(document));

  /* ------------------------------------------------------------- network */
  G.Network = initNetwork({
    onMessage: (data) => onMessage(G, data),
    onError: () => {},
    onClose: () => onNetworkClose(G),
  });

  /* ------------------------------------------------------------- main loop */
  initLoop(G).start();                  // loads the first map (synchronously) + starts the game RAF
  if (loading) {
    loading.markReady('map');           // map with orbit view is built
    // Queued right after the game loop's own first frame, so this fires
    // once the orbit view has actually rendered the new map:
    requestAnimationFrame(() => loading.markReady('frame'));
    // When everything is ready the screen auto-hides (0.3 s fade) and the
    // arena + main menu fade in (0.3 s) from the darkness:
    loading.onHide = () => {
      G.canvas.style.opacity = '1';
      G.startPanel.style.opacity = '1';
    };
  }
}
