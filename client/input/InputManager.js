import { AudioSys } from '../audio/AudioController.js';

function defaultServer() {
  return typeof window !== 'undefined' ? (window.location.hostname + ':3001') : 'localhost:3001';
}

/**
 * InputManager — Translates hardware mouse and keyboard events into semantic game actions and commands.
 */
export class InputManager {
  /**
   * @param {import('../core/GameEngine.js').GameEngine} [engine]
   * @param {HTMLCanvasElement} [canvas]
   * @param {Object} [context]
   */
  constructor(engine = null, canvas = null, context = null) {
    this.engine = engine;
    this.canvas = canvas;
    this.context = context || engine?.context || (typeof window !== 'undefined' ? window.__GAME_CONTEXT__ : null);

    this.keys = this.context?.keys || {};
    this.pointerLocked = false;
    this.sensitivity = 0.0023;
    this.lastUnlockTime = 0;
    this.pendingLockRetry = false;
    this._retryLockTimer = null;

    if (this.context) {
      this.context.keys = this.keys;
      this.context.inputManager = this;
    }

    this._setupListeners();
    this._setupPanelListeners();
  }

  requestPointerLock() {
    const canvas = this.canvas || (typeof document !== 'undefined' ? document.getElementById('gl') : null);
    if (!canvas) return;

    if (document.pointerLockElement === canvas) {
      this.pointerLocked = true;
      if (this.context) this.context.pointerLocked = true;
      this.pendingLockRetry = false;
      return;
    }

    try {
      if (typeof canvas.focus === 'function') {
        canvas.focus({ preventScroll: true });
      }
    } catch { /* ignore */ }

    try {
      const lockPromise = canvas.requestPointerLock();
      if (lockPromise && typeof lockPromise.catch === 'function') {
        lockPromise.catch((err) => {
          // In Chromium, exiting pointer lock via ESC triggers a 1.25s cooldown during which
          // calling requestPointerLock() throws/rejects SecurityError.
          // Handle gracefully and schedule retry once cooldown passes.
          const msg = String(err?.message || err || '');
          if (err?.name === 'SecurityError' || msg.includes('Pointer lock cannot be acquired immediately')) {
            this._handleCooldownLockRetry();
          }
        });
      }
    } catch { /* ignore */ }
  }

  _handleCooldownLockRetry() {
    this.pendingLockRetry = true;
    if (this._retryLockTimer) {
      clearTimeout(this._retryLockTimer);
    }
    const elapsed = performance.now() - (this.lastUnlockTime || 0);
    const delay = Math.max(50, Math.ceil(1300 - elapsed));
    this._retryLockTimer = setTimeout(() => {
      this._retryLockTimer = null;
      const G = this.context;
      if (this.pendingLockRetry && G && G.started && !G.won && (!G.menuController || !G.menuController.isMenuOpen())) {
        this.requestPointerLock();
      }
    }, delay);
  }

  exitPointerLock() {
    this.pendingLockRetry = false;
    if (this._retryLockTimer) {
      clearTimeout(this._retryLockTimer);
      this._retryLockTimer = null;
    }
    this.pointerLocked = false;
    if (this.context) this.context.pointerLocked = false;
    if (typeof document !== 'undefined' && document.exitPointerLock) {
      try {
        document.exitPointerLock();
      } catch { /* ignore */ }
    }
  }

