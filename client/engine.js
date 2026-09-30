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
  scene.fog = new TH.Fog(0x1c2a44, 100, 300);

  const camera = new TH.PerspectiveCamera(115, innerWidth / innerHeight, 0.001, 300);
  camera.layers.enable(2);
  
  const skyGroup = new TH.Group(); 
  scene.add(skyGroup);

  /* lights */
  scene.add(new TH.HemisphereLight(0x8fb4e8, 0x3a4a66, 1.1));
  const sun = new TH.DirectionalLight(0xfff2dc, 1.9); 
  sun.position.set(36, 64, 22); 
  scene.add(sun);
  const rimL = new TH.DirectionalLight(0x7fa8ff, 0.8); 
  rimL.position.set(-48, 18, -34); 
  scene.add(rimL);
  scene.add(new TH.AmbientLight(0x9fb8ff, 0.35));

  /* environment reflections (procedural) */
  try {
    const pmrem = new TH.PMREMGenerator(renderer);
    const envScene = new TH.Scene();
    const g = new TH.BoxGeometry(1, 1, 1);
    const addEnv = (col, pos, sc) => {
      const m = new TH.Mesh(g, new TH.MeshBasicMaterial({ color: col }));
      m.position.set(...pos); m.scale.set(...sc); envScene.add(m);
    };
    addEnv(0x0a1428, [0, 0, 0], [400, 400, 400]);
    addEnv(0x2eeaff, [-60, 90, -40], [120, 0.5, 120]);
    addEnv(0xff9a3d, [70, 40, 60], [80, 0.5, 80]);
    addEnv(0x8f6bff, [0, -80, 0], [200, 0.5, 200]);
    scene.environment = pmrem.fromScene(envScene, 0.04).texture;
    pmrem.dispose();
  } catch { /* older three: skip env map */ }

  scene.background = new TH.Color(0x1c2a44);

  return { renderer, scene, camera, skyGroup };
}


