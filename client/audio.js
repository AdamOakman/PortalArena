export const AudioSys = {
  ac: null,
  muted: false,
  listenerPos: null,
  ensure() {
    if (!this.ac) { try { this.ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* ignore */ } }
  },
  tone(f0, f1, dur, type = 'sine', vol = 0.12, when = 0, pos = null) {
    if (!this.ac || this.muted) return;
    let finalVol = vol;
    if (pos && this.listenerPos) {
      const dx = pos.x - this.listenerPos.x;
      const dy = pos.y - this.listenerPos.y;
      const dz = pos.z - this.listenerPos.z;
      const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
      if (dist > 5) finalVol = vol * (5 / dist);
      if (finalVol < 0.005) return;
    }
    const t0 = this.ac.currentTime + when;
    const o = this.ac.createOscillator(), g = this.ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    g.gain.setValueAtTime(finalVol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.ac.destination); o.start(t0); o.stop(t0 + dur + 0.02);
  },
  toggleMute() {
    this.muted = !this.muted;
    return this.muted;
  }
};