  _setupListeners() {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;

    document.addEventListener('pointerlockchange', () => {
      const wasLocked = this.pointerLocked;
      const isLocked = !!(this.canvas && document.pointerLockElement === this.canvas);
      this.pointerLocked = isLocked;
      if (this.context) this.context.pointerLocked = isLocked;

      if (!isLocked) {
        this.lastUnlockTime = performance.now();
      } else {
        this.pendingLockRetry = false;
        if (this._retryLockTimer) {
          clearTimeout(this._retryLockTimer);
          this._retryLockTimer = null;
        }
      }

      if (this.context?.menuController) {
        this.context.menuController.onPointerLockChange(isLocked, wasLocked);
      } else {
        const menuPanel = this.context?.menuPanel || document.getElementById('menupanel');
        if (menuPanel) {
          if (this.pointerLocked) {
            menuPanel.classList.add('hidden');
          } else {
            const switchBtn = this.context?.dom ? this.context.dom('btnswitchmode') : document.getElementById('btnswitchmode');
            if (switchBtn) {
              switchBtn.textContent = this.context?.isSpectator ? 'JOIN GAME (J)' : 'SPECTATE';
            }
          }
        }
      }

      if (this.engine?.eventBus) {
        this.engine.eventBus.emit('POINTER_LOCK_CHANGED', { locked: this.pointerLocked });
      }
    });

    document.addEventListener('pointerlockerror', () => {
      this.pointerLocked = false;
      if (this.context) this.context.pointerLocked = false;
    });

    const triggerLock = () => {
      AudioSys.ensure();
      const G = this.context;
      if (G && G.started && !this.pointerLocked && !G.won) {
        if (G.menuController && G.menuController.isMenuOpen()) {
          return;
        }
        this.requestPointerLock();
      }
    };

    if (this.canvas) {
      this.canvas.addEventListener('click', triggerLock);
      this.canvas.addEventListener('pointerdown', triggerLock);
    }
    window.addEventListener('click', () => {
      const G = this.context;
      if (G && G.started && !this.pointerLocked && !G.won) {
        if (G.menuController && G.menuController.isMenuOpen()) return;
        triggerLock();
      }
    });
    window.addEventListener('pointerdown', (e) => {
      const G = this.context;
      if (G && G.started && !this.pointerLocked && !G.won) {
        if (G.menuController && G.menuController.isMenuOpen()) return;
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.closest?.('.retro-menu-item'))) return;
        triggerLock();
      }
    });

    document.addEventListener('mousemove', (e) => {
      const G = this.context;
      if (G?.menuController && G.menuController.isMenuOpen()) return;
      if (!this.pointerLocked || (this.canvas && document.pointerLockElement !== this.canvas)) return;
      if (Math.abs(e.movementX) > 100 || Math.abs(e.movementY) > 100) return;

      const fov = G?.camera?.fov || 115;
      const baseFov = G?.baseFov || 115;
      const sens = this.sensitivity * (fov / baseFov);

      if (G && G.isSpectator) {
        if (G.spectatorMode === 'freefly') {
          G.specYaw -= e.movementX * sens;
          G.specPitch = Math.max(-1.55, Math.min(1.55, G.specPitch - e.movementY * sens));
        }
        return;
      }

      if (G && G.pl) {
        G.pl.yaw -= e.movementX * sens;
        G.pl.pitch = Math.max(-1.55, Math.min(1.55, G.pl.pitch - e.movementY * sens));
      } else if (this.engine?.player) {
        this.engine.player.yaw -= e.movementX * sens;
        this.engine.player.pitch = Math.max(-1.55, Math.min(1.55, this.engine.player.pitch - e.movementY * sens));
      }
    });

    document.addEventListener('mousedown', (e) => {
      if (!this.pointerLocked) return;
      const G = this.context;
      if (G && G.won) return;
      AudioSys.ensure();

      if (G && G.isSpectator) {
        if (e.button === 0 && G.cycleSpectatorTarget) {
          G.cycleSpectatorTarget(1);
        } else if (e.button === 2 && G.toggleFollowPerspective) {
          G.toggleFollowPerspective();
        }
        return;
      }

      if (G && (G.isDead || G.countdownActive || (G.match && G.match.phase === 'countdown'))) return;

      if (e.button === 0) {
        if (G && G.grabbedCube && G.camera && G.TH) {
          const dir = new G.TH.Vector3(0, 0, -1).applyQuaternion(G.camera.quaternion).normalize();
          G.grabbedCube.vel.copy(dir).multiplyScalar(22).add(G.pl.vel);
          G.grabbedCube.rotVel.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(15);
          if (G.Network?.send) {
            G.Network.send({
              type: 'throw_cube',
              idx: G.grabCubes.indexOf(G.grabbedCube),
              pos: G.grabbedCube.pos.toArray(),
              vel: G.grabbedCube.vel.toArray()
            });
          }
          G.grabbedCube = null;
        } else {
          const wm = this.engine?.weaponManager || G?.weaponManager;
          if (wm) {
            wm.firePrimary();
          } else if (G) {
            if (G.activeWeapon === 1 && G.firePortal) G.firePortal(G.localPlayerIndex * 2);
            else if (G.activeWeapon === 2 && G.fireRocket) G.fireRocket();
            else if (G.activeWeapon === 3 && G.fireInstagib) G.fireInstagib();
          }
        }
      } else if (e.button === 2) {
        const wm = this.engine?.weaponManager || G?.weaponManager;
        if (wm) {
          wm.fireSecondary(true);
        } else if (G) {
          if (G.activeWeapon === 1 && !G.grabbedCube && G.firePortal) {
            G.firePortal(G.localPlayerIndex * 2 + 1);
          } else if (G.activeWeapon === 2 || G.activeWeapon === 3) {
            G.isZooming = true;
          }
        }
      }
    });

    document.addEventListener('mouseup', (e) => {
      if (e.button === 2) {
        const wm = this.engine?.weaponManager || this.context?.weaponManager;
        if (wm) {
          wm.fireSecondary(false);
        } else if (this.context) {
          this.context.isZooming = false;
        }
      }
    });

    document.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('wheel', (e) => {
      const G = this.context;
      if (!this.pointerLocked || !G || G.won || !G.started) return;
      if (G.isSpectator) {
        if (G.cycleSpectatorTarget) G.cycleSpectatorTarget(e.deltaY > 0 ? 1 : -1);
        return;
      }
      const nextWeapon = (G.activeWeapon === 1) ? 2 : 1;
      const wm = this.engine?.weaponManager || G?.weaponManager;
      if (wm) {
        wm.select(nextWeapon);
      } else {
        G.activeWeapon = nextWeapon;
        if (G.gun && G.rocketGun) {
          if (G.activeWeapon === 1) {
            G.gun.visible = true;
            G.rocketGun.visible = false;
          } else {
            G.gun.visible = false;
            G.rocketGun.visible = true;
          }
        }
      }
    });

    document.addEventListener('keydown', (e) => {
      const G = this.context;

      if (G?.menuController?.handleKeyDown(e)) {
        return;
      }

      if (e.code === 'Enter') {
        const startPanel = G?.startPanel || document.getElementById('startpanel');
        if (G && !G.started && startPanel && !startPanel.classList.contains('hidden')) {
          const btn = G.dom ? G.dom('btnstart') : document.getElementById('btnstart');
          if (btn) btn.click();
          return;
        }
      }

      if (e.target && e.target.tagName === 'INPUT') return;

      if (this.pendingLockRetry && G && G.started && !this.pointerLocked && !G.won) {
        const elapsed = performance.now() - (this.lastUnlockTime || 0);
        if (elapsed >= 1250) {
          this.requestPointerLock();
        }
      }

      const c = e.code;
      if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'KeyJ', 'ControlLeft', 'BracketLeft', 'BracketRight', 'Digit1', 'Digit2', 'Digit3'].includes(c)) {
        e.preventDefault();
      }

      this.keys[c] = true;
      if (c === 'Tab') {
        e.preventDefault();
        if (G) G.statsOpen = G.started;
      }

      if (!G || !G.started) return;

      if (c === 'KeyJ' && !e.repeat) {
        if (G.isSpectator && G.requestJoin) {
          if (G.menuController) G.menuController.hideInGameMenu();
          const mp = document.getElementById('menupanel');
          if (mp) mp.classList.add('hidden');
          G.requestJoin();
          return;
        }
      }

      if (c === 'KeyF') this.toggleFullscreen();

      if (c === 'Escape') {
        if (!G.won) {
          const menuPanel = G.menuPanel || document.getElementById('menupanel');
          if (menuPanel) {
            menuPanel.classList.toggle('hidden');
            const switchBtn = G.dom ? G.dom('btnswitchmode') : document.getElementById('btnswitchmode');
            if (switchBtn) switchBtn.textContent = G.isSpectator ? 'JOIN GAME (J)' : 'SPECTATE';
          }
        }
      }

      if (c === 'KeyM') {
        AudioSys.toggleMute();
        try {
          localStorage.setItem('portal_sound', AudioSys.muted ? 'off' : 'on');
        } catch { /* ignore */ }
        const muteInf = G.dom ? G.dom('muteinf') : document.getElementById('muteinf');
        if (muteInf) muteInf.textContent = AudioSys.muted ? 'off' : 'on';
        if (G?.menuController) {
          G.menuController.syncSoundButtons();
        } else {
          this.syncMuteBtn();
        }
      }

      if (c === 'BracketLeft') this.setFov((G.baseFov || 115) - 5);
      if (c === 'BracketRight') this.setFov((G.baseFov || 115) + 5);

      if (G.isSpectator || G.isDead) return;

      const wm = this.engine?.weaponManager || G.weaponManager;
      if (c === 'Digit1') {
        if (wm) {
          wm.select(1);
        } else {
          G.activeWeapon = 1;
          if (G.gun) G.gun.visible = true;
          if (G.rocketGun) G.rocketGun.visible = false;
          if (G.instagibGun) G.instagibGun.visible = false;
        }
      }
      if (c === 'Digit2') {
        if (wm) {
          wm.select(2);
        } else {
          G.activeWeapon = 2;
          if (G.gun) G.gun.visible = false;
          if (G.rocketGun) G.rocketGun.visible = true;
          if (G.instagibGun) G.instagibGun.visible = false;
        }
      }
      if (c === 'Digit3') {
        if (wm) {
          wm.select(3);
        } else {
          G.activeWeapon = 3;
          if (G.gun) G.gun.visible = false;
          if (G.rocketGun) G.rocketGun.visible = false;
          if (G.instagibGun) G.instagibGun.visible = true;
        }
      }

      if (G.countdownActive || (G.match && G.match.phase === 'countdown')) {
        if (['Space', 'KeyE'].includes(c)) return;
      }

      if (c === 'Space' && G.pl) {
        G.pl.jumpBuf = G.nowT;
      }

      if (c === 'KeyR' && !e.repeat) {
        if (G.match && (G.match.phase === 'warmup' || G.match.phase === 'waiting')) {
          G.localReady = !G.localReady;
          if (G.Network?.send) {
            G.Network.send({ type: 'ready', ready: G.localReady });
          }
        }
      }

      if (c === 'KeyN' && G.newMap) {
        G.newMap(String(Math.floor(Math.random() * 1e9)));
      }

      if (c === 'KeyE' && G.camera && G.TH) {
        if (G.grabbedCube) {
          G.grabbedCube.vel.copy(G.pl.vel);
          G.grabbedCube = null;
        } else if (G.grabCubes) {
          G.camera.updateMatrixWorld(true);
          const pos = G.camera.getWorldPosition(new G.TH.Vector3());
          const dir = new G.TH.Vector3(0, 0, -1).applyQuaternion(G.camera.quaternion).normalize();
          let bestC = null, bestT = 7.0;
          for (const cb of G.grabCubes) {
            const v = cb.pos.clone().sub(pos);
            const dist = v.length();
            if (dist > 7.0) continue;
            v.normalize();
            if (v.dot(dir) > 0.9 && dist < bestT) {
              bestT = dist;
              bestC = cb;
            }
          }
          if (bestC) G.grabbedCube = bestC;
        }
      }
    });

    document.addEventListener('keyup', (e) => {
      this.keys[e.code] = false;
      if (e.code === 'Tab' && this.context) {
        this.context.statsOpen = false;
      }
    });
  }

  _setupPanelListeners() {
    const G = this.context;
    if (!G || typeof document === 'undefined') return;

    ['click', 'keydown', 'pointerdown'].forEach((evt) => {
      window.addEventListener(evt, () => AudioSys.ensure(), { passive: true });
    });

    if (G.menuController) return;

    const fovSlider = G.dom ? G.dom('fovslider') : document.getElementById('fovslider');
    const fovSlider2 = G.dom ? G.dom('fovslider2') : document.getElementById('fovslider2');
    if (fovSlider) fovSlider.addEventListener('input', (e) => this.setFov(+e.target.value));
    if (fovSlider2) fovSlider2.addEventListener('input', (e) => this.setFov(+e.target.value));

    const btnMute = G.dom ? G.dom('btnmute') : document.getElementById('btnmute');
    if (btnMute) {
      btnMute.addEventListener('click', () => {
        AudioSys.toggleMute();
        this.syncMuteBtn();
      });
    }

    const btnFs = G.dom ? G.dom('btnfs') : document.getElementById('btnfs');
    if (btnFs) btnFs.addEventListener('click', () => this.toggleFullscreen());

    const ipInput = G.dom ? G.dom('ipinput') : document.getElementById('ipinput');
    if (ipInput) ipInput.placeholder = defaultServer();

    const btnStart = G.dom ? G.dom('btnstart') : document.getElementById('btnstart');
    if (btnStart) {
      btnStart.addEventListener('click', () => {
        AudioSys.ensure();
        const ipIn = document.getElementById('ipinput');
        const passIn = document.getElementById('passinput');
        const nameIn = document.getElementById('nameinput');
        const ip = (ipIn && ipIn.value.trim()) ? ipIn.value.trim() : defaultServer();
        const pass = (passIn && passIn.value.trim()) ? passIn.value.trim() : 'secret';
        const name = (nameIn && nameIn.value.trim()) ? nameIn.value.trim() : 'Guest';

        G.lastIp = ip;
        G.lastPass = pass;
        G.lastName = name;
        if (G.startConnection) {
          G.startConnection(ip, pass, name);
        } else if (G.Network?.connect) {
          G.Network.connect(ip, pass, name);
        }
      });
    }

    const cancelBtn = document.getElementById('connect-overlay-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        if (G.onConnectionTimeout) G.onConnectionTimeout('Connection cancelled');
      });
    }

    const btnResume = G.dom ? G.dom('btnresume') : document.getElementById('btnresume');
    if (btnResume) {
      btnResume.addEventListener('click', () => {
        AudioSys.ensure();
        this.requestPointerLock();
      });
    }

    const switchBtn = G.dom ? G.dom('btnswitchmode') : document.getElementById('btnswitchmode');
    if (switchBtn) {
      switchBtn.addEventListener('click', () => {
        if (G.isSpectator) {
          if (G.requestJoin) G.requestJoin();
        } else {
          if (G.requestSpectate) G.requestSpectate();
        }
        const menuPanel = G.menuPanel || document.getElementById('menupanel');
        if (menuPanel) menuPanel.classList.add('hidden');
        this.requestPointerLock();
      });
    }

    const btnNewMap = G.dom ? G.dom('btnnewmap') : document.getElementById('btnnewmap');
    if (btnNewMap) {
      btnNewMap.addEventListener('click', () => {
        const seedInput = G.dom ? G.dom('seedinput2') : document.getElementById('seedinput2');
        const s = (seedInput && seedInput.value.trim()) || String(Math.floor(Math.random() * 1e9));
        if (G.newMap) G.newMap(s);
      });
    }

    const btnAgain = G.dom ? G.dom('btnagain') : document.getElementById('btnagain');
    if (btnAgain) {
      btnAgain.addEventListener('click', () => {
        if (G.newMap) G.newMap(String(Math.floor(Math.random() * 1e9)));
      });
    }

    const btnSame = G.dom ? G.dom('btnsame') : document.getElementById('btnsame');
    if (btnSame) {
      btnSame.addEventListener('click', () => {
        if (G.Network?.send) {
          G.Network.send({ type: 'new_map', seed: G.currentSeed });
        }
        const winPanel = G.winPanel || document.getElementById('winpanel');
        if (winPanel) winPanel.classList.add('hidden');
        this.requestPointerLock();
      });
    }
  }

  addEventLog(msg, hot = false) {
    if (typeof document === 'undefined') return;
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

  setFov(f) {
    const G = this.context;
    if (!G) return;
    if (G.menuController) {
      G.menuController.setFov(f);
      return;
    }
    G.baseFov = Math.max(90, Math.min(135, Math.round(f)));
    try {
      localStorage.setItem('portal_fov', String(G.baseFov));
    } catch { /* ignore */ }
    const ids = ['fovinf', 'fovslider', 'fovval', 'fovslider2', 'fovval2'];
    ids.forEach((id) => {
      const el = G.dom ? G.dom(id) : (typeof document !== 'undefined' ? document.getElementById(id) : null);
      if (el) {
        if ('value' in el) el.value = G.baseFov;
        else el.textContent = G.baseFov;
      }
    });
  }

  toggleFullscreen() {
    if (typeof document === 'undefined') return;
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen();
    }
  }

  syncMuteBtn() {
    const G = this.context;
    if (!G) return;
    if (G.menuController) {
      G.menuController.syncSoundButtons();
      return;
    }
    const b = G.dom ? G.dom('btnmute') : document.getElementById('btnmute');
    if (b) b.textContent = 'SOUND: ' + (AudioSys.muted ? 'OFF' : 'ON');
    const i = G.dom ? G.dom('muteinf') : document.getElementById('muteinf');
    if (i) i.textContent = AudioSys.muted ? 'off' : 'on';
  }

  showSummary() {
    const G = this.context;
    if (!G || !G.match) return;
    let title, sub;
    if (G.match.winner === 'tie') {
      title = 'DRAW';
      sub = 'THE CHAMBER BALANCES — NO FAVOR GIVEN';
    } else {
      const w = G.match.winner && G.match.players ? G.match.players[G.match.winner] : null;
      title = (w ? w.name : 'PLAYER') + ' WINS';
      sub = 'THE ROUND IS DECIDED';
    }
    const t = G.dom ? G.dom('winTitle') : document.getElementById('winTitle');
    const s = G.dom ? G.dom('winSub') : document.getElementById('winSub');
    if (t) t.textContent = title;
    if (s) s.textContent = sub;
    const winPanel = G.winPanel || document.getElementById('winpanel');
    if (winPanel) winPanel.classList.remove('hidden');
  }

  isKeyDown(code) {
    return !!this.keys[code];
  }

  destroy() {
    this.exitPointerLock();
  }
}
