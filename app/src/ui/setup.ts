// Quick-match and tournament setup screens: per-slot named human or bot
// (skill & character individually selectable), deck selection, rule preset.

import { BOT_CHARACTERS, BOT_ROSTER, BOT_SKILLS, botBuildDeck, type BotCharacter, type BotProfile, type BotSkill } from "../game/bots";
import { getPrefs, savePrefs } from "../game/persist";
import { RULE_PRESETS, type RuleSet } from "../game/rules";
import { STADIUMS } from "../core/stadium";
import type { LauncherKind } from "../core/types";
import { showGarage } from "./garage";
import { Tournament, type TournamentSlot } from "../game/tournament";
import type { ComboSelection } from "../core/types";
import { ZH, fmt } from "../i18n/zh";
import { button, el, overlay, row, select } from "./dom";
import type { GameApp } from "./app";
import { runMatch } from "./match";
import { showBracket } from "./bracket";

export interface SlotConfig {
  kind: "human" | "bot";
  name: string;
  bot: BotProfile;
  deckRefs: string[]; // combo refs; empty = bot auto-build
  launcher: LauncherKind;
}

export function defaultSlot(i: number): SlotConfig {
  const roster = BOT_ROSTER[i % BOT_ROSTER.length]!;
  const prefs = getPrefs();
  return {
    kind: i === 0 ? "human" : "bot",
    name: i === 0 ? prefs.name : fmt(ZH.playerN, { n: i + 1 }),
    bot: { ...roster },
    deckRefs: [],
    launcher: i === 0 ? prefs.launcher : "string",
  };
}

export const LAUNCHER_LABELS: Record<LauncherKind, string> = {
  winder: ZH.launcherWinder,
  string: ZH.launcherString,
  hold: ZH.launcherHold,
};

export function slotDisplayName(s: SlotConfig): string {
  return s.kind === "bot" ? s.bot.name : s.name;
}

export function resolveDeck(app: GameApp, s: SlotConfig, seed: number): ComboSelection[] {
  if (s.deckRefs.length > 0) return s.deckRefs.map((r) => app.resolveComboRef(r));
  if (s.kind === "bot") return botBuildDeck(app.db, s.bot, app.rules, seed);
  // human default: first official preset
  return [app.db.combos[0]!.parts];
}

/** Editor card for one player slot. */
export function slotEditor(
  app: GameApp,
  cfg: SlotConfig,
  title: string,
  reopen?: () => void,
): HTMLElement {
  const card = el("div", { class: "card" });
  card.append(el("div", { class: "label" }, title));

  const kindSel = select(
    [
      { value: "human", label: ZH.human },
      { value: "bot", label: ZH.bot },
    ],
    cfg.kind,
  );
  const nameInput = el("input", { type: "text", value: cfg.name });
  nameInput.addEventListener("input", () => (cfg.name = nameInput.value || cfg.name));

  const rosterSel = select(
    BOT_ROSTER.map((b, i) => ({ value: String(i), label: `${b.name}（${BOT_SKILLS[b.skill].zh}・${BOT_CHARACTERS[b.character].zh}）` })),
    "0",
  );
  const skillSel = select(
    (Object.keys(BOT_SKILLS) as BotSkill[]).map((k) => ({ value: k, label: BOT_SKILLS[k].zh })),
    cfg.bot.skill,
  );
  const charSel = select(
    (Object.keys(BOT_CHARACTERS) as BotCharacter[]).map((k) => ({ value: k, label: BOT_CHARACTERS[k].zh })),
    cfg.bot.character,
  );
  rosterSel.addEventListener("change", () => {
    const b = BOT_ROSTER[Number(rosterSel.value)]!;
    cfg.bot = { ...b };
    skillSel.value = b.skill;
    charSel.value = b.character;
  });
  skillSel.addEventListener("change", () => (cfg.bot.skill = skillSel.value as BotSkill));
  charSel.addEventListener("change", () => (cfg.bot.character = charSel.value as BotCharacter));

  const deckOpts = [{ value: "auto", label: `${ZH.deck}：自動` }, ...app.comboOptions()];
  const deckSels: HTMLSelectElement[] = [];
  const deckWrap = el("div", { class: "row", style: "flex-direction:column; gap:6px" });
  const rebuildDecks = (): void => {
    deckWrap.replaceChildren();
    deckSels.length = 0;
    const n = Math.max(1, app.rules.deckSize);
    for (let i = 0; i < n; i++) {
      const s = select(deckOpts, cfg.deckRefs[i] ?? (cfg.kind === "bot" ? "auto" : deckOpts[1]?.value ?? "auto"));
      s.addEventListener("change", () => syncDecks());
      deckSels.push(s);
      deckWrap.append(s);
    }
    syncDecks();
  };
  const syncDecks = (): void => {
    const refs = deckSels.map((s) => s.value).filter((v) => v !== "auto");
    cfg.deckRefs = refs.length === deckSels.length ? refs : [];
  };

  const launcherSel = select(
    (Object.keys(LAUNCHER_LABELS) as LauncherKind[]).map((k) => ({
      value: k,
      label: LAUNCHER_LABELS[k],
    })),
    cfg.launcher,
  );
  launcherSel.addEventListener("change", () => (cfg.launcher = launcherSel.value as LauncherKind));

  const humanRow = el("div", {}, row(nameInput), row(launcherSel));
  const botRows = el("div", {}, row(rosterSel), row(skillSel, charSel));
  const syncKind = (): void => {
    cfg.kind = kindSel.value as "human" | "bot";
    humanRow.style.display = cfg.kind === "human" ? "" : "none";
    botRows.style.display = cfg.kind === "bot" ? "" : "none";
    rebuildDecks();
  };
  kindSel.addEventListener("change", syncKind);

  const deckHeader = row(
    el("span", { class: "label" }, ZH.deck),
    reopen
      ? button(ZH.menu.garage, () => showGarage(app, reopen), "btn small fixed")
      : el("span", {}),
  );
  card.append(row(kindSel), humanRow, botRows, deckHeader, deckWrap);
  syncKind();
  return card;
}

