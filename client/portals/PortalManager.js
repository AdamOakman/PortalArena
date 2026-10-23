import * as THREE from 'three';
import { AudioSys } from '../audio/AudioController.js';
import { PORT } from '../../shared/constants.js';

/**
 * PortalManager — Subsystem coordinating portal state, placement, pair transformations,
 * visual meshes (quads, frames, glow lights, sparkles), and recursive camera rendering.
 */
export class PortalManager {
  constructor(engine = null) {
    this.engine = engine;

    this.portals = [
      this._createPortal(0x33ff33), // Local portal 0 (primary)
      this._createPortal(0x00aa00), // Local portal 1 (secondary)
      this._createPortal(0xff5555), // Remote portal 0
      this._createPortal(0xaa0000)  // Remote portal 1
    ];

    this.R_AB = [new THREE.Matrix4(), new THREE.Matrix4()];
    this.R_BA = [new THREE.Matrix4(), new THREE.Matrix4()];

    // Visuals
    this.portalGroup = new THREE.Group();
    this.quadMats = [];
    this.quads = [];
    this.frames = [];
    this.glowLights = [];
    this.sparkles = [];

    // Rendering pipeline
    this.MAX_DEPTH = 4;
    this.MIN_PORTAL_PX = 32;
    this.portalRTs = [];
    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e6);
    this.vcam = new THREE.PerspectiveCamera(115, 1, 0.001, 300);
    this.vcam.matrixAutoUpdate = false;
    this.vcam.layers.enable(1);

    this.renderer = null;
    this.camera = null;
    this.scene = null;
    this.skyGroup = null;
    this.localPlayerModel = null;
    this.localPlayerCloneModel = null;

    // Shared scratch objects
    this._fRef = new THREE.Vector3();
    this._fR = new THREE.Vector3();
    this._fU = new THREE.Vector3();
    this._fR2 = new THREE.Vector3();
    this._fU2 = new THREE.Vector3();
    this._mA = new THREE.Matrix4();
    this._mAt = new THREE.Matrix4();
    this._mB = new THREE.Matrix4();
    this._mBnR = new THREE.Vector3();
    this._mBnN = new THREE.Vector3();

    this._frustum = new THREE.Frustum();
    this._projScreen = new THREE.Matrix4();
    this._sphere = new THREE.Sphere(new THREE.Vector3(), 1);
    this._T1 = new THREE.Matrix4();
    this._T2 = new THREE.Matrix4();
    this._camPool = Array.from({ length: this.MAX_DEPTH + 1 }, () => new THREE.Matrix4());
    this._posPool = Array.from({ length: this.MAX_DEPTH + 1 }, () => new THREE.Vector3());
    this._pvM = new THREE.Matrix4();

