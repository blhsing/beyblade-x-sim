// Procedurally synthesized sound effects (no third-party assets).
// Everything is generated with Web Audio primitives; parameters are tied to
// simulation quantities (RPM, impulse magnitude) for a realistic feel.

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private hums: { osc: OscillatorNode; noiseGain: GainNode; gain: GainNode; pan: StereoPannerNode }[] = [];
  private noiseBuf: AudioBuffer | null = null;
  enabled = true;

  /** Must be called from a user gesture (mobile autoplay policy). */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(ctx.destination);
    // shared white-noise buffer
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    this.startMusic();
  }

  private noiseSource(): AudioBufferSourceNode | null {
    if (!this.ctx || !this.noiseBuf) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.start();
    return src;
  }

  /** Continuous per-bey spin hum; call update every frame. */
  startHums(count: number): void {
    if (!this.ctx || !this.master || this.hums.length) return;
    for (let i = 0; i < count; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = "sawtooth";
      const oscGain = this.ctx.createGain();
      oscGain.gain.value = 0.012;
      const noise = this.noiseSource()!;
      const nFilter = this.ctx.createBiquadFilter();
      nFilter.type = "bandpass";
      nFilter.Q.value = 2.2;
      const noiseGain = this.ctx.createGain();
      noiseGain.gain.value = 0.0;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      const pan = this.ctx.createStereoPanner();
      osc.connect(oscGain).connect(gain);
      noise.connect(nFilter).connect(noiseGain).connect(gain);
      gain.connect(pan).connect(this.master);
      osc.start();
      this.hums.push({ osc, noiseGain, gain, pan });
      // keep filter reachable via closure state
      (this.hums[i] as any).nFilter = nFilter;
    }
  }

  /** rpm≈0..9000, pan -1..1, speed m/s for the "scrape" component. */
  updateHum(i: number, rpm: number, pan: number, speed: number): void {
    const h = this.hums[i];
    if (!h || !this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const on = rpm > 300;
    h.gain.gain.setTargetAtTime(on ? Math.min(0.9, rpm / 9000) * 0.5 : 0, t, 0.08);
    h.osc.frequency.setTargetAtTime(40 + rpm / 45, t, 0.05);
    (h as any).nFilter.frequency.setTargetAtTime(600 + rpm / 4 + speed * 900, t, 0.05);
    h.noiseGain.gain.setTargetAtTime(on ? 0.05 + Math.min(0.12, speed * 0.12) : 0, t, 0.08);
    h.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), t, 0.05);
  }

  stopHums(): void {
    for (const h of this.hums) {
      try {
        h.gain.gain.value = 0;
        h.osc.stop();
      } catch {
        /* already stopped */
      }
    }
    this.hums = [];
  }

  private env(peak: number, decay: number): GainNode | null {
    if (!this.ctx || !this.master) return null;
    const g = this.ctx.createGain();
    const t = this.ctx.currentTime;
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    g.connect(this.master);
    return g;
  }

  /** Metallic collision: noise transient + detuned ring, scaled by impulse. */
  hit(mag: number): void {
    if (!this.ctx || !this.enabled) return;
    const m = Math.min(1, mag * 14);
    const g = this.env(0.65 * m + 0.08, 0.16 + 0.1 * m);
    if (!g) return;
    const noise = this.noiseSource()!;
    const f = this.ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = 1800;
    noise.connect(f).connect(g);
    setTimeout(() => noise.stop(), 300);
    for (const freq of [2450, 3170, 4890]) {
      const o = this.ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = freq * (0.97 + Math.random() * 0.06);
      const og = this.env(0.09 * m, 0.28);
      if (og) o.connect(og);
      o.start();
      o.stop(this.ctx.currentTime + 0.3);
    }
  }

  /** Single ratchet click (winder pull / burst click). */
  click(sharp = 1): void {
    if (!this.ctx || !this.enabled) return;
    const g = this.env(0.35 * sharp, 0.045);
    if (!g) return;
    const o = this.ctx.createOscillator();
    o.type = "square";
    o.frequency.value = 2900;
    o.connect(g);
    o.start();
    o.stop(this.ctx.currentTime + 0.05);
  }

  /** Launch: click burst + air whoosh. */
  launch(sp: number): void {
    if (!this.ctx || !this.enabled) return;
    const n = this.noiseSource();
    const g = this.env(0.5, 0.5);
    if (!n || !g) return;
    const f = this.ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.setValueAtTime(400, this.ctx.currentTime);
    f.frequency.exponentialRampToValueAtTime(2600 + sp / 8, this.ctx.currentTime + 0.25);
    f.Q.value = 1.4;
    n.connect(f).connect(g);
    setTimeout(() => n.stop(), 600);
  }

  /** Xtreme dash: rising gear buzz. */
  dash(): void {
    if (!this.ctx || !this.enabled) return;
    const o = this.ctx.createOscillator();
    o.type = "sawtooth";
    const t = this.ctx.currentTime;
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(950, t + 0.35);
    const g = this.env(0.32, 0.45);
    if (!g) return;
    o.connect(g);
    o.start();
    o.stop(t + 0.5);
  }

  /** Burst finish: shatter (parts flying). */
  burst(): void {
    if (!this.ctx || !this.enabled) return;
    this.hit(1.2);
    for (let i = 0; i < 6; i++) {
      setTimeout(() => this.click(0.5 + Math.random()), 40 + i * 55 + Math.random() * 40);
    }
  }

  /** Bey drops into a pocket: thud + plastic rattle. */
  pocket(): void {
    if (!this.ctx || !this.enabled) return;
    const o = this.ctx.createOscillator();
    o.type = "sine";
    const t = this.ctx.currentTime;
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.18);
    const g = this.env(0.55, 0.25);
    if (!g) return;
    o.connect(g);
    o.start();
    o.stop(t + 0.3);
    for (let i = 0; i < 4; i++) setTimeout(() => this.click(0.35), 120 + i * 70);
  }

  /** Countdown beep; final=true for the GO SHOOT tone. */
  beep(final = false): void {
    if (!this.ctx || !this.enabled) return;
    const o = this.ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = final ? 1320 : 880;
    const g = this.env(0.3, final ? 0.35 : 0.12);
    if (!g) return;
    o.connect(g);
    o.start();
    o.stop(this.ctx.currentTime + (final ? 0.4 : 0.15));
  }

  // ---- atmospheric music (procedural, togglable, on by default) ----------

  private musicGain: GainNode | null = null;
  private musicTimer: number | null = null;
  private musicBar = 0;

  get musicEnabled(): boolean {
    return localStorage.getItem("beyblade.music") !== "0";
  }

  setMusic(on: boolean): void {
    localStorage.setItem("beyblade.music", on ? "1" : "0");
    if (on) this.startMusic();
    else this.stopMusic();
  }

  /** Called from unlock(); starts the loop when enabled. */
  startMusic(): void {
    if (!this.ctx || !this.master || this.musicTimer !== null || !this.musicEnabled) return;
    const ctx = this.ctx;
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = 0.16;
    // gentle space: feedback delay shared by the plucks
    const delay = ctx.createDelay(1.0);
    delay.delayTime.value = 0.42;
    const fb = ctx.createGain();
    fb.gain.value = 0.34;
    delay.connect(fb).connect(delay);
    const delaySend = ctx.createGain();
    delaySend.gain.value = 0.5;
    delaySend.connect(delay);
    delay.connect(this.musicGain);
    this.musicGain.connect(this.master);

    // A-minor-ish progression, one chord per 4s bar
    const CHORDS = [
      [110.0, 164.81, 261.63], // Am
      [87.31, 130.81, 220.0], // F
      [98.0, 146.83, 246.94], // G
      [82.41, 123.47, 196.0], // Em
    ];
    const BAR = 4;
    let nextBarTime = ctx.currentTime + 0.1;

    const scheduleBar = (t0: number, chord: number[]): void => {
      // pad: detuned saws through a slowly-breathing lowpass
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.Q.value = 0.8;
      lp.frequency.setValueAtTime(420, t0);
      lp.frequency.linearRampToValueAtTime(980, t0 + BAR / 2);
      lp.frequency.linearRampToValueAtTime(420, t0 + BAR);
      const padGain = ctx.createGain();
      padGain.gain.setValueAtTime(0, t0);
      padGain.gain.linearRampToValueAtTime(0.09, t0 + 1.1);
      padGain.gain.setValueAtTime(0.09, t0 + BAR - 0.9);
      padGain.gain.linearRampToValueAtTime(0, t0 + BAR + 0.4);
      lp.connect(padGain).connect(this.musicGain!);
      for (const f of chord) {
        for (const det of [-4, 3]) {
          const o = ctx.createOscillator();
          o.type = "sawtooth";
          o.frequency.value = f;
          o.detune.value = det;
          o.connect(lp);
          o.start(t0);
          o.stop(t0 + BAR + 0.5);
        }
      }
      // sparse pluck arpeggio into the delay
      for (let i = 0; i < 5; i++) {
        if (Math.random() < 0.35) continue;
        const t = t0 + 0.4 + i * 0.72;
        const f = chord[Math.floor(Math.random() * chord.length)]! * (Math.random() < 0.3 ? 4 : 2);
        const o = ctx.createOscillator();
        o.type = "triangle";
        o.frequency.value = f;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.11, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
        o.connect(g);
        g.connect(this.musicGain!);
        g.connect(delaySend);
        o.start(t);
        o.stop(t + 0.7);
      }
    };

    this.musicTimer = window.setInterval(() => {
      while (nextBarTime < ctx.currentTime + 1.2) {
        scheduleBar(nextBarTime, CHORDS[this.musicBar % CHORDS.length]!);
        this.musicBar++;
        nextBarTime += BAR;
      }
    }, 400);
  }

  stopMusic(): void {
    if (this.musicTimer !== null) {
      clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
    if (this.musicGain && this.ctx) {
      this.musicGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
      const g = this.musicGain;
      setTimeout(() => g.disconnect(), 1200);
      this.musicGain = null;
    }
  }
}

export const sfx = new Sfx();
