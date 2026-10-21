import { AudioSys } from '../audio/AudioController.js';
import { MenuDecorator } from './MenuDecorator.js';

const STORAGE_KEYS = {
  FOV: 'portal_fov',
  NAME: 'portal_player_name',
  IP: 'portal_server_ip',
  SEED: 'portal_last_seed',
  SOUND: 'portal_sound'
};

function defaultServer() {
  return typeof window !== 'undefined' && window.location.hostname
    ? `${window.location.hostname}:3001`
    : 'localhost:3001';
}

/**
 * MenuController — Orchestrates retro Diablo 1 / Quake 1 Gothic-Slipgate menus,
 * keyboard/mouse navigation, local storage settings, and 3D weapon decorators.
 */
export class MenuController {
  /**
   * @param {Object} context - Game state context (G)
   */
  constructor(context) {
    this.context = context;

    // View panels
    this.startPanel = null;
    this.menuPanel = null;
    this.exitModal = null;

    // Sub-views
    this.mainRootView = null;
    this.startGameView = null;
    this.mainOptionsView = null;
    this.ingameRootView = null;
    this.ingameOptionsView = null;

    // 3D Decorators
    this.mainDecorator = null;
    this.ingameDecorator = null;

    // Navigation state
    this.activeView = 'main'; // 'main', 'start_game', 'main_options', 'ingame', 'ingame_options'
    this.selectedIndex = 0;
    this.currentItems = [];

    // Form inputs
    this.nameInput = null;
    this.ipInput = null;
    this.passInput = null;
    this.seedInput = null;

    this._onResize = () => this._handleResize();
  }

  /**
   * Initialize DOM bindings, load saved settings, and mount decorators.
   */
  init() {
    if (typeof document === 'undefined') return;

    this.startPanel = document.getElementById('startpanel');
    this.menuPanel = document.getElementById('menupanel');
    this.exitModal = document.getElementById('exit-modal');

    this.mainRootView = document.getElementById('main-menu-root');
    this.startGameView = document.getElementById('start-game-view');
    this.mainOptionsView = document.getElementById('main-options-view');

    this.ingameRootView = document.getElementById('ingame-menu-root');
    this.ingameOptionsView = document.getElementById('ingame-options-view');

    this.nameInput = document.getElementById('nameinput');
    this.ipInput = document.getElementById('ipinput');
    this.passInput = document.getElementById('passinput');
    this.seedInput = document.getElementById('seedinput');

    // Populate and persist player name
    if (this.nameInput) {
      try {
        const savedName = localStorage.getItem(STORAGE_KEYS.NAME);
        this.nameInput.value = savedName || 'Guest';
      } catch {
        this.nameInput.value = 'Guest';
      }
      this.nameInput.addEventListener('input', () => {
        try {
          localStorage.setItem(STORAGE_KEYS.NAME, this.nameInput.value.trim() || 'Guest');
        } catch {
          /* ignore */
        }
      });
    }

    if (this.ipInput) {
      this.ipInput.placeholder = defaultServer();
      try {
        const savedIp = localStorage.getItem(STORAGE_KEYS.IP);
        this.ipInput.value = savedIp || '';
      } catch {
        this.ipInput.value = '';
      }
      this.ipInput.addEventListener('input', () => {
        try {
          localStorage.setItem(STORAGE_KEYS.IP, this.ipInput.value.trim());
        } catch {
          /* ignore */
        }
      });
    }

    if (this.passInput) {
      this.passInput.value = 'secret';
    }

    // Initialize FOV and Sound settings from localStorage
    this._loadSavedFov();
    this._loadSavedSound();

    // Setup 3D Decorators
    const mainCanvas = document.getElementById('main-decorator-canvas');
    if (mainCanvas) {
      this.mainDecorator = new MenuDecorator(mainCanvas);
    }

    const ingameCanvas = document.getElementById('ingame-decorator-canvas');
    if (ingameCanvas) {
      this.ingameDecorator = new MenuDecorator(ingameCanvas);
    }

    this._bindEvents();
    window.addEventListener('resize', this._onResize);

    // Initial view is root main menu
    this.showScreen('main');
  }

