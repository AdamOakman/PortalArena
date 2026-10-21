/* ============================================================================
   Portal Arena — portal physics + Quake/Warsow movement in the browser.
   Files: index.html (UI shell) + main.js (this, the composition root).

   The client is architected into clean OOP subsystem managers coordinating
   with GameEngine and the shared context G:
     WorldManager     — map building, colliders, destructible walls
     PortalManager    — portal state, placement, pair transforms, visuals
     WeaponManager    — portal gun / rockets / instagib + FX pools
     PlayerController — local/remote players, movement, death
     InputManager     — pointer lock, mouse/keyboard, menu controls
     GameEngine       — main animation frame & loop coordinator
     NetworkManager   — server WebSocket message handling & synchronization
     HUDController    — HUD, scoreboards, and crosshair UI
     RenderManager    — Three.js rendering pipeline and cameras

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

import * as THREE from 'three';
import { CFG, PORT } from '../shared/constants.js';
import { initPhysics } from '../shared/physics.js';
import { initEngine } from './rendering/RenderManager.js';
import { initTextures } from './rendering/TextureFactory.js';
import { initModels } from './rendering/ModelFactory.js';
import { HUDController } from './ui/HUDController.js';
import { initNetwork, onMessage, onNetworkClose } from './network/NetworkManager.js';
import { initWorld } from './world/WorldManager.js';
import { initPortalRendering, initPortals } from './portals/PortalManager.js';
import { initWeapons } from './weapons/WeaponManager.js';
import { PlayerController } from './entities/PlayerController.js';
import { InputManager } from './input/InputManager.js';
import { LoadingScreen } from './ui/LoadingScreen.js';
import { GameEngine } from './core/GameEngine.js';
import { MenuController } from './ui/MenuController.js';

/**
 * PortalClient — Root Application orchestrator and composition coordinator.
 * Encapsulates client bootstrapping, loading screen lifecycle, connection
 * state management, spectator cycling, and subsystem wiring.
 */
export class PortalClient {
  /**
   * @param {Object} [options]
   * @param {number} [options.loadingDelayMs=5000]
   */
  constructor(options = {}) {
    this.options = {
      loadingDelayMs: 5000,
      ...options,
    };
    this.loading = null;
    this.context = null;
    this.engine = null;
    this.loop = null;
    this.connectionTimeout = null;
    this.reconnectRetryTimer = null;
  }

  /**
   * Bootstrap the client application: setup loading screen and trigger startup.
   */
  boot() {
    try {
      this.initLoadingScreen();
      this.start(THREE);
    } catch (err) {
      console.error('Initialization error details:', err);
      this.showFatal('Initialization error: ' + (err?.stack || err?.message || err));
    }
  }

