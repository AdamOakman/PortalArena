export function initPortalRendering(ctx) {
  const { TH, innerWidth, innerHeight, renderer, camera, scene, portals, PORT, R_AB, R_BA, frames, sparkles, quads, quadMats, glowLights, skyGroup } = ctx;
  const V3 = TH.Vector3;
  const M4 = TH.Matrix4;

  const MAX_DEPTH = 4;
  const portalRTs = [];
  function makeRTs() {
    const w = Math.max(256, Math.floor(innerWidth * 0.7)), h = Math.max(256, Math.floor(innerHeight * 0.7));
    for (let d = 0; d < MAX_DEPTH; d++) {
      const dw = Math.max(64, Math.floor(w / (d + 1)));
      const dh = Math.max(64, Math.floor(h / (d + 1)));
      if (!portalRTs[d]) portalRTs[d] = [null, null, null, null];
      for (let i = 0; i < 4; i++) {
        if (portalRTs[d][i]) portalRTs[d][i].dispose();
        portalRTs[d][i] = new TH.WebGLRenderTarget(dw, dh, { minFilter: TH.LinearFilter, magFilter: TH.LinearFilter, colorSpace: TH.SRGBColorSpace });
      }
    }
  }
  makeRTs();

  const clipPlane = new TH.Plane(new V3(0, 1, 0), 1e6);
  renderer.clippingPlanes = [clipPlane];

  const vcam = new TH.PerspectiveCamera(115, 1, 0.02, 300);
  vcam.matrixAutoUpdate = false;
  vcam.layers.enable(1);

  const _frustum = new TH.Frustum(), _projScreen = new M4();

  // --- Scratch objects that are SAFE to share across recursion levels
  //     (only used before recursive calls within the same invocation)
  const _sphere = new TH.Sphere(new V3(), 1); // frustum test — read before any recursion
  const _T1 = new M4(), _T2 = new M4();       // used to build camMatrix — read before recursion

  // --- Per-depth scratch objects: these are read AFTER recursive calls return,
  //     so each recursion level needs its own slot (MAX_DEPTH + 1 slots = 0..4)
  const _camPool  = Array.from({ length: MAX_DEPTH + 1 }, () => new M4()); // virtual cam matrix
  const _posPool  = Array.from({ length: MAX_DEPTH + 1 }, () => new V3()); // parent cam position

  // Scratch for placePortalVisuals — called at 60 Hz, completely safe to share (non-recursive)
  const _pvM = new M4();

  function parkClip() { clipPlane.normal.set(0, 1, 0); clipPlane.constant = 1e6; }

  function renderPortalRecursive(i, parentCamMatrix, depth) {
    const pairIdx = Math.floor(i / 2);
    const qIdx = i % 2 === 0 ? i + 1 : i - 1;
    const P = portals[i], Q = portals[qIdx];

    // Use depth-specific scratch so recursive calls don't clobber our values
    const _camMatrix = _camPool[depth];
    const _parentPos = _posPool[depth];

    vcam.matrixWorld.copy(parentCamMatrix);
    vcam.matrixWorldInverse.copy(parentCamMatrix).invert();
    vcam.fov = camera.fov; vcam.aspect = camera.aspect;
    vcam.updateProjectionMatrix();

    _parentPos.setFromMatrixPosition(parentCamMatrix); // depth-specific — safe after recursion
    const dot = (_parentPos.x - P.c.x) * P.n.x + (_parentPos.y - P.c.y) * P.n.y + (_parentPos.z - P.c.z) * P.n.z;
    if (dot <= 0.01) return null;

    _projScreen.multiplyMatrices(vcam.projectionMatrix, vcam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);
    _sphere.center.copy(P.c);
    _sphere.radius = Math.hypot(PORT.hw, PORT.hh) + 0.5;
    if (!_frustum.intersectsSphere(_sphere)) return null;

    const R = i % 2 === 0 ? R_AB[pairIdx] : R_BA[pairIdx];
    if (!R) return null;

    // Build: _camPool[depth] = T2 * R * T1 * parentCamMatrix
    // _T1/_T2 are shared but only read before the recursive call — safe
    _T1.makeTranslation(-P.c.x, -P.c.y, -P.c.z);
    _T2.makeTranslation(Q.c.x, Q.c.y, Q.c.z);
    _camMatrix.multiplyMatrices(_T1, parentCamMatrix); // T1 * parent
    _camMatrix.premultiply(R);                          // R * T1 * parent
    _camMatrix.premultiply(_T2);                        // T2 * R * T1 * parent

    // Recurse — inner calls write to _camPool[depth+1] and _posPool[depth+1],
    // leaving _camPool[depth] and _posPool[depth] intact
    const texs = [null, null, null, null];
    if (depth < PORT.recursion) {
      for (let j = 0; j < 4; j++) {
        if (portals[j].placed && portals[j % 2 === 0 ? j + 1 : j - 1].placed) {
          texs[j] = renderPortalRecursive(j, _camMatrix, depth + 1);
        }
      }
    }

    // Re-set vcam from our depth-specific _camMatrix (inner calls restored nothing, so we must re-set)
    vcam.matrixAutoUpdate = false;
    vcam.matrixWorld.copy(_camMatrix);
    vcam.matrixWorldInverse.copy(_camMatrix).invert();
    vcam.fov = camera.fov; vcam.aspect = camera.aspect;
    vcam.updateProjectionMatrix();

    // _parentPos is depth-specific — still holds the correct value from before recursion
    const dP = (_parentPos.x - P.c.x) * P.n.x + (_parentPos.y - P.c.y) * P.n.y + (_parentPos.z - P.c.z) * P.n.z;
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

    // RT target is sRGB (hardware encodes on store) — quads must output linear here
    for (let j = 0; j < 4; j++) {
      if (quadMats[j]) quadMats[j].uniforms.uEncode.value = 0;
    }

    skyGroup.position.setFromMatrixPosition(_camMatrix);
    renderer.render(scene, vcam);

    frames[exitIdx].visible = oldFrameVis;
    sparkles[exitIdx].mesh.visible = oldSparkVis;
    quads[exitIdx].visible = oldQuadVis;

    return rt.texture;
  }

  function renderPortalViews() {
    const texs = [null, null, null, null];
    for (let i = 0; i < 4; i++) {
      const qIdx = i % 2 === 0 ? i + 1 : i - 1;
      if (portals[i].placed && portals[qIdx].placed) {
        texs[i] = renderPortalRecursive(i, camera.matrixWorld, 0);
      }
    }
    parkClip();
    for (let i = 0; i < 4; i++) {
      if (quadMats[i]) {
        quadMats[i].uniforms.uTex.value = texs[i];
        // canvas pass follows: default framebuffer has no hardware conversion,
        // so the quad must do the final linear→sRGB encode itself
        quadMats[i].uniforms.uEncode.value = 1;
        quads[i].visible = portals[i].placed;
      }
    }
  }

  function placePortalVisuals() {
    for (let i = 0; i < 4; i++) {
      const P = portals[i];
      if (!P.placed) {
        quads[i].visible = false; frames[i].visible = false;
        glowLights[i].intensity = 0; sparkles[i].mesh.visible = false;
        continue;
      }
      frames[i].visible = true;
      const q = quads[i], f = frames[i], lt = glowLights[i];
      // Reuse _pvM — no new M4() per frame
      _pvM.makeBasis(P.r, P.u, P.n);
      _pvM.setPosition(P.c);
      q.quaternion.setFromRotationMatrix(_pvM); q.position.copy(P.c);
      f.quaternion.copy(q.quaternion); f.position.copy(P.c);
      lt.position.copy(P.c).addScaledVector(P.n, 0.5);
      lt.intensity = 5.0;
      sparkles[i].mesh.visible = true;
      sparkles[i].mesh.quaternion.copy(q.quaternion); sparkles[i].mesh.position.copy(P.c);
    }
  }

  return { renderPortalViews, placePortalVisuals, parkClip, makeRTs };
}
