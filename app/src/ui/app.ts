// GameApp: owns the parts DB, the 3D view, global settings, and screen
// navigation. Individual screens live in setup.ts / match.ts / online.ts.

import { PartIndex, deriveBeyParams, resolveCombo } from "../core/derive";
import { DT, createWorld, step } from "../core/sim";
import type { ComboPreset, ComboSelection, PartsDb, WorldConfig, WorldState } from "../core/types";
import { BattleView } from "../render/scene";
import { STADIUMS, type StadiumSpec } from "../core/stadium";
import { BOT_ROSTER, botBuildDeck, botChooseLaunch } from "../game/bots";
import { RULE_PRESETS, RULES_OFFICIAL, type RuleSet } from "../game/rules";
import { ZH } from "../i18n/zh";
import { UI_CSS, button, el, overlay, row } from "./dom";
import { isAudioUnlocked, sfx } from "../audio/sfx";
import { gyro } from "../sensors/gyro";
import { showQuickSetup, showTournamentSetup } from "./setup";
import { showOnline } from "./online";
import { showGarage } from "./garage";
import { showRecords } from "./records";
import { showAuthGate, showProfile } from "./auth";
import { getAuth, refreshMe } from "../game/auth";

export interface CustomComboStore {
  list(): { name: string; combo: ComboSelection }[];
  save(name: string, combo: ComboSelection): void;
  remove(name: string): void;
}

function customStore(): CustomComboStore {
  const KEY = "beyblade.customCombos";
  return {
    list() {
      try {
        return JSON.parse(localStorage.getItem(KEY) ?? "[]");
      } catch {
        return [];
      }
    },
    save(name, combo) {
      const all = this.list().filter((c) => c.name !== name);
      all.push({ name, combo });
      localStorage.setItem(KEY, JSON.stringify(all));
    },
    remove(name) {
      localStorage.setItem(KEY, JSON.stringify(this.list().filter((c) => c.name !== name)));
    },
  };
}

export class GameApp {
  readonly index: PartIndex;
  readonly view: BattleView;
  readonly customs = customStore();
  rules: RuleSet = { ...RULES_OFFICIAL };
  /** while set, the frame loop delegates to the active battle */
  frameHook: ((dt: number) => void) | null = null;
  private screenEl: HTMLElement | null = null;

  constructor(
    readonly db: PartsDb,
    readonly root: HTMLElement,
  ) {
    document.head.append(el("style", {}, UI_CSS));
    this.showAudioHint();
    this.index = new PartIndex(db);
    this.view = new BattleView(root);
    this.view.setStadium(this.stadium());
    let last = performance.now();
    const loop = (now: number): void => {
      requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (this.frameHook) this.frameHook(dt);
      else this.stepCinema(dt);
    };
    requestAnimationFrame(loop);
    this.startMenuCinema(); // live bot battles fade behind every menu
  }

  /**
   * Browsers forbid audio until the user interacts — the game genuinely
   * cannot make a sound before then, on any site. Rather than leave that
   * looking broken, say so, and clear the notice the instant the first tap
   * starts everything.
   */
  private showAudioHint(): void {
    if (isAudioUnlocked()) return;
    const hint = el("div", { class: "audiohint" }, ZH.tapForSound);
    document.body.append(hint);
    window.addEventListener("beyblade:audio", () => hint.remove(), { once: true });
  }

  // ---- menu-background cinema: live bot matches with movie-style shots ----

  private cinemaWorld: WorldState | null = null;
  private cinemaCfg: WorldConfig | null = null;
  private cinemaAcc = 0;
  private cinemaPhase: "launch" | "battle" | "linger" = "linger";
  private cinemaTimer = 0;
  private cinemaEnabled = false;

  startMenuCinema(): void {
    this.cinemaEnabled = true;
    sfx.setScore("menu"); // calm ambience behind the menus
    this.view.audioMuted = true;
    this.view.mode = "cinema";
    if (!this.cinemaWorld && this.cinemaPhase !== "launch") this.newCinemaBattle();
  }

  /** Real matches/replays own the stage; the background show stops fully. */
  stopMenuCinema(): void {
    this.cinemaEnabled = false;
    this.cinemaWorld = null;
    this.cinemaCfg = null;
    this.view.audioMuted = false;
    this.view.removeOpponentLauncher();
    this.view.clearBeys();
  }

