export const AudioSys = {
  ac: null,
  muted: false,
  listenerPos: null,
  _noiseBuf: null,
  ensure() {
    if (!this.ac) { try { this.ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* ignore */ } }
  },
  /* Distance attenuation: full volume within 5 units, linear falloff beyond.
     Returns 0 when the source is too far to be audible. */
  volAt(pos, vol) {
    if (!pos || !this.listenerPos) return vol;
    const dx = pos.x - this.listenerPos.x;
    const dy = pos.y - this.listenerPos.y;
    const dz = pos.z - this.listenerPos.z;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    const v = dist > 5 ? vol * (5 / dist) : vol;
    return v < 0.005 ? 0 : v;
  },
  tone(f0, f1, dur, type = 'sine', vol = 0.12, when = 0, pos = null) {
    if (!this.ac || this.muted) return;
    const finalVol = this.volAt(pos, vol);
    if (!finalVol) return;
    const t0 = this.ac.currentTime + when;
    const o = this.ac.createOscillator(), g = this.ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    g.gain.setValueAtTime(finalVol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.ac.destination); o.start(t0); o.stop(t0 + dur + 0.02);
  },
  /* White-noise burst with an optional swept biquad filter (whoosh / zap crackle). */
  noise(dur, vol = 0.15, when = 0, pos = null, filter = null) {
    if (!this.ac || this.muted) return;
    const finalVol = this.volAt(pos, vol);
    if (!finalVol) return;
    if (!this._noiseBuf) {
      const len = Math.floor(this.ac.sampleRate * 2);
      const buf = this.ac.createBuffer(1, len, this.ac.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this._noiseBuf = buf;
    }
    const t0 = this.ac.currentTime + when;
    const src = this.ac.createBufferSource();
    src.buffer = this._noiseBuf;
    const g = this.ac.createGain();
    g.gain.setValueAtTime(finalVol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node = src;
    if (filter) {
      const f = this.ac.createBiquadFilter();
      f.type = filter.type;
      f.frequency.setValueAtTime(filter.f0, t0);
      f.frequency.exponentialRampToValueAtTime(Math.max(20, filter.f1), t0 + dur);
      if (filter.q) f.Q.value = filter.q;
      node.connect(f); node = f;
    }
    node.connect(g).connect(this.ac.destination);
    src.start(t0); src.stop(t0 + dur + 0.02);
  },
  /* Portal open / close — a single blended sound: charge, whoosh and finish
     all attack at once (no sequence, so the total stays short) and every
     pitch sweeps in the same direction — up for open, down for close.
     Part volumes are normalized (0.04 + 0.12 + 0.10 = 0.26) so the mixed
     peak matches the loudest overlap of the old sequential version. */
  portalOpen(pos) {
    this.tone(500, 1000, 0.35, 'sawtooth', 0.04, 0, pos);
    this.noise(0.35, 0.12, 0, pos, { type: 'bandpass', f0: 800, f1: 1600, q: 1.2 });
    this.tone(300, 600, 0.6, 'sine', 0.10, 0, pos);
  },
  portalClose(pos) {
    this.tone(500, 250, 0.35, 'sawtooth', 0.04, 0, pos);
    this.noise(0.35, 0.12, 0, pos, { type: 'bandpass', f0: 800, f1: 400, q: 1.2 });
    this.tone(300, 150, 0.6, 'sine', 0.10, 0, pos);
  },
  /* Instagib shot trigger — emitted from the shooter's position.
     Volumes normalized to match the portal gun trigger (0.085 + 0.045 = 0.13). */
  instagibShot(pos) {
    this.tone(150, 40, 0.8, 'square', 0.085, 0, pos);
    this.tone(800, 150, 0.5, 'sawtooth', 0.045, 0.05, pos);
  },
  /* Zap — instagib beam impact where the beam ends on a wall.
     `delay` = sound travel time from the impact to the listener, so the
     impact crack lands after the trigger instead of on top of it. */
  zap(pos, delay = 0) {
    this.noise(0.12, 0.22, delay, pos, { type: 'highpass', f0: 2500, f1: 1200, q: 0.8 });
    this.tone(2600, 180, 0.18, 'triangle', delay, 0.16, pos);
  },
  toggleMute() {
    this.muted = !this.muted;
    return this.muted;
  }
};
