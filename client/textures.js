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

  // Dark medieval gothic stone palette (brightened for legibility)
  const wallDef = { base: '#4b221c', line: '#6b3328', glow: '#5c3222', emissive: 0x1a0d06, edge: 0x7a4438 };
  const defs = {
     plat:   { base: '#4a241d', line: '#6b3328', glow: '#6a4526', emissive: 0x20100a, edge: 0x7a4438 },
    ramp:   wallDef, // ramps match the walls
    wall:   wallDef,
  };

  const matCache = {};
  function getSlabMat(kind) {
    if (matCache[kind]) return matCache[kind];
    if (kind === 'lava') {
      const mat = new TH.MeshStandardMaterial({
        color: 0x1a0502, emissive: 0xff3300, emissiveIntensity: 1.7,
        metalness: 0.1, roughness: 0.4
      });
      matCache[kind] = { mat, edgeMat: new TH.LineBasicMaterial({ color: 0xff6a2a, transparent: true, opacity: 0.6 }) };
      return matCache[kind];
    }
    const d = defs[kind] || defs.plat;
    const tex = gridTexture(d.base, d.line, d.glow, 0.14);
    tex.repeat.set(2.5, 2.5);
    const mat = new TH.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: d.emissive, emissiveIntensity: 0.8, metalness: 0.25, roughness: 0.75 });
    const edgeMat = new TH.LineBasicMaterial({ color: d.edge, transparent: true, opacity: 0.42 });
    matCache[kind] = { mat, edgeMat };
    return matCache[kind];
  }

  return { getSlabMat, gridTexture };
}