  /**
   * Instantiate and configure the loading screen overlay.
   */
  initLoadingScreen() {
    this.loading = new LoadingScreen({ delayMs: this.options.loadingDelayMs });

    if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
      document.fonts.ready
        .then(() => this.loading.markReady('fonts'))
        .catch(() => this.loading.markReady('fonts'));
    } else if (this.loading) {
      this.loading.markReady('fonts');
    }
  }

  /**
   * Display a fatal error message when initialization fails.
   * @param {string} msg
   */
  showFatal(msg) {
    if (this.loading) this.loading.dispose();
    if (typeof document === 'undefined') return;
    const d = document.createElement('div');
    d.id = 'err';
    d.style.whiteSpace = 'pre-wrap';
    d.textContent = msg;
    document.body.appendChild(d);
  }

  /**
   * Build the shared context, initialize subsystems in dependency order, and start the loop.
   * @param {Object} ns - Three.js namespace
   */
  start(ns = THREE) {
    const TH = ns;
    if (this.loading) {
      this.loading.injectThree(TH);
      this.loading.markReady('three');
    }

    const G = this.createContext(TH);
    this.context = G;
    G.client = this;

    // Attach client control methods onto G for subsystem compatibility
    G.requestJoin = () => this.requestJoin();
    G.requestSpectate = () => this.requestSpectate();
    G.cycleSpectatorTarget = (dir) => this.cycleSpectatorTarget(dir);
    G.toggleFollowPerspective = () => this.toggleFollowPerspective();
    G.showConnectOverlay = (text) => this.showConnectOverlay(text);
    G.hideConnectOverlay = () => this.hideConnectOverlay();
    G.onConnectionTimeout = (msg) => this.onConnectionTimeout(msg);
    G.startConnection = (ip, pass, name) => this.startConnection(ip, pass, name);
    G.onConnectionSuccess = () => this.onConnectionSuccess();

    this.initSubsystems(G);
    this.startLoop(G);
  }

  /**
   * Create the initial session context object.
   * @param {Object} TH - Three.js namespace
   * @returns {Object}
   */
  createContext(TH) {
    return {
      TH,
      V3: TH.Vector3,
      M4: TH.Matrix4,
      physics: initPhysics(TH, CFG, PORT),
      CFG,
      PORT,
      canvas: typeof document !== 'undefined' ? document.getElementById('gl') : null,
      dom: (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null),

      // --- Session state ---
      baseFov: (() => {
        try {
          const saved = localStorage.getItem('portal_fov');
          if (saved !== null) {
            const p = parseInt(saved, 10);
            if (!isNaN(p) && p >= 90 && p <= 135) return p;
          }
        } catch { /* ignore */ }
        return 115;
      })(),
      started: false,
      won: false,
      isDead: false,
      match: null,
      localReady: false,
      statsOpen: false,
      nowT: 0,
      nextPingT: 0,
      lastPingMs: 0,
      isConnected: false,
      activeWeapon: 1,
      isZooming: false,
      zoomAmt: 0,
      muzzleT: 0,
      autohop: true,
      pointerLocked: false,
      lastIp: null,
      lastPass: null,
      lastName: null,
      localPlayerId: null,
      localPlayerIndex: 0,
      isSpectator: true,
      spectatorMode: 'freefly',
      followPerspective: 'pov',
      spectateTargetPid: null,
      specPos: new TH.Vector3(0, 10, 20),
      specYaw: 0,
      specPitch: -0.2,
    };
  }

  /**
   * Initialize all game subsystems in dependency order.
   * @param {Object} G - Context
   */
  initSubsystems(G) {
    const TH = G.TH;

    // Renderer & scene core
    Object.assign(G, initEngine(TH, G.canvas));

    // Textures
    Object.assign(G, initTextures(TH));

    // Models (Gun & Player)
    Object.assign(G, initModels(TH, G.camera, G.scene));

    // Panels
    G.startPanel = G.dom('startpanel');
    G.menuPanel = G.dom('menupanel');
    G.winPanel = G.dom('winpanel');

    // World geometry, portals, weapons
    initWorld(G);
    initPortals(G);
    initWeapons(G);

    // Player subsystem
    const playerController = new PlayerController(G.engine || null);
    G.playerController = playerController;
    G.pl = {
      pos: playerController.position,
      vel: playerController.velocity,
      yaw: 0,
      pitch: 0,
      viewOffset: null,
      grounded: false,
      groundNormal: new G.V3(0, 1, 0),
      groundT: -1,
      jumpBuf: -1,
      cp: new G.V3(),
      maxSpeed: 0,
      crouchT: 0
    };
    G.grabCubes = G.grabCubes || [];
    G.grabbedCube = G.grabbedCube || null;
    G.remotePlayers = G.remotePlayers || {};
    G.remotePlayerMeshes = G.remotePlayerMeshes || {};
    playerController.initModel(G);

    G.physStep = (dt, activeKeys) => playerController.stepPhysics(dt, activeKeys, G);
    G.collideCube = (c, radius) => G.physics.collideCube(c, G.obbs, G.portals, radius);
    G.resolveCubeCollisions = () => G.physics.resolveCubeCollisions(G.grabCubes, G.grabbedCube);
    G.die = (killerId, viaPortal, cause, shotOrigin) => playerController.die(killerId, viaPortal, cause, shotOrigin, G);
    G.updateRemotePlayers = (dt, nowT) => {
      if (G.engine?.entityManager) {
        G.engine.entityManager.updateRemotePlayers(dt, nowT, G);
      } else {
        for (const pid in G.remotePlayers) {
          const rp = G.remotePlayers[pid];
          if (rp && rp.updateVisuals) rp.updateVisuals(dt, nowT, G);
        }
      }
    };
    G.updateLocalView = (dt, now) => playerController.updateLocalView(dt, now, G);

    // Menu Controller
    G.menuController = new MenuController(G);
    G.menuController.init();
    G.showMainMenu = () => G.menuController.showMainMenu();
    G.showInGameMenu = () => G.menuController.showInGameMenu();
    G.hideInGameMenu = () => G.menuController.hideInGameMenu();
    G.toggleInGameMenu = () => G.menuController.toggleInGameMenu();

    // Input subsystem
    G.inputManager = new InputManager(G.engine || null, G.canvas, G);
    G.keys = G.inputManager.keys;
    G.requestLock = () => G.inputManager.requestPointerLock();
    G.addEventLog = (msg, hot) => G.inputManager.addEventLog(msg, hot);
    G.showSummary = () => G.inputManager.showSummary();

    // Portal rendering pipeline
    const innerW = typeof window !== 'undefined' ? window.innerWidth : 800;
    const innerH = typeof window !== 'undefined' ? window.innerHeight : 600;
    Object.assign(
      G,
      initPortalRendering(
        {
          portalManager: G.portalManager,
          TH,
          innerWidth: innerW,
          innerHeight: innerH,
          renderer: G.renderer,
          camera: G.camera,
          scene: G.scene,
          portals: G.portals,
          PORT,
          R_AB: G.R_AB,
          R_BA: G.R_BA,
          frames: G.frames,
          sparkles: G.sparkles,
          quads: G.quads,
          quadMats: G.quadMats,
          glowLights: G.glowLights,
          skyGroup: G.skyGroup,
        },
        G
      )
    );

    // HUD
    G.hudController = new HUDController(G.engine || null);
    G.hud = G.hudController.hud;
    G.updateHUD = (state) => G.hudController.updateHUD(state);
    G.showCountdown = () => G.hudController.showCountdown();
    G.cancelCountdown = () => G.hudController.cancelCountdown();

    // Network manager
    G.Network = initNetwork({
      onMessage: (data) => onMessage(G, data),
      onError: () => {},
      onClose: () => onNetworkClose(G),
    });

    // GameEngine composition root
    this.engine = new GameEngine(G.canvas, G);
    G.engine = this.engine;

    if (typeof window !== 'undefined') {
      window.__ENGINE__ = this.engine;
      window.__CLIENT__ = this;
      window.__GAME_CONTEXT__ = G;
    }
  }

  /**
   * Start the main animation frame loop and handle loading screen transitions.
   * @param {Object} G - Context
   */
  startLoop(G) {
    if (this.engine) {
      this.engine.start();
    }

    if (this.loading) {
      this.loading.markReady('map');
      requestAnimationFrame(() => this.loading.markReady('frame'));
      this.loading.onHide = () => {
        if (G.canvas) G.canvas.style.opacity = '1';
        if (G.startPanel) G.startPanel.style.opacity = '1';
        if (G.menuController) G.menuController.showMainMenu();
      };
    }
  }

  /**
   * Request to join the active match as a player.
   */
  requestJoin() {
    if (this.context?.Network) {
      this.context.Network.send({ type: 'join_game' });
    }
  }

  /**
   * Request to switch to spectate mode.
   */
  requestSpectate() {
    if (this.context?.Network) {
      this.context.Network.send({ type: 'spectate_game' });
    }
  }

  /**
   * Cycle spectate target between active players, or toggle back to freefly.
   * @param {number} [dir=1]
   */
  cycleSpectatorTarget(dir = 1) {
    const G = this.context;
    if (!G) return;
    const activePids = Object.keys(G.remotePlayers || {});
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
  }

  /**
   * Toggle between POV and third-person chase perspective when following a spectator target.
   */
  toggleFollowPerspective() {
    const G = this.context;
    if (!G) return;
    if (G.spectatorMode === 'follow') {
      G.followPerspective = G.followPerspective === 'pov' ? 'chase' : 'pov';
    } else {
      this.cycleSpectatorTarget(-1);
    }
  }

  /**
   * Show the connection modal overlay with status text.
   * @param {string} text
   */
  showConnectOverlay(text) {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('connect-overlay');
    const title = document.getElementById('connect-overlay-title');
    if (title) title.textContent = text;
    if (el) el.classList.remove('hidden');
  }

  /**
   * Hide the connection modal overlay.
   */
  hideConnectOverlay() {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('connect-overlay');
    if (el) el.classList.add('hidden');
  }

  /**
   * Initiate a server connection with timeout guard.
   * @param {string} ip
   * @param {string} pass
   * @param {string} name
   */
  startConnection(ip, pass, name) {
    const G = this.context;
    if (!G) return;
    G.lastIp = ip;
    G.lastPass = pass;
    G.lastName = name;
    G.isConnecting = true;
    G.isReconnecting = false;

    const connStatus = document.getElementById('connstatus');
    if (connStatus) connStatus.classList.add('hidden');

    this.showConnectOverlay('Connecting...');

    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
    if (G.connectionTimeout) clearTimeout(G.connectionTimeout);

    this.connectionTimeout = setTimeout(() => {
      this.onConnectionTimeout('Connecting timed out after 30 seconds');
    }, 30000);
    G.connectionTimeout = this.connectionTimeout;

    if (G.Network) {
      G.Network.connect(ip, pass, name);
    }
  }

  /**
   * Handle successful connection event.
   */
  onConnectionSuccess() {
    const G = this.context;
    if (!G) return;
    G.isConnecting = false;
    G.isReconnecting = false;

    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
    if (G.connectionTimeout) {
      clearTimeout(G.connectionTimeout);
      G.connectionTimeout = null;
    }
    if (G.reconnectRetryTimer) {
      clearTimeout(G.reconnectRetryTimer);
      G.reconnectRetryTimer = null;
    }

    this.hideConnectOverlay();
    if (G.menuController) G.menuController.hideInGameMenu();
  }

  /**
   * Reset game state and return to main menu on connection timeout or disconnect.
   * @param {string} [msg]
   */
  onConnectionTimeout(msg) {
    const G = this.context;
    if (!G) return;

    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
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
    this.hideConnectOverlay();
    if (G.menuController) G.menuController.hideInGameMenu();

    if (typeof document !== 'undefined' && document.exitPointerLock) {
      try {
        document.exitPointerLock();
      } catch { /* ignore */ }
    }
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

    if (G.loadMap) {
      G.loadMap(String(Math.floor(Math.random() * 1e9)));
    }
    if (G.canvas) {
      G.canvas.style.opacity = '1';
    }
    if (G.camera) {
      G.camera.fov = G.baseFov || 115;
      G.camera.updateProjectionMatrix();
    }

    if (G.remotePlayerMeshes) {
      for (const pid in G.remotePlayerMeshes) {
        if (G.remotePlayerMeshes[pid]) {
          G.scene.remove(G.remotePlayerMeshes[pid]);
          G.remotePlayerMeshes[pid].traverse((o) => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
          });
        }
      }
      G.remotePlayerMeshes = {};
    }
    G.remotePlayers = {};

    if (typeof document !== 'undefined') {
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
        if (G.menuController) G.menuController.showMainMenu();
      }
      const connStatus = document.getElementById('connstatus');
      if (connStatus) {
        if (msg) {
          connStatus.textContent = msg;
          connStatus.classList.remove('hidden');
        } else {
          connStatus.textContent = '';
          connStatus.classList.add('hidden');
        }
      }
    }

    if (msg && G.addEventLog) {
      G.addEventLog(msg, true);
    }
  }

  /**
   * Cleanup and dispose client instance.
   */
  dispose() {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
    if (this.engine) {
      this.engine.destroy();
    }
    if (this.loading) {
      this.loading.dispose();
    }
  }
}

export { GameEngine };
export default PortalClient;

let clientInstance = null;

/**
 * Global boot function to start the client application.
 * @param {Object} [options]
 * @returns {PortalClient}
 */
export function boot(options) {
  if (!clientInstance) {
    clientInstance = new PortalClient(options);
  }
  clientInstance.boot();
  return clientInstance;
}

if (typeof window !== 'undefined') {
  boot();
}
