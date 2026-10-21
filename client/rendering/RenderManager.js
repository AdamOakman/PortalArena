import * as THREE from 'three';

/**
 * RenderManager — Subsystem encapsulating Three.js renderer, scene graph, camera, and atmosphere.
 */
export class RenderManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    if ('outputColorSpace' in this.renderer) {
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    }
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.renderer.localClippingEnabled = true;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x251c4a, 30, 140);
    this.scene.background = new THREE.Color(0x171233);

    this.camera = new THREE.PerspectiveCamera(115, window.innerWidth / window.innerHeight, 0.02, 300);
    this.camera.layers.enable(2);

    this.skyGroup = new THREE.Group();
    this.scene.add(this.skyGroup);

    this._setupLighting();
    this._setupSky();

    window.addEventListener('resize', () => this.onResize());
  }

  _setupLighting() {
    this.scene.add(new THREE.HemisphereLight(0x4a4a72, 0x1c1826, 1.5));
    const moon = new THREE.DirectionalLight(0x99a2d4, 1.5);
    moon.position.set(60, 90, -40);
    this.scene.add(moon);

    const rimL = new THREE.DirectionalLight(0x4a3566, 0.7);
    rimL.position.set(-48, 18, -34);
    this.scene.add(rimL);

    this.scene.add(new THREE.AmbientLight(0x3a3650, 1.2));
  }

  _setupSky() {
    const SKY_R = 250;
    const dotTex = (size, a, b) => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      gr.addColorStop(0, a);
      gr.addColorStop(1, b);
      g.fillStyle = gr;
      g.fillRect(0, 0, size, size);
      const t = new THREE.CanvasTexture(c);
      if ('colorSpace' in t) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };

    // Moon sprite
    const moonSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: dotTex(128, 'rgba(238,235,255,1)', 'rgba(150,145,205,0)'),
      transparent: true,
      depthWrite: false,
      fog: false,
      clippingPlanes: []
    }));
    moonSprite.scale.set(30, 30, 1);
    moonSprite.position.set(0.42, 0.58, -0.7).normalize().multiplyScalar(SKY_R);
    this.skyGroup.add(moonSprite);

    // Stars
    const STAR_COUNT = 400;
    const starPos = new Float32Array(STAR_COUNT * 3);
    const starCol = new Float32Array(STAR_COUNT * 3);
    const sd = new THREE.Vector3();
    const sc = new THREE.Color();

    for (let i = 0; i < STAR_COUNT; i++) {
      do {
        sd.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
      } while (sd.lengthSq() > 1 || sd.lengthSq() < 0.01);

      if (Math.random() < 0.75) sd.y = Math.abs(sd.y);
      sd.normalize().multiplyScalar(SKY_R * (0.92 + Math.random() * 0.08));
      starPos[i * 3] = sd.x;
      starPos[i * 3 + 1] = sd.y;
      starPos[i * 3 + 2] = sd.z;

      const b = 0.35 + Math.random() * 0.65;
      sc.setRGB(b, b, Math.min(1, b * 1.15));
      starCol[i * 3] = sc.r;
      starCol[i * 3 + 1] = sc.g;
      starCol[i * 3 + 2] = sc.b;
    }

    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    starGeo.setAttribute('color', new THREE.BufferAttribute(starCol, 3));
    const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
      size: 2.4,
      map: dotTex(32, 'rgba(255,255,255,1)', 'rgba(255,255,255,0)'),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true,
      fog: false,
      clippingPlanes: []
    }));
    stars.frustumCulled = false;
    this.skyGroup.add(stars);

    // Drifting clouds
    const cloudTex = (() => {
      const c = document.createElement('canvas');
      c.width = 192;
      c.height = 96;
      const g = c.getContext('2d');
      for (let i = 0; i < 7; i++) {
        const x = 20 + Math.random() * 152, y = 30 + Math.random() * 36, r = 18 + Math.random() * 22;
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, 'rgba(255,255,255,0.55)');
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr;
        g.fillRect(x - r, y - r, r * 2, r * 2);
      }
      const t = new THREE.CanvasTexture(c);
      if ('colorSpace' in t) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();

    this.clouds = [];
    for (let i = 0; i < 9; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: cloudTex,
        color: 0x9a90c8,
        transparent: true,
        depthWrite: false,
        fog: false,
        clippingPlanes: []
      }));
      const w = 60 + Math.random() * 70;
      s.scale.set(w, w * (0.35 + Math.random() * 0.2), 1);
      const base = new THREE.Vector3(Math.random() * 2 - 1, 0.12 + Math.random() * 0.4, Math.random() * 2 - 1)
        .normalize().multiplyScalar(SKY_R * 0.95);
      const cl = { s, base, speed: 4 + Math.random() * 7, phase: Math.random() * SKY_R * 2, op: 0.14 + Math.random() * 0.14 };
      s.material.opacity = cl.op;
      s.position.copy(base);
      this.clouds.push(cl);
      this.skyGroup.add(s);
    }
  }

  updateSky(t) {
    const SKY_R = 250;
    if (!this.clouds) return;
    for (const cl of this.clouds) {
      const x = ((cl.base.x + cl.phase + t * cl.speed) % (SKY_R * 2) + SKY_R * 2) % (SKY_R * 2) - SKY_R;
      cl.s.position.x = x;
      const f = Math.max(0.15, Math.min(1, (x + SKY_R) / (SKY_R * 0.25), (SKY_R - x) / (SKY_R * 0.25)));
      cl.s.material.opacity = cl.op * f;
    }
  }

  onResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  render() {
    this.renderer.autoClear = true;
    this.camera.layers.enable(0);
    this.camera.layers.enable(2);
    this.renderer.render(this.scene, this.camera);
  }
}

export function initEngine(TH, canvas) {
  const manager = new RenderManager(canvas);
  return {
    renderManager: manager,
    renderer: manager.renderer,
    scene: manager.scene,
    camera: manager.camera,
    skyGroup: manager.skyGroup,
    updateSky: (t) => manager.updateSky(t)
  };
}

