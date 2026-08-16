/** Persisted on/off flag, defaulting to on, safe without localStorage. */
function readStored(key: string): boolean {
  try {
    return localStorage.getItem(key) !== "0";
  } catch {
    return true;
  }
}

export type ScoreName =
  | "menu"
  | "garage"
  | "launch"
  | "battleAttack"
  | "battleDefense"
  | "battleStamina"
  | "battleBalance"
  | "tournament"
  | "victory";

/** A score is pure data — the generator below renders any of them. */
interface Score {
  /** seconds per bar (chord length) */
  bar: number;
  /** chord roots/voicings in Hz, one per bar, cycled */
  chords: number[][];
  padWave: OscillatorType;
  padGain: number;
  /** lowpass sweep floor/ceiling for the pad */
  lp: [number, number];
  /** arpeggio notes per bar (0 = none) */
  arps: number;
  arpWave: OscillatorType;
  arpGain: number;
  /** octave multipliers the arp may pick */
  arpOct: number[];
  /** eighth-note bass pulse on the chord root */
  bass: number;
  /** kick/hat pattern density, 0 = silent */
  beat: number;
  delay: number;
  feedback: number;
  /** overall level */
  level: number;
}

// Note: frequencies are written out rather than computed so each score's
// harmony is legible and tweakable at a glance.
const SCORES: Record<ScoreName, Score> = {
  // calm, spacious — menus and the cinema background
  menu: {
    bar: 4, chords: [[110.0, 164.81, 261.63], [87.31, 130.81, 220.0], [98.0, 146.83, 246.94], [82.41, 123.47, 196.0]],
    padWave: "sawtooth", padGain: 0.09, lp: [420, 980], arps: 5, arpWave: "triangle",
    arpGain: 0.11, arpOct: [2, 4], bass: 0, beat: 0, delay: 0.42, feedback: 0.34, level: 0.16,
  },
  // brighter and curious — building a bey in the garage
  garage: {
    bar: 3.6, chords: [[130.81, 196.0, 329.63], [146.83, 220.0, 349.23], [110.0, 174.61, 277.18], [123.47, 185.0, 293.66]],
    padWave: "triangle", padGain: 0.075, lp: [520, 1250], arps: 7, arpWave: "sine",
    arpGain: 0.09, arpOct: [2, 4], bass: 0, beat: 0, delay: 0.33, feedback: 0.3, level: 0.15,
  },
  // tense hold before GO SHOOT — short bars, tightening filter
  launch: {
    bar: 2, chords: [[82.41, 123.47, 164.81], [87.31, 130.81, 174.61]],
    padWave: "sawtooth", padGain: 0.11, lp: [300, 1500], arps: 4, arpWave: "square",
    arpGain: 0.05, arpOct: [4], bass: 0.05, beat: 0.4, delay: 0.2, feedback: 0.25, level: 0.17,
  },
  // fast, syncopated, minor — an attack type is on the dish
  battleAttack: {
    bar: 1.7, chords: [[110.0, 164.81, 220.0], [116.54, 174.61, 233.08], [98.0, 146.83, 196.0], [103.83, 155.56, 207.65]],
    padWave: "sawtooth", padGain: 0.075, lp: [520, 2400], arps: 16, arpWave: "square",
    arpGain: 0.07, arpOct: [2, 4], bass: 0.16, beat: 1.15, delay: 0.17, feedback: 0.26, level: 0.21,
  },
  // heavy, low and deliberate — defense grinding it out
  battleDefense: {
    bar: 2.6, chords: [[65.41, 98.0, 130.81], [73.42, 110.0, 146.83], [61.74, 92.5, 123.47], [69.3, 103.83, 138.59]],
    padWave: "sawtooth", padGain: 0.115, lp: [230, 1100], arps: 8, arpWave: "triangle",
    arpGain: 0.07, arpOct: [2], bass: 0.2, beat: 0.95, delay: 0.3, feedback: 0.3, level: 0.21,
  },
  // hypnotic cycling — a stamina war that will go the distance
  battleStamina: {
    bar: 2.4, chords: [[98.0, 146.83, 220.0], [110.0, 164.81, 246.94], [87.31, 130.81, 196.0], [98.0, 155.56, 233.08]],
    padWave: "triangle", padGain: 0.085, lp: [400, 1700], arps: 16, arpWave: "sine",
    arpGain: 0.075, arpOct: [4, 8], bass: 0.12, beat: 0.8, delay: 0.4, feedback: 0.4, level: 0.19,
  },
  // bright and anthemic — balance types, and the default field
  battleBalance: {
    bar: 2.1, chords: [[130.81, 196.0, 261.63], [110.0, 164.81, 220.0], [146.83, 220.0, 293.66], [123.47, 185.0, 246.94]],
    padWave: "sawtooth", padGain: 0.08, lp: [480, 2100], arps: 12, arpWave: "triangle",
    arpGain: 0.08, arpOct: [2, 4], bass: 0.15, beat: 1.05, delay: 0.24, feedback: 0.28, level: 0.21,
  },
  // grander, march-like — bracket play
  tournament: {
    bar: 2.6, chords: [[98.0, 146.83, 196.0], [110.0, 164.81, 220.0], [130.81, 196.0, 261.63], [87.31, 138.59, 174.61]],
    padWave: "sawtooth", padGain: 0.1, lp: [340, 1600], arps: 5, arpWave: "square",
    arpGain: 0.05, arpOct: [2, 4], bass: 0.11, beat: 0.8, delay: 0.3, feedback: 0.32, level: 0.19,
  },
  // triumphant, wide — the result panel
  victory: {
    bar: 3, chords: [[130.81, 196.0, 329.63], [174.61, 261.63, 392.0], [146.83, 220.0, 349.23], [130.81, 196.0, 329.63]],
    padWave: "sawtooth", padGain: 0.105, lp: [600, 2200], arps: 6, arpWave: "triangle",
    arpGain: 0.1, arpOct: [4, 8], bass: 0.07, beat: 0.5, delay: 0.34, feedback: 0.3, level: 0.2,
  },
};

