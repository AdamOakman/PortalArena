import { AudioSys } from './audio.js';

function fmtTime(t, tenths) {
  const v = Math.max(0, t);
  const m = String(Math.floor(v / 60)).padStart(2, '0');
  const s = String(Math.floor(v % 60)).padStart(2, '0');
  return tenths ? `${m}:${s}.${String(Math.floor((v % 1) * 10))}` : `${m}:${s}`;
}

export function initHUD(document) {
  const dom = id => document.getElementById(id);
  const countdownEl = dom('countdown');
  let countdownTimer = null;

  function showCountdown() {
    if (!countdownEl) return;
    if (countdownTimer) {
      clearTimeout(countdownTimer);
      countdownTimer = null;
    }
    const steps = [
      { text: '3', isFight: false, f0: 320, f1: 260, dur: 0.18, type: 'triangle', vol: 0.18 },
      { text: '2', isFight: false, f0: 360, f1: 300, dur: 0.18, type: 'triangle', vol: 0.18 },
      { text: '1', isFight: false, f0: 420, f1: 350, dur: 0.18, type: 'triangle', vol: 0.18 },
      { text: 'FIGHT!', isFight: true, f0: 600, f1: 950, dur: 0.35, type: 'sawtooth', vol: 0.25 }
    ];
    let stepIdx = 0;
    function playStep() {
      if (stepIdx >= steps.length) {
        countdownEl.classList.add('hidden');
        countdownEl.classList.remove('count-pulse', 'fight');
        countdownTimer = null;
        return;
      }
      const s = steps[stepIdx++];
      countdownEl.textContent = s.text;
      countdownEl.classList.remove('hidden', 'fight', 'count-pulse');
      void countdownEl.offsetWidth; // retrigger css animation
      countdownEl.classList.add('count-pulse');
      if (s.isFight) countdownEl.classList.add('fight');
      if (s.isFight) {
        AudioSys.tone(s.f0, s.f1, s.dur, s.type, s.vol);
        AudioSys.tone(300, 480, 0.45, 'square', 0.15);
      } else {
        AudioSys.tone(s.f0, s.f1, s.dur, s.type, s.vol);
      }
      const delay = s.isFight ? 800 : 1000;
      countdownTimer = setTimeout(playStep, delay);
    }
    playStep();
  }

  function cancelCountdown() {
    if (countdownTimer) {
      clearTimeout(countdownTimer);
      countdownTimer = null;
    }
    if (countdownEl) {
      countdownEl.classList.add('hidden');
      countdownEl.classList.remove('count-pulse', 'fight');
    }
  }

  const hud = { 
    root: dom('hud'),
    speed: dom('speedval'), 
    fill: dom('barfill'), 
    matchtimer: dom('matchtimer'),
    nameA: dom('nameA'),
    nameB: dom('nameB'),
    scoreA: dom('scoreA'),
    scoreB: dom('scoreB'),
    readyA: dom('readyA'),
    readyB: dom('readyB'),
    winstats: dom('winstats'),
    statsboard: dom('statsboard'),
    statsbody: dom('statsbody'),
    spectateinfo: dom('spectateinfo')
  };

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
    let specNote = '';
    if (match.spectators && Object.keys(match.spectators).length > 0) {
      const names = Object.values(match.spectators).map(s => esc(s.name)).join(', ');
      specNote = `<div class="sbnote" style="margin-top:6px;color:#a89f8c">Spectators: ${names}</div>`;
    }
    hud.statsbody.innerHTML = rows.map((r, i) =>
      `<tr class="${r.pid === localPid ? 'me' : ''}"><td>${i + 1}</td><td>${esc(r.p.name)}</td><td>${r.p.ping} ms</td><td>${r.p.acc}%</td><td>${r.p.score}</td></tr>`
    ).join('') + (specNote ? `<tr><td colspan="5" style="padding-top:10px">${specNote}</td></tr>` : '');
  }

  function updateHUD(state) {
    const { pl, CFG, currentSeed, match, localReady, localIndex, statsOpen, localPid, started, isSpectator, spectatorSpeed, spectatorMode, followPerspective, isTargetDead, spectateTargetPid, remotePlayers } = state;

    // The whole HUD stays hidden in the main menu (orbit preview)
    hud.root.classList.toggle('hidden', !started);
    // Speed
    const sp = isSpectator ? (spectatorSpeed || 0) : pl.vel.length();
    hud.speed.innerHTML = Math.round(sp * 10) + '<span>u/s</span>';
    hud.fill.style.width = Math.min(100, (sp / 34) * 100) + '%';
    hud.fill.classList.toggle('hot', sp > CFG.GMAX + 2);

    const crosshairEl = dom('crosshair');
    if (crosshairEl) {
      if (isSpectator && spectatorMode === 'follow' && (followPerspective === 'chase' || isTargetDead)) {
        crosshairEl.style.display = 'none';
      } else {
        crosshairEl.style.display = '';
      }
    }

    if (hud.spectateinfo) {
      if (isSpectator && spectatorMode === 'follow' && spectateTargetPid) {
        let targetName = null;
        if (remotePlayers && remotePlayers[spectateTargetPid] && remotePlayers[spectateTargetPid].name) {
          targetName = remotePlayers[spectateTargetPid].name;
        } else if (match && match.players && match.players[spectateTargetPid] && match.players[spectateTargetPid].name) {
          targetName = match.players[spectateTargetPid].name;
        } else if (match && match.spectators && match.spectators[spectateTargetPid] && match.spectators[spectateTargetPid].name) {
          targetName = match.spectators[spectateTargetPid].name;
        }

        if (!targetName && match && match.players) {
          const p = match.players[String(spectateTargetPid)] || match.players[Number(spectateTargetPid)];
          if (p && p.name) targetName = p.name;
        }

        if (!targetName) targetName = `Player ${spectateTargetPid}`;
        hud.spectateinfo.textContent = `Spectating ${targetName}`;
        hud.spectateinfo.classList.remove('hidden');
      } else {
        hud.spectateinfo.classList.add('hidden');
        hud.spectateinfo.textContent = '';
      }
    }
    
    
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
      } else if (match.phase === 'countdown') {
        hud.matchtimer.textContent = 'STARTING...';
        hud.matchtimer.classList.remove('dim');
        hud.readyA.textContent = ''; hud.readyA.classList.remove('on');
        hud.readyB.textContent = ''; hud.readyB.classList.remove('on');
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
    

    if (match && match.phase === 'summary' && hud.winstats) {
      const seat = seats(match);
      const A = seat[0], B = seat[1];
      const rw = match.roundWins || {};
      const rwA = (A && rw[A.pid]) || 0;
      const rwB = (B && rw[B.pid]) || 0;
      hud.winstats.innerHTML =
        `<span style="display:block;font-size:15px">${A ? A.name : '—'} <b style="font-size:20px">${A ? A.score : 0}</b> kills</span>` +
        `<span style="display:block;font-size:15px">${B ? B.name : '—'} <b style="font-size:20px">${B ? B.score : 0}</b> kills</span>` +
        `<span style="display:block;font-size:13px;color:#8a7a66;margin-top:8px">rounds won ${rwA} – ${rwB} · seed <b>${currentSeed}</b></span>`;
    }
    renderStats(match, statsOpen, localPid);
  }

  return { updateHUD, showCountdown, cancelCountdown };
}
