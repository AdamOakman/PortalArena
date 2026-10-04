export function initEngine(TH, canvas) {
  const renderer = new TH.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  if ('outputColorSpace' in renderer) renderer.outputColorSpace = TH.SRGBColorSpace;
  else if (TH.sRGBEncoding) renderer.outputEncoding = TH.sRGBEncoding;
  renderer.toneMapping = TH.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  renderer.localClippingEnabled = true;

  const scene = new TH.Scene();
  scene.fog = new TH.Fog(0x251c4a, 30, 140);

  const camera = new TH.PerspectiveCamera(115, innerWidth / innerHeight, 0.02, 300);
  camera.layers.enable(2);
  
  const skyGroup = new TH.Group(); 
  scene.add(skyGroup);

  /* lights — moonlit night over a gothic arena */
  scene.add(new TH.HemisphereLight(0x4a4a72, 0x1c1826, 1.5));
  const moon = new TH.DirectionalLight(0x99a2d4, 1.5);
  moon.position.set(60, 90, -40);
  scene.add(moon);
  const rimL = new TH.DirectionalLight(0x4a3566, 0.7);
  rimL.position.set(-48, 18, -34);
  scene.add(rimL);
  scene.add(new TH.AmbientLight(0x3a3650, 1.2));

  /* environment reflections (procedural) */
  try {
    const pmrem = new TH.PMREMGenerator(renderer);
    const envScene = new TH.Scene();
    const g = new TH.BoxGeometry(1, 1, 1);
    const addEnv = (col, pos, sc) => {
      const m = new TH.Mesh(g, new TH.MeshBasicMaterial({ color: col }));
      m.position.set(...pos); m.scale.set(...sc); envScene.add(m);
    };
    addEnv(0x07070d, [0, 0, 0], [400, 400, 400]);
    addEnv(0xff5a1a, [0, -40, 0], [200, 0.5, 200]);   // lava glow from below
    addEnv(0x2a1a3a, [-80, 60, -60], [100, 0.5, 100]);  // faint moon
    addEnv(0x111018, [80, 40, 60], [80, 0.5, 80]);
    scene.environment = pmrem.fromScene(envScene, 0.04).texture;
    pmrem.dispose();
  } catch { /* older three: skip env map */ }

  scene.background = new TH.Color(0x171233); // dark violet

  /* ------------------------------------------------------------- sky decor
     Flat moon, starfield and drifting clouds on a camera-centered dome.
     skyGroup is re-aimed at the eye each frame (main view) and at the
     virtual camera for portal views, so the sky renders in both — through
     a portal it appears mirror-rotated, like a real skybox. Sky materials
     opt out of the portal clip plane (clippingPlanes = []) and of fog. */
  const SKY_R = 250; // dome radius, inside the 300 far plane

  function softDotTex(size, a, b) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gr.addColorStop(0, a); gr.addColorStop(1, b);
    g.fillStyle = gr; g.fillRect(0, 0, size, size);
    const t = new TH.CanvasTexture(c);
    if ('colorSpace' in t) t.colorSpace = TH.SRGBColorSpace;
    return t;
  }

  // flat moon — billboard sprite, always faces the viewer
  const moonSprite = new TH.Sprite(new TH.SpriteMaterial({
    map: softDotTex(128, 'rgba(238,235,255,1)', 'rgba(150,145,205,0)'),
    transparent: true, depthWrite: false, fog: false, clippingPlanes: []
  }));
  moonSprite.scale.set(30, 30, 1);
  moonSprite.position.set(0.42, 0.58, -0.7).normalize().multiplyScalar(SKY_R);
  skyGroup.add(moonSprite);

  // stars — soft round points on the dome, upper-hemisphere biased
  const STAR_COUNT = 400;
  const starPos = new Float32Array(STAR_COUNT * 3);
  const starCol = new Float32Array(STAR_COUNT * 3);
  const _sd = new TH.Vector3(), _sc = new TH.Color();
  for (let i = 0; i < STAR_COUNT; i++) {
    do { _sd.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1); }
    while (_sd.lengthSq() > 1 || _sd.lengthSq() < 0.01);
    if (Math.random() < 0.75) _sd.y = Math.abs(_sd.y);
    _sd.normalize().multiplyScalar(SKY_R * (0.92 + Math.random() * 0.08));
    starPos[i * 3] = _sd.x; starPos[i * 3 + 1] = _sd.y; starPos[i * 3 + 2] = _sd.z;
    const b = 0.35 + Math.random() * 0.65;
    _sc.setRGB(b, b, Math.min(1, b * 1.15)); // cool white-blue
    starCol[i * 3] = _sc.r; starCol[i * 3 + 1] = _sc.g; starCol[i * 3 + 2] = _sc.b;
  }
  const starGeo = new TH.BufferGeometry();
  starGeo.setAttribute('position', new TH.BufferAttribute(starPos, 3));
  starGeo.setAttribute('color', new TH.BufferAttribute(starCol, 3));
  const stars = new TH.Points(starGeo, new TH.PointsMaterial({
    size: 2.4, map: softDotTex(32, 'rgba(255,255,255,1)', 'rgba(255,255,255,0)'),
    vertexColors: true, transparent: true, depthWrite: false,
    sizeAttenuation: true, fog: false, clippingPlanes: []
  }));
  stars.frustumCulled = false; // dome surrounds the eye — never frustum-cull
  skyGroup.add(stars);

  // flat clouds — billboard sprites drifting across the dome, fading at the wrap seam
  const cloudTex = (() => {
    const c = document.createElement('canvas'); c.width = 192; c.height = 96;
    const g = c.getContext('2d');
    for (let i = 0; i < 7; i++) {
      const x = 20 + Math.random() * 152, y = 30 + Math.random() * 36, r = 18 + Math.random() * 22;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(255,255,255,0.55)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    const t = new TH.CanvasTexture(c);
    if ('colorSpace' in t) t.colorSpace = TH.SRGBColorSpace;
    return t;
  })();
  const clouds = [];
  for (let i = 0; i < 9; i++) {
    const s = new TH.Sprite(new TH.SpriteMaterial({
      map: cloudTex, color: 0x9a90c8, transparent: true,
      depthWrite: false, fog: false, clippingPlanes: []
    }));
    const w = 60 + Math.random() * 70;
    s.scale.set(w, w * (0.35 + Math.random() * 0.2), 1);
    const base = new TH.Vector3(Math.random() * 2 - 1, 0.12 + Math.random() * 0.4, Math.random() * 2 - 1)
      .normalize().multiplyScalar(SKY_R * 0.95);
    const cl = { s, base, speed: 4 + Math.random() * 7, phase: Math.random() * SKY_R * 2, op: 0.14 + Math.random() * 0.14 };
    s.material.opacity = cl.op;
    s.position.copy(base);
    clouds.push(cl);
    skyGroup.add(s);
  }

  function updateSky(t) {
    for (const cl of clouds) {
      const x = ((cl.base.x + cl.phase + t * cl.speed) % (SKY_R * 2) + SKY_R * 2) % (SKY_R * 2) - SKY_R;
      cl.s.position.x = x;
      const f = Math.max(0.15, Math.min(1, (x + SKY_R) / (SKY_R * 0.25), (SKY_R - x) / (SKY_R * 0.25)));
      cl.s.material.opacity = cl.op * f;
    }
  }

  return { renderer, scene, camera, skyGroup, updateSky };
}