  private newCinemaBattle(): void {
    const seed = (Math.random() * 0xffffffff) >>> 0;
    const i = Math.floor(Math.random() * BOT_ROSTER.length);
    const botA = BOT_ROSTER[i]!;
    const botB = BOT_ROSTER[(i + 1 + Math.floor(Math.random() * (BOT_ROSTER.length - 1))) % BOT_ROSTER.length]!;
    const single = { ...RULES_OFFICIAL };
    try {
      const comboA = botBuildDeck(this.db, botA, single, seed ^ 0xa1)[0]!;
      const comboB = botBuildDeck(this.db, botB, single, seed ^ 0xb2)[0]!;
      const rcA = resolveCombo(this.index, comboA);
      const rcB = resolveCombo(this.index, comboB);
      const pA = deriveBeyParams(rcA);
      const pB = deriveBeyParams(rcB);
      this.view.setBeys({ rc: rcA, params: pA }, { rc: rcB, params: pB });
      this.view.attachOpponentLauncher(rcA, pA, 0);
      this.view.attachOpponentLauncher(rcB, pB, 1);
      this.cinemaCfg = {
        seed,
        beys: [pA, pB],
        launches: [
          botChooseLaunch(botA, rcA.parts.blade?.rotation ?? "right", seed ^ 0xc3),
          botChooseLaunch(botB, rcB.parts.blade?.rotation ?? "right", seed ^ 0xd4),
        ],
        xtremeDashEnabled: true,
        clicksMax: 4,
        maxTicks: 240 * 90,
      };
      this.cinemaWorld = null;
      this.cinemaPhase = "launch";
      this.cinemaTimer = 1.6;
      this.view.cineLaunchShot(Math.random() < 0.5 ? 0 : 1);
    } catch {
      this.cinemaPhase = "linger";
      this.cinemaTimer = 3;
    }
  }

  private stepCinema(dt: number): void {
    if (!this.cinemaEnabled) {
      this.view.update(null, dt);
      return;
    }
    if (this.cinemaPhase === "launch") {
      this.cinemaTimer -= dt;
      if (this.cinemaTimer <= 0 && this.cinemaCfg) {
        void this.view.playOpponentRelease();
        this.cinemaWorld = createWorld(this.cinemaCfg);
        this.cinemaAcc = 0;
        this.cinemaPhase = "battle";
      }
      this.view.update(null, dt);
      return;
    }
    if (this.cinemaPhase === "battle" && this.cinemaWorld && this.cinemaCfg) {
      const stadium = this.stadium();
      this.cinemaAcc += dt;
      let steps = 0;
      while (this.cinemaAcc > DT && !this.cinemaWorld.finish && !this.cinemaWorld.draw && steps < 1200) {
        step(this.cinemaWorld, this.cinemaCfg, stadium);
        this.cinemaAcc -= DT;
        steps++;
      }
      this.view.consumeEvents(this.cinemaWorld);
      this.view.update(this.cinemaWorld, dt);
      if (this.cinemaWorld.finish || this.cinemaWorld.draw) {
        this.cinemaPhase = "linger"; // let the camera dwell on the outcome
        this.cinemaTimer = 2.4;
      }
      return;
    }
    // linger on the finished battle, then start the next one
    this.cinemaTimer -= dt;
    this.view.update(this.cinemaWorld, dt);
    if (this.cinemaTimer <= 0) this.newCinemaBattle();
  }

  stadium(): StadiumSpec {
    return STADIUMS[this.rules.stadium] ?? STADIUMS.bx10!;
  }

  comboLabel(sel: ComboSelection): string {
    const blade = this.index.get("blade", sel.blade) ?? this.index.get("mainBlade", sel.mainBlade);
    const ratchet = this.index.get("ratchet", sel.ratchet);
    const bit = this.index.get("bit", sel.bit);
    const name = blade?.name["zh-TW"] ?? "?";
    const v = blade?.variantLabel ? `（${blade.variantLabel}）` : "";
    return `${name}${v} ${ratchet?.code ?? "?"}${bit?.code ?? "?"}`;
  }

  comboOptions(): { value: string; label: string }[] {
    const seen = new Set<string>();
    const opts: { value: string; label: string }[] = [];
    for (const c of this.db.combos as ComboPreset[]) {
      const label = this.comboLabel(c.parts);
      if (seen.has(label)) continue;
      seen.add(label);
      opts.push({ value: `official:${this.db.combos.indexOf(c)}`, label });
    }
    for (const c of this.customs.list()) {
      opts.push({ value: `custom:${c.name}`, label: `⭐ ${c.name}` });
    }
    return opts;
  }

  resolveComboRef(ref: string): ComboSelection {
    if (ref.startsWith("official:")) {
      return (this.db.combos as ComboPreset[])[Number(ref.slice(9))]!.parts;
    }
    const name = ref.slice(7);
    const c = this.customs.list().find((x) => x.name === name);
    if (!c) throw new Error("unknown combo " + name);
    return c.combo;
  }

