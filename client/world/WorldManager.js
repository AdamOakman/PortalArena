import * as THREE from 'three';
import { generateMap } from '../../shared/mapgen.js';
import { PORT } from '../../shared/constants.js';

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

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
  if (useNormalsAndUVs) {
    merged.setAttribute('normal', new THREE.BufferAttribute(normArray, 3));
    merged.setAttribute('uv', new THREE.BufferAttribute(uvArray, 2));
  }
  merged.setIndex(new THREE.BufferAttribute(indexArray, 1));
  return merged;
}

function createCurvedRampGeo(r, M = 32, T = 0.3) {
  const { cx, cz, dir, len, rise, width, y0 } = r;
  const ry = dir === 0 ? 0 : dir === 1 ? -Math.PI / 2 : dir === 2 ? Math.PI : Math.PI / 2;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0, 'YZX'));
  const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const right = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const center = new THREE.Vector3(cx, 0, cz);

  const positions = [], normals = [], uvs = [], indices = [];

  function addV(s, y, w, nx, ny, nz, u, v) {
    const p = center.clone().addScaledVector(fwd, s).addScaledVector(right, w);
    p.y = y;
    positions.push(p.x, p.y, p.z);
    normals.push(nx, ny, nz);
    uvs.push(u, v);
  }

  const topStartIdx = positions.length / 3;
  for (let j = 0; j <= M; j++) {
    const u = j / M, s = u * len - len / 2;
    const y = y0 + rise * (6 * (u ** 5) - 15 * (u ** 4) + 10 * (u ** 3));
    const dyDs = (rise / len) * (30 * (u ** 2) * ((1 - u) ** 2));
    const theta = Math.atan2(dyDs, 1);
    const ns = -Math.sin(theta), ny = Math.cos(theta);
    const nw = fwd.clone().multiplyScalar(ns);
    nw.y = ny;

    addV(s, y, -width / 2, nw.x, nw.y, nw.z, s * 0.5, 0);
    addV(s, y, width / 2, nw.x, nw.y, nw.z, s * 0.5, width * 0.5);
  }
  for (let j = 0; j < M; j++) {
    const r1 = topStartIdx + j * 2, r2 = topStartIdx + (j + 1) * 2;
    indices.push(r1, r1 + 1, r2 + 1, r1, r2 + 1, r2);
  }

  const leftStartIdx = positions.length / 3;
  const leftN = right.clone().multiplyScalar(-1);
  for (let j = 0; j <= M; j++) {
    const u = j / M, s = u * len - len / 2;
    const y = y0 + rise * (6 * (u ** 5) - 15 * (u ** 4) + 10 * (u ** 3));
    addV(s, y, -width / 2, leftN.x, 0, leftN.z, s * 0.5, y * 0.5);
    addV(s, y - T, -width / 2, leftN.x, 0, leftN.z, s * 0.5, (y - T) * 0.5);
  }
  for (let j = 0; j < M; j++) {
    const r1 = leftStartIdx + j * 2, r2 = leftStartIdx + (j + 1) * 2;
    indices.push(r1, r2, r2 + 1, r1, r2 + 1, r1 + 1);
  }

  const rightStartIdx = positions.length / 3;
  const rightN = right.clone();
  for (let j = 0; j <= M; j++) {
    const u = j / M, s = u * len - len / 2;
    const y = y0 + rise * (6 * (u ** 5) - 15 * (u ** 4) + 10 * (u ** 3));
    addV(s, y, width / 2, rightN.x, 0, rightN.z, s * 0.5, y * 0.5);
    addV(s, y - T, width / 2, rightN.x, 0, rightN.z, s * 0.5, (y - T) * 0.5);
  }
  for (let j = 0; j < M; j++) {
    const r1 = rightStartIdx + j * 2, r2 = rightStartIdx + (j + 1) * 2;
    indices.push(r1, r1 + 1, r2 + 1, r1, r2 + 1, r2);
  }

  const botStartIdx = positions.length / 3;
  for (let j = 0; j <= M; j++) {
    const u = j / M, s = u * len - len / 2;
    const y = y0 + rise * (6 * (u ** 5) - 15 * (u ** 4) + 10 * (u ** 3)) - T;
    addV(s, y, -width / 2, 0, -1, 0, s * 0.5, 0);
    addV(s, y, width / 2, 0, -1, 0, s * 0.5, width * 0.5);
  }
  for (let j = 0; j < M; j++) {
    const r1 = botStartIdx + j * 2, r2 = botStartIdx + (j + 1) * 2;
    indices.push(r1, r2 + 1, r1 + 1, r1, r2, r2 + 1);
  }

  const lowStartIdx = positions.length / 3;
  const lowN = fwd.clone().multiplyScalar(-1);
  addV(-len / 2, y0, -width / 2, lowN.x, 0, lowN.z, 0, 0);
  addV(-len / 2, y0, width / 2, lowN.x, 0, lowN.z, width * 0.5, 0);
  addV(-len / 2, y0 - T, width / 2, lowN.x, 0, lowN.z, width * 0.5, T * 0.5);
  addV(-len / 2, y0 - T, -width / 2, lowN.x, 0, lowN.z, 0, T * 0.5);
  indices.push(lowStartIdx, lowStartIdx + 2, lowStartIdx + 1, lowStartIdx, lowStartIdx + 3, lowStartIdx + 2);

  const highStartIdx = positions.length / 3;
  const highN = fwd.clone();
  addV(len / 2, y0 + rise, -width / 2, highN.x, 0, highN.z, 0, 0);
  addV(len / 2, y0 + rise, width / 2, highN.x, 0, highN.z, width * 0.5, 0);
  addV(len / 2, y0 + rise - T, width / 2, highN.x, 0, highN.z, width * 0.5, T * 0.5);
  addV(len / 2, y0 + rise - T, -width / 2, highN.x, 0, highN.z, 0, T * 0.5);
  indices.push(highStartIdx, highStartIdx + 1, highStartIdx + 2, highStartIdx, highStartIdx + 2, highStartIdx + 3);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);

  const edgePositions = [];
  function addEdge(p1, p2) {
    if (!p1 || !p2 || isNaN(p1.x) || isNaN(p1.y) || isNaN(p1.z) || isNaN(p2.x) || isNaN(p2.y) || isNaN(p2.z)) return;
    edgePositions.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
  }
  const samplePt = (s, yOffset, w) => {
    const u = (s + len / 2) / len;
    const y = y0 + rise * (6 * (u ** 5) - 15 * (u ** 4) + 10 * (u ** 3)) + yOffset;
    const p = center.clone().addScaledVector(fwd, s).addScaledVector(right, w);
    p.y = y;
    return p;
  };
  for (let j = 0; j < M; j++) {
    const sA = (j / M) * len - len / 2;
    const sB = ((j + 1) / M) * len - len / 2;
    addEdge(samplePt(sA, 0, -width / 2), samplePt(sB, 0, -width / 2));
    addEdge(samplePt(sA, 0, width / 2), samplePt(sB, 0, width / 2));
    addEdge(samplePt(sA, -T, -width / 2), samplePt(sB, -T, -width / 2));
    addEdge(samplePt(sA, -T, width / 2), samplePt(sB, -T, width / 2));
  }
  addEdge(samplePt(-len / 2, 0, -width / 2), samplePt(-len / 2, -T, -width / 2));
  addEdge(samplePt(-len / 2, 0, width / 2), samplePt(-len / 2, -T, width / 2));
  addEdge(samplePt(len / 2, 0, -width / 2), samplePt(len / 2, -T, -width / 2));
  addEdge(samplePt(len / 2, 0, width / 2), samplePt(len / 2, -T, width / 2));
  addEdge(samplePt(-len / 2, -T, -width / 2), samplePt(-len / 2, -T, width / 2));
  addEdge(samplePt(len / 2, -T, -width / 2), samplePt(len / 2, -T, width / 2));

  geo.computeBoundingSphere();
  const edges = new THREE.BufferGeometry();
  edges.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
  edges.computeBoundingSphere();
  return { geo, edges };
}