    if (this.engine && this.engine.eventBus) {
      this.engine.eventBus.on('WALL_DESTROYED', () => this.handleWallDestroyed());
    }
  }

  _createPortal(color) {
    return {
      placed: false,
      closing: false,
      openTime: 0,
      closeTime: 0,
      c: new THREE.Vector3(),
      n: new THREE.Vector3(),
      r: new THREE.Vector3(),
      u: new THREE.Vector3(),
      color
    };
  }

  _portalShaderMat(color) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: null },
        uColor: { value: new THREE.Color(color) },
        uTime: { value: 0 },
        uEncode: { value: 1 }
      },
      vertexShader: `varying vec2 vUv; varying vec4 vScreenPos; 
        void main(){ 
          vUv=uv; 
          vec4 pos = projectionMatrix*modelViewMatrix*vec4(position,1.0);
          vScreenPos = pos;
          gl_Position = pos; 
        }`,
      fragmentShader: `
        uniform sampler2D uTex; uniform vec3 uColor; uniform float uTime; uniform float uEncode;
        varying vec2 vUv; varying vec4 vScreenPos;
        vec4 sRGBEncode( vec3 value ) {
            vec3 safe = max( value, vec3( 0.0 ) );
            vec3 low = safe * 12.92;
            vec3 high = pow( safe, vec3( 0.41666 ) ) * 1.055 - vec3( 0.055 );
            return vec4( mix( high, low, step( safe, vec3( 0.0031308 ) ) ), 1.0 );
        }
        void main(){
          vec2 p = vUv*2.0-1.0;
          float e = length(p);
          if(e>1.0) discard;

          vec2 screenUv = (vScreenPos.xy / vScreenPos.w) * 0.5 + 0.5;
          vec4 tex = texture2D(uTex, screenUv);
          gl_FragColor = (uEncode > 0.5) ? sRGBEncode(tex.rgb) : vec4(tex.rgb, 1.0);
        }`
    });
  }

  /**
   * Create quads, frames, glow lights, and sparkles, adding them to scene.
   * @param {THREE.Scene} scene
   */
  initVisuals(scene) {
    this.scene = scene;
    scene.add(this.portalGroup);

    this.quadMats = [];
    this.quads = [];
    this.frames = [];
    this.glowLights = [];
    this.sparkles = [];

    for (let i = 0; i < 4; i++) {
      const m = this._portalShaderMat(this.portals[i].color);
      this.quadMats.push(m);
      const q = new THREE.Mesh(new THREE.PlaneGeometry(PORT.hw * 2, PORT.hh * 2), m);
      q.renderOrder = 5;
      this.quads.push(q);
      this.portalGroup.add(q);

      const frameGrp = new THREE.Group();
      const core = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.02, 8, 64),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
      );
      const glow1 = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.08, 8, 64),
        new THREE.MeshBasicMaterial({ color: this.portals[i].color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
      );
      const glow2 = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.25, 8, 64),
        new THREE.MeshBasicMaterial({ color: this.portals[i].color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
      );
      frameGrp.add(core, glow1, glow2);
      frameGrp.scale.set(PORT.hw + 0.05, PORT.hh + 0.05, 1);
      this.frames.push(frameGrp);
      this.portalGroup.add(frameGrp);

      const lt = new THREE.PointLight(this.portals[i].color, 13.0, 16, 1.8);
      lt.layers.enable(2);
      this.glowLights.push(lt);
      this.portalGroup.add(lt);

      const sparkGeo = new THREE.BufferGeometry();
      const sparkPos = new Float32Array(300);
      const sparkVel = [];
      const sparkLife = new Float32Array(100);
      for (let j = 0; j < 100; j++) {
        sparkPos[j * 3] = 0;
        sparkPos[j * 3 + 1] = 0;
        sparkPos[j * 3 + 2] = 0;
        sparkVel.push(new THREE.Vector3());
        sparkLife[j] = 0;
      }
      sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
      sparkGeo.setAttribute('life', new THREE.BufferAttribute(sparkLife, 1));
      const sparkMat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(this.portals[i].color) } },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        vertexShader: `attribute float life; varying float vLife; void main() { vLife = life; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition; gl_PointSize = clamp((life * 80.0) / max(0.1, -mvPosition.z), 1.0, 100.0); }`,
        fragmentShader: `uniform vec3 uColor; varying float vLife; void main() { vec2 p = gl_PointCoord - 0.5; float d = length(p); if (d > 0.5) discard; gl_FragColor = vec4(uColor * (1.0 - d*2.0), vLife); }`
      });
      const sparkMesh = new THREE.Points(sparkGeo, sparkMat);
      sparkMesh.frustumCulled = false;
      this.portalGroup.add(sparkMesh);
      this.sparkles.push({ mesh: sparkMesh, pos: sparkPos, vel: sparkVel, life: sparkLife });
    }
  }

  /**
   * Construct or resize WebGL Render Targets for recursive views.
   * @param {number} width
   * @param {number} height
   */
  makeRTs(width = null, height = null) {
    const w = Math.max(256, Math.floor((width || window.innerWidth) * 0.7));
    const h = Math.max(256, Math.floor((height || window.innerHeight) * 0.7));
    for (let d = 0; d < this.MAX_DEPTH; d++) {
      const dw = Math.max(64, Math.floor(w / (d + 1)));
      const dh = Math.max(64, Math.floor(h / (d + 1)));
      if (!this.portalRTs[d]) this.portalRTs[d] = [null, null, null, null];
      for (let i = 0; i < 4; i++) {
        if (this.portalRTs[d][i]) this.portalRTs[d][i].dispose();
        this.portalRTs[d][i] = new THREE.WebGLRenderTarget(dw, dh, {
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          colorSpace: THREE.SRGBColorSpace
        });
      }
    }
  }

  /**
   * Initialize portal rendering pipeline.
   */
  initRendering(ctx) {
    this.renderer = ctx.renderer;
    this.camera = ctx.camera;
    this.scene = ctx.scene;
    this.skyGroup = ctx.skyGroup;
    this.engine = ctx.engine || this.engine;
    if (ctx.playerModel) this.localPlayerModel = ctx.playerModel;
    if (ctx.playerCloneModel) this.localPlayerCloneModel = ctx.playerCloneModel;
    this.renderer.clippingPlanes = [this.clipPlane];
    this.makeRTs(ctx.innerWidth, ctx.innerHeight);
  }

  /**
   * Reset clipping plane to inactive position.
   */
  parkClip() {
    this.clipPlane.normal.set(0, 1, 0);
    this.clipPlane.constant = 1e6;
  }

  /**
   * Compute reference basis { r, u } for a normal.
   * @param {THREE.Vector3} n
   */
  frameFor(n) {
    if (Math.abs(n.y) > 0.98) this._fRef.set(0, 0, 1);
    else this._fRef.set(0, 1, 0);
    this._fR.crossVectors(this._fRef, n).normalize();
    if (this._fR.lengthSq() < 1e-8) this._fR.set(1, 0, 0);
    this._fU.crossVectors(n, this._fR);
    return { r: this._fR.clone(), u: this._fU.clone() };
  }

  /**
   * Update pair rotation matrices for local (0, 1) and remote (2, 3) portals.
   */
  updatePair() {
    for (let idx = 0; idx < 2; idx++) {
      const offset = idx * 2;
      if (!this.portals[offset] || !this.portals[offset + 1]) continue;

      const nA = this.portals[offset].n;
      if (Math.abs(nA.y) > 0.98) this._fRef.set(0, 0, 1);
      else this._fRef.set(0, 1, 0);
      this._fR.crossVectors(this._fRef, nA).normalize();
      if (this._fR.lengthSq() < 1e-8) this._fR.set(1, 0, 0);
      this._fU.crossVectors(nA, this._fR);

      const nB = this.portals[offset + 1].n;
      if (Math.abs(nB.y) > 0.98) this._fRef.set(0, 0, 1);
      else this._fRef.set(0, 1, 0);
      this._fR2.crossVectors(this._fRef, nB).normalize();
      if (this._fR2.lengthSq() < 1e-8) this._fR2.set(1, 0, 0);
      this._fU2.crossVectors(nB, this._fR2);

      this._mBnR.copy(this._fR2).multiplyScalar(-1);
      this._mBnN.copy(nB).multiplyScalar(-1);
      this._mA.makeBasis(this._fR, this._fU, nA);
      this._mB.makeBasis(this._mBnR, this._fU2, this._mBnN);
      this._mAt.copy(this._mA).transpose();
      this.R_AB[idx].multiplyMatrices(this._mB, this._mAt);
      this.R_BA[idx].copy(this.R_AB[idx]).transpose();
    }
  }

  updatePairs() {
    this.updatePair();
  }

  /**
   * Try to place a portal on a surface hit.
   * @param {number} pi - Portal index (0..3)
   * @param {Object} hit - Raycast hit result
   * @param {Object} context - Game context fallback
   */
  tryPlace(pi, hit, context = null) {
    const G = context || this.engine?.context || window.__GAME_CONTEXT__;
    if (hit.obb.noPortal || hit.obb.destroyed || hit.obb.kind === 'ramp') {
      AudioSys.tone(220, 120, 0.15, 'square', 0.06);
      return false;
    }

    const P = this.portals[pi];
    const n = hit.normal.clone().normalize();
    const f = this.frameFor(n);

    const physics = G?.physics || this.engine?.physics;
    const obbs = G?.obbs || [];
    const lavaPools = G?.lavaPools || [];
    const destroyedWallObbs = G?.destroyedWallObbs || [];
    const destroyedWalls = G?.destroyedWalls || [];

    const validPlacement = physics?.findClosestValidPortalPos(
      hit.point, n, f.r, f.u, hit.obb, pi,
      obbs, this.portals, lavaPools, destroyedWallObbs, destroyedWalls
    );

    if (!validPlacement) {
      AudioSys.tone(220, 120, 0.15, 'square', 0.06);
      return false;
    }

    const c = validPlacement.c;
    P.placed = true;
    P.closing = false;
    P.c.copy(c);
    P.n.copy(n);
    P.r.copy(f.r);
    P.u.copy(f.u);
    P.openTime = performance.now() / 1000;

    const network = G?.Network || this.engine?.network;
    if (network) {
      network.send({
        type: 'portal_place',
        pi,
        c: P.c.toArray(),
        n: P.n.toArray(),
        r: P.r.toArray(),
        u: P.u.toArray(),
        wallId: hit.obb.id
      });
    }

    this.updatePair();
    AudioSys.tone(700, 1400, 0.09, 'sine', 0.08);
    AudioSys.tone(1400, 2400, 0.12, 'triangle', 0.05, 0.03);
    AudioSys.portalOpen(c);
    return true;
  }

  /**
   * Cancel or remove a placed portal.
   * @param {number} pi - Portal index
   * @param {boolean} broadcast - Send network packet
   * @param {Object} context - Game context fallback
   */
  cancelPortal(pi, broadcast = true, context = null) {
    const P = this.portals[pi];
    if (!P.placed) return;

    P.placed = false;
    P.closing = true;
    P.closeTime = performance.now() / 1000;

    const G = context || this.engine?.context || window.__GAME_CONTEXT__;
    const network = G?.Network || this.engine?.network;
    if (broadcast && network) {
      network.send({ type: 'portal_remove', pi });
    }

    this.updatePair();
    AudioSys.portalClose(P.c);
  }

  /**
   * Raycast against map colliders.
   */
  raycast(origin, dir, maxDist, minDist = 0.02, context = null) {
    const G = context || this.engine?.context || window.__GAME_CONTEXT__;
    const physics = G?.physics || this.engine?.physics;
    const obbs = G?.obbs || [];
    return physics ? physics.raycast(origin, dir, maxDist, obbs, minDist) : null;
  }

  _isLive(P) {
    return P.placed || P.closing;
  }

  /**
   * Recursively render portal views into render targets.
   */
  renderPortalRecursive(i, parentCamMatrix, depth) {
    const pairIdx = Math.floor(i / 2);
    const qIdx = i % 2 === 0 ? i + 1 : i - 1;
    const P = this.portals[i], Q = this.portals[qIdx];

    const _camMatrix = this._camPool[depth];
    const _parentPos = this._posPool[depth];

    this.vcam.matrixWorld.copy(parentCamMatrix);
    this.vcam.matrixWorldInverse.copy(parentCamMatrix).invert();
    this.vcam.fov = this.camera.fov;
    this.vcam.aspect = this.camera.aspect;
    this.vcam.updateProjectionMatrix();

    _parentPos.setFromMatrixPosition(parentCamMatrix);
    const dot = (_parentPos.x - P.c.x) * P.n.x + (_parentPos.y - P.c.y) * P.n.y + (_parentPos.z - P.c.z) * P.n.z;
    if (dot <= 0.0001) return null;

    if (depth > 0) {
      const dCam = _parentPos.distanceTo(P.c);
      const pxH = (PORT.hh / (dCam * Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5)))) * window.innerHeight;
      if (pxH < this.MIN_PORTAL_PX) return null;
    }

    this._projScreen.multiplyMatrices(this.vcam.projectionMatrix, this.vcam.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._projScreen);
    this._sphere.center.copy(P.c);
    this._sphere.radius = Math.hypot(PORT.hw, PORT.hh) + 0.5;
    if (!this._frustum.intersectsSphere(this._sphere)) return null;

    const R = i % 2 === 0 ? this.R_AB[pairIdx] : this.R_BA[pairIdx];
    if (!R) return null;

    this._T1.makeTranslation(-P.c.x, -P.c.y, -P.c.z);
    this._T2.makeTranslation(Q.c.x, Q.c.y, Q.c.z);
    _camMatrix.multiplyMatrices(this._T1, parentCamMatrix);
    _camMatrix.premultiply(R);
    _camMatrix.premultiply(this._T2);

    const texs = [null, null, null, null];
    if (depth < PORT.recursion) {
      for (let j = 0; j < 4; j++) {
        if (this._isLive(this.portals[j]) && this._isLive(this.portals[j % 2 === 0 ? j + 1 : j - 1])) {
          texs[j] = this.renderPortalRecursive(j, _camMatrix, depth + 1);
        }
      }
    }

    this.vcam.matrixAutoUpdate = false;
    this.vcam.matrixWorld.copy(_camMatrix);
    this.vcam.matrixWorldInverse.copy(_camMatrix).invert();
    this.vcam.fov = this.camera.fov;
    this.vcam.aspect = this.camera.aspect;
    this.vcam.updateProjectionMatrix();

    const dP = (_parentPos.x - P.c.x) * P.n.x + (_parentPos.y - P.c.y) * P.n.y + (_parentPos.z - P.c.z) * P.n.z;
    if (Math.abs(dP) > 0.0001) {
      const s = dP >= 0 ? 1 : -1;
      this.clipPlane.normal.copy(Q.n).multiplyScalar(s);
      this.clipPlane.constant = -s * Q.n.dot(Q.c) + 0.005;
    } else {
      this.parkClip();
    }

    const exitIdx = qIdx;
    const oldVis = [];
    if (this.skyGroup) {
      this.skyGroup.position.setFromMatrixPosition(_camMatrix);
    }
    const vcamPos = this.skyGroup ? this.skyGroup.position : _parentPos;

    for (let j = 0; j < 4; j++) {
      oldVis[j] = {
        frame: this.frames[j] ? this.frames[j].visible : false,
        spark: this.sparkles[j] && this.sparkles[j].mesh ? this.sparkles[j].mesh.visible : false,
        quad: this.quads[j] ? this.quads[j].visible : false,
        light: this.glowLights[j] ? this.glowLights[j].intensity : 0
      };
      if (j === exitIdx) {
        if (this.frames[j]) this.frames[j].visible = false;
        if (this.sparkles[j] && this.sparkles[j].mesh) this.sparkles[j].mesh.visible = false;
        if (this.quads[j]) this.quads[j].visible = false;
        if (this.glowLights[j]) this.glowLights[j].intensity = 0;
      } else {
        const pj = this.portals[j];
        if (this._isLive(pj)) {
          const vdot = (vcamPos.x - pj.c.x) * pj.n.x + (vcamPos.y - pj.c.y) * pj.n.y + (vcamPos.z - pj.c.z) * pj.n.z;
          const vFacing = vdot > 0.0001;
          if (this.frames[j]) this.frames[j].visible = vFacing;
          if (this.sparkles[j] && this.sparkles[j].mesh) this.sparkles[j].mesh.visible = vFacing;
          if (this.quads[j]) this.quads[j].visible = vFacing && (texs[j] !== null);
          if (this.glowLights[j]) this.glowLights[j].intensity = vFacing ? 13.0 : 0;
        } else {
          if (this.frames[j]) this.frames[j].visible = false;
          if (this.sparkles[j] && this.sparkles[j].mesh) this.sparkles[j].mesh.visible = false;
          if (this.quads[j]) this.quads[j].visible = false;
          if (this.glowLights[j]) this.glowLights[j].intensity = 0;
        }
      }
    }

    for (let j = 0; j < 4; j++) {
      if (this.quadMats[j]) this.quadMats[j].uniforms.uTex.value = texs[j];
    }

    const rt = this.portalRTs[depth][i];
    this.renderer.setRenderTarget(rt);
    this.renderer.clear();

    for (let j = 0; j < 4; j++) {
      if (this.quadMats[j]) this.quadMats[j].uniforms.uEncode.value = 0;
    }

    // Local player portal transition avatar handling:
    // When depth === 0 (direct first-person view into portal i), if the transition clone
    // is placed at exit portal Q (where vcam is currently located), hide it during this pass
    // so vcam does not render the clone attached to its own lens when looking down or through
    // the entrance portal.
    // When looking across the room at exit portal B, this.camera renders playerCloneModel on
    // layer 0 emerging from portal B starting from the gun rifle.
    // Deeper recursive views (depth > 0) render normally so recursive copies/reflections remain visible.
    const G = this.engine?.context || (typeof window !== 'undefined' ? window.__GAME_CONTEXT__ : null);
    const localClone = this.localPlayerCloneModel || G?.playerCloneModel || G?.playerModel?.userData?.cloneMesh || (typeof window !== 'undefined' ? window.playerCloneModel : null);
    const localModel = this.localPlayerModel || G?.playerModel || (typeof window !== 'undefined' ? window.playerModel : null);
    const trans = localModel?.userData?.portalTransition;
    let restoreCloneVis = null;

    if (depth === 0 && localClone && localClone.visible) {
      if (trans?.inPortal && trans.targetQ === Q) {
        restoreCloneVis = localClone.visible;
        localClone.visible = false;
      }
    }

    this.renderer.render(this.scene, this.vcam);

    if (restoreCloneVis !== null && localClone) {
      localClone.visible = restoreCloneVis;
    }

    for (let j = 0; j < 4; j++) {
      if (this.frames[j]) this.frames[j].visible = oldVis[j].frame;
      if (this.sparkles[j] && this.sparkles[j].mesh) this.sparkles[j].mesh.visible = oldVis[j].spark;
      if (this.quads[j]) this.quads[j].visible = oldVis[j].quad;
      if (this.glowLights[j]) this.glowLights[j].intensity = oldVis[j].light;
    }

    return rt.texture;
  }

  /**
   * Render portal camera textures for all active pairs.
   */
  renderPortalViews() {
    const texs = [null, null, null, null];
    for (let i = 0; i < 4; i++) {
      const qIdx = i % 2 === 0 ? i + 1 : i - 1;
      if (this._isLive(this.portals[i]) && this._isLive(this.portals[qIdx])) {
        texs[i] = this.renderPortalRecursive(i, this.camera.matrixWorld, 0);
      }
    }
    this.parkClip();
    for (let i = 0; i < 4; i++) {
      if (this.quadMats[i]) {
        this.quadMats[i].uniforms.uTex.value = texs[i];
        this.quadMats[i].uniforms.uEncode.value = 1;
        const P = this.portals[i];
        const dot = (this.camera.position.x - P.c.x) * P.n.x + (this.camera.position.y - P.c.y) * P.n.y + (this.camera.position.z - P.c.z) * P.n.z;
        this.quads[i].visible = this._isLive(P) && (dot > 0.0001) && (texs[i] !== null);
      }
    }
  }

  /**
   * Update visual orientations and facing states.
   */
  placePortalVisuals() {
    if (!this.camera || !this.quads || this.quads.length === 0) return;
    const camPos = this.camera.position;
    for (let i = 0; i < 4; i++) {
      const P = this.portals ? this.portals[i] : null;
      if (!P || !this._isLive(P)) {
        if (this.quads && this.quads[i]) this.quads[i].visible = false;
        if (this.frames && this.frames[i]) this.frames[i].visible = false;
        if (this.glowLights && this.glowLights[i]) this.glowLights[i].intensity = 0;
        if (this.sparkles && this.sparkles[i] && this.sparkles[i].mesh) this.sparkles[i].mesh.visible = false;
        continue;
      }
      const dot = (camPos.x - P.c.x) * P.n.x + (camPos.y - P.c.y) * P.n.y + (camPos.z - P.c.z) * P.n.z;
      const isFacing = dot > 0.0001;

      if (this.frames && this.frames[i]) this.frames[i].visible = isFacing;
      if (this.sparkles && this.sparkles[i] && this.sparkles[i].mesh) this.sparkles[i].mesh.visible = isFacing;
      const q = this.quads ? this.quads[i] : null;
      const f = this.frames ? this.frames[i] : null;
      const lt = this.glowLights ? this.glowLights[i] : null;
      if (q && f && lt) {
        this._pvM.makeBasis(P.r, P.u, P.n);
        this._pvM.setPosition(P.c);
        q.quaternion.setFromRotationMatrix(this._pvM);
        q.position.copy(P.c);
        f.quaternion.copy(q.quaternion);
        f.position.copy(P.c).addScaledVector(P.n, 0.02);
        lt.position.copy(P.c).addScaledVector(P.n, 0.35);
        lt.color.setHex(P.color);
        if (isFacing) {
          if (lt.intensity === 0) lt.intensity = 13.0;
        } else {
          lt.intensity = 0;
        }
        if (this.sparkles && this.sparkles[i] && this.sparkles[i].mesh) {
          this.sparkles[i].mesh.quaternion.copy(q.quaternion);
          this.sparkles[i].mesh.position.copy(P.c).addScaledVector(P.n, 0.02);
        }
      }
    }
  }

  /**
   * Reset all portals.
   */
  reset() {
    for (const p of this.portals) {
      p.placed = false;
      p.closing = false;
    }
    this.updatePairs();
  }

  /**
   * Handle wall destroyed event by checking if anchored portals must close.
   */
  handleWallDestroyed() {
    if (this.engine && this.engine.worldManager) {
      for (const p of this.portals) {
        if (p.placed && this.engine.worldManager.isPortalOnDestroyedWall(p.c, p.n, p.r, p.u)) {
          p.placed = false;
        }
      }
      this.updatePairs();
    }
  }

  get isPairActive() {
    return this.portals[0].placed && this.portals[1].placed;
  }
}

