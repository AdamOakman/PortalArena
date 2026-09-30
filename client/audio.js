export const AudioSys = {
  ac: null,
  muted: false,
  ensure() {
    if (!this.ac) { try { this.ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* ignore */ } }
  },
  tone(f0, f1, dur, type = 'sine', vol = 0.12, when = 0) {
    if (!this.ac || this.muted) return;
    const t0 = this.ac.currentTime + when;
    const o = this.ac.createOscillator(), g = this.ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.ac.destination); o.start(t0); o.stop(t0 + dur + 0.02);
  },
  toggleMute() {
    this.muted = !this.muted;
    return this.muted;
  }
};


