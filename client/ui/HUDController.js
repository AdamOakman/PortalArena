import { AudioSys } from '../audio/AudioController.js';

function fmtTime(t, tenths) {
  const v = Math.max(0, t);
  const m = String(Math.floor(v / 60)).padStart(2, '0');
  const s = String(Math.floor(v % 60)).padStart(2, '0');
  return tenths ? `${m}:${s}.${String(Math.floor((v % 1) * 10))}` : `${m}:${s}`;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function seats(match) {
  const seat = { 0: null, 1: null };
  if (!match || !match.players) return seat;
  for (const pid in match.players) {
    const p = match.players[pid];
    if (p.index === 0 || p.index === 1) seat[p.index] = Object.assign({ pid }, p);
  }
  return seat;
}

function setReadyRow(el, p, isLocal, localReady) {
  if (!el) return;
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

/**
 * HUDController — Manages user interface overlays, speedometers, crosshairs, and scoreboard.
 */
export class HUDController {
  constructor(engine) {
    this.engine = engine;
    this.speedVal = document.getElementById('speedval');
    this.barFill = document.getElementById('barfill');
    this.countdown = document.getElementById('countdown');
    this.eventLog = document.getElementById('eventlog');
    this.crosshair = document.getElementById('crosshair');
    this.countdownTimer = null;
    this.lastStatsT = -1e9;

    this.hud = {
      root: document.getElementById('hud'),
      speed: this.speedVal,
      fill: this.barFill,
      matchtimer: document.getElementById('matchtimer'),
      nameA: document.getElementById('nameA'),
      nameB: document.getElementById('nameB'),
      scoreA: document.getElementById('scoreA'),
      scoreB: document.getElementById('scoreB'),
      readyA: document.getElementById('readyA'),
      readyB: document.getElementById('readyB'),
      winstats: document.getElementById('winstats'),
      statsboard: document.getElementById('statsboard'),
      statsbody: document.getElementById('statsbody'),
      spectateinfo: document.getElementById('spectateinfo')
    };

    this._setupListeners();
  }

  _setupListeners() {
    if (!this.engine || !this.engine.eventBus) return;

    this.engine.eventBus.on('PLAYER_SPEED_CHANGED', (data) => this.updateSpeed(data));
    this.engine.eventBus.on('EVENT_LOG_ADD', (data) => this.addEventLog(data.text, data.hot));
  }

  updateSpeed(data) {
    if (!data) return;
    const spd = Math.round(data.speed || 0);

    if (this.speedVal) {
      this.speedVal.innerHTML = `${spd}<span>u/s</span>`;
    }

    if (this.barFill) {
      const pct = Math.min(100, Math.round((spd / 35) * 100));
      this.barFill.style.width = `${pct}%`;
      if (spd > 15) {
        this.barFill.classList.add('hot');
      } else {
        this.barFill.classList.remove('hot');
      }
    }
  }

  addEventLog(msg, hot = false) {
    if (!this.eventLog) return;
    const el = document.createElement('div');
    el.className = hot ? 'event hot' : 'event';
    el.textContent = msg;
    this.eventLog.appendChild(el);

    while (this.eventLog.children.length > 5) {
      this.eventLog.removeChild(this.eventLog.firstChild);
    }

    setTimeout(() => {
      if (el.parentNode === this.eventLog) {
        this.eventLog.removeChild(el);
      }
    }, 15000);
  }

  setCrosshairGrab(canGrab) {
    if (this.crosshair) {
      if (canGrab) this.crosshair.classList.add('grab');
      else this.crosshair.classList.remove('grab');
    }
  }

  showCountdown() {
    const countdownEl = this.countdown;
    if (!countdownEl) return;
    if (this.countdownTimer) {
      clearTimeout(this.countdownTimer);
      this.countdownTimer = null;
    }
    const steps = [
      { text: '3', isFight: false, f0: 320, f1: 260, dur: 0.18, type: 'triangle', vol: 0.18 },
      { text: '2', isFight: false, f0: 360, f1: 300, dur: 0.18, type: 'triangle', vol: 0.18 },
      { text: '1', isFight: false, f0: 420, f1: 350, dur: 0.18, type: 'triangle', vol: 0.18 },
      { text: 'FIGHT!', isFight: true, f0: 600, f1: 950, dur: 0.35, type: 'sawtooth', vol: 0.25 }
    ];
    let stepIdx = 0;
    const playStep = () => {
      if (stepIdx >= steps.length) {
        countdownEl.classList.add('hidden');
        countdownEl.classList.remove('count-pulse', 'fight');
        this.countdownTimer = null;
        return;
      }
      const s = steps[stepIdx++];
      countdownEl.textContent = s.text;
      countdownEl.classList.remove('hidden', 'fight', 'count-pulse');
      void countdownEl.offsetWidth;
      countdownEl.classList.add('count-pulse');
      if (s.isFight) countdownEl.classList.add('fight');
      if (s.isFight) {
        AudioSys.tone(s.f0, s.f1, s.dur, s.type, s.vol);
        AudioSys.tone(300, 480, 0.45, 'square', 0.15);
      } else {
        AudioSys.tone(s.f0, s.f1, s.dur, s.type, s.vol);
      }
      const delay = s.isFight ? 800 : 1000;
      this.countdownTimer = setTimeout(playStep, delay);
    };
    playStep();
  }

  cancelCountdown() {
    if (this.countdownTimer) {
      clearTimeout(this.countdownTimer);
      this.countdownTimer = null;
    }
    if (this.countdown) {
      this.countdown.classList.add('hidden');
      this.countdown.classList.remove('count-pulse', 'fight');
    }
  }

  renderStats(match, statsOpen, localPid) {
    if (!this.hud.statsboard) return;
    if (!statsOpen || !match) {
      this.hud.statsboard.classList.add('hidden');
      return;
    }
    this.hud.statsboard.classList.remove('hidden');
    const now = performance.now();
    if (now - this.lastStatsT < 100) return;
    this.lastStatsT = now;
    const rows = Object.keys(match.players || {}).map(pid => ({ pid, p: match.players[pid] }))
      .sort((a, b) => (b.p.score - a.p.score) || (b.p.hits - a.p.hits) || String(a.p.name).localeCompare(String(b.p.name)));
    let specNote = '';
    if (match.spectators && Object.keys(match.spectators).length > 0) {
      const names = Object.values(match.spectators).map(s => esc(s.name)).join(', ');
      specNote = `<div class="sbnote" style="margin-top:6px;color:#a89f8c">Spectators: ${names}</div>`;
    }
    this.hud.statsbody.innerHTML = rows.map((r, i) =>
      `<tr class="${r.pid === localPid ? 'me' : ''}"><td>${i + 1}</td><td>${esc(r.p.name)}</td><td>${r.p.ping} ms</td><td>${r.p.acc}%</td><td>${r.p.score}</td></tr>`
    ).join('') + (specNote ? `<tr><td colspan="5" style="padding-top:10px">${specNote}</td></tr>` : '');
  }

  updateHUD(state) {
    const { pl, CFG, currentSeed, match, localReady, localIndex, statsOpen, localPid, started, isSpectator, spectatorSpeed, spectatorMode, followPerspective, isTargetDead, spectateTargetPid, remotePlayers } = state;

    if (this.hud.root) {
      this.hud.root.classList.toggle('hidden', !started);
    }
    const sp = isSpectator ? (spectatorSpeed || 0) : (pl && pl.vel ? pl.vel.length() : 0);
    if (this.hud.speed) {
      this.hud.speed.innerHTML = Math.round(sp * 10) + '<span>u/s</span>';
    }
    if (this.hud.fill) {
      this.hud.fill.style.width = Math.min(100, (sp / 34) * 100) + '%';
      this.hud.fill.classList.toggle('hot', sp > (CFG ? CFG.GMAX : 11) + 2);
    }

    if (this.crosshair) {
      if (isSpectator && spectatorMode === 'follow' && (followPerspective === 'chase' || isTargetDead)) {
        this.crosshair.style.display = 'none';
      } else {
        this.crosshair.style.display = '';
      }
    }

    if (this.hud.spectateinfo) {
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
        this.hud.spectateinfo.textContent = `Spectating ${targetName}`;
        this.hud.spectateinfo.classList.remove('hidden');
      } else {
        this.hud.spectateinfo.classList.add('hidden');
        this.hud.spectateinfo.textContent = '';
      }
    }

    if (match && this.hud.matchtimer) {
      const seat = seats(match);
      const A = seat[0], B = seat[1];
      if (this.hud.nameA) this.hud.nameA.textContent = A ? A.name : '—';
      if (this.hud.nameB) this.hud.nameB.textContent = B ? B.name : '—';
      if (this.hud.scoreA) this.hud.scoreA.textContent = A ? A.score : 0;
      if (this.hud.scoreB) this.hud.scoreB.textContent = B ? B.score : 0;

      if (match.phase === 'waiting') {
        this.hud.matchtimer.textContent = 'WAITING FOR OPPONENT';
        this.hud.matchtimer.classList.add('dim');
        setReadyRow(this.hud.readyA, A, localIndex === 0, localReady);
        setReadyRow(this.hud.readyB, B, localIndex === 1, localReady);
      } else if (match.phase === 'warmup') {
        this.hud.matchtimer.textContent = 'WARMUP ' + fmtTime(match.timeLeft, false);
        this.hud.matchtimer.classList.add('dim');
        setReadyRow(this.hud.readyA, A, localIndex === 0, localReady);
        setReadyRow(this.hud.readyB, B, localIndex === 1, localReady);
      } else if (match.phase === 'countdown') {
        this.hud.matchtimer.textContent = 'STARTING...';
        this.hud.matchtimer.classList.remove('dim');
        if (this.hud.readyA) { this.hud.readyA.textContent = ''; this.hud.readyA.classList.remove('on'); }
        if (this.hud.readyB) { this.hud.readyB.textContent = ''; this.hud.readyB.classList.remove('on'); }
      } else if (match.phase === 'active') {
        this.hud.matchtimer.textContent = fmtTime(match.timeLeft, true);
        this.hud.matchtimer.classList.remove('dim');
        if (this.hud.readyA) { this.hud.readyA.textContent = ''; this.hud.readyA.classList.remove('on'); }
        if (this.hud.readyB) { this.hud.readyB.textContent = ''; this.hud.readyB.classList.remove('on'); }
      } else {
        this.hud.matchtimer.textContent = '00:00.0';
        this.hud.matchtimer.classList.add('dim');
        if (this.hud.readyA) { this.hud.readyA.textContent = ''; this.hud.readyA.classList.remove('on'); }
        if (this.hud.readyB) { this.hud.readyB.textContent = ''; this.hud.readyB.classList.remove('on'); }
      }
    }

    if (match && match.phase === 'summary' && this.hud.winstats) {
      const seat = seats(match);
      const A = seat[0], B = seat[1];
      const rw = match.roundWins || {};
      const rwA = (A && rw[A.pid]) || 0;
      const rwB = (B && rw[B.pid]) || 0;
      this.hud.winstats.innerHTML =
        `<span style="display:block;font-size:15px">${A ? A.name : '—'} <b style="font-size:20px">${A ? A.score : 0}</b> kills</span>` +
        `<span style="display:block;font-size:15px">${B ? B.name : '—'} <b style="font-size:20px">${B ? B.score : 0}</b> kills</span>` +
        `<span style="display:block;font-size:13px;color:#8a7a66;margin-top:8px">rounds won ${rwA} – ${rwB} · seed <b>${currentSeed}</b></span>`;
    }
    this.renderStats(match, statsOpen, localPid);
  }
}
