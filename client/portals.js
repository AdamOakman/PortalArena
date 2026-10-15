import { AudioSys } from './audio.js';
import { PORT } from '../shared/constants.js';

/* ============================================================================
   PORTALS — state, placement logic, pair transforms, and portal visuals
   (quad, frame, glow light, sparkle particles per portal slot).
   ============================================================================ */
export function initPortals(G) {
  const { TH, V3, M4 } = G;

  function mkPortal(color) { return { placed: false, closing: false, openTime: 0, closeTime: 0, c: new V3(), n: new V3(), r: new V3(), u: new V3(), color }; }

  G.portals = [mkPortal(0x33ff33), mkPortal(0x00aa00), mkPortal(0xff5555), mkPortal(0xaa0000)];

  G.portalGroup = new TH.Group(); G.scene.add(G.portalGroup);
  G.quadMats = []; G.quads = []; G.frames = []; G.glowLights = []; G.sparkles = [];
  for (let i = 0; i < 4; i++) {
    const m = portalShaderMat(G.portals[i].color);
    G.quadMats.push(m);
    const q = new TH.Mesh(new TH.PlaneGeometry(PORT.hw * 2, PORT.hh * 2), m);
    q.renderOrder = 5; G.quads.push(q); G.portalGroup.add(q);

    const frameGrp = new TH.Group();
    const core = new TH.Mesh(new TH.TorusGeometry(1, 0.02, 8, 64), new TH.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
    const glow1 = new TH.Mesh(new TH.TorusGeometry(1, 0.08, 8, 64), new TH.MeshBasicMaterial({ color: G.portals[i].color, transparent: true, opacity: 0.8, blending: TH.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
    const glow2 = new TH.Mesh(new TH.TorusGeometry(1, 0.25, 8, 64), new TH.MeshBasicMaterial({ color: G.portals[i].color, transparent: true, opacity: 0.35, blending: TH.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
    frameGrp.add(core, glow1, glow2);
    frameGrp.scale.set(PORT.hw + 0.05, PORT.hh + 0.05, 1);
    G.frames.push(frameGrp); G.portalGroup.add(frameGrp);

    const lt = new TH.PointLight(G.portals[i].color, 13.0, 16, 1.8); G.glowLights.push(lt); G.portalGroup.add(lt);

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
        uniforms: { uColor: { value: new TH.Color(G.portals[i].color) } },
        transparent: true, blending: TH.AdditiveBlending, depthWrite: false,
        vertexShader: `attribute float life; varying float vLife; void main() { vLife = life; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = life * 12.0; }`,
        fragmentShader: `uniform vec3 uColor; varying float vLife; void main() { vec2 p = gl_PointCoord - 0.5; float d = length(p); if (d > 0.5) discard; gl_FragColor = vec4(uColor * (1.0 - d*2.0), vLife); }`
    });
    const sparkMesh = new TH.Points(sparkGeo, sparkMat);
    sparkMesh.frustumCulled = false;
    G.portalGroup.add(sparkMesh);
    G.sparkles.push({ mesh: sparkMesh, pos: sparkPos, vel: sparkVel, life: sparkLife });
  }

  function portalShaderMat(color) {
    return new TH.ShaderMaterial({
      uniforms: { uTex: { value: null }, uColor: { value: new TH.Color(color) }, uTime: { value: 0 }, uEncode: { value: 1 } },
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
          // RTs are sRGB (SRGB8_ALPHA8): sampling returns LINEAR and storing
          // re-encodes in hardware. So RT passes pass through (uEncode=0); the
          // final canvas pass has no hardware conversion and encodes here
          // (uEncode=1). One encode per view, exactly like the direct view.
          gl_FragColor = (uEncode > 0.5) ? sRGBEncode(tex.rgb) : vec4(tex.rgb, 1.0);
        }`
    });
  }

  // Pre-allocated scratch objects for frameFor / updatePair (called 128×/sec from state handler)
  const _fRef = new V3(), _fR = new V3(), _fU = new V3();
  const _fR2 = new V3(), _fU2 = new V3();
  const _mA = new M4(), _mAt = new M4(), _mB = new M4(), _mBnR = new V3(), _mBnN = new V3();
  function frameFor(n) {
    // Returns new V3 clones — only called on portal placement (infrequent), not the hot path
    if (Math.abs(n.y) > 0.98) _fRef.set(0, 0, 1); else _fRef.set(0, 1, 0);
    _fR.crossVectors(_fRef, n).normalize();
    if (_fR.lengthSq() < 1e-8) _fR.set(1, 0, 0);
    _fU.crossVectors(n, _fR);
    return { r: _fR.clone(), u: _fU.clone() };
  }

  /* pair transform matrices A->B and B->A (orthonormal rotations) — fully zero-allocation */
  G.R_AB = [new M4(), new M4()];
  G.R_BA = [new M4(), new M4()];
  function updatePair() {
    for (let idx = 0; idx < 2; idx++) {
      const offset = idx * 2;
      if (!G.portals[offset] || !G.portals[offset+1]) continue;
      // Inline frameFor(portals[offset].n) into _fR, _fU (scratch)
      const nA = G.portals[offset].n;
      if (Math.abs(nA.y) > 0.98) _fRef.set(0, 0, 1); else _fRef.set(0, 1, 0);
      _fR.crossVectors(_fRef, nA).normalize();
      if (_fR.lengthSq() < 1e-8) _fR.set(1, 0, 0);
      _fU.crossVectors(nA, _fR);
      // Inline frameFor(portals[offset+1].n) into _fR2, _fU2 (scratch)
      const nB = G.portals[offset+1].n;
      if (Math.abs(nB.y) > 0.98) _fRef.set(0, 0, 1); else _fRef.set(0, 1, 0);
      _fR2.crossVectors(_fRef, nB).normalize();
      if (_fR2.lengthSq() < 1e-8) _fR2.set(1, 0, 0);
      _fU2.crossVectors(nB, _fR2);
      // Build matrices in-place — no new M4(), no clone()
      _mBnR.copy(_fR2).multiplyScalar(-1);
      _mBnN.copy(nB).multiplyScalar(-1);
      _mA.makeBasis(_fR, _fU, nA);
      _mB.makeBasis(_mBnR, _fU2, _mBnN);
      _mAt.copy(_mA).transpose();
      G.R_AB[idx].multiplyMatrices(_mB, _mAt);
      G.R_BA[idx].copy(G.R_AB[idx]).transpose();
    }
  }

  function tryPlace(pi, hit) {
    if (hit.obb.noPortal || hit.obb.destroyed || hit.obb.kind === 'ramp') {
      AudioSys.tone(220, 120, 0.15, 'square', 0.06);
      return false;
    }
    const P = G.portals[pi];
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
    /* no overlapping placement on the same face or intersecting nearby */
    for (let i = 0; i < G.portals.length; i++) {
      if (i === pi) continue;
      const Q = G.portals[i];
      if (Q.placed) {
        const sameFace = Math.abs(n.dot(Q.n)) > 0.98 && Math.abs(c.clone().sub(Q.c).dot(n)) < 0.2;
        if (sameFace) {
          const d = c.clone().sub(Q.c);
          const du = Math.abs(d.dot(f.r)), dv = Math.abs(d.dot(f.u));
          if (du < PORT.hw * 2 + 0.35 && dv < PORT.hh * 2 + 0.35) { AudioSys.tone(220, 120, 0.15, 'square', 0.06); return false; }
        }
        if (c.distanceTo(Q.c) < Math.max(PORT.hw, PORT.hh) * 1.5) {
          AudioSys.tone(220, 120, 0.15, 'square', 0.06); return false;
        }
      }
    }
    P.placed = true; P.closing = false; P.c.copy(c); P.n.copy(n); P.r.copy(f.r); P.u.copy(f.u); P.openTime = performance.now() / 1000;
    G.Network.send({
        type: 'portal_place', pi,
        c: P.c.toArray(), n: P.n.toArray(), r: P.r.toArray(), u: P.u.toArray(),
        wallId: hit.obb.id
      });
    updatePair();
    // Immediate gun-trigger click from the player's perspective (non-positional)
    AudioSys.tone(700, 1400, 0.09, 'sine', 0.08); AudioSys.tone(1400, 2400, 0.12, 'triangle', 0.05, 0.03);
    // Positional 3-part opening sound at the portal on the wall
    AudioSys.portalOpen(c);
    return true;
  }

  /* Remove a placed portal (e.g. its wall was blown away by a rocket).
     Plays the closing animation — the inverse of the opening bounce —
     before the visuals are torn down. */
  function cancelPortal(pi, broadcast = true) {
    const P = G.portals[pi];
    if (!P.placed) return;
    P.placed = false;
    P.closing = true;
    P.closeTime = performance.now() / 1000;
    if (broadcast) G.Network.send({ type: 'portal_remove', pi });
    updatePair();
    AudioSys.portalClose(P.c);
  }

  /* ray vs all OBBs -> nearest {point, normal, obb} */
  function raycast(origin, dir, maxDist, minDist = 0.02) {
    return G.physics.raycast(origin, dir, maxDist, G.obbs, minDist);
  }

  G.frameFor = frameFor;
  G.updatePair = updatePair;
  G.tryPlace = tryPlace;
  G.cancelPortal = cancelPortal;
  G.raycast = raycast;
}
