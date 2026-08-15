// GameApp: owns the parts DB, the 3D view, global settings, and screen
// navigation. Individual screens live in setup.ts / match.ts / online.ts.

import { PartIndex } from "../core/derive";
import type { ComboPreset, ComboSelection, PartsDb } from "../core/types";
import { BattleView } from "../render/scene";
import { STADIUMS, type StadiumSpec } from "../core/stadium";
import { RULE_PRESETS, RULES_OFFICIAL, type RuleSet } from "../game/rules";
import { ZH } from "../i18n/zh";
import { UI_CSS, button, el, overlay } from "./dom";
import { sfx } from "../audio/sfx";
import { gyro } from "../sensors/gyro";
import { showQuickSetup, showTournamentSetup } from "./setup";
import { showOnline } from "./online";
import { showGarage } from "./garage";
import { showRecords } from "./records";

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
    this.index = new PartIndex(db);
    this.view = new BattleView(root);
    this.view.setStadium(this.stadium());
    let last = performance.now();
    const loop = (now: number): void => {
      requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (this.frameHook) this.frameHook(dt);
      else this.view.update(null, dt);
    };
    requestAnimationFrame(loop);
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

  showMenu(): void {
    this.view.mode = "orbit";
    this.view.clearBeys();
    const o = overlay();
    const panel = el("div", { class: "panel" });
    panel.append(
      el("div", { class: "title" }, ZH.appTitle),
      el(
        "div",
        { class: "subtitle" },
        `${Object.values(this.db.parts).reduce((n, l) => n + l.length, 0)} 零件・${this.db.combos.length} 組官方配置`,
      ),
      button(ZH.menu.quick, () => {
        sfx.unlock();
        showQuickSetup(this);
      }, "btn primary"),
      button(ZH.menu.tournament, () => {
        sfx.unlock();
        showTournamentSetup(this);
      }),
      button(ZH.menu.online, () => {
        sfx.unlock();
        showOnline(this);
      }),
      button(ZH.menu.garage, () => showGarage(this)),
      button(ZH.menu.records, () => showRecords(this)),
      button(ZH.menu.about, () => this.showAbout()),
      (() => {
        const label = (): string => `${ZH.music}：${sfx.musicEnabled ? ZH.on : ZH.off}`;
        const b = button(label(), () => {
          sfx.unlock();
          sfx.setMusic(!sfx.musicEnabled);
          b.textContent = label();
        }, "btn small");
        return b;
      })(),
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
