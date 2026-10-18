import * as THREE from 'three';

/**
 * TextureFactory — Factory pattern for generating procedural arena textures and materials.
 */
export class TextureFactory {
  constructor() {
    this.matCache = new Map();

    const wallDef = { base: '#4b221c', line: '#6b3328', glow: '#5c3222', emissive: 0x1a0d06, edge: 0x7a4438 };
    this.defs = {
      plat: { base: '#4a241d', line: '#6b3328', glow: '#6a4526', emissive: 0x20100a, edge: 0x7a4438 },
      ramp: wallDef,
      wall: wallDef
    };
  }

  createGridTexture(base, line, glow, alpha) {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = base;
    g.fillRect(0, 0, 512, 512);
    g.strokeStyle = line;
    g.lineWidth = 3;
    g.globalAlpha = 0.9;

    for (let i = 0; i <= 8; i++) {
      const p = i * 64 + 0.5;
      g.beginPath();
      g.moveTo(p, 0); g.lineTo(p, 512);
      g.moveTo(0, p); g.lineTo(512, p);
      g.stroke();
    }

    g.globalAlpha = 0.35;
    g.lineWidth = 1;
    for (let i = 0; i <= 32; i++) {
      const p = i * 16 + 0.5;
      g.beginPath();
      g.moveTo(p, 0); g.lineTo(p, 512);
      g.moveTo(0, p); g.lineTo(512, p);
      g.stroke();
    }

    g.globalAlpha = alpha;
    g.fillStyle = glow;
    for (let i = 0; i <= 8; i++) {
      const p = i * 64 - 1.5;
      g.fillRect(p, 0, 3, 512);
      g.fillRect(0, p, 512, 3);
    }

    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if ('colorSpace' in t) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  createStoneTexture(base, grain) {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = base;
    g.fillRect(0, 0, 512, 512);

    const rng = (s) => {
      const v = Math.sin(s) * 43758.5453;
      return v - Math.floor(v);
    };

    // Soft stone clouding
    for (let i = 0; i < 48; i++) {
      const cx = rng(i * 17.3 + 1) * 512;
      const cy = rng(i * 31.7 + 2) * 512;
      const rad = 30 + rng(i * 53.1 + 3) * 70;
      const grad = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
      grad.addColorStop(0, grain);
      grad.addColorStop(1, 'transparent');
      g.globalAlpha = 0.12;
      g.fillStyle = grad;
      g.beginPath();
      g.arc(cx, cy, rad, 0, Math.PI * 2);
      g.fill();
    }

    // Fine organic stone grain
    g.fillStyle = grain;
    for (let i = 0; i < 300; i++) {
      const x = rng(i * 73.1 + 5) * 512;
      const y = rng(i * 119.3 + 7) * 512;
      const r = 0.8 + rng(i * 39.7 + 9) * 2.2;
      g.globalAlpha = 0.06 + rng(i * 23.3) * 0.10;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }

    // Subtle dark pores
    g.fillStyle = '#140a05';
    for (let i = 0; i < 120; i++) {
      const x = rng(i * 163.7 + 11) * 512;
      const y = rng(i * 229.1 + 13) * 512;
      const r = 0.6 + rng(i * 89.3 + 17) * 1.6;
      g.globalAlpha = 0.14;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }

    g.globalAlpha = 1.0;
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if ('colorSpace' in t) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  getSlabMaterial(kind) {
    if (this.matCache.has(kind)) return this.matCache.get(kind);

    if (kind === 'lava') {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x1a0502,
        emissive: 0xff3300,
        emissiveIntensity: 1.7,
        metalness: 0.1,
        roughness: 0.4
      });
      const res = {
        mat,
        edgeMat: new THREE.LineBasicMaterial({ color: 0xff6a2a, transparent: true, opacity: 0.6 })
      };
      this.matCache.set(kind, res);
      return res;
    }

    const d = this.defs[kind] || this.defs.plat;
    const tex = this.createStoneTexture(d.base, d.line);
    tex.repeat.set(2.5, 2.5);

    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      emissiveMap: tex,
      emissive: d.emissive,
      emissiveIntensity: 0.8,
      metalness: 0.25,
      roughness: 0.75
    });

    const edgeMat = new THREE.LineBasicMaterial({ color: d.edge, transparent: true, opacity: 0.12 });
    const res = { mat, edgeMat };
    this.matCache.set(kind, res);
    return res;
  }

  getSlabMat(kind) {
    return this.getSlabMaterial(kind);
  }

  gridTexture(base, line, glow, alpha) {
    return this.createGridTexture(base, line, glow, alpha);
  }

  stoneTexture(base, grain) {
    return this.createStoneTexture(base, grain);
  }

  dispose() {
    for (const item of this.matCache.values()) {
      if (item.mat) item.mat.dispose();
      if (item.edgeMat) item.edgeMat.dispose();
    }
    this.matCache.clear();
  }
}

export function initTextures() {
  const factory = new TextureFactory();
  return {
    textureFactory: factory,
    getSlabMat: (kind) => factory.getSlabMaterial(kind),
    gridTexture: (...args) => factory.createGridTexture(...args),
    stoneTexture: (...args) => factory.createStoneTexture(...args)
  };
}

