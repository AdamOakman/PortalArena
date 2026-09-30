export function initPortalRendering(ctx) {
  const { TH, innerWidth, innerHeight, renderer, camera, scene, portals, PORT, R_AB, R_BA, frames, sparkles, quads, quadMats, glowLights, skyGroup } = ctx;
  const V3 = TH.Vector3;
  const M4 = TH.Matrix4;

  const MAX_DEPTH = 3;
  const portalRTs = [];
  function makeRTs() {
    const w = Math.max(256, Math.floor(innerWidth * 0.7)), h = Math.max(256, Math.floor(innerHeight * 0.7));
    for (let d = 0; d < MAX_DEPTH; d++) {
      const dw = Math.max(64, Math.floor(w / (d + 1)));
      const dh = Math.max(64, Math.floor(h / (d + 1)));
      if (!portalRTs[d]) portalRTs[d] = [null, null, null, null];
      for (let i = 0; i < 4; i++) {
        if (portalRTs[d][i]) portalRTs[d][i].dispose();
        portalRTs[d][i] = new TH.WebGLRenderTarget(dw, dh, { minFilter: TH.LinearFilter, magFilter: TH.LinearFilter });
      }
    }
  }
  makeRTs();

  const clipPlane = new TH.Plane(new V3(0, 1, 0), 1e6);
  renderer.clippingPlanes = [clipPlane];

  const vcam = new TH.PerspectiveCamera(115, 1, 0.02, 300);
  vcam.matrixAutoUpdate = false;
  vcam.layers.enable(1); // allow virtual camera to see the player model

  const _frustum = new TH.Frustum(), _projScreen = new TH.Matrix4();
  
  function parkClip() { clipPlane.normal.set(0, 1, 0); clipPlane.constant = 1e6; }

  function renderPortalRecursive(i, parentCamMatrix, depth) {
    const pairIdx = Math.floor(i / 2);
    const qIdx = i % 2 === 0 ? i + 1 : i - 1;
    const P = portals[i], Q = portals[qIdx];
    
    vcam.matrixWorld.copy(parentCamMatrix);
    vcam.matrixWorldInverse.copy(parentCamMatrix).invert();
    vcam.fov = camera.fov; vcam.aspect = camera.aspect;
    vcam.updateProjectionMatrix();
    
    const parentPos = new V3().setFromMatrixPosition(parentCamMatrix);
    const dot = new V3().subVectors(parentPos, P.c).dot(P.n);
    if (dot <= 0.01) return null; // Camera is behind or flush with the portal plane
    
    _projScreen.multiplyMatrices(vcam.projectionMatrix, vcam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);
    const maxRad = Math.hypot(PORT.hw, PORT.hh) + 0.5;
    if (!_frustum.intersectsSphere(new TH.Sphere(P.c, maxRad))) return null;

    const R = i % 2 === 0 ? R_AB[pairIdx] : R_BA[pairIdx];
    if (!R) return null;
    const T1 = new M4().makeTranslation(-P.c.x, -P.c.y, -P.c.z);
    const T2 = new M4().makeTranslation(Q.c.x, Q.c.y, Q.c.z);
    const camMatrix = new M4().multiplyMatrices(T2, new M4().multiplyMatrices(R, new M4().multiplyMatrices(T1, parentCamMatrix)));
    
    let texs = [null, null, null, null];
    if (depth < PORT.recursion) {
      for (let j = 0; j < 4; j++) {
        if (portals[j].placed && portals[j%2 === 0 ? j+1 : j-1].placed) {
          texs[j] = renderPortalRecursive(j, camMatrix, depth + 1);
        }
      }
    }
    
    vcam.matrixAutoUpdate = false;
    vcam.matrixWorld.copy(camMatrix);
    vcam.matrixWorldInverse.copy(camMatrix).invert();
    vcam.fov = camera.fov; vcam.aspect = camera.aspect;
    vcam.updateProjectionMatrix();
    
    const dP = (parentPos.x - P.c.x) * P.n.x + (parentPos.y - P.c.y) * P.n.y + (parentPos.z - P.c.z) * P.n.z;
    if (Math.abs(dP) > 0.05) {
      const s = dP >= 0 ? 1 : -1;
      clipPlane.normal.copy(Q.n).multiplyScalar(s);
      clipPlane.constant = -s * Q.n.dot(Q.c) + 0.02;
    } else { parkClip(); }
    
    const exitIdx = qIdx;
    const oldFrameVis = frames[exitIdx].visible;
    const oldSparkVis = sparkles[exitIdx].mesh.visible;
    const oldQuadVis = quads[exitIdx].visible;
    const oldSourceVis = quads[i].visible;
    frames[exitIdx].visible = false;
    sparkles[exitIdx].mesh.visible = false;
    quads[exitIdx].visible = false;
    quads[i].visible = false;
    
    for (let j = 0; j < 4; j++) {
      if (quadMats[j]) quadMats[j].uniforms.uTex.value = texs[j];
    }
    
    const rt = portalRTs[depth][i];
    renderer.setRenderTarget(rt);
    renderer.clear();
    
    skyGroup.position.setFromMatrixPosition(camMatrix);
    renderer.render(scene, vcam);
    
    frames[exitIdx].visible = oldFrameVis;
    sparkles[exitIdx].mesh.visible = oldSparkVis;
    quads[exitIdx].visible = oldQuadVis;
    quads[i].visible = oldSourceVis;
    
    return rt.texture;
  }

  function renderPortalViews() {
    let texs = [null, null, null, null];
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
          quads[i].visible = portals[i].placed;
       }
    }
  }

  function placePortalVisuals() {
    for (let i = 0; i < 4; i++) {
      const P = portals[i];
      if (!P.placed) { quads[i].visible = false; frames[i].visible = false; glowLights[i].intensity = 0; sparkles[i].mesh.visible = false; continue; }
      frames[i].visible = true;
      const q = quads[i], f = frames[i], lt = glowLights[i];
      const m = new M4().makeBasis(P.r, P.u, P.n);
      m.setPosition(P.c);
      q.quaternion.setFromRotationMatrix(m); q.position.copy(P.c);
      f.quaternion.copy(q.quaternion); f.position.copy(P.c);
      lt.position.copy(P.c).addScaledVector(P.n, 0.5);
      lt.intensity = 5.0;
      sparkles[i].mesh.visible = true;
      sparkles[i].mesh.quaternion.copy(q.quaternion); sparkles[i].mesh.position.copy(P.c);
    }
  }

  return { renderPortalViews, placePortalVisuals, parkClip, makeRTs };
}