export function rulesPicker(app: GameApp): HTMLElement {
  const prefs = getPrefs();
  const presetSel = select(app.rulePresetOptions(), prefs.rulesPreset);
  if (!presetSel.value) presetSel.value = "official";
  const ptsSel = select(
    [3, 4, 5, 7].map((n) => ({ value: String(n), label: `${ZH.pointsToWin} ${n}` })),
    String(prefs.pointsToWin),
  );
  const stadiumSel = select(
    Object.values(STADIUMS).map((s) => ({ value: s.name, label: s.labelZh })),
    STADIUMS[prefs.stadium] ? prefs.stadium : app.rules.stadium,
  );
  const apply = (): void => {
    app.rules = { ...RULE_PRESETS[presetSel.value]! };
    app.rules.pointsToWin = Number(ptsSel.value);
    app.rules.stadium = stadiumSel.value as RuleSet["stadium"];
    app.rules.xtremeDashEnabled = app.rules.stadium !== "burstStd";
    app.view.setStadium(app.stadium());
    savePrefs({
      rulesPreset: presetSel.value,
      pointsToWin: app.rules.pointsToWin,
      stadium: app.rules.stadium,
    });
  };
  presetSel.addEventListener("change", () => {
    apply();
    ptsSel.value = String(app.rules.pointsToWin);
  });
  ptsSel.addEventListener("change", apply);
  stadiumSel.addEventListener("change", apply);
  apply();
  return el("div", { style: "display:flex; flex-direction:column; gap:8px" }, row(presetSel, ptsSel), row(stadiumSel));
}

export function showQuickSetup(app: GameApp): void {
  const o = overlay();
  const panel = el("div", { class: "panel" });
  const a = defaultSlot(0);
  const b = defaultSlot(1);
  panel.append(
    el("div", { class: "title", style: "font-size:22px" }, ZH.menu.quick),
    rulesPicker(app),
    slotEditor(app, a, fmt(ZH.playerN, { n: 1 }), () => showQuickSetup(app)),
    slotEditor(app, b, fmt(ZH.playerN, { n: 2 }), () => showQuickSetup(app)),
    button(ZH.start, () => {
      app.enableGyroByDefault(); // inside the click gesture for iOS permission
      if (a.kind === "human") savePrefs({ name: a.name, launcher: a.launcher });
      void runMatch(app, [a, b], () => app.showMenu(), {}, "快速對戰");
    }, "btn primary"),
    button(ZH.back, () => app.showMenu()),
  );
  o.append(panel);
  app.setScreen(o);
}

export function showTournamentSetup(app: GameApp): void {
  const o = overlay();
  const panel = el("div", { class: "panel" });
  panel.append(el("div", { class: "title", style: "font-size:22px" }, ZH.menu.tournament));

  const countSel = select(
    [2, 3, 4, 6, 8, 12, 16].map((n) => ({ value: String(n), label: `${n} 人` })),
    "4",
  );
  const fmtSel = select(
    [
      { value: "singleElim", label: ZH.singleElim },
      { value: "roundRobin", label: ZH.roundRobin },
    ],
    "singleElim",
  );
  const slotsWrap = el("div", { style: "display:flex; flex-direction:column; gap:8px; width:100%" });
  let slots: SlotConfig[] = [];
  const rebuild = (): void => {
    const n = Number(countSel.value);
    slots = Array.from({ length: n }, (_, i) => slots[i] ?? defaultSlot(i));
    slots.length = n;
    slotsWrap.replaceChildren(
      ...slots.map((s, i) =>
        slotEditor(app, s, fmt(ZH.playerN, { n: i + 1 }), () => showTournamentSetup(app)),
      ),
    );
  };
  countSel.addEventListener("change", rebuild);
  rebuild();

  panel.append(
    rulesPicker(app),
    row(countSel, fmtSel),
    slotsWrap,
    button(ZH.start, () => {
      const tSlots: TournamentSlot[] = slots.map((s, i) => ({
        name: slotDisplayName(s),
        kind: s.kind,
        bot: s.bot,
        deck: resolveDeck(app, s, 1000 + i * 77),
      }));
      const tour = new Tournament(tSlots, fmtSel.value as "singleElim" | "roundRobin");
      showBracket(app, tour, slots);
    }, "btn primary"),
    button(ZH.back, () => app.showMenu()),
  );
  o.append(panel);
  app.setScreen(o);
}