// Procedurally synthesized sound effects (no third-party assets).
// Everything is generated with Web Audio primitives; parameters are tied to
// simulation quantities (RPM, impulse magnitude) for a realistic feel.

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private hums: { osc: OscillatorNode; noiseGain: GainNode; gain: GainNode; pan: StereoPannerNode }[] = [];
  private noiseBuf: AudioBuffer | null = null;
  /** master gate for effects (hums, clashes, clicks, launches, bursts) —
   * persisted alongside the music setting so it survives a reload. Read
   * lazily: this module is imported by headless tests where there is no
   * localStorage at all. */
  enabled = readStored("beyblade.sfx");

  get sfxEnabled(): boolean {
    return this.enabled;
  }

  setSfx(on: boolean): void {
    this.enabled = on;
    try {
      localStorage.setItem("beyblade.sfx", on ? "1" : "0");
    } catch {
      /* no storage (headless) — the in-memory flag still applies */
    }
    if (!on) this.stopHums(); // silence anything already droning
  }

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
    this.watchFocus();
  }

  /** Suspend all audio when the app loses focus / is backgrounded, and pick
   * it back up on return — a game left in a tab should go quiet. */
  private focusWatched = false;
  private watchFocus(): void {
    if (this.focusWatched) return;
    this.focusWatched = true;
    // Use document.hidden ONLY. hasFocus() is false in plenty of ordinary
    // situations — a webview, an address-bar tap, a just-dismissed prompt —
    // and this used to run immediately on unlock, so the audio context was
    // suspended the instant it was created and the game started silent.
    const apply = (): void => {
      if (!this.ctx) return;
      if (document.hidden && this.ctx.state === "running") void this.ctx.suspend();
      else if (!document.hidden && this.ctx.state === "suspended") void this.ctx.resume();
    };
    document.addEventListener("visibilitychange", apply);
    window.addEventListener("pagehide", () => {
      if (this.ctx?.state === "running") void this.ctx.suspend();
    });
    // deliberately NOT called here: unlock() has just resumed the context
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

  // ---- procedural score library --------------------------------------
  //
  // One generator, many scores. A score is DATA — harmony, tempo, timbre,
  // whether there is a bassline or a beat — so scenes and matchups can pick
  // a mood without new audio code. Battle scores are chosen from the types
  // actually on the dish: attack is fast and syncopated, defense is heavy
  // and slow, stamina is a hypnotic cycle, balance is bright and anthemic.

  private musicGain: GainNode | null = null;
  private musicTimer: number | null = null;
  private musicBar = 0;
  private score: Score = SCORES.menu!;
  private scoreName: ScoreName = "menu";

  /** Currently playing score. */
  get currentScore(): ScoreName {
    return this.scoreName;
  }

  /**
   * Switch score. Restarts the loop so the new harmony takes effect at the
   * next bar; a no-op if the same score is already playing.
   */
  setScore(name: ScoreName): void {
    if (name === this.scoreName) return;
    this.scoreName = name;
    this.score = SCORES[name] ?? SCORES.menu!;
    this.musicBar = 0;
    if (this.musicTimer !== null) {
      this.stopMusic();
      this.startMusic();
    }
  }

  /**
   * Pick a battle score from the bey types in play. A mirror match leans
   * into its own archetype; a mixed field takes the more aggressive side,
   * because that is what the fight will look like.
   */
  battleScoreFor(types: (string | null | undefined)[]): ScoreName {
    const present = types.filter(Boolean) as string[];
    if (present.length === 0) return "battleBalance";
    const rank: Record<string, number> = { attack: 3, balance: 2, defense: 1, stamina: 0 };
    let best = present[0]!;
    for (const t of present) if ((rank[t] ?? 0) > (rank[best] ?? 0)) best = t;
    // a true mirror gets its own colour rather than the aggression winner
    const allSame = present.every((t) => t === present[0]);
    const pick = allSame ? present[0]! : best;
    switch (pick) {
      case "attack":
        return "battleAttack";
      case "defense":
        return "battleDefense";
      case "stamina":
        return "battleStamina";
      default:
        return "battleBalance";
    }
  }

  get musicEnabled(): boolean {
    return readStored("beyblade.music");
  }

  setMusic(on: boolean): void {
    try {
      localStorage.setItem("beyblade.music", on ? "1" : "0");
    } catch {
      /* no storage (headless) */
    }
    if (on) this.startMusic();
    else this.stopMusic();
  }

  /** Called from unlock(); starts the loop when enabled. */
  startMusic(): void {
    if (!this.ctx || !this.master || this.musicTimer !== null || !this.musicEnabled) return;
    const ctx = this.ctx;
    const sc = this.score;
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = sc.level;
    // shared feedback delay — the space the plucks live in
    const delay = ctx.createDelay(1.0);
    delay.delayTime.value = sc.delay;
    const fb = ctx.createGain();
    fb.gain.value = sc.feedback;
    delay.connect(fb).connect(delay);
    const delaySend = ctx.createGain();
    delaySend.gain.value = 0.5;
    delaySend.connect(delay);
    delay.connect(this.musicGain);
    this.musicGain.connect(this.master);
    const BAR = sc.bar;
    let nextBarTime = ctx.currentTime + 0.1;

    const scheduleBar = (t0: number, chord: number[]): void => {
      const out = this.musicGain;
      if (!out) return;
      // pad: detuned oscillators through a breathing lowpass
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.Q.value = 0.8;
      lp.frequency.setValueAtTime(sc.lp[0], t0);
      lp.frequency.linearRampToValueAtTime(sc.lp[1], t0 + BAR / 2);
      lp.frequency.linearRampToValueAtTime(sc.lp[0], t0 + BAR);
      const padGain = ctx.createGain();
      padGain.gain.setValueAtTime(0, t0);
      padGain.gain.linearRampToValueAtTime(sc.padGain, t0 + BAR * 0.28);
      padGain.gain.setValueAtTime(sc.padGain, t0 + BAR - BAR * 0.22);
      padGain.gain.linearRampToValueAtTime(0, t0 + BAR + 0.35);
      lp.connect(padGain).connect(out);
      for (const f of chord) {
        for (const det of [-4, 3]) {
          const o = ctx.createOscillator();
          o.type = sc.padWave;
          o.frequency.value = f;
          o.detune.value = det;
          o.connect(lp);
          o.start(t0);
          o.stop(t0 + BAR + 0.5);
        }
      }

      // bassline: eighth-note pulse on the root, an octave down
      if (sc.bass > 0) {
        const steps = 4;
        for (let i = 0; i < steps; i++) {
          const t = t0 + (i * BAR) / steps;
          const o = ctx.createOscillator();
          o.type = "sine";
          o.frequency.value = chord[0]! / 2;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(sc.bass, t + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t + BAR / steps);
          o.connect(g).connect(out);
          o.start(t);
          o.stop(t + BAR / steps + 0.05);
        }
      }

      // Beat: a real 16-step pattern, not an alternating tick. Kick on the
      // downbeats, snare on the backbeat, hats on the offbeats — that
      // backbeat is what makes a battle feel driven rather than ambient.
      if (sc.beat > 0 && this.noiseBuf) {
        const STEPS = 16;
        const KICK = [0, 3, 6, 8, 11, 14];
        const SNARE = [4, 12];
        for (let i = 0; i < STEPS; i++) {
          const t = t0 + (i * BAR) / STEPS;
          const isKick = KICK.includes(i);
          const isSnare = SNARE.includes(i);
          const isHat = i % 2 === 1;
          if (!isKick && !isSnare && !isHat) continue;
          // sub-bass thump for the kick, so it lands in the chest
          if (isKick) {
            const o = ctx.createOscillator();
            o.type = "sine";
            o.frequency.setValueAtTime(150, t);
            o.frequency.exponentialRampToValueAtTime(46, t + 0.11);
            const kg = ctx.createGain();
            kg.gain.setValueAtTime(0.34 * sc.beat, t);
            kg.gain.exponentialRampToValueAtTime(0.0001, t + 0.19);
            o.connect(kg).connect(out);
            o.start(t);
            o.stop(t + 0.22);
          }
          const src = ctx.createBufferSource();
          src.buffer = this.noiseBuf;
          const bp = ctx.createBiquadFilter();
          bp.type = isSnare ? "bandpass" : isKick ? "lowpass" : "highpass";
          bp.frequency.value = isSnare ? 1900 : isKick ? 140 : 8200;
          if (isSnare) bp.Q.value = 0.8;
          const g = ctx.createGain();
          const amp = (isSnare ? 0.2 : isKick ? 0.1 : 0.05) * sc.beat;
          g.gain.setValueAtTime(amp, t);
          g.gain.exponentialRampToValueAtTime(0.0001, t + (isSnare ? 0.13 : isKick ? 0.08 : 0.035));
          src.connect(bp).connect(g).connect(out);
          src.start(t);
          src.stop(t + 0.24);
        }
      }

      // arpeggio into the delay
      for (let i = 0; i < sc.arps; i++) {
        if (Math.random() < 0.28) continue;
        const t = t0 + (i * BAR) / Math.max(1, sc.arps) + 0.05;
        const oct = sc.arpOct[Math.floor(Math.random() * sc.arpOct.length)]!;
        const f = chord[Math.floor(Math.random() * chord.length)]! * oct;
        const o = ctx.createOscillator();
        o.type = sc.arpWave;
        o.frequency.value = f;
        const g = ctx.createGain();
        g.gain.setValueAtTime(sc.arpGain, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + Math.min(0.6, BAR * 0.32));
        o.connect(g);
        g.connect(out);
        g.connect(delaySend);
        o.start(t);
        o.stop(t + 0.7);
      }
    };

    this.musicTimer = window.setInterval(() => {
      while (nextBarTime < ctx.currentTime + 1.2) {
        scheduleBar(nextBarTime, sc.chords[this.musicBar % sc.chords.length]!);
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

// Browsers do not allow ANY audio before the user's first interaction —
// that is the autoplay policy, not something the page can opt out of, so a
// game opened and left untouched is silent by rule. What we can do is make
// the very first interaction of any kind start everything, and tell the UI
// the moment it happens so it can stop advertising a tap.
if (typeof document !== "undefined") {
  const EVENTS = ["pointerdown", "touchend", "keydown", "click"];
  const kick = (): void => {
    sfx.unlock();
    audioUnlocked = true;
    for (const ev of EVENTS) document.removeEventListener(ev, kick, true);
    window.dispatchEvent(new CustomEvent("beyblade:audio"));
  };
  for (const ev of EVENTS) document.addEventListener(ev, kick, true);
}

let audioUnlocked = false;
/** True once a user gesture has let the audio context start. */
export function isAudioUnlocked(): boolean {
  return audioUnlocked;
}
