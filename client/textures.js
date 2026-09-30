export function initTextures(TH) {
  function gridTexture(base, line, glow, alpha) {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = base; g.fillRect(0, 0, 512, 512);
    g.strokeStyle = line; g.lineWidth = 3; g.globalAlpha = 0.9;
    for (let i = 0; i <= 8; i++) { const p = i * 64 + 0.5; g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 512); g.moveTo(0, p); g.lineTo(512, p); g.stroke(); }
    g.globalAlpha = 0.35; g.lineWidth = 1;
    for (let i = 0; i <= 32; i++) { const p = i * 16 + 0.5; g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 512); g.moveTo(0, p); g.lineTo(512, p); g.stroke(); }
    g.globalAlpha = alpha; g.fillStyle = glow;
    for (let i = 0; i <= 8; i++) { const p = i * 64 - 1.5; g.fillRect(p, 0, 3, 512); g.fillRect(0, p, 512, 3); }
    const t = new TH.CanvasTexture(c);
    t.wrapS = t.wrapT = TH.RepeatWrapping;
    if ('colorSpace' in t) t.colorSpace = TH.SRGBColorSpace;
    return t;
  }

  function makeSlabMat(kind) {
    const defs = {
      plat:   { base: '#1a2f4d', line: '#3f86c4', glow: '#4df0ff', emissive: 0x2fb4dd, edge: 0x2eeaff },
      ramp:   { base: '#2b2547', line: '#7a63b8', glow: '#c98cff', emissive: 0x9a5df0, edge: 0xb45cff },
      wall:   { base: '#22314e', line: '#4d6ea0', glow: '#7ab4ff', emissive: 0x4a86e8, edge: 0x4a9aff },
      gantry: { base: '#3a2b22', line: '#a0763f', glow: '#ffb45c', emissive: 0xf08c32, edge: 0xff9a3d },
      tower:  { base: '#16304e', line: '#3f7fa8', glow: '#4df0ff', emissive: 0x28a0d8, edge: 0x6adfff },
    };
    const d = defs[kind] || defs.plat;
    const tex = gridTexture(d.base, d.line, d.glow, 0.22);
    tex.repeat.set(2.5, 2.5);
    return { mat: new TH.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: d.emissive, emissiveIntensity: 0.85, metalness: 0.45, roughness: 0.3, envMapIntensity: 1.3 }), edge: d.edge };
  }
  
  const matCache = {};
  function getSlabMat(kind) {
    if (matCache[kind]) return matCache[kind];
    const defs = {
      plat:   { base: '#1a2f4d', line: '#3f86c4', glow: '#4df0ff', emissive: 0x2fb4dd, edge: 0x2eeaff },
      ramp:   { base: '#2b2547', line: '#7a63b8', glow: '#c98cff', emissive: 0x9a5df0, edge: 0xb45cff },
      wall:   { base: '#22314e', line: '#4d6ea0', glow: '#7ab4ff', emissive: 0x4a86e8, edge: 0x4a9aff },
      gantry: { base: '#3a2b22', line: '#a0763f', glow: '#ffb45c', emissive: 0xf08c32, edge: 0xff9a3d },
      tower:  { base: '#16304e', line: '#3f7fa8', glow: '#4df0ff', emissive: 0x28a0d8, edge: 0x6adfff },
      jumppad:{ base: '#1a4d1a', line: '#3fc43f', glow: '#4dff4d', emissive: 0x2fdd2f, edge: 0x2eff2e },
    };
    const d = defs[kind] || defs.plat;
    const tex = gridTexture(d.base, d.line, d.glow, 0.22);
    tex.repeat.set(2.5, 2.5);
    const mat = new TH.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: d.emissive, emissiveIntensity: 0.85, metalness: 0.45, roughness: 0.3, envMapIntensity: 1.3 });
    const edgeMat = new TH.LineBasicMaterial({ color: d.edge, transparent: true, opacity: 0.42 });
    matCache[kind] = { mat, edgeMat };
    return matCache[kind];
  }

  return { makeSlabMat, getSlabMat, gridTexture };
}