/**
 * Procedural backward compatibility wrapper for portals state and visuals.
 */
export function initPortals(G) {
  const manager = G.portalManager || new PortalManager(G.engine || null);
  G.portalManager = manager;
  manager.initVisuals(G.scene);

  G.portals = manager.portals;
  G.portalGroup = manager.portalGroup;
  G.quadMats = manager.quadMats;
  G.quads = manager.quads;
  G.frames = manager.frames;
  G.glowLights = manager.glowLights;
  G.sparkles = manager.sparkles;
  G.R_AB = manager.R_AB;
  G.R_BA = manager.R_BA;

  G.frameFor = (n) => manager.frameFor(n);
  G.updatePair = () => manager.updatePair();
  G.tryPlace = (pi, hit) => manager.tryPlace(pi, hit, G);
  G.cancelPortal = (pi, broadcast) => manager.cancelPortal(pi, broadcast, G);
  G.raycast = (origin, dir, maxDist, minDist) => manager.raycast(origin, dir, maxDist, minDist, G);

  return manager;
}

/**
 * Procedural backward compatibility wrapper for portal recursive rendering.
 */
export function initPortalRendering(ctx, fallbackG = null) {
  const manager = ctx.portalManager || fallbackG?.portalManager || (typeof window !== 'undefined' && window.__GAME_CONTEXT__?.portalManager) || new PortalManager(ctx.engine || fallbackG?.engine || null);
  if (ctx.portalManager) ctx.portalManager = manager;
  if (fallbackG) fallbackG.portalManager = manager;
  if (ctx.portals && (!manager.portals || manager.portals.length === 0)) manager.portals = ctx.portals;
  if (ctx.quads && (!manager.quads || manager.quads.length === 0)) manager.quads = ctx.quads;
  if (ctx.frames && (!manager.frames || manager.frames.length === 0)) manager.frames = ctx.frames;
  if (ctx.sparkles && (!manager.sparkles || manager.sparkles.length === 0)) manager.sparkles = ctx.sparkles;
  if (ctx.glowLights && (!manager.glowLights || manager.glowLights.length === 0)) manager.glowLights = ctx.glowLights;
  if (ctx.quadMats && (!manager.quadMats || manager.quadMats.length === 0)) manager.quadMats = ctx.quadMats;
  if (ctx.R_AB) manager.R_AB = ctx.R_AB;
  if (ctx.R_BA) manager.R_BA = ctx.R_BA;
  manager.initRendering(ctx);

  return {
    portalManager: manager,
    renderPortalViews: () => manager.renderPortalViews(),
    placePortalVisuals: () => manager.placePortalVisuals(),
    parkClip: () => manager.parkClip(),
    makeRTs: (w, h) => manager.makeRTs(w, h)
  };
}

