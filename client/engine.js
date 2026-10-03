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
  scene.fog = new TH.Fog(0x211c3d, 30, 140);

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

  scene.background = new TH.Color(0x191631);

  return { renderer, scene, camera, skyGroup };
}





