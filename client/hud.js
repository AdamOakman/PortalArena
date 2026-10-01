function fmtTime(t, tenths) {
  const v = Math.max(0, t);
  const m = String(Math.floor(v / 60)).padStart(2, '0');
  const s = String(Math.floor(v % 60)).padStart(2, '0');
  return tenths ? `${m}:${s}.${String(Math.floor((v % 1) * 10))}` : `${m}:${s}`;
}

export function initHUD(document) {
  const dom = id => document.getElementById(id);
  const hud = { 
    speed: dom('speedval'), 
    fill: dom('barfill'), 
    hint: dom('hint'), 
    dist: dom('exitdist'), 
    compass: dom('compass'), 
    matchtimer: dom('matchtimer'),
    nameA: dom('nameA'),
    nameB: dom('nameB'),
    scoreA: dom('scoreA'),
    scoreB: dom('scoreB'),
    readyA: dom('readyA'),
    readyB: dom('readyB'),
    aim: dom('aimring'),
    winstats: dom('winstats'),
    statsboard: dom('statsboard'),
    statsbody: dom('statsbody')
  };
  let lastHintMsg = '';

  // Seat map from the server match snapshot: seat 0 = left, seat 1 = right
  function seats(match) {
    const seat = { 0: null, 1: null };
    for (const pid in match.players) {
      const p = match.players[pid];
      if (p.index === 0 || p.index === 1) seat[p.index] = Object.assign({ pid }, p);
    }
    return seat;
  }

  function setReadyRow(el, p, isLocal, localReady) {
    if (isLocal) {
      el.textContent = localReady ? 'READY' : 'PRESS R';
      el.classList.toggle('on', localReady);
    } else if (p) {
      el.textContent = p.ready ? 'READY' : 'NOT READY';
      el.classList.toggle('on', p.ready);
    } else {
      el.textContent = 'AWAITING PLAYER';
      el.classList.remove('on');
    }
  }

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let lastStatsT = -1e9;
  function renderStats(match, statsOpen, localPid) {
    if (!hud.statsboard) return;
    if (!statsOpen || !match) { hud.statsboard.classList.add('hidden'); return; }
    hud.statsboard.classList.remove('hidden');
    const now = performance.now();
    if (now - lastStatsT < 100) return;
    lastStatsT = now;
    const rows = Object.keys(match.players).map(pid => ({ pid, p: match.players[pid] }))
      .sort((a, b) => (b.p.score - a.p.score) || (b.p.hits - a.p.hits) || String(a.p.name).localeCompare(String(b.p.name)));
    hud.statsbody.innerHTML = rows.map((r, i) =>
      `<tr class="${r.pid === localPid ? 'me' : ''}"><td>${i + 1}</td><td>${esc(r.p.name)}</td><td>${r.p.ping} ms</td><td>${r.p.acc}%</td><td>${r.p.score}</td></tr>`
    ).join('');
  }

  function updateHUD(state) {
    const { pl, CFG, currentSeed, exitPos, hit, msg, match, localReady, localIndex, statsOpen, localPid } = state;
    
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
    if (hud.dist) hud.dist.textContent = Math.round(d);
    if (hud.compass) hud.compass.style.transform = 'rotate(' + (-rel) + 'rad)';
    
    // Match bar: names, scores, countdown, ready state
    if (match && hud.matchtimer) {
      const seat = seats(match);
      const A = seat[0], B = seat[1];
      hud.nameA.textContent = A ? A.name : '—';
      hud.nameB.textContent = B ? B.name : '—';
      hud.scoreA.textContent = A ? A.score : 0;
      hud.scoreB.textContent = B ? B.score : 0;

      if (match.phase === 'waiting') {
        hud.matchtimer.textContent = 'WAITING FOR OPPONENT';
        hud.matchtimer.classList.add('dim');
        setReadyRow(hud.readyA, A, localIndex === 0, localReady);
        setReadyRow(hud.readyB, B, localIndex === 1, localReady);
      } else if (match.phase === 'warmup') {
        hud.matchtimer.textContent = 'WARMUP ' + fmtTime(match.timeLeft, false);
        hud.matchtimer.classList.add('dim');
        setReadyRow(hud.readyA, A, localIndex === 0, localReady);
        setReadyRow(hud.readyB, B, localIndex === 1, localReady);
      } else if (match.phase === 'active') {
        hud.matchtimer.textContent = fmtTime(match.timeLeft, true);
        hud.matchtimer.classList.remove('dim');
        hud.readyA.textContent = ''; hud.readyA.classList.remove('on');
        hud.readyB.textContent = ''; hud.readyB.classList.remove('on');
      } else { // summary
        hud.matchtimer.textContent = '00:00.0';
        hud.matchtimer.classList.add('dim');
        hud.readyA.textContent = ''; hud.readyA.classList.remove('on');
        hud.readyB.textContent = ''; hud.readyB.classList.remove('on');
      }
    }
    
    // Hint
    if (msg !== lastHintMsg) { 
      hud.hint.textContent = msg; 
      hud.hint.style.display = msg ? '' : 'none'; 
      lastHintMsg = msg; 
    }
    
    // Aimring
    hud.aim.classList.toggle('valid', !!hit);

    if (match && match.phase === 'summary' && hud.winstats) {
      const seat = seats(match);
      const A = seat[0], B = seat[1];
      const rw = match.roundWins || {};
      const rwA = (A && rw[A.pid]) || 0;
      const rwB = (B && rw[B.pid]) || 0;
      hud.winstats.innerHTML =
        `<span style="display:block;font-size:15px">${A ? A.name : '—'} <b style="font-size:20px">${A ? A.score : 0}</b> kills</span>` +
        `<span style="display:block;font-size:15px">${B ? B.name : '—'} <b style="font-size:20px">${B ? B.score : 0}</b> kills</span>` +
        `<span style="display:block;font-size:13px;color:#8fb6d6;margin-top:8px">rounds won ${rwA} – ${rwB} · seed <b>${currentSeed}</b></span>`;
    }
    renderStats(match, statsOpen, localPid);
  }

  return { updateHUD };
}
