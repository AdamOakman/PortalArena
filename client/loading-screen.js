/* ============================================================================
   LOADING SCREEN — reusable 3-D loading overlay.

   A fullscreen dark overlay with a small 3-D scene centered on the screen:
   the game's own player model (models.js) carrying the game's instagib runs
   from a green portal (left) to a red portal (right), teleports back through
   the left portal, and loops indefinitely.

   Timeline
   --------
     new LoadingScreen()  → overlay mounts and fades in (0.3 s)
     markReady(gate) …    → once every configured gate has fired, the overlay
                            fades out (0.3 s), is removed from the DOM, and
                            the `onHide` callback (if any) is invoked

   Usage
   -----
     import { LoadingScreen } from './loading-screen.js';

     const ls = new LoadingScreen();     // default gates: three, map, frame, fonts
     ls.injectThree(TH);                 // three.js arrived → 3-D animation starts
     ls.markReady('three');
     ls.markReady('map');                // map built
     ls.markReady('frame');              // first frame rendered
     ls.markReady('fonts');              // document.fonts.ready
     ls.onHide = () => { // overlay gone — reveal what is behind it

     ls.hide();                          // manual dismissal at any time (Promise)

   Reuse in other places
   ---------------------
     - Custom gate set: new LoadingScreen({ gates: ['map', 'frame'] })
       (e.g. a mid-session "rebuilding the chamber" screen).
     - Fresh instances pick up the three.js namespace already published on
       window.__THREE_NS__ by the first one, so later uses need no extra
       wiring — the animation starts as soon as the overlay fades in.
   ============================================================================ */

import { initModels } from './models.js';

export const FADE_MS = 300;              // 0.3 s per spec

const DEFAULT_GATES = ['three', 'map', 'frame', 'fonts'];
const BG = 0x0a0708;                     // matches --bg in index.html

/* Generic 0.3 s opacity-transition helpers, reusable in other places. */
export function fadeIn(el, ms = FADE_MS) {
  if (!el) return Promise.resolve();
  el.style.transition = `opacity ${ms}ms ease`;
  el.style.opacity = '0';
  return new Promise(resolve => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener('transitionend', onEnd);
      clearTimeout(timer);
      resolve();
    };
    const onEnd = e => {
      if (e.target === el && e.propertyName === 'opacity') done();
    };
    // Resolves when the fade completes; the timeout covers browsers that
    // skip the transitionend event.
    const timer = setTimeout(done, ms + 80);
    el.addEventListener('transitionend', onEnd);
    // Double rAF so the initial state is committed before the transition runs.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (el.isConnected) el.style.opacity = '1';
      else done();
    }));
  });
}
export function fadeOut(el, ms = FADE_MS) {
  if (!el) return;
  el.style.transition = `opacity ${ms}ms ease`;
  el.style.opacity = '0';
}

export class LoadingScreen {
  /**
   * @param {object} [opts]
   * @param {string[]} [opts.gates] readiness gates — all must fire before
   *                                 the screen auto-hides
   * @param {number} [opts.delayMs] artificial minimum display time (ms)
   */
  constructor(opts = {}) {
    this.gates = opts.gates || DEFAULT_GATES;
    this._minVisibleMs = opts.delayMs || 0;   // artificial minimum display time
    this._ready = {};
    this._hidden = false;
    this._cleaned = false;
    this._hidePromise = null;
    this.onHide = null;                  // invoked when the fade-out completes
    this._threeNS = null;                // three.js namespace
    this._raf = null;
    this._threeCheckId = null;
    this._t = 0;                         // elapsed animation time (s)
    this._lastTS = null;
    this._prevPhase = 0;                 // previous cycle phase (wrap detection)

    this._buildDOM();
    this._ensureScene();
    this.show();                         // fade in immediately
  }