  setScreen(node: HTMLElement | null): void {
    this.screenEl?.remove();
    this.screenEl = node;
    if (node) document.body.append(node);
  }

  /** Entry point: account gate → mode select. */
  showMenu(): void {
    if (!getAuth()) {
      void refreshMe(); // revalidate in the background
      showAuthGate(this, () => this.showMenu());
      return;
    }
    this.showModeSelect();
  }

  showModeSelect(): void {
    this.startMenuCinema();
    const o = overlay();
    const panel = el("div", { class: "panel" });
    panel.append(
      el("div", { class: "title" }, ZH.appTitle),
      el(
        "div",
        { class: "subtitle" },
        `${getAuth()?.nickname ?? ""}${getAuth()?.guest ? `（${ZH.auth.guestBadge}）` : ""}`,
      ),
      button(ZH.mode.single, () => {
        sfx.unlock();
        this.showLocalMenu();
      }, "btn primary"),
      button(ZH.mode.multi, () => {
        sfx.unlock();
        showOnline(this);
      }),
      button(ZH.auth.profile, () => showProfile(this)),
      row(
        (() => {
          const label = (): string => `${ZH.music}：${sfx.musicEnabled ? ZH.on : ZH.off}`;
          const b = button(label(), () => {
            sfx.unlock();
            sfx.setMusic(!sfx.musicEnabled);
            b.textContent = label();
          }, "btn small");
          return b;
        })(),
        (() => {
          const label = (): string => `${ZH.sound}：${sfx.sfxEnabled ? ZH.on : ZH.off}`;
          const b = button(label(), () => {
            sfx.unlock();
            sfx.setSfx(!sfx.sfxEnabled);
            b.textContent = label();
          }, "btn small");
          return b;
        })(),
      ),
    );
    o.append(panel);
    this.setScreen(o);
  }

  /** Single-player hub (the player + bots; multiplayer lives online). */
  showLocalMenu(): void {
    this.startMenuCinema();
    const o = overlay();
    const panel = el("div", { class: "panel" });
    panel.append(
      el("div", { class: "title", style: "font-size:24px" }, ZH.mode.single),
      el(
        "div",
        { class: "subtitle" },
        `${Object.values(this.db.parts).reduce((n, l) => n + l.length, 0)} 零件・${this.db.combos.length} 組官方配置`,
      ),
      button(ZH.menu.quick, () => showQuickSetup(this), "btn primary"),
      button(ZH.menu.tournament, () => showTournamentSetup(this)),
      button(ZH.menu.garage, () => showGarage(this)),
      button(ZH.menu.records, () => showRecords(this)),
      button(ZH.menu.about, () => this.showAbout()),
      button(ZH.back, () => this.showModeSelect()),
    );
    o.append(panel);
    this.setScreen(o);
  }

  showAbout(): void {
    const o = overlay();
    const panel = el("div", { class: "panel" });
    panel.append(
      el("div", { class: "title" }, ZH.menu.about),
      el("div", { class: "subtitle", style: "text-align:left; line-height:1.7" }, ZH.aboutText),
      button(ZH.back, () => this.showMenu()),
    );
    o.append(panel);
    this.setScreen(o);
  }

  /**
   * Try to make gyro the active view (called from user-gesture handlers so
   * iOS shows its permission prompt). Falls back to orbit silently.
   */
  enableGyroByDefault(): void {
    void gyro.enable().then((ok) => {
      if (ok) this.view.mode = "gyro";
    });
  }

  /** View-mode toolbar used by match screens. */
  viewControls(): HTMLElement {
    const bar = el("div", { class: "row", style: "width:auto" });
    // 重新校正: phone lying flat on the table, stadium beyond its top edge
    const calBtn = button(ZH.recalibrate, () => {
      if (!gyro.active) {
        void gyro.enable().then((ok) => {
          if (ok) this.view.mode = "gyro";
        });
        return;
      }
      gyro.recenter();
      this.view.mode = "gyro";
    }, "btn small");
    const toggleBtn = button(ZH.viewToggle, () => {
      this.view.mode = this.view.mode === "gyro" ? "orbit" : gyro.active ? "gyro" : "orbit";
    }, "btn small");
    bar.append(calBtn, toggleBtn);
    return bar;
  }

  rulePresetOptions(): { value: string; label: string }[] {
    return Object.entries(RULE_PRESETS).map(([k, r]) => ({ value: k, label: r.name }));
  }
}