function renderGothicDecor(map, group, animObjects) {
  const iron = new THREE.MeshStandardMaterial({ color: 0x17161d, metalness: 0.75, roughness: 0.35 });
  const stone = new THREE.MeshStandardMaterial({ color: 0x2a2633, metalness: 0.05, roughness: 0.85 });
  const flame = new THREE.MeshBasicMaterial({ color: 0xff7a22 });
  const bannerR = new THREE.MeshStandardMaterial({ color: 0x4a0e18, roughness: 0.9, side: THREE.DoubleSide });
  const bannerP = new THREE.MeshStandardMaterial({ color: 0x241040, roughness: 0.9, side: THREE.DoubleSide });
  const bone = new THREE.MeshStandardMaterial({ color: 0xb8b0a0, roughness: 0.6 });
  const eye = new THREE.MeshStandardMaterial({ color: 0x0a0a0c, emissive: 0x220800, emissiveIntensity: 0.8 });

  const ironG = [], stoneG = [], flameG = [], bannerRG = [], bannerPG = [], boneG = [], eyeG = [];
  const put = (arr, geo, x, y, z, ry = 0) => {
    const g = geo.clone();
    g.applyMatrix4(new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0, 'YZX')),
      new THREE.Vector3(1, 1, 1)
    ));
    arr.push(g);
  };

  for (const d of map.decor) {
    const [x, y, z] = d.c, s = d.s || 1;
    if (d.t === 'torch') {
      put(ironG, new THREE.BoxGeometry(0.18 * s, 1.7 * s, 0.18 * s), x, y + 0.85 * s, z);
      const f = new THREE.ConeGeometry(0.24 * s, 0.7 * s, 6);
      f.translate(0, 0.35 * s, 0);
      put(flameG, f, x, y + 1.7 * s, z);
      const L = new THREE.PointLight(0xff6a2a, 14, 22, 2);
      L.position.set(x, y + 2.2 * s, z);
      group.add(L);
      if (animObjects) animObjects.push({ obj: L, type: 'torchlight', phase: Math.random() * 10 });
    } else if (d.t === 'brazier') {
      const bowl = new THREE.CylinderGeometry(1.4 * s, 0.9 * s, 1.0 * s, 8);
      bowl.translate(0, 0.5 * s, 0);
      put(stoneG, bowl, x, y, z);
      const f = new THREE.ConeGeometry(0.85 * s, 2.4 * s, 7);
      f.translate(0, 1.3 * s, 0);
      const fm = new THREE.Mesh(f, flame);
      fm.position.set(x, y, z);
      group.add(fm);
      if (animObjects) animObjects.push({ obj: fm, type: 'flame', phase: Math.random() * 10 });
      const L = new THREE.PointLight(0xff6a2a, 26, 32, 2);
      L.position.set(x, y + 2 * s, z);
      group.add(L);
    } else if (d.t === 'arch') {
      const ry = d.ry || 0;
      const s = d.s || 1;
      const wallH = d.h !== undefined ? d.h : (4.9 * s);
      const w = d.w !== undefined ? d.w : (5.5 * s);
      const postW = 0.8 * s;
      const postD = 1.2 * s;
      const lintelH = 0.7 * s;
      const ox = (w / 2) * Math.cos(ry), oz = (w / 2) * Math.sin(ry);
      put(stoneG, new THREE.BoxGeometry(postW, wallH, postD), x + ox, y + wallH / 2, z + oz, ry);
      put(stoneG, new THREE.BoxGeometry(postW, wallH, postD), x - ox, y + wallH / 2, z - oz, ry);
      put(stoneG, new THREE.BoxGeometry(w + postW, lintelH, postD), x, y + wallH - lintelH / 2, z, ry);
      const fin = new THREE.ConeGeometry(0.9 * s, 1.6 * s, 4);
      fin.rotateY(Math.PI / 4);
      fin.translate(0, 0.8 * s, 0);
      put(stoneG, fin, x, y + wallH, z, ry);
    } else if (d.t === 'banner') {
      const arr = ((Math.round(x * 7 + z * 13) % 2) + 2) % 2 ? bannerPG : bannerRG;
      put(arr, new THREE.PlaneGeometry(1.1 * s, 3.0 * s), x, y, z, d.ry || 0);
    } else if (d.t === 'obelisk') {
      put(stoneG, new THREE.BoxGeometry(1.6 * s, 9 * s, 1.6 * s), x, y + 4.5 * s, z, d.ry || 0);
      const tip = new THREE.ConeGeometry(1.15 * s, 2.2 * s, 4);
      tip.rotateY(Math.PI / 4);
      tip.translate(0, 1.1 * s, 0);
      put(stoneG, tip, x, y + 9 * s, z, d.ry || 0);
    } else if (d.t === 'cross') {
      put(stoneG, new THREE.BoxGeometry(0.7 * s, 5 * s, 0.7 * s), x, y + 2.5 * s, z, d.ry || 0);
      put(stoneG, new THREE.BoxGeometry(2.6 * s, 0.7 * s, 0.7 * s), x, y + 3.4 * s, z, d.ry || 0);
    } else if (d.t === 'skull') {
      const cr = new THREE.SphereGeometry(0.55 * s, 8, 6);
      cr.scale(1, 0.9, 0.9);
      cr.translate(0, 0.5 * s, 0);
      put(boneG, cr, x, y, z, d.ry || 0);
      put(boneG, new THREE.BoxGeometry(0.7 * s, 0.35 * s, 0.5 * s), x, y + 0.18 * s, z, d.ry || 0);
      put(eyeG, new THREE.BoxGeometry(0.22 * s, 0.18 * s, 0.12 * s), x + 0.2 * s, y + 0.55 * s, z + 0.4 * s, d.ry || 0);
      put(eyeG, new THREE.BoxGeometry(0.22 * s, 0.18 * s, 0.12 * s), x - 0.2 * s, y + 0.55 * s, z + 0.4 * s, d.ry || 0);
    }
  }
  const mergeAdd = (geos, mat) => {
    if (geos.length) group.add(new THREE.Mesh(mergeBufferGeometries(geos, true), mat));
  };
  mergeAdd(ironG, iron);
  mergeAdd(stoneG, stone);
  mergeAdd(flameG, flame);
  mergeAdd(bannerRG, bannerR);
  mergeAdd(bannerPG, bannerP);
  mergeAdd(boneG, bone);
  mergeAdd(eyeG, eye);
}