  /* ----------------------------------------------------------------- DOM -- */
  _buildDOM() {
    // Stylesheet for the pulsing "Loading..." heading. Injected only once
    // and shared by every LoadingScreen instance (it stays in <head> after
    // the last screen is disposed — it is inert without its element).
    if (!document.getElementById('loading-screen-style')) {
      const style = document.createElement('style');
      style.id = 'loading-screen-style';
      style.textContent =
        '@keyframes loading-screen-pulse{ 0%,100%{opacity:1} 50%{opacity:.3} }'
        + '#loading-screen-title{ position:absolute; top:10%; left:0; right:0;'
        + ' text-align:center; font-family:var(--display); font-size:30px;'
        + ' font-weight:600; letter-spacing:.28em; color:var(--bone-dim);'
        + ' text-shadow:0 0 18px rgba(255,122,34,.25);'
        + ' animation:loading-screen-pulse 1.4s ease-in-out infinite; }';
      document.head.appendChild(style);
    }
    const el = document.createElement('div');
    el.id = 'loading-screen';
    el.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:9999',
      `background:#${BG.toString(16)}`,
      'display:flex', 'align-items:center', 'justify-content:center',
      'opacity:0', `transition:opacity ${FADE_MS}ms ease`,
      'pointer-events:none',
    ].join(';');
    const cnv = document.createElement('canvas');
    cnv.style.cssText = `position:absolute;inset:0;width:100%;height:100%;display:block;opacity:0;transition:opacity ${FADE_MS}ms ease;`;
    el.appendChild(cnv);
    // Pulsing "Loading..." heading, above the animation
    const title = document.createElement('div');
    title.id = 'loading-screen-title';
    title.textContent = 'Loading...';
    el.appendChild(title);
    document.body.appendChild(el);
    this._el = el;
    this._canvas = cnv;
  }

  /** Fade the overlay in. Also re-mounts it after a previous hide(). */
  show() {
    if (this._cleaned) return;
    if (!this._el) {
      this._cleaned = false;
      this._buildDOM();
      this._ensureScene();
    }
    this._hidden = false;
    this._shownAt = performance.now();
    fadeIn(this._el);
  }

  /* --------------------------------------------------------------- three -- */
  _ensureScene() {
    if (this._scene) return;
    const ns = this._threeNS || window.__THREE_NS__;
    if (ns) this._initThree(ns);
    else this._waitForThree();
  }

  _waitForThree() {
    if (this._threeCheckId) return;
    const poll = () => {
      this._threeCheckId = null;
      if (this._cleaned || this._scene) return;
      if (window.__THREE_NS__) this._initThree(window.__THREE_NS__);
      else this._threeCheckId = setTimeout(poll, 16);
    };
    this._threeCheckId = setTimeout(poll, 16);
  }

  /** Called by the app the moment three.js is available. */
  injectThree(ns) {
    clearTimeout(this._threeCheckId);
    this._threeCheckId = null;
    window.__THREE_NS__ = ns;
    if (!this._scene) this._initThree(ns);
  }

  _initThree(TH) {
    if (this._cleaned || this._scene) return;
    this._threeNS = TH;

    const W = this._canvas.clientWidth || window.innerWidth;
    const H = this._canvas.clientHeight || window.innerHeight;

    /* renderer */
    const renderer = new TH.WebGLRenderer({ canvas: this._canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(W, H);
    if ('outputColorSpace' in renderer) renderer.outputColorSpace = TH.SRGBColorSpace;
    else if (TH.sRGBEncoding) renderer.outputEncoding = TH.sRGBEncoding;
    renderer.toneMapping = TH.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.localClippingEnabled = true;   // per-material clip planes (portal pass)
    this._renderer = renderer;

    /* scene / camera — pulled back so the stage reads as a small, centered
       element on the dark backdrop */
    const scene = new TH.Scene();
    scene.background = new TH.Color(BG);
    scene.fog = new TH.Fog(BG, 16, 34);
    this._scene = scene;

    const camera = new TH.PerspectiveCamera(50, W / H, 0.1, 100);
    camera.position.set(0, 2.8, 15);
    camera.lookAt(0, 1.3, 0);
    this._camera = camera;

    /* lights */
    scene.add(new TH.AmbientLight(0x3a3650, 1.4));
    const moon = new TH.DirectionalLight(0x99a2d4, 1.2);
    moon.position.set(8, 12, 6);
    scene.add(moon);

    /* floor — fog fades its edges into the backdrop */
    const floor = new TH.Mesh(
      new TH.PlaneGeometry(40, 40),
      new TH.MeshStandardMaterial({ color: 0x16101a, metalness: 0.3, roughness: 0.9 })
    );
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    /* portals */
    this._portals = this._makePortals(TH, scene);

    /* player + weapon (the game's own model, from models.js) */
    this._player = this._makePlayer(TH, scene, camera);

    /* resize handler */
    this._onResize = () => {
      const nW = window.innerWidth, nH = window.innerHeight;
      renderer.setSize(nW, nH);
      camera.aspect = nW / nH;
      camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', this._onResize);

    /* start the loop */
    this._t = 0;
    this._lastTS = null;
    this._prevPhase = 0;
    this._sceneRevealed = false;
    this._loop();
  }

  /* ----------------------------------------------------------- portals ---- */
  _makePortals(TH, scene) {
    const PORTAL_X = 5;                  // half-span of the run
    const PH = 2.4, PW = 1.4;
    const HW = PW / 2, HH = PH / 2;      // oval semi-axes
    const CORE_TUBE = 0.02;                              // core ring tube radius
    const GLOW_TUBE = 0.22;                              // glow halo tube radius
    const IHW = HW * (1 - GLOW_TUBE), IHH = HH * (1 - GLOW_TUBE); // inner rim (glow inner edge)

    // Clip planes for the portal pass (local clipping). Each side is a fan
    // of tangent planes approximating HALF of the portal's INNER RIM — the
    // inner edge of the wider glow halo, the most inner curve of the portal
    // — so the model is masked by that curve, not the ring's outer boundary.
    //   rightClip = right half of the right portal's inner rim (the entering
    //               model is cut off as it crosses this curve)
    //   leftClip  = left half of the left portal's inner rim (the emerging
    //               model is revealed as it crosses this curve)
    function makeHalfEllipseClips(cx, cy, hw, hh, side) {
      const N = 8;
      const planes = [];
      for (let k = 0; k < N; k++) {
        const th = -Math.PI / 2 + (k + 0.5) * (Math.PI / N);
        const px = cx + side * hw * Math.cos(th);
        const py = cy + hh * Math.sin(th);
        let nx = side * Math.cos(th) / hw, ny = Math.sin(th) / hh; // outward
        const len = Math.hypot(nx, ny);
        nx /= len; ny /= len;
        // Keep the interior (centre) side of each tangent line
        planes.push(new TH.Plane(new TH.Vector3(-nx, -ny, 0), px * nx + py * ny));
      }
      return planes;
    }
    const rightClip = makeHalfEllipseClips( PORTAL_X, PH / 2, IHW, IHH,  1);
    const leftClip  = makeHalfEllipseClips(-PORTAL_X, PH / 2, IHW, IHH, -1);

    // Sparkle particle field — same shader and emission/decay as the
    // gameplay portals (portals.js) so the loading portals glow the same.
    function makeSparkles(color, hw, hh) {
      const COUNT = 100;
      const pos = new Float32Array(COUNT * 3);
      const life = new Float32Array(COUNT);
      const vel = [];
      for (let j = 0; j < COUNT; j++) vel.push(new TH.Vector3());
      const geo = new TH.BufferGeometry();
      geo.setAttribute('position', new TH.BufferAttribute(pos, 3));
      geo.setAttribute('life', new TH.BufferAttribute(life, 1));
      const mat = new TH.ShaderMaterial({
        uniforms: { uColor: { value: new TH.Color(color) } },
        transparent: true, blending: TH.AdditiveBlending, depthWrite: false,
        vertexShader: `attribute float life; varying float vLife; void main() { vLife = life; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = life * 12.0; }`,
        fragmentShader: `uniform vec3 uColor; varying float vLife; void main() { vec2 p = gl_PointCoord - 0.5; float d = length(p); if (d > 0.5) discard; gl_FragColor = vec4(uColor * (1.0 - d*2.0), vLife); }`
      });
      const mesh = new TH.Points(geo, mat);
      mesh.frustumCulled = false;
      return { mesh, pos, vel, life, hw, hh };
    }

    function makePortal(color, x) {
      const grp = new TH.Group();
      grp.position.set(x, PH / 2, 0);

      // White core ring (as in gameplay)
      const core = new TH.Mesh(
        new TH.TorusGeometry(1, CORE_TUBE, 8, 64),
        new TH.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false })
      );
      core.scale.set(HW, HH, 1);
      grp.add(core);

      // Glow halo
      const glow = new TH.Mesh(
        new TH.TorusGeometry(1, GLOW_TUBE, 12, 48),
        new TH.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: TH.AdditiveBlending, depthWrite: false })
      );
      glow.scale.set(HW, HH, 1);
      grp.add(glow);

      // Inner fill
      const fill = new TH.Mesh(
        new TH.CircleGeometry(1, 48),
        new TH.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, blending: TH.AdditiveBlending, depthWrite: false })
      );
      fill.scale.set(HW, HH, 1);
      grp.add(fill);

      // Point light
      grp.add(new TH.PointLight(color, 6, 8, 2));

      // Sparkles (same as the gameplay portals)
      const sparkles = makeSparkles(color, HW, HH);
      grp.add(sparkles.mesh);

      scene.add(grp);
      return { grp, core, glow, sparkles };
    }

    // The game's own portal colours: primary green, secondary red
    const left  = makePortal(0x33ff33, -PORTAL_X);
    const right = makePortal(0xff5555,  PORTAL_X);
    return { left, right, PORTAL_X, PH, PW, leftClip, rightClip };
  }

  /* ------------------------------------------------------------ player ---- */
  _makePlayer(TH, scene, camera) {
    // The game's own model builder (models.js): local-player blue, layer 0
    // (visible to this camera), no clip plane. Two instances are built so
    // that during the portal pass one can be running into the right portal
    // while the other runs out of the left one at the same time.
    const { createPlayerModel } = initModels(TH, camera, scene);

    function makeOne() {
      const player = createPlayerModel(0x4a86e8, 0, null);
      // Carry only the instagib — hide the other two mirror weapons.
      player.userData.mirrorGun.visible = false;
      player.userData.mirrorRocketGun.visible = false;
      player.userData.mirrorInstagibGun.visible = true;

      // Clone every material (the weapon parts are shared by reference
      // across instances) so each model can carry its own portal clip
      // plane. This only touches the loading scene's own model set, never
      // the game's viewmodel.
      const mats = new Set();
      player.traverse(c => {
        if (c.isMesh) {
          c.material = c.material.clone();
          mats.add(c.material);
        }
      });

      // Subtle red light from the rail core onto the floor.
      const glow = new TH.PointLight(0xff2222, 0.7, 4, 2);
      glow.position.set(0.2, 1.3, -0.4);
      player.add(glow);

      // rig = scene-level group (run position + lean)
      const rig = new TH.Group();
      rig.add(player);
      player.rotation.y = -Math.PI / 2;    // face +X (left → right)
      scene.add(rig);
      return { rig, player, glow, mats: [...mats] };
    }

    const A = makeOne();
    const B = makeOne();
    const { PORTAL_X, leftClip, rightClip } = this._portals;
    // A starts as the runner (clipped by the right portal's edge), B as the
    // one emerging from the left portal. _tick reassigns these every frame,
    // so the per-cycle role swap is handled automatically.
    this._setClip(A, rightClip);
    this._setClip(B, leftClip);
    A.rig.position.set(-PORTAL_X, 0, 0);
    B.rig.position.set(-PORTAL_X, 0, 0);
    B.rig.visible = false;                  // only A runs at first
    return { A, B, isARunner: true, PORTAL_X };
  }

  /* ------------------------------------------------------------- loop ----- */
  _loop() {
    if (this._hidden || this._cleaned) return;
    this._raf = requestAnimationFrame(ts => {
      if (this._hidden || this._cleaned) return;
      const dt = this._lastTS !== null ? Math.min(0.05, (ts - this._lastTS) / 1000) : 0;
      this._lastTS = ts;
      this._t += dt;
      this._tick(dt, ts);
      this._renderer.render(this._scene, this._camera);
      // 3-D content fades in from the dark backdrop (0.3 s)
      if (!this._sceneRevealed) {
        this._sceneRevealed = true;
        this._canvas.style.opacity = '1';
      }
      this._loop();
    });
  }

  /* ------------------------------------------------------------- tick ----- */
  _tick(dt, ts) {
    const { A, B, PORTAL_X } = this._player;
    const { left, right, PW, leftClip, rightClip } = this._portals;

    const RUN_SPEED = 4.2;               // units/s
    const SPAN = PORTAL_X * 2;           // distance between the portals
    const runTime = SPAN / RUN_SPEED;    // duration of one run leg
    const TRANS = PW / RUN_SPEED;           // time to cross a portal at run speed
    const cycleLen = runTime + TRANS;

    const phase = this._t % cycleLen;

    // A new cycle begins (the portal pass just completed): the model that
    // emerged on the left becomes the runner — the roles swap.
    if (phase < this._prevPhase) this._player.isARunner = !this._player.isARunner;
    this._prevPhase = phase;

    const runner = this._player.isARunner ? A : B;
    const other  = this._player.isARunner ? B : A;

    // The runner is entering the right portal (clipped at its right edge);
    // the other is emerging from the left portal (clipped at its left edge).
    // Reassigned every frame so the role swap is automatic.
    this._setClip(runner, rightClip);
    this._setClip(other, leftClip);

    if (phase < runTime) {
      // --- RUN: a single model runs left → right ---
      const p = phase / runTime;
      const stride = this._t * RUN_SPEED * 2.8;
      // Running bob + slight forward lean (toward the running direction)
      runner.rig.position.set(-PORTAL_X + p * SPAN, Math.abs(Math.sin(stride)) * 0.07, 0);
      runner.rig.rotation.z = -(0.09 + 0.05 * Math.sin(stride * 2));
      runner.rig.visible = true;
      // The other waits, invisible, at the left portal
      other.rig.position.set(-PORTAL_X, 0, 0);
      other.rig.visible = false;
      runner.glow.intensity = 0.6 + 0.25 * Math.sin(ts * 0.007);
      other.glow.intensity = 0;
    } else {
      // --- PORTAL PASS: the model keeps running forward THROUGH the right
      //     portal — masked by the portal's right edge as it goes in — while,
      //     at the same moment, a copy is unmasked by the left portal's left
      //     edge and runs forward out of it. Constant speed, no fade: the
      //     clip planes do the hiding/revealing, so mid-pass each model is
      //     half inside its portal and half hidden behind the near edge.
      const u = (phase - runTime) / TRANS;   // linear → constant forward speed
      const flick = 0.6 + 0.25 * Math.sin(ts * 0.007);

      // Entering: run forward into the right portal; its right edge clips it
      runner.rig.position.set(PORTAL_X + u * PW, 0, 0);
      runner.rig.rotation.z = 0;
      runner.rig.visible = true;
      runner.glow.intensity = flick;

      // Emerging: run forward out of the left portal; its left edge clips it
      other.rig.position.set(-PORTAL_X - PW + u * PW, 0, 0);
      other.rig.rotation.z = 0;
      other.rig.visible = true;
      other.glow.intensity = flick;
    }

    // Portal pulse; bright while the pass is happening
    const flashing = phase >= runTime;
    const pulse = 0.88 + 0.12 * Math.sin(ts * 0.003);
    left.glow.material.opacity  = flashing ? 0.9 : 0.3 + 0.12 * pulse;
    right.glow.material.opacity = flashing ? 0.9 : 0.3 + 0.12 * pulse;

    // Sparkles — the same drifting ember field as the gameplay portals
    this._updateSparkles(left.sparkles, dt);
    this._updateSparkles(right.sparkles, dt);
  }

  /* Point a model's (cloned) materials at a portal's clip planes (the
     half-ellipse tangent fan). Always the same count, so the shader never
     recompiles when roles swap. */
  _setClip(m, planes) {
    for (const mat of m.mats) mat.clippingPlanes = planes;
  }

  /* Advance one portal's sparkle field (same simulation as gameplay). */
  _updateSparkles(sp, dt) {
    const { pos, vel, life, hw, hh } = sp;
    for (let j = 0; j < life.length; j++) {
      if (life[j] <= 0) {
        if (Math.random() < 0.2) {
          const ang = Math.random() * Math.PI * 2;
          const ex = Math.cos(ang) * hw;
          const ey = Math.sin(ang) * hh;
          pos[j*3] = ex; pos[j*3+1] = ey; pos[j*3+2] = (Math.random() - 0.5) * 0.2;
          vel[j].set(ex, ey, 0).normalize().multiplyScalar(Math.random() * 2.0 + 1.0);
          vel[j].z = (Math.random() - 0.5) * 3.0;
          life[j] = 0.5 + Math.random() * 1.0;
        }
      } else {
        life[j] -= dt * 1.2;
        pos[j*3] += vel[j].x * dt;
        pos[j*3+1] += vel[j].y * dt;
        pos[j*3+2] += vel[j].z * dt;
      }
    }
    sp.mesh.geometry.attributes.position.needsUpdate = true;
    sp.mesh.geometry.attributes.life.needsUpdate = true;
  }

  /* -------------------------------------------------------- public API ---- */

  /**
   * Mark one readiness gate as done. When every configured gate has fired
   * the screen auto-hides (0.3 s fade out).
   * @param {string} gate  one of this.gates
   */
  markReady(gate) {
    if (this._hidden || this._cleaned) return;
    this._ready[gate] = true;
    if (!this.gates.every(g => this._ready[g])) return;
    // Artificial minimum display time (preview): keep the screen up for at
    // least _minVisibleMs after it was shown.
    const wait = this._minVisibleMs - (performance.now() - (this._shownAt || 0));
    if (wait > 0) this._hideDelayId = setTimeout(() => this.hide(), wait);
    else this.hide();
  }

  /**
   * Fade out (0.3 s) and remove the overlay.
   * @returns {Promise<void>} resolves when the fade is complete
   */
  hide() {
    if (this._hidePromise) return this._hidePromise;
    this._hidePromise = new Promise(resolve => {
      if (!this._el) { resolve(); return; }
      fadeOut(this._el);
      setTimeout(() => {
        this._cleanup();
        resolve();
      }, FADE_MS + 20);                  // small margin for the CSS transition
    });
    return this._hidePromise;
  }

  /** Tear everything down (loop, listeners, GL resources, DOM). */
  dispose() {
    this._cleanup();
  }

  /* ---------------------------------------------------------- cleanup ----- */
  _cleanup() {
    if (this._cleaned) return;
    this._cleaned = true;
    this._hidden = true;
    cancelAnimationFrame(this._raf);
    clearTimeout(this._threeCheckId);
    clearTimeout(this._hideDelayId);
    this._threeCheckId = null;
    window.removeEventListener('resize', this._onResize);
    if (this._renderer) { this._renderer.dispose(); this._renderer = null; }
    if (this._scene) {
      const mats = new Set();
      this._scene.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => mats.add(m));
      });
      mats.forEach(m => { if (m.map) m.map.dispose(); m.dispose(); });
      this._scene = null;
    }
    this._portals = null;
    this._player = null;
    this._camera = null;
    if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
    this._el = null;
    this._canvas = null;
    if (this.onHide) {
      const cb = this.onHide;
      this.onHide = null;
      cb();
    }
  }
}
