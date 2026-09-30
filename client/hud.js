export function initHUD(document) {
  const dom = id => document.getElementById(id);
  const hud = { 
    speed: dom('speedval'), 
    fill: dom('barfill'), 
    hint: dom('hint'), 
    dist: dom('exitdist'), 
    compass: dom('compass'), 
    timer: dom('timer'), 
    aim: dom('aimring'),
    winstats: dom('winstats')
  };
  let lastHintMsg = '';

  function updateHUD(state) {
    const { pl, CFG, currentSeed, portalsFired, exitPos, hit, won, mm, ss, ms, msg } = state;
    
    // Speed
    const sp = pl.vel.length();
    hud.speed.innerHTML = Math.round(sp * 10) + '<span>u/s</span>';
    hud.fill.style.width = Math.min(100, (sp / 34) * 100) + '%';
    hud.fill.classList.toggle('hot', sp > CFG.GMAX + 2);
    
    // Exit Dist & Compass
    let d = 0, rel = 0;
    if (exitPos) {
      d = pl.pos.distanceTo(exitPos);
      const dx = exitPos.x - pl.pos.x, dz = exitPos.z - pl.pos.z;
      const ang = Math.atan2(dx, dz);
      rel = pl.yaw - ang;
    }
    hud.dist.textContent = Math.round(d);
    hud.compass.style.transform = 'rotate(' + (-rel) + 'rad)';
    
    // Timer
    if (mm !== undefined) {
      hud.timer.textContent = `${mm}:${ss}.${ms}`;
    }
    
    // Hint
    if (msg !== lastHintMsg) { 
      hud.hint.textContent = msg; 
      hud.hint.style.display = msg ? '' : 'none'; 
      lastHintMsg = msg; 
    }
    
    // Aimring
    hud.aim.classList.toggle('valid', !!hit);

    if (won && hud.winstats) {
      hud.winstats.innerHTML = `time <b>${hud.timer.textContent}</b>   max speed <b>${Math.round(pl.maxSpeed * 10)} u/s</b>   portals fired <b>${portalsFired}</b>   seed <b>${currentSeed}</b>`;
    }
  }

  return { updateHUD };
}