/**
 * WorldManager — Subsystem managing procedural map geometry, colliders, and destructible walls.
 */
export class WorldManager {
  constructor(engine = null) {
    this.engine = engine;
    this.worldGroup = null;
    this.obbs = [];
    this.spawnPts = [];
    this.lavaPools = [];
    this.hintZones = [];
    this.destroyedWalls = [];
    this.destroyedWallObbs = [];
    this.animObjects = [];
    this.instCubeMesh = null;
    this.instCubeEdges = null;
    this.currentSeed = '';

    if (this.engine && this.engine.eventBus) {
      this.engine.eventBus.on('WALL_DESTROYED', (payload) => this.handleWallDestroyed(payload));
    }
  }

  /**
   * Clear current world meshes, lights, and colliders.
   */
  clear(context = null) {
    const G = context || this.engine?.context || window.__GAME_CONTEXT__;
    const scene = G?.scene || this.engine?.scene;

    if (this.worldGroup && scene) {
      scene.remove(this.worldGroup);
      this.worldGroup.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
            for (const k of ['map', 'emissiveMap']) if (m[k]) m[k].dispose();
            m.dispose();
          });
        }
      });
      this.worldGroup = null;
    }

    this.obbs = [];
    this.destroyedWalls = [];
    this.destroyedWallObbs = [];
    this.spawnPts = [];
    this.lavaPools = [];
    this.hintZones = [];

    if (G) {
      G.obbs = this.obbs;
      G.destroyedWalls = this.destroyedWalls;
      G.destroyedWallObbs = this.destroyedWallObbs;

      if (G.animObjects) {
        for (const a of G.animObjects) {
          if (a.slot) {
            if (a.obj) a.obj.visible = false;
          } else if (a.obj && a.obj.parent) {
            a.obj.parent.remove(a.obj);
          }
        }
        G.animObjects = [];
      }

      if (G.rockets && G.rockets.length > 0) {
        for (const r of G.rockets) {
          if (r.mesh) {
            scene.remove(r.mesh);
            r.mesh.traverse(o => {
              if (o.material) o.material.dispose();
              if (o.geometry) o.geometry.dispose();
            });
          }
        }
        G.rockets.length = 0;
      }

      if (G.activeBeams && G.activeBeams.length > 0) {
        for (const b of G.activeBeams) {
          if (b.coreMesh) scene.remove(b.coreMesh);
          if (b.hMesh) scene.remove(b.hMesh);
          if (b.points) scene.remove(b.points);
        }
        G.activeBeams.length = 0;
      }

      if (G._gibPool) {
        G._gibPool.releaseAll();
        for (const g of G._gibPool.items) g.mesh.visible = false;
      }
      if (G._ibPool) {
        G._ibPool.releaseAll();
        for (const b of G._ibPool.items) b.group.visible = false;
      }
      if (G._scorchPool) {
        G._scorchPool.releaseAll();
        for (const s of G._scorchPool.items) s.mesh.visible = false;
      }
      if (G._smokePool) {
        if (G._smokePool.releaseAll) G._smokePool.releaseAll();
        for (const s of G._smokePool) {
          s.active = false;
          if (s.mesh) s.mesh.visible = false;
        }
      }
    }
  }

  addWallFragment(obb, uIdx, u, y, w, h, fragIdx, context = null) {
    const G = context || this.engine?.context || window.__GAME_CONTEXT__;
    const A = obb.ax, C = obb.c;
    const tIdx = uIdx === 0 ? 2 : 0;
    const c = new THREE.Vector3(
      C.x + A[uIdx].x * u + A[1].x * y,
      C.y + A[uIdx].y * u + A[1].y * y,
      C.z + A[uIdx].z * u + A[1].z * y
    );
    const sx = uIdx === 0 ? w : obb.he[tIdx] * 2;
    const sz = uIdx === 2 ? w : obb.he[tIdx] * 2;
    const baseGeo = new THREE.BoxGeometry(sx, h, sz);
    const edgeGeo = new THREE.EdgesGeometry(baseGeo);
    const m = new THREE.Matrix4().makeBasis(A[0], A[1], A[2]);
    m.setPosition(c);
    baseGeo.applyMatrix4(m);
    edgeGeo.applyMatrix4(m);
    const mMat = G?.getSlabMat ? G.getSlabMat('wall') : { mat: new THREE.MeshBasicMaterial(), edgeMat: new THREE.LineBasicMaterial() };
    const meshObj = new THREE.Group();
    meshObj.add(new THREE.Mesh(baseGeo, mMat.mat));
    meshObj.add(new THREE.LineSegments(edgeGeo, mMat.edgeMat));
    if (this.worldGroup) this.worldGroup.add(meshObj);
    else if (G?.scene) G.scene.add(meshObj);

    const fragObb = {
      id: `${obb.id || 'wall'}_f${fragIdx !== undefined ? fragIdx : 0}`,
      c,
      ax: [A[0].clone(), A[1].clone(), A[2].clone()],
      he: [sx / 2, h / 2, sz / 2],
      rad: Math.hypot(sx, h, sz) / 2 + 3,
      kind: 'wall',
      destroyed: true,
      noPortal: true,
      mesh: meshObj
    };

    this.obbs.push(fragObb);
    if (G && G.obbs && G.obbs !== this.obbs) G.obbs.push(fragObb);
  }

  destroyWall(obb, point, normal, broadcast = true, spawnDebris = true, context = null) {
    const G = context || this.engine?.context || window.__GAME_CONTEXT__;
    if (!obb || obb.kind !== 'wall' || obb.boundary) return;
    const uIdx = obb.he[0] >= obb.he[2] ? 0 : 2;
    const tIdx = uIdx === 0 ? 2 : 0;
    if (obb.he[tIdx] > 2.5) return;

    if (broadcast && G?.Network) {
      G.Network.send({
        type: 'destroy_wall',
        wallId: obb.id,
        wallCenter: obb.c.toArray(),
        point: point.toArray(),
        normal: normal ? normal.toArray() : [0, 1, 0]
      });
    }

    if (obb.mesh) {
      if (this.worldGroup) this.worldGroup.remove(obb.mesh);
      else if (G?.scene) G.scene.remove(obb.mesh);
      obb.mesh.traverse(o => {
        if (o.geometry) o.geometry.dispose();
      });
    }

    const destroyedData = {
      id: obb.id,
      c: obb.c.clone(),
      ax: [obb.ax[0].clone(), obb.ax[1].clone(), obb.ax[2].clone()],
      he: [obb.he[0], obb.he[1], obb.he[2]],
      rad: obb.rad
    };
    this.destroyedWallObbs.push(destroyedData);
    if (G && G.destroyedWallObbs && G.destroyedWallObbs !== this.destroyedWallObbs) G.destroyedWallObbs.push(destroyedData);

    obb.destroyed = true;
    obb.noPortal = true;

    const idx = this.obbs.indexOf(obb);
    if (idx > -1) this.obbs.splice(idx, 1);
    if (G && G.obbs && G.obbs !== this.obbs) {
      const gIdx = G.obbs.indexOf(obb);
      if (gIdx > -1) G.obbs.splice(gIdx, 1);
    }

    if (G && G.portals) {
      for (let i = 0; i < 4; i++) {
        const P = G.portals[i];
        if (P.placed && P.c.distanceTo(obb.c) < obb.rad + 2.0) {
          const d = P.c.clone().sub(obb.c);
          const u0 = Math.abs(d.dot(obb.ax[0]));
          const u1 = Math.abs(d.dot(obb.ax[1]));
          const u2 = Math.abs(d.dot(obb.ax[2]));
          if (u0 <= obb.he[0] + 0.6 && u1 <= obb.he[1] + 0.6 && u2 <= obb.he[2] + 0.6) {
            if (G.cancelPortal) G.cancelPortal(i);
          }
        }
      }
    }

    const rel = new THREE.Vector3(point.x - obb.c.x, point.y - obb.c.y, point.z - obb.c.z);
    const uC = rel.dot(obb.ax[uIdx]);
    const yC = rel.dot(obb.ax[1]);

    const R = 4.8;
    const MIN_PIECE = 0.3;
    const uMin = -obb.he[uIdx], uMax = obb.he[uIdx];
    const yMin = -obb.he[1], yMax = obb.he[1];

    const pieces = [];
    const startU = uC - R;
    const endU = uC + R;

    if (startU > uMin + MIN_PIECE) pieces.push({ u: (uMin + startU) / 2, w: startU - uMin, y: 0, h: yMax - yMin });
    if (endU < uMax - MIN_PIECE) pieces.push({ u: (endU + uMax) / 2, w: endU - uMax, y: 0, h: yMax - yMin });

    const bandMinU = Math.max(uMin, startU);
    const bandMaxU = Math.min(uMax, endU);
    const bandW = bandMaxU - bandMinU;
    const bandMinY = Math.max(yMin, yC - R);
    const bandMaxY = Math.min(yMax, yC + R);

    if (bandW >= MIN_PIECE && bandMaxY - bandMinY >= MIN_PIECE) {
      if (bandMinY - yMin > MIN_PIECE) {
        pieces.push({ u: (bandMinU + bandMaxU) / 2, w: bandW, y: (yMin + bandMinY) / 2, h: bandMinY - yMin });
      }
      if (yMax - bandMaxY > MIN_PIECE) {
        pieces.push({ u: (bandMinU + bandMaxU) / 2, w: bandW, y: (bandMaxY + yMax) / 2, h: yMax - bandMaxY });
      }
    }

    for (let pIdx = 0; pIdx < pieces.length; pIdx++) {
      const p = pieces[pIdx];
      this.addWallFragment(obb, uIdx, p.u, p.y, p.w, p.h, pIdx, G);
    }

    if (!spawnDebris || (typeof document !== 'undefined' && document.hidden) || !G) return;

    const activeDebris = G.animObjects ? G.animObjects.filter(a => a.type === 'debris').length : 0;
    if (activeDebris > 60) return;
    const debrisCount = activeDebris > 30 ? 8 : 16;

    const mMat = G.getSlabMat ? G.getSlabMat('wall') : { mat: new THREE.MeshBasicMaterial(), edgeMat: new THREE.LineBasicMaterial() };
    const blastNormal = normal ? normal.clone() : new THREE.Vector3(0, 1, 0);
    const rr = (min, max) => min + Math.random() * (max - min);

    for (let i = 0; i < debrisCount; i++) {
      const bs = rr(0.9, 2.2);
      const bGeo = new THREE.BoxGeometry(bs, bs, bs);
      const bMesh = new THREE.Group();
      bMesh.add(new THREE.Mesh(bGeo, mMat.mat));
      bMesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(bGeo), mMat.edgeMat));

      const offset = new THREE.Vector3(rr(-3, 3), rr(-3, 3), rr(-3, 3));
      bMesh.position.copy(point).add(offset);
      G.scene.add(bMesh);

      const scatter = offset.clone().normalize().multiplyScalar(rr(4, 12));
      const vel = blastNormal.clone().multiplyScalar(rr(15, 35)).add(scatter);
      vel.y += rr(5, 15);

      const rot = new THREE.Vector3(rr(-15, 15), rr(-15, 15), rr(-15, 15));
      G.animObjects.push({ type: 'debris', obj: bMesh, vel, rot, life: 4.0 });
    }
  }

  loadMap(seedStr, context = null) {
    const G = context || this.engine?.context || window.__GAME_CONTEXT__;
    this.currentSeed = seedStr;
    if (G) G.currentSeed = seedStr;

    this.clear(G);

    if (G && G.portals) {
      for (const P of G.portals) {
        P.placed = false;
        P.closing = false;
      }
      if (G.placePortalVisuals) G.placePortalVisuals();
    }

    const map = generateMap(seedStr);
    this.worldGroup = new THREE.Group();
    if (G && G.scene) {
      G.scene.add(this.worldGroup);
      G.worldGroup = this.worldGroup;
    }

    const geoBatches = {}, edgeBatches = {};
    let slabIdx = 0;

    for (const rec of map.slabs) {
      const [sx, sy, sz] = rec.s;
      const baseGeo = new THREE.BoxGeometry(sx, sy, sz);
      const edgeGeo = new THREE.EdgesGeometry(baseGeo);
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(...rec.c),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rec.ry || 0, rec.rz || 0, 'YZX')),
        new THREE.Vector3(1, 1, 1)
      );
      baseGeo.applyMatrix4(m);
      edgeGeo.applyMatrix4(m);
      const kind = rec.kind || 'plat';

      let meshObj = null;
      if (kind === 'wall') {
        const mMat = G?.getSlabMat ? G.getSlabMat('wall') : { mat: new THREE.MeshBasicMaterial(), edgeMat: new THREE.LineBasicMaterial() };
        meshObj = new THREE.Group();
        meshObj.add(new THREE.Mesh(baseGeo, mMat.mat));
        meshObj.add(new THREE.LineSegments(edgeGeo, mMat.edgeMat));
        this.worldGroup.add(meshObj);
      } else if (kind === 'ramp') {
        // Handled via map.ramps
      } else {
        if (!geoBatches[kind]) geoBatches[kind] = [];
        if (!edgeBatches[kind]) edgeBatches[kind] = [];
        geoBatches[kind].push(baseGeo);
        edgeBatches[kind].push(edgeGeo);
      }

      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      const ax = [new THREE.Vector3(1, 0, 0).applyQuaternion(q), new THREE.Vector3(0, 1, 0).applyQuaternion(q), new THREE.Vector3(0, 0, 1).applyQuaternion(q)];
      const rad = Math.hypot(sx, sy, sz) / 2 + 3;
      const obbItem = {
        id: `slab_${slabIdx}`,
        slabIdx: slabIdx++,
        c: new THREE.Vector3(...rec.c),
        he: [sx / 2, sy / 2, sz / 2],
        ax,
        rad,
        kind,
        boundary: rec.boundary,
        noPortal: rec.noPortal,
        mesh: meshObj,
        ramp: rec.ramp
      };
      this.obbs.push(obbItem);
      if (G && G.obbs && G.obbs !== this.obbs) G.obbs.push(obbItem);
    }

    if (map.ramps) {
      for (const r of map.ramps) {
        const { geo, edges } = createCurvedRampGeo(r);
        if (!geoBatches['ramp']) geoBatches['ramp'] = [];
        if (!edgeBatches['ramp']) edgeBatches['ramp'] = [];
        geoBatches['ramp'].push(geo);
        edgeBatches['ramp'].push(edges);
      }
    }

    for (const kind in geoBatches) {
      const mergedGeo = mergeBufferGeometries(geoBatches[kind], true);
      const mergedEdges = mergeBufferGeometries(edgeBatches[kind], false);
      if (!mergedGeo) continue;
      const mats = G?.getSlabMat ? G.getSlabMat(kind) : { mat: new THREE.MeshBasicMaterial(), edgeMat: new THREE.LineBasicMaterial() };
      this.worldGroup.add(new THREE.Mesh(mergedGeo, mats.mat));
      this.worldGroup.add(new THREE.LineSegments(mergedEdges, mats.edgeMat));
    }

    renderGothicDecor(map, this.worldGroup, G?.animObjects);

    if (map.grabCubes.length > 0 && G) {
      G.grabCubes.length = 0;
      G.grabbedCube = null;
      const cubeGeo = new THREE.BoxGeometry(1.5, 1.5, 1.5, 4, 4, 4);
      const cubePos = cubeGeo.attributes.position;
      for (let i = 0; i < cubePos.count; i++) {
        const hw = 0.75 - 0.25;
        const x = cubePos.getX(i), y = cubePos.getY(i), z = cubePos.getZ(i);
        const cx = Math.max(-hw, Math.min(hw, x));
        const cy = Math.max(-hw, Math.min(hw, y));
        const cz = Math.max(-hw, Math.min(hw, z));
        const dx = x - cx, dy = y - cy, dz = z - cz;
        const len = Math.hypot(dx, dy, dz);
        if (len > 0.001) {
          cubePos.setXYZ(i, cx + (dx / len) * 0.25, cy + (dy / len) * 0.25, cz + (dz / len) * 0.25);
        }
      }
      cubeGeo.computeVertexNormals();
      const cubeEdgeGeo = new THREE.EdgesGeometry(cubeGeo, 15);
      const cMat = new THREE.MeshStandardMaterial({ color: 0x334455, emissive: 0x0088ff, emissiveIntensity: 0.6, metalness: 0.2, roughness: 0.4 });
      const eMat = new THREE.LineBasicMaterial({ color: 0x00ffff });

      G.instCubeMesh = new THREE.InstancedMesh(cubeGeo, cMat, map.grabCubes.length);
      G.instCubeEdges = new THREE.InstancedMesh(cubeEdgeGeo, eMat, map.grabCubes.length);
      G.instCubeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      G.instCubeEdges.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.worldGroup.add(G.instCubeMesh, G.instCubeEdges);

      for (let i = 0; i < map.grabCubes.length; i++) {
        const hc = map.grabCubes[i];
        const pos = new THREE.Vector3(...hc.c);
        G.grabCubes.push({ pos: pos.clone(), vel: new THREE.Vector3(0, 0, 0), rotVel: new THREE.Vector3(0, 0, 0), rad: 0.75, id: i, quat: new THREE.Quaternion() });
      }
    } else if (G) {
      G.grabCubes.length = 0;
      G.grabbedCube = null;
    }

    this.spawnPts = map.spawns.map(s => new THREE.Vector3(s.x, s.y, s.z));
    this.lavaPools = map.lava;
    this.hintZones = map.hints.map(h => ({ min: new THREE.Vector3(...h.min), max: new THREE.Vector3(...h.max), msg: h.msg }));

    if (G) {
      G.spawnPts = this.spawnPts;
      G.lavaPools = this.lavaPools;
      G.hintZones = this.hintZones;

      if (G.pl && this.spawnPts[0]) {
        G.pl.pos.copy(this.spawnPts[0]);
        G.pl.vel.set(0, 0, 0);
        G.pl.cp.copy(this.spawnPts[0]);
        G.pl.yaw = Math.atan2(-this.spawnPts[0].x, -this.spawnPts[0].z);
      }

      if (!G.match || G.match.phase !== 'summary' || G.isSpectator) {
        G.won = false;
        if (G.winPanel) G.winPanel.classList.add('hidden');
      }

      G.localReady = false;
      G.lastInstagibTime = -999;
      G.lastRocketTime = -999;

      const seedDom = G.dom ? G.dom('seedinfo') : (typeof document !== 'undefined' ? document.getElementById('seedinfo') : null);
      if (seedDom) seedDom.textContent = seedStr;

      if (G.prewarmFX) G.prewarmFX();
    }

    if (this.engine && this.engine.eventBus) {
      this.engine.eventBus.emit('MAP_LOADED', { seed: this.currentSeed, mapData: map });
    }

    return map;
  }

  resetWalls(seed, context = null) {
    const G = context || this.engine?.context || window.__GAME_CONTEXT__;
    const seedToUse = seed || this.currentSeed || (G ? G.currentSeed : '');
    if (!seedToUse || !G) return;

    const savePl = {
      pos: G.pl.pos.clone(),
      vel: G.pl.vel.clone(),
      cp: G.pl.cp.clone(),
      yaw: G.pl.yaw,
      pitch: G.pl.pitch,
      viewOffset: G.pl.viewOffset ? G.pl.viewOffset.clone() : null,
      maxSpeed: G.pl.maxSpeed,
      grounded: G.pl.grounded,
      jumpBuf: G.pl.jumpBuf
    };
    const saveWon = G.won;
    const saveReady = G.localReady;

    this.loadMap(seedToUse, G);

    if (!G.isSpectator && G.started) {
      G.pl.pos.copy(savePl.pos);
      G.pl.vel.copy(savePl.vel);
      G.pl.cp.copy(savePl.cp);
      G.pl.yaw = savePl.yaw;
      G.pl.pitch = savePl.pitch;
      G.pl.viewOffset = savePl.viewOffset;
      G.pl.maxSpeed = savePl.maxSpeed;
      G.pl.grounded = savePl.grounded;
      G.pl.jumpBuf = savePl.jumpBuf;
    }

    G.won = saveWon;
    G.localReady = saveReady;

    if (saveWon && !G.isSpectator && G.match && G.match.phase === 'summary') {
      if (G.winPanel) G.winPanel.classList.remove('hidden');
    }
  }

  newMap(s, context = null) {
    const G = context || this.engine?.context || window.__GAME_CONTEXT__;
    if (G && G.Network) {
      G.Network.send({ type: 'new_map', seed: s });
      if (G.menuPanel) G.menuPanel.classList.add('hidden');
      if (G.requestLock) G.requestLock();
    }
  }

  handleWallDestroyed(payload) {
    if (!payload) return;
    this.destroyedWalls.push(payload);
  }

  isPortalOnDestroyedWall(c, n, r, u) {
    const hw = PORT.hw, hh = PORT.hh;

    for (const dob of this.destroyedWallObbs) {
      const d = c.clone().sub(dob.c);
      const u0 = Math.abs(d.dot(dob.ax[0]));
      const u1 = Math.abs(d.dot(dob.ax[1]));
      const u2 = Math.abs(d.dot(dob.ax[2]));
      const ext0 = r && u ? (hw * Math.abs(r.dot(dob.ax[0])) + hh * Math.abs(u.dot(dob.ax[0]))) : hw;
      const ext1 = r && u ? (hw * Math.abs(r.dot(dob.ax[1])) + hh * Math.abs(u.dot(dob.ax[1]))) : hh;
      const ext2 = r && u ? (hw * Math.abs(r.dot(dob.ax[2])) + hh * Math.abs(u.dot(dob.ax[2]))) : hw;
      if (u0 <= dob.he[0] + ext0 + 0.2 &&
          u1 <= dob.he[1] + ext1 + 0.2 &&
          u2 <= dob.he[2] + ext2 + 0.2) {
        return true;
      }
    }

    for (const obb of this.obbs) {
      if (obb.kind === 'ramp') continue;
      if (obb.destroyed || obb.noPortal) {
        const d = c.clone().sub(obb.c);
        const u0 = Math.abs(d.dot(obb.ax[0]));
        const u1 = Math.abs(d.dot(obb.ax[1]));
        const u2 = Math.abs(d.dot(obb.ax[2]));
        const ext0 = r && u ? (hw * Math.abs(r.dot(obb.ax[0])) + hh * Math.abs(u.dot(obb.ax[0]))) : hw;
        const ext1 = r && u ? (hw * Math.abs(r.dot(obb.ax[1])) + hh * Math.abs(u.dot(obb.ax[1]))) : hh;
        const ext2 = r && u ? (hw * Math.abs(r.dot(obb.ax[2])) + hh * Math.abs(u.dot(obb.ax[2]))) : hw;
        if (u0 <= obb.he[0] + ext0 + 0.2 &&
            u1 <= obb.he[1] + ext1 + 0.2 &&
            u2 <= obb.he[2] + ext2 + 0.2) {
          return true;
        }
      }
    }

    for (const dw of this.destroyedWalls) {
      if (dw.point) {
        const pt = new THREE.Vector3(...dw.point);
        if (c.distanceTo(pt) < 5.4) return true;
      }
      if (dw.wallCenter) {
        const wc = new THREE.Vector3(...dw.wallCenter);
        if (c.distanceTo(wc) < 4.5) return true;
      }
    }

    return false;
  }
}

/**
 * Procedural backward compatibility wrapper for world subsystem.
 * @param {Object} G - Game state context
 */
export function initWorld(G) {
  const manager = G.worldManager || new WorldManager(G.engine || null);
  G.worldManager = manager;

  G.worldGroup = manager.worldGroup;
  G.obbs = manager.obbs;
  G.spawnPts = manager.spawnPts;
  G.lavaPools = manager.lavaPools;
  G.hintZones = manager.hintZones;
  G.destroyedWalls = manager.destroyedWalls;
  G.destroyedWallObbs = manager.destroyedWallObbs;
  G.animObjects = manager.animObjects;
  G.currentSeed = manager.currentSeed;

  G.clearWorld = () => manager.clear(G);
  G.loadMap = (seed) => manager.loadMap(seed, G);
  G.newMap = (s) => manager.newMap(s, G);
  G.destroyWall = (obb, pt, n, b, s) => manager.destroyWall(obb, pt, n, b, s, G);
  G.resetWalls = (seed) => manager.resetWalls(seed, G);
  G.isPortalOnDestroyedWall = (c, n, r, u) => manager.isPortalOnDestroyedWall(c, n, r, u);

  return manager;
}