// Scratch matrices for portal transition calculations
const _T1_trans = new THREE.Matrix4();
const _T2_trans = new THREE.Matrix4();
const _M_trans = new THREE.Matrix4();
const _cloneMat_trans = new THREE.Matrix4();

/**
 * Coordinate portal transition clipping and visual exit clone for a player avatar.
 *
 * @param {THREE.Object3D} mesh - The main 3D player mesh.
 * @param {THREE.Object3D} cloneMesh - The duplicated 3D player mesh appearing at the exit portal.
 * @param {THREE.Plane} clipPlane - The clipping plane applied to the primary player mesh.
 * @param {THREE.Plane} cloneClipPlane - The clipping plane applied to the exit clone mesh.
 * @param {THREE.Vector3|number[]} pos - Player position.
 * @param {Array} portals - Array of placed portals.
 * @param {THREE.Matrix4[]} R_AB - Forward transition rotation matrices.
 * @param {THREE.Matrix4[]} R_BA - Backward transition rotation matrices.
 */
export function updatePortalTransition(mesh, cloneMesh, clipPlane, cloneClipPlane, pos, portals, R_AB, R_BA) {
  if (!mesh || !cloneMesh || !clipPlane || !cloneClipPlane) return { inPortal: false };

  const posX = Array.isArray(pos) ? pos[0] : (pos ? pos.x : mesh.position.x);
  const posY = Array.isArray(pos) ? pos[1] : (pos ? pos.y : mesh.position.y);
  const posZ = Array.isArray(pos) ? pos[2] : (pos ? pos.z : mesh.position.z);

  // Synchronize internal child parts (crouch, headGroup, mirror guns) from mesh to cloneMesh
  const cCloneBody = cloneMesh.children.find(c => c.name === 'bodyMesh');
  const cBody = mesh.children.find(c => c.name === 'bodyMesh');
  if (cCloneBody && cBody) {
    cCloneBody.scale.copy(cBody.scale);
    cCloneBody.position.copy(cBody.position);
  }

  if (cloneMesh.userData?.headGroup && mesh.userData?.headGroup) {
    cloneMesh.userData.headGroup.rotation.x = mesh.userData.headGroup.rotation.x;
    cloneMesh.userData.headGroup.position.y = mesh.userData.headGroup.position.y;
  }

  if (cloneMesh.userData?.mirrorGun && mesh.userData?.mirrorGun) {
    cloneMesh.userData.mirrorGun.visible = mesh.userData.mirrorGun.visible;
    cloneMesh.userData.mirrorRocketGun.visible = mesh.userData.mirrorRocketGun.visible;
    if (cloneMesh.userData.mirrorInstagibGun && mesh.userData.mirrorInstagibGun) {
      cloneMesh.userData.mirrorInstagibGun.visible = mesh.userData.mirrorInstagibGun.visible;
    }

    const mg = mesh.userData.mirrorGun;
    const mrg = mesh.userData.mirrorRocketGun;
    const mig = mesh.userData.mirrorInstagibGun;
    const cmg = cloneMesh.userData.mirrorGun;
    const cmrg = cloneMesh.userData.mirrorRocketGun;
    const cmig = cloneMesh.userData.mirrorInstagibGun;

    if (cmg && mg) {
      cmg.scale.copy(mg.scale);
      cmg.position.copy(mg.position);
      cmg.rotation.copy(mg.rotation);
      if (cmg.userData?.core?.material && mg.userData?.core?.material) {
        cmg.userData.core.material.color.copy(mg.userData.core.material.color);
        cmg.userData.core.material.emissive.copy(mg.userData.core.material.emissive);
        cmg.userData.core.material.emissiveIntensity = mg.userData.core.material.emissiveIntensity;
      }
      if (cmg.userData?.ring?.material && mg.userData?.ring?.material) {
        cmg.userData.ring.material.color.copy(mg.userData.ring.material.color);
        cmg.userData.ring.material.emissive.copy(mg.userData.ring.material.emissive);
        cmg.userData.ring.material.emissiveIntensity = mg.userData.ring.material.emissiveIntensity;
      }
    }
    if (cmrg && mrg) { cmrg.scale.copy(mrg.scale); cmrg.position.copy(mrg.position); cmrg.rotation.copy(mrg.rotation); }
    if (cmig && mig) { cmig.scale.copy(mig.scale); cmig.position.copy(mig.position); cmig.rotation.copy(mig.rotation); }
  }

  let inPortal = false;
  let targetP = null;
  let targetQ = null;
  let targetR = null;
  if (mesh.visible && portals && R_AB && R_BA) {
    let bestDist = 3.5;

    for (let pairIdx = 0; pairIdx < 2; pairIdx++) {
      const offset = pairIdx * 2;
      const p0 = portals[offset];
      const p1 = portals[offset + 1];
      if (!p0 || !p1 || !p0.placed || !p1.placed) continue;

      for (let pi = 0; pi < 2; pi++) {
        const P = pi === 0 ? p0 : p1;
        const Q = pi === 0 ? p1 : p0;
        const R = pi === 0 ? R_AB[pairIdx] : R_BA[pairIdx];
        if (!R) continue;

        const dx = posX - P.c.x;
        const dy = posY - P.c.y;
        const dz = posZ - P.c.z;
        const dn = dx * P.n.x + dy * P.n.y + dz * P.n.z;
        const du = Math.abs(dx * P.r.x + dy * P.r.y + dz * P.r.z);
        const dv = Math.abs(dx * P.u.x + dy * P.u.y + dz * P.u.z);

        // Check if player or outstretched weapon is within transition zone of portal P
        if (dn >= -0.8 && dn <= 2.5 && du <= PORT.hw + 0.6 && dv <= PORT.hh + 0.6) {
          const dCenter = Math.hypot(dx, dy, dz);
          if (dCenter < bestDist) {
            bestDist = dCenter;
            targetP = P;
            targetQ = Q;
            targetR = R;
            inPortal = true;
          }
        }
      }
    }

    if (inPortal && targetP && targetQ && targetR) {
      clipPlane.normal.copy(targetP.n);
      clipPlane.constant = -targetP.n.dot(targetP.c);

      cloneClipPlane.normal.copy(targetQ.n);
      cloneClipPlane.constant = -targetQ.n.dot(targetQ.c);

      mesh.updateMatrixWorld(true);

      _T1_trans.makeTranslation(-targetP.c.x, -targetP.c.y, -targetP.c.z);
      _T2_trans.makeTranslation(targetQ.c.x, targetQ.c.y, targetQ.c.z);
      _M_trans.multiplyMatrices(targetR, _T1_trans);
      _M_trans.premultiply(_T2_trans);

      _cloneMat_trans.multiplyMatrices(_M_trans, mesh.matrixWorld);
      _cloneMat_trans.decompose(cloneMesh.position, cloneMesh.quaternion, cloneMesh.scale);
      cloneMesh.updateMatrixWorld(true);
      cloneMesh.visible = true;
    }
  }

  if (!inPortal) {
    cloneMesh.visible = false;
    clipPlane.normal.set(0, 1, 0);
    clipPlane.constant = 1e6;
    cloneClipPlane.normal.set(0, 1, 0);
    cloneClipPlane.constant = 1e6;
  }

  const transitionState = { inPortal, targetP, targetQ, targetR };
  if (mesh.userData) {
    mesh.userData.portalTransition = transitionState;
  }
  return transitionState;
}

PortalManager.updatePortalTransition = updatePortalTransition;
