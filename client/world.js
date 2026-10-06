import { generateMap } from '../shared/mapgen.js?v=2';

/* ============================================================================
   WORLD — map building (batched for performance) + destructible walls.
   Owns the world state: colliders (obbs), spawn points, lava pools, hint
   zones, the animated-objects list, and the instanced grab-cube meshes.
   ============================================================================ */
export function initWorld(G) {
  const { TH, V3 } = G;

  G.worldGroup = null; // rebuilt on new map
  G.obbs = [];         // colliders {c:V3, he:[hx,hy,hz], ax:[X,Y,Z], rad}
  G.spawnPts = [];     // V3[] — the 6 map spawn points
  G.lavaPools = [];    // { x, z, r, y } — instant-death lava
  G.hintZones = [];
  G.animObjects = [];
  G.instCubeMesh = null;
  G.instCubeEdges = null;
  G.currentSeed = '';

  function clearWorld() {
    if (!G.worldGroup) return;
    G.scene.remove(G.worldGroup);
    G.worldGroup.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { for (const k of ['map', 'emissiveMap']) if (m[k]) m[k].dispose(); m.dispose(); });
    });
    G.worldGroup = null; G.obbs = []; G.animObjects = [];
    G._gibPool.releaseAll(); for (const g of G._gibPool.items) g.mesh.visible = false;
    G._ibPool.releaseAll(); for (const b of G._ibPool.items) b.group.visible = false;
    G._scorchPool.releaseAll(); for (const s of G._scorchPool.items) s.mesh.visible = false;
  }

  function mergeBufferGeometries(geometries, useNormalsAndUVs) {
    if (geometries.length === 0) return null;
    let vertCount = 0, indexCount = 0;
    for (const g of geometries) {
      vertCount += g.attributes.position.count;
      indexCount += g.index ? g.index.count : g.attributes.position.count;
    }
    const posArray = new Float32Array(vertCount * 3);
    const normArray = useNormalsAndUVs ? new Float32Array(vertCount * 3) : null;
    const uvArray = useNormalsAndUVs ? new Float32Array(vertCount * 2) : null;
    const indexArray = vertCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);

    let vOffset = 0, iOffset = 0;
    for (const g of geometries) {
      const vLen = g.attributes.position.count;
      posArray.set(g.attributes.position.array, vOffset * 3);
      if (useNormalsAndUVs) {
        if (g.attributes.normal) normArray.set(g.attributes.normal.array, vOffset * 3);
        if (g.attributes.uv) uvArray.set(g.attributes.uv.array, vOffset * 2);
      }
      if (g.index) {
        const idx = g.index.array;
        for (let i = 0; i < idx.length; i++) indexArray[iOffset++] = idx[i] + vOffset;
      } else {
        for (let i = 0; i < vLen; i++) indexArray[iOffset++] = i + vOffset;
      }
      vOffset += vLen;
    }

    const merged = new TH.BufferGeometry();
    merged.setAttribute('position', new TH.BufferAttribute(posArray, 3));
    if (useNormalsAndUVs) {
      merged.setAttribute('normal', new TH.BufferAttribute(normArray, 3));
      merged.setAttribute('uv', new TH.BufferAttribute(uvArray, 2));
    }
    merged.setIndex(new TH.BufferAttribute(indexArray, 1));
    return merged;
  }

  // Gothic decorations: torches, banners, arches, obelisks, braziers, crosses, skulls.
  // Geometry is merged per material to keep draw calls low.
  function renderGothicDecor(map, group) {
    const iron = new TH.MeshStandardMaterial({ color: 0x17161d, metalness: 0.75, roughness: 0.35 });
    const stone = new TH.MeshStandardMaterial({ color: 0x2a2633, metalness: 0.05, roughness: 0.85 });
    const flame = new TH.MeshBasicMaterial({ color: 0xff7a22 });
    const bannerR = new TH.MeshStandardMaterial({ color: 0x4a0e18, roughness: 0.9, side: TH.DoubleSide });
    const bannerP = new TH.MeshStandardMaterial({ color: 0x241040, roughness: 0.9, side: TH.DoubleSide });
    const bone = new TH.MeshStandardMaterial({ color: 0xb8b0a0, roughness: 0.6 });
    const eye = new TH.MeshStandardMaterial({ color: 0x0a0a0c, emissive: 0x220800, emissiveIntensity: 0.8 });

    const ironG = [], stoneG = [], flameG = [], bannerRG = [], bannerPG = [], boneG = [], eyeG = [];
    const put = (arr, geo, x, y, z, ry = 0) => {
      const g = geo.clone();
      g.applyMatrix4(new TH.Matrix4().compose(
        new V3(x, y, z),
        new TH.Quaternion().setFromEuler(new TH.Euler(0, ry, 0, 'YZX')),
        new V3(1, 1, 1)));
      arr.push(g);
    };

    let torchLights = 0;
    for (const d of map.decor) {
      const [x, y, z] = d.c, s = d.s || 1;
      if (d.t === 'torch') {
        put(ironG, new TH.BoxGeometry(0.18 * s, 1.7 * s, 0.18 * s), x, y + 0.85 * s, z);
        const f = new TH.ConeGeometry(0.24 * s, 0.7 * s, 6); f.translate(0, 0.35 * s, 0);
        put(flameG, f, x, y + 1.7 * s, z);
        if (torchLights < 24 && Math.random() < 0.5) {
          const L = new TH.PointLight(0xff6a2a, 14, 22, 2);
          L.position.set(x, y + 2.2 * s, z); group.add(L);
          G.animObjects.push({ obj: L, type: 'torchlight', phase: Math.random() * 10 });
          torchLights++;
        }
      } else if (d.t === 'brazier') {
        const bowl = new TH.CylinderGeometry(1.4 * s, 0.9 * s, 1.0 * s, 8); bowl.translate(0, 0.5 * s, 0);
        put(stoneG, bowl, x, y, z);
        const f = new TH.ConeGeometry(0.85 * s, 2.4 * s, 7); f.translate(0, 1.3 * s, 0);
        const fm = new TH.Mesh(f, flame);
        fm.position.set(x, y, z); group.add(fm);
        G.animObjects.push({ obj: fm, type: 'flame', phase: Math.random() * 10 });
        const L = new TH.PointLight(0xff6a2a, 26, 32, 2);
        L.position.set(x, y + 2 * s, z); group.add(L);
      } else if (d.t === 'arch') {
        const ry = d.ry || 0;
        const w = 5.5 * s;
        // Doorpost offsets must be rotated with the arch, otherwise
        // east/west gates (ry = PI/2) place the posts inside/outside
        // the wall instead of flanking the passage.
        const ox = (w / 2) * Math.cos(ry), oz = (w / 2) * Math.sin(ry);
        put(stoneG, new TH.BoxGeometry(0.6 * s, 4.6 * s, 0.6 * s), x + ox, y + 2.3 * s, z + oz, ry);
        put(stoneG, new TH.BoxGeometry(0.6 * s, 4.6 * s, 0.6 * s), x - ox, y + 2.3 * s, z - oz, ry);
        put(stoneG, new TH.BoxGeometry(w + 1.2 * s, 0.55 * s, 0.6 * s), x, y + 4.9 * s, z, ry);
        const fin = new TH.ConeGeometry(1.0 * s, 1.8 * s, 4); fin.rotateY(Math.PI / 4); fin.translate(0, 0.9 * s, 0);
        put(stoneG, fin, x, y + 5.15 * s, z, ry);
      } else if (d.t === 'banner') {
        const arr = ((Math.round(x * 7 + z * 13) % 2) + 2) % 2 ? bannerPG : bannerRG;
        put(arr, new TH.PlaneGeometry(1.1 * s, 3.0 * s), x, y, z, d.ry || 0);
      } else if (d.t === 'obelisk') {
        put(stoneG, new TH.BoxGeometry(1.6 * s, 9 * s, 1.6 * s), x, y + 4.5 * s, z, d.ry || 0);
        const tip = new TH.ConeGeometry(1.15 * s, 2.2 * s, 4); tip.rotateY(Math.PI / 4); tip.translate(0, 1.1 * s, 0);
        put(stoneG, tip, x, y + 9 * s, z, d.ry || 0);
      } else if (d.t === 'cross') {
        put(stoneG, new TH.BoxGeometry(0.7 * s, 5 * s, 0.7 * s), x, y + 2.5 * s, z, d.ry || 0);
        put(stoneG, new TH.BoxGeometry(2.6 * s, 0.7 * s, 0.7 * s), x, y + 3.4 * s, z, d.ry || 0);
      } else if (d.t === 'skull') {
        const cr = new TH.SphereGeometry(0.55 * s, 8, 6); cr.scale(1, 0.9, 0.9); cr.translate(0, 0.5 * s, 0);
        put(boneG, cr, x, y, z, d.ry || 0);
        put(boneG, new TH.BoxGeometry(0.7 * s, 0.35 * s, 0.5 * s), x, y + 0.18 * s, z, d.ry || 0);
        put(eyeG, new TH.BoxGeometry(0.22 * s, 0.18 * s, 0.12 * s), x + 0.2 * s, y + 0.55 * s, z + 0.4 * s, d.ry || 0);
        put(eyeG, new TH.BoxGeometry(0.22 * s, 0.18 * s, 0.12 * s), x - 0.2 * s, y + 0.55 * s, z + 0.4 * s, d.ry || 0);
      }
    }
    const mergeAdd = (geos, mat) => { if (geos.length) group.add(new TH.Mesh(mergeBufferGeometries(geos, true), mat)); };
    mergeAdd(ironG, iron); mergeAdd(stoneG, stone); mergeAdd(flameG, flame);
    mergeAdd(bannerRG, bannerR); mergeAdd(bannerPG, bannerP);
    mergeAdd(boneG, bone); mergeAdd(eyeG, eye);
  }

  function addWallFragment(obb, uIdx, u, y, w, h) {
    // Fragment of a destroyed wall in the parent's frame: u = center along the
    // wall's long axis, w = width along it, y = center height, h = height.
    // Inherits the parent's orientation (also covers rotated cover walls).
    const A = obb.ax, C = obb.c;
    const tIdx = uIdx === 0 ? 2 : 0;
    const c = new V3(
      C.x + A[uIdx].x * u + A[1].x * y,
      C.y + A[uIdx].y * u + A[1].y * y,
      C.z + A[uIdx].z * u + A[1].z * y
    );
    const sx = uIdx === 0 ? w : obb.he[tIdx] * 2;
    const sz = uIdx === 2 ? w : obb.he[tIdx] * 2;
    const baseGeo = new TH.BoxGeometry(sx, h, sz);
    const edgeGeo = new TH.EdgesGeometry(baseGeo);
    const m = new TH.Matrix4().makeBasis(A[0], A[1], A[2]);
    m.setPosition(c);
    baseGeo.applyMatrix4(m);
    edgeGeo.applyMatrix4(m);
    const mMat = G.getSlabMat('wall');
    const meshObj = new TH.Group();
    meshObj.add(new TH.Mesh(baseGeo, mMat.mat));
    meshObj.add(new TH.LineSegments(edgeGeo, mMat.edgeMat));
    if (G.worldGroup) G.worldGroup.add(meshObj);
    else G.scene.add(meshObj);

    G.obbs.push({
      c,
      ax: [A[0].clone(), A[1].clone(), A[2].clone()],
      he: [sx / 2, h / 2, sz / 2],
      rad: Math.hypot(sx, h, sz) / 2 + 3,
      kind: 'wall',
      mesh: meshObj
    });
  }

  function destroyWall(obb, point, normal) {
    if (obb.kind !== 'wall') return;
    if (obb.boundary) return; // Boundary walls are indestructible by rockets
    // Long axis = the wider horizontal extent; the other is the wall's thickness.
    const uIdx = obb.he[0] >= obb.he[2] ? 0 : 2;
    const tIdx = uIdx === 0 ? 2 : 0;
    if (obb.he[tIdx] > 2.5) return; // Only destroy thin vertical walls (not corner towers)

    if (obb.mesh) {
      if (G.worldGroup) G.worldGroup.remove(obb.mesh);
      else G.scene.remove(obb.mesh);

      obb.mesh.traverse(o => {
        if (o.geometry) o.geometry.dispose();
      });
    }

    // Remove from physics
    const idx = G.obbs.indexOf(obb);
    if (idx > -1) G.obbs.splice(idx, 1);

    for (let i = 0; i < 4; i++) {
       const P = G.portals[i];
       if (P.placed && P.c.distanceTo(obb.c) < obb.rad + 1) {
          if (Math.abs(P.n.dot(obb.ax[tIdx])) > 0.99) G.cancelPortal(i);
       }
    }

    // Hit in the wall's local frame: u runs along the wall, y is up.
    const rel = new V3(point.x - obb.c.x, point.y - obb.c.y, point.z - obb.c.z);
    const uC = rel.dot(obb.ax[uIdx]);
    const yC = rel.dot(obb.ax[1]);

    const R = 4.8;
    const MIN_PIECE = 0.3; // drop crumbs so repeat hits carve clean holes, not micro-slivers
    const uMin = -obb.he[uIdx], uMax = obb.he[uIdx];
    const yMin = -obb.he[1], yMax = obb.he[1];

    const pieces = [];

    const startU = uC - R;
    const endU = uC + R;

    if (startU > uMin + MIN_PIECE) pieces.push({ u: (uMin + startU)/2, w: startU - uMin, y: 0, h: yMax - yMin });
    if (endU < uMax - MIN_PIECE) pieces.push({ u: (endU + uMax)/2, w: uMax - endU, y: 0, h: yMax - yMin });

    const bandMinU = Math.max(uMin, startU);
    const bandMaxU = Math.min(uMax, endU);
    const bandW = bandMaxU - bandMinU;
    const bandMinY = Math.max(yMin, yC - R);
    const bandMaxY = Math.min(yMax, yC + R);

    // The blast removes one rectangular chunk (the blast radius' bounding box,
    // clipped to the wall) — no strip grid. At most 4 large pieces remain:
    // the side slabs plus one piece above and below the void.
    if (bandW >= MIN_PIECE && bandMaxY - bandMinY >= MIN_PIECE) {
      if (bandMinY - yMin > MIN_PIECE)
        pieces.push({ u: (bandMinU + bandMaxU) / 2, w: bandW, y: (yMin + bandMinY) / 2, h: bandMinY - yMin });
      if (yMax - bandMaxY > MIN_PIECE)
        pieces.push({ u: (bandMinU + bandMaxU) / 2, w: bandW, y: (bandMaxY + yMax) / 2, h: yMax - bandMaxY });
    }

    for (const p of pieces) {
      addWallFragment(obb, uIdx, p.u, p.y, p.w, p.h);
    }

    // Spawn physical debris chunks
    const mMat = G.getSlabMat('wall');
    const blastNormal = normal ? normal.clone() : new V3(0, 1, 0);
    const rr = (min, max) => min + Math.random() * (max - min);
    for (let i = 0; i < 24; i++) {
      const bs = rr(0.9, 2.2);
      const bGeo = new TH.BoxGeometry(bs, bs, bs);
      const bMesh = new TH.Group();
      bMesh.add(new TH.Mesh(bGeo, mMat.mat));
      bMesh.add(new TH.LineSegments(new TH.EdgesGeometry(bGeo), mMat.edgeMat));

      const offset = new V3(rr(-3, 3), rr(-3, 3), rr(-3, 3));
      bMesh.position.copy(point).add(offset);
      G.scene.add(bMesh);

      // Fly outward from the wall along the normal, plus some scatter
      const scatter = offset.clone().normalize().multiplyScalar(rr(4, 12));
      const vel = blastNormal.clone().multiplyScalar(rr(15, 35)).add(scatter);
      vel.y += rr(5, 15); // always pop up a bit

      const rot = new V3(rr(-15, 15), rr(-15, 15), rr(-15, 15));
      G.animObjects.push({ type: 'debris', obj: bMesh, vel, rot, life: 4.0 });
    }
  }

  function loadMap(seedStr) {
    G.currentSeed = seedStr;
    clearWorld();
    for (const P of G.portals) { P.placed = false; P.closing = false; }
    G.placePortalVisuals();
    const map = generateMap(seedStr);
    G.worldGroup = new TH.Group(); G.scene.add(G.worldGroup);

    // --- Batched World Build ---
    const geoBatches = {}, edgeBatches = {};
    for (const rec of map.slabs) {
      const [sx, sy, sz] = rec.s;
      const baseGeo = new TH.BoxGeometry(sx, sy, sz);
      const edgeGeo = new TH.EdgesGeometry(baseGeo);
      const m = new TH.Matrix4().compose(
        new V3(...rec.c),
        new TH.Quaternion().setFromEuler(new TH.Euler(0, rec.ry || 0, rec.rz || 0, 'YZX')),
        new V3(1, 1, 1)
      );
      baseGeo.applyMatrix4(m);
      edgeGeo.applyMatrix4(m);
      const kind = rec.kind || 'plat';

      let meshObj = null;
      if (kind === 'wall') {
        const mMat = G.getSlabMat('wall');
        meshObj = new TH.Group();
        meshObj.add(new TH.Mesh(baseGeo, mMat.mat));
        meshObj.add(new TH.LineSegments(edgeGeo, mMat.edgeMat));
        G.worldGroup.add(meshObj);
      } else {
        if (!geoBatches[kind]) geoBatches[kind] = [];
        if (!edgeBatches[kind]) edgeBatches[kind] = [];
        geoBatches[kind].push(baseGeo);
        edgeBatches[kind].push(edgeGeo);
      }

      const q = new TH.Quaternion().setFromRotationMatrix(m);
      const ax = [new V3(1, 0, 0).applyQuaternion(q), new V3(0, 1, 0).applyQuaternion(q), new V3(0, 0, 1).applyQuaternion(q)];
      const rad = Math.hypot(sx, sy, sz) / 2 + 3;
      G.obbs.push({ c: new V3(...rec.c), he: [sx / 2, sy / 2, sz / 2], ax, rad, kind, boundary: rec.boundary, mesh: meshObj });
    }

    for (const kind in geoBatches) {
      const mergedGeo = mergeBufferGeometries(geoBatches[kind], true);
      const mergedEdges = mergeBufferGeometries(edgeBatches[kind], false);
      if (!mergedGeo) continue;
      const mats = G.getSlabMat(kind);
      G.worldGroup.add(new TH.Mesh(mergedGeo, mats.mat));
      G.worldGroup.add(new TH.LineSegments(mergedEdges, mats.edgeMat));
    }

    // --- Gothic decor (merged per material) ---
    renderGothicDecor(map, G.worldGroup);
    // --- End Batched World Build ---

    if (map.grabCubes.length > 0) {
      G.grabCubes.length = 0;
      G.grabbedCube = null;
      const cubeGeo = new TH.BoxGeometry(1.5, 1.5, 1.5, 4, 4, 4);
      const cubePos = cubeGeo.attributes.position;
      for (let i = 0; i < cubePos.count; i++) {
          let x = cubePos.getX(i), y = cubePos.getY(i), z = cubePos.getZ(i);
          const hw = 0.75 - 0.25;
          let cx = Math.max(-hw, Math.min(hw, x));
          let cy = Math.max(-hw, Math.min(hw, y));
          let cz = Math.max(-hw, Math.min(hw, z));
          const dx = x - cx, dy = y - cy, dz = z - cz;
          const len = Math.hypot(dx, dy, dz);
          if (len > 0.001) {
             x = cx + (dx / len) * 0.25;
             y = cy + (dy / len) * 0.25;
             z = cz + (dz / len) * 0.25;
             cubePos.setXYZ(i, x, y, z);
          }
      }
      cubeGeo.computeVertexNormals();
      const cubeEdgeGeo = new TH.EdgesGeometry(cubeGeo, 15);
      const cMat = new TH.MeshStandardMaterial({ color: 0x334455, emissive: 0x0088ff, emissiveIntensity: 0.6, metalness: 0.2, roughness: 0.4 });
      const eMat = new TH.LineBasicMaterial({ color: 0x00ffff });

      G.instCubeMesh = new TH.InstancedMesh(cubeGeo, cMat, map.grabCubes.length);
      // LineSegments can't directly be InstancedMesh in some versions without InstancedBufferGeometry, but standard InstancedMesh supports it in r117+!
      G.instCubeEdges = new TH.InstancedMesh(cubeEdgeGeo, eMat, map.grabCubes.length);
      G.instCubeMesh.instanceMatrix.setUsage(TH.DynamicDrawUsage);
      G.instCubeEdges.instanceMatrix.setUsage(TH.DynamicDrawUsage);
      G.worldGroup.add(G.instCubeMesh, G.instCubeEdges);

      for (let i = 0; i < map.grabCubes.length; i++) {
        const hc = map.grabCubes[i];
        const pos = new TH.Vector3(...hc.c);
        G.grabCubes.push({ pos: pos.clone(), vel: new TH.Vector3(0, 0, 0), rotVel: new TH.Vector3(0, 0, 0), rad: 0.75, id: i, quat: new TH.Quaternion() });
      }
    } else {
      G.grabCubes.length = 0;
      G.grabbedCube = null;
    }
    G.spawnPts = map.spawns.map(s => new V3(s.x, s.y, s.z));
    G.lavaPools = map.lava;
    G.hintZones = map.hints.map(h => ({ min: new V3(...h.min), max: new V3(...h.max), msg: h.msg }));
    G.pl.pos.copy(G.spawnPts[0]); G.pl.vel.set(0, 0, 0); G.pl.cp.copy(G.spawnPts[0]);
    G.pl.yaw = Math.atan2(-G.spawnPts[0].x, -G.spawnPts[0].z); // face arena center
    G.pl.pitch = 0; G.pl.viewOffset = null; G.pl.maxSpeed = 0; G.pl.grounded = false; G.pl.jumpBuf = -1;
    G.won = false; G.localReady = false; G.lastInstagibTime = -999; G.lastRocketTime = -999;
    G.winPanel.classList.add('hidden');
    G.dom('seedinfo').textContent = seedStr;
    G.prewarmFX();
  }

  function newMap(s) {
    G.Network.send({ type: 'new_map', seed: s });
    G.menuPanel.classList.add('hidden');
    G.requestLock();
  }

  G.clearWorld = clearWorld;
  G.loadMap = loadMap;
  G.newMap = newMap;
  G.destroyWall = destroyWall;
}