  /**
   * Load saved sound setting from localStorage and synchronize audio subsystem.
   * @private
   */
  _loadSavedSound() {
    let muted = false;
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.SOUND);
      if (saved === 'off' || saved === 'muted') {
        muted = true;
      }
    } catch {
      /* ignore */
    }
    AudioSys.setMuted(muted);
    this.syncSoundButtons();
  }

  /**
   * Toggle mute state, persist to localStorage, and synchronize UI buttons.
   */
  toggleSound() {
    AudioSys.ensure();
    const isMuted = AudioSys.toggleMute();
    try {
      localStorage.setItem(STORAGE_KEYS.SOUND, isMuted ? 'off' : 'on');
    } catch {
      /* ignore */
    }
    this.syncSoundButtons();
    if (!isMuted) {
      this._playTone('select');
    }
  }

  /**
   * Synchronize all sound toggle buttons and HUD readout.
   */
  syncSoundButtons() {
    const text = `SOUND: ${AudioSys.muted ? 'OFF' : 'ON'}`;
    const btnMuteInGame = document.getElementById('btnmute');
    const btnMuteMain = document.getElementById('btnmutemain');
    const muteInf = document.getElementById('muteinf');

    if (btnMuteInGame) btnMuteInGame.textContent = text;
    if (btnMuteMain) btnMuteMain.textContent = text;
    if (muteInf) muteInf.textContent = AudioSys.muted ? 'off' : 'on';
  }

  /**
   * Load saved FOV from localStorage and sync to context & DOM.
   * @private
   */
  _loadSavedFov() {
    let fov = 115;
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.FOV);
      if (saved !== null) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed) && parsed >= 90 && parsed <= 135) {
          fov = parsed;
        }
      }
    } catch {
      /* ignore */
    }

    if (this.context) {
      this.context.baseFov = fov;
    }
    this.setFov(fov, false);
  }

  /**
   * Set field of view, synchronize DOM sliders, and persist to localStorage.
   * @param {number} fov
   * @param {boolean} [save=true]
   */
  setFov(fov, save = true) {
    const val = Math.max(90, Math.min(135, Math.round(fov)));
    if (this.context) {
      this.context.baseFov = val;
      if (this.context.camera) {
        this.context.camera.fov = val;
        this.context.camera.updateProjectionMatrix();
      }
    }

    if (save) {
      try {
        localStorage.setItem(STORAGE_KEYS.FOV, String(val));
      } catch {
        /* ignore */
      }
    }

    const ids = ['fovslider', 'fovval', 'fovslider2', 'fovval2', 'fovinf'];
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        if ('value' in el) el.value = val;
        else el.textContent = String(val);
      }
    });
  }

  /**
   * Bind DOM button and input listeners.
   * @private
   */
  _bindEvents() {
    // FOV Sliders
    const fov1 = document.getElementById('fovslider');
    const fov2 = document.getElementById('fovslider2');
    if (fov1) fov1.addEventListener('input', (e) => this.setFov(+e.target.value));
    if (fov2) fov2.addEventListener('input', (e) => this.setFov(+e.target.value));

    // Exit Modal button
    const exitReturnBtn = document.getElementById('btnexitreturn');
    if (exitReturnBtn) {
      exitReturnBtn.addEventListener('click', () => {
        this._playTone('action');
        if (this.exitModal) this.exitModal.classList.add('hidden');
      });
    }

    // Connect overlay cancel
    const cancelBtn = document.getElementById('connect-overlay-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        this._playTone('action');
        if (this.context?.onConnectionTimeout) {
          this.context.onConnectionTimeout('Connection cancelled');
        }
      });
    }
  }

  /**
   * Switch the visible screen and update selectable items & 3D decorator.
   * @param {string} screen - 'main', 'start_game', 'main_options', 'ingame', 'ingame_options'
   */
  showScreen(screen) {
    this.activeView = screen;

    // Main Menu sub-views
    if (this.mainRootView) this.mainRootView.classList.toggle('hidden', screen !== 'main');
    if (this.startGameView) this.startGameView.classList.toggle('hidden', screen !== 'start_game');
    if (this.mainOptionsView) this.mainOptionsView.classList.toggle('hidden', screen !== 'main_options');

    // In-Game Menu sub-views
    if (this.ingameRootView) this.ingameRootView.classList.toggle('hidden', screen !== 'ingame');
    if (this.ingameOptionsView) this.ingameOptionsView.classList.toggle('hidden', screen !== 'ingame_options');

    // Refresh selectable menu items for active view
    let container = null;
    let decorator = null;

    if (screen === 'main' || screen === 'start_game' || screen === 'main_options') {
      container = screen === 'main' ? this.mainRootView : (screen === 'start_game' ? this.startGameView : this.mainOptionsView);
      decorator = this.mainDecorator;
      if (this.ingameDecorator) this.ingameDecorator.stop();
    } else if (screen === 'ingame' || screen === 'ingame_options') {
      container = screen === 'ingame' ? this.ingameRootView : this.ingameOptionsView;
      decorator = this.ingameDecorator;
      if (this.mainDecorator) this.mainDecorator.stop();
    }

    if (decorator) {
      decorator.start();
      decorator.resize();
      requestAnimationFrame(() => {
        if (decorator) {
          decorator.resize();
          decorator.updateTarget();
        }
      });
    }

    this._gatherItems(container);
    this.selectedIndex = 0;
    this._updateSelectedVisuals();
  }

  /**
   * Find and cache all selectable items within the active container.
   * @param {HTMLElement|null} container
   * @private
   */
  _gatherItems(container) {
    this.currentItems = [];
    if (!container) return;

    const items = container.querySelectorAll('.retro-menu-item, .retro-menu-item-row, .retro-action-btn');
    this.currentItems = Array.from(items);

    this.currentItems.forEach((el, idx) => {
      el.onmouseenter = () => {
        if (this.selectedIndex !== idx) {
          this.selectedIndex = idx;
          this._playTone('select');
          this._updateSelectedVisuals();
        }
      };

      el.onclick = (e) => {
        // If clicking on an input directly, don't prevent focus
        if (e.target && e.target.tagName === 'INPUT') {
          this.selectedIndex = idx;
          this._updateSelectedVisuals();
          return;
        }

        e.preventDefault();
        this._playTone('action');
        this._executeAction(el);
      };
    });
  }

  /**
   * Update CSS classes and move 3D decorator to the selected item.
   * @private
   */
  _updateSelectedVisuals() {
    this.currentItems.forEach((el, idx) => {
      el.classList.toggle('selected', idx === this.selectedIndex);
    });

    const activeItem = this.currentItems[this.selectedIndex];
    if (activeItem) {
      if ((this.activeView === 'main' || this.activeView === 'start_game' || this.activeView === 'main_options') && this.mainDecorator) {
        this.mainDecorator.setTarget(activeItem);
      } else if ((this.activeView === 'ingame' || this.activeView === 'ingame_options') && this.ingameDecorator) {
        this.ingameDecorator.setTarget(activeItem);
      }

      // If selecting a form row in start game, focus the nested input
      if (this.activeView === 'start_game') {
        const inp = activeItem.querySelector('input') || (activeItem.tagName === 'INPUT' ? activeItem : null);
        if (inp && document.activeElement !== inp) {
          inp.focus();
        }
      }
    }
  }

  /**
   * Navigate to next selectable option.
   */
  selectNext() {
    if (this.currentItems.length <= 1) return;
    this.selectedIndex = (this.selectedIndex + 1) % this.currentItems.length;
    this._playTone('select');
    this._updateSelectedVisuals();
  }

  /**
   * Navigate to previous selectable option.
   */
  selectPrev() {
    if (this.currentItems.length <= 1) return;
    this.selectedIndex = (this.selectedIndex - 1 + this.currentItems.length) % this.currentItems.length;
    this._playTone('select');
    this._updateSelectedVisuals();
  }

  /**
   * Activate currently selected item.
   */
  activateSelected() {
    const item = this.currentItems[this.selectedIndex];
    if (item) {
      this._playTone('action');
      this._executeAction(item);
    }
  }

  /**
   * Execute semantic action corresponding to clicked or activated button.
   * @param {HTMLElement} btn
   * @private
   */
  _executeAction(btn) {
    const action = btn.getAttribute('data-action');

    switch (action) {
      case 'open_start_game':
        this.showScreen('start_game');
        break;

      case 'open_main_options':
        this.showScreen('main_options');
        break;

      case 'open_ingame_options':
        this.showScreen('ingame_options');
        break;

      case 'back_to_main':
        this.showScreen('main');
        break;

      case 'back_to_ingame':
        this.showScreen('ingame');
        break;

      case 'enter_chamber':
        this._startChamberConnection();
        break;

      case 'resume_game':
        this.hideInGameMenu();
        if (this.context?.requestLock) {
          this.context.requestLock();
        }
        break;

      case 'toggle_join_spectate':
        this._toggleJoinSpectate();
        break;

      case 'toggle_sound':
        this.toggleSound();
        break;

      case 'toggle_fullscreen':
        this.toggleFullscreen();
        break;

      case 'disconnect_to_main':
        this.disconnectToMainMenu();
        break;

      case 'exit_game':
        this.gracefulExit();
        break;

      case 'focus_input': {
        const inpId = btn.getAttribute('data-input-id');
        if (inpId) {
          const inp = document.getElementById(inpId);
          if (inp) inp.focus();
        }
        break;
      }

      default:
        if (btn.id === 'btnmute' || btn.id === 'btnmutemain') {
          this.toggleSound();
        } else if (btn.id === 'btnfs' || btn.id === 'btnfsmain') {
          this.toggleFullscreen();
        }
        break;
    }
  }

  /**
   * Toggle fullscreen mode.
   */
  toggleFullscreen() {
    this._playTone('action');
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  /**
   * Collect inputs and launch game server connection.
   * @private
   */
  _startChamberConnection() {
    AudioSys.ensure();
    const name = (this.nameInput?.value.trim()) || 'Guest';
    const ip = (this.ipInput?.value.trim()) || defaultServer();
    const pass = (this.passInput?.value.trim()) || 'secret';
    const seed = (this.seedInput?.value.trim()) || '';

    try {
      localStorage.setItem(STORAGE_KEYS.NAME, name);
      localStorage.setItem(STORAGE_KEYS.IP, ip);
      if (seed) localStorage.setItem(STORAGE_KEYS.SEED, seed);
    } catch {
      /* ignore */
    }

    if (this.context) {
      this.context.requestedSeed = seed;
      if (this.context.startConnection) {
        this.context.startConnection(ip, pass, name);
      } else if (this.context.Network?.connect) {
        this.context.Network.connect(ip, pass, name);
      }
    }
  }

  /**
   * Toggle between joining the active game and spectating.
   * @private
   */
  _toggleJoinSpectate() {
    const G = this.context;
    if (!G) return;
    this.hideInGameMenu();
    if (G.isSpectator) {
      if (G.requestJoin) G.requestJoin();
    } else {
      G.isSpectator = true;
      G.spectatorMode = 'freefly';
      if (G.gun) G.gun.visible = false;
      if (G.rocketGun) G.rocketGun.visible = false;
      if (G.instagibGun) G.instagibGun.visible = false;
      if (G.playerModel) G.playerModel.visible = false;
      if (G.pl && G.specPos) {
        G.specPos.copy(G.pl.pos);
        G.specPos.y += 2;
        G.specYaw = G.pl.yaw;
        G.specPitch = G.pl.pitch;
      }
      if (G.requestSpectate) G.requestSpectate();
    }
    if (G.requestLock) G.requestLock();
  }

  /**
   * Update Join Game / Spectate button text according to spectator state.
   * @param {boolean} isSpectator
   */
  updateSpectateBtn(isSpectator) {
    const btn = document.getElementById('btnswitchmode');
    if (btn) {
      btn.textContent = isSpectator ? 'JOIN GAME (J)' : 'SPECTATE';
    }
  }

  /**
   * Gracefully close game browser tab with security fallback modal.
   */
  gracefulExit() {
    try {
      window.close();
    } catch {
      /* ignore */
    }

    try {
      window.open('', '_self', '');
      window.close();
    } catch {
      /* ignore */
    }

    // Fallback if browser security prevents closing tab
    if (this.exitModal) {
      this.exitModal.classList.remove('hidden');
    }
  }

  /**
   * Disconnect from active session and return cleanly to Root Main Menu with orbiting camera.
   */
  disconnectToMainMenu() {
    const G = this.context;
    if (!G) return;

    // Reset state before disconnecting to avoid reconnect handler
    G.isConnecting = false;
    G.isReconnecting = false;
    G.started = false;
    G.isConnected = false;
    G.isDead = false;
    G.isSpectator = true;
    G.spectatorMode = 'freefly';
    G.spectateTargetPid = null;

    if (G.client?.connectionTimeout) {
      clearTimeout(G.client.connectionTimeout);
      G.client.connectionTimeout = null;
    }
    if (G.connectionTimeout) {
      clearTimeout(G.connectionTimeout);
      G.connectionTimeout = null;
    }
    if (G.reconnectRetryTimer) {
      clearTimeout(G.reconnectRetryTimer);
      G.reconnectRetryTimer = null;
    }

    if (G.Network?.disconnect) {
      G.Network.disconnect();
    }

    if (typeof document !== 'undefined' && document.exitPointerLock) {
      try {
        document.exitPointerLock();
      } catch { /* ignore */ }
    }
    G.pointerLocked = false;

    // Reset models, portals, and map
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
          if (G.remotePlayerMeshes[pid].userData?.cloneMesh) {
            G.scene.remove(G.remotePlayerMeshes[pid].userData.cloneMesh);
            G.remotePlayerMeshes[pid].userData.cloneMesh.traverse((o) => {
              if (o.geometry) o.geometry.dispose();
              if (o.material) o.material.dispose();
            });
          }
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

    // Load fresh empty map for orbiting camera view
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

    // Hide overlays & redundant connection status
    const hud = document.getElementById('hud');
    if (hud) hud.classList.add('hidden');
    const menu = document.getElementById('menupanel');
    if (menu) menu.classList.add('hidden');
    const win = document.getElementById('winpanel');
    if (win) win.classList.add('hidden');
    const connStatus = document.getElementById('connstatus');
    if (connStatus) {
      connStatus.textContent = '';
      connStatus.classList.add('hidden');
    }
    const connectOverlay = document.getElementById('connect-overlay');
    if (connectOverlay) connectOverlay.classList.add('hidden');

    this.showMainMenu();
  }

  /**
   * Show Main Menu overlay and root 3-item list.
   */
  showMainMenu() {
    if (this.menuPanel) this.menuPanel.classList.add('hidden');
    if (this.startPanel) {
      this.startPanel.classList.remove('hidden');
      this.startPanel.style.opacity = '1';
    }
    this.showScreen('main');
  }

  /**
   * Show In-Game Menu overlay.
   */
  showInGameMenu() {
    if (this.startPanel) this.startPanel.classList.add('hidden');
    if (this.menuPanel) this.menuPanel.classList.remove('hidden');
    this.updateSpectateBtn(!!this.context?.isSpectator);
    this.syncSoundButtons();
    this.showScreen('ingame');
  }

  /**
   * Hide In-Game Menu overlay.
   */
  hideInGameMenu() {
    if (this.menuPanel) this.menuPanel.classList.add('hidden');
    const mp = document.getElementById('menupanel');
    if (mp) mp.classList.add('hidden');
    if (this.ingameDecorator) this.ingameDecorator.stop();
  }

  /**
   * Toggle In-Game Menu visibility.
   */
  toggleInGameMenu() {
    if (!this.menuPanel) return;
    if (this.menuPanel.classList.contains('hidden')) {
      this.showInGameMenu();
    } else {
      this.hideInGameMenu();
      if (this.context?.requestLock) {
        this.context.requestLock();
      }
    }
  }

  /**
   * Check if any menu panel is currently visible.
   * @returns {boolean}
   */
  isMenuOpen() {
    const startOpen = this.startPanel && !this.startPanel.classList.contains('hidden');
    const inGameOpen = this.menuPanel && !this.menuPanel.classList.contains('hidden');
    return !!(startOpen || inGameOpen);
  }

  /**
   * Handle pointer lock state transitions.
   * @param {boolean} locked
   * @param {boolean} [wasLocked=false]
   */
  onPointerLockChange(locked, wasLocked = false) {
    if (locked) {
      this.hideInGameMenu();
    } else if (wasLocked && this.context?.started && !this.context?.won) {
      this.showInGameMenu();
    }
  }

  /**
   * Central keyboard router for menus.
   * @param {KeyboardEvent} e
   * @returns {boolean} - true if key event was consumed by the menu
   */
  handleKeyDown(e) {
    const isInput = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');

    if (e.code === 'Escape') {
      if (this.exitModal && !this.exitModal.classList.contains('hidden')) {
        this.exitModal.classList.add('hidden');
        return true;
      }

      if (this.activeView === 'start_game' || this.activeView === 'main_options') {
        this.showScreen('main');
        return true;
      }

      if (this.activeView === 'ingame_options') {
        this.showScreen('ingame');
        return true;
      }

      if (this.activeView === 'ingame') {
        this.hideInGameMenu();
        if (this.context?.requestLock) this.context.requestLock();
        return true;
      }

      if (this.context?.started && !this.context?.won) {
        this.showInGameMenu();
        return true;
      }

      return false;
    }

    if (this.activeView === 'start_game') {
      if (e.code === 'ArrowUp' || (!isInput && e.code === 'KeyW')) {
        e.preventDefault();
        this.selectPrev();
        return true;
      }
      if (e.code === 'ArrowDown' || (!isInput && e.code === 'KeyS')) {
        e.preventDefault();
        this.selectNext();
        return true;
      }
      if (e.code === 'Enter') {
        e.preventDefault();
        const activeItem = this.currentItems[this.selectedIndex];
        if (activeItem && activeItem.getAttribute('data-action') === 'back_to_main') {
          this.showScreen('main');
        } else {
          this._playTone('action');
          this._startChamberConnection();
        }
        return true;
      }
      if (isInput) return false;
    } else if (isInput) {
      return false;
    }

    if (!this.isMenuOpen()) return false;

    if (this.activeView === 'ingame' && e.code === 'KeyJ') {
      e.preventDefault();
      this._playTone('action');
      this._toggleJoinSpectate();
      return true;
    }

    if (e.code === 'KeyW' || e.code === 'ArrowUp') {
      e.preventDefault();
      this.selectPrev();
      return true;
    }

    if (e.code === 'KeyS' || e.code === 'ArrowDown') {
      e.preventDefault();
      this.selectNext();
      return true;
    }

    if (e.code === 'Enter') {
      e.preventDefault();
      this.activateSelected();
      return true;
    }

    return false;
  }

  /**
   * Play retro Diablo/Quake styled sound feedback.
   * Navigation tone is crisp and slightly louder; action tone is mellow and warm.
   * @param {'select'|'action'} type
   * @private
   */
  _playTone(type) {
    AudioSys.ensure();
    if (type === 'select') {
      // Crisp, slightly louder stone/iron click
      AudioSys.tone(520, 260, 0.045, 'triangle', 0.15);
    } else if (type === 'action') {
      // Mellow, warm round chime
      AudioSys.tone(280, 180, 0.16, 'sine', 0.11);
    }
  }

  /**
   * Window resize handler.
   * @private
   */
  _handleResize() {
    if (this.mainDecorator && (this.activeView === 'main' || this.activeView === 'start_game' || this.activeView === 'main_options')) {
      this.mainDecorator.resize();
    }
    if (this.ingameDecorator && (this.activeView === 'ingame' || this.activeView === 'ingame_options')) {
      this.ingameDecorator.resize();
    }
  }

  /**
   * Clean up listeners and WebGL resources.
   */
  destroy() {
    window.removeEventListener('resize', this._onResize);
    if (this.mainDecorator) this.mainDecorator.dispose();
    if (this.ingameDecorator) this.ingameDecorator.dispose();
  }
}
