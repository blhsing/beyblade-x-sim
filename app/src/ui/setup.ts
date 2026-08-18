// Quick-match and tournament setup screens: per-slot named human or bot
// (skill & character individually selectable), deck selection, rule preset.

import { BOT_CHARACTERS, BOT_ROSTER, BOT_SKILLS, botBuildDeck, type BotCharacter, type BotProfile, type BotSkill } from "../game/bots";
import { getPrefs, savePrefs } from "../game/persist";
import { COMBO_FILTERS, comboItems, openGallery } from "./gallery";
import { RULE_PRESETS, deckDuplicateError, type RuleSet } from "../game/rules";
import { STADIUMS } from "../core/stadium";
import { LAUNCHER_KINDS, type LauncherKind } from "../core/types";
import { showGarage } from "./garage";
import { Tournament, type TournamentSlot } from "../game/tournament";
import type { ComboSelection } from "../core/types";
import { ZH, fmt } from "../i18n/zh";
import { button, el, overlay, row, select } from "./dom";
import type { GameApp } from "./app";
import { runMatch } from "./match";
import { showBracket } from "./bracket";
import { versusThumb } from "../render/thumbs";

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
  entry: ZH.launcherEntry,
  winder: ZH.launcherWinder,
  longWinder: ZH.launcherLongWinder,
  string: ZH.launcherString,
  hold: ZH.launcherHold,
  winderL: ZH.launcherWinderL,
  stringL: ZH.launcherStringL,
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

const versusPrefetches = new Set<string>();

/** Warm the exact first-battle overheads while the player is still in setup. */
export function prefetchSlotVersus(app: GameApp, slot: SlotConfig): void {
  const candidates = slot.kind === "bot" && slot.deckRefs.length === 0
    ? [resolveDeck(app, slot, 501)[0], resolveDeck(app, slot, 502)[0]]
    : [resolveDeck(app, slot, 501)[0]];
  for (const combo of candidates) {
    if (!combo) continue;
    const fingerprint = JSON.stringify(combo);
    if (versusPrefetches.has(fingerprint)) continue;
    versusPrefetches.add(fingerprint);
    const render = (): void => {
      void versusThumb(app.index, combo, `setup-${fingerprint}`).then((url) => {
        if (!url) versusPrefetches.delete(fingerprint);
      });
    };
    if (window.requestIdleCallback) window.requestIdleCallback(render, { timeout: 500 });
    else window.setTimeout(render, 0);
  }
}

/** Editor card for one player slot. */
export function slotEditor(
  app: GameApp,
  cfg: SlotConfig,
  title: string,
  reopen?: () => void,
  lockKind?: "human" | "bot",
): HTMLElement {
  if (lockKind) cfg.kind = lockKind;
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
    prefetchSlotVersus(app, cfg);
  });
  skillSel.addEventListener("change", () => {
    cfg.bot.skill = skillSel.value as BotSkill;
    prefetchSlotVersus(app, cfg);
  });
  charSel.addEventListener("change", () => {
    cfg.bot.character = charSel.value as BotCharacter;
    prefetchSlotVersus(app, cfg);
  });

  // bey picker: swipeable 3D gallery instead of a dropdown
  const deckVals: string[] = [];
  const deckWrap = el("div", { class: "row", style: "flex-direction:column; gap:6px" });
  const labelFor = (v: string): string =>
    v === "auto"
      ? `${ZH.deck}：自動`
      : (app.comboOptions().find((o) => o.value === v)?.label ?? v);
  const syncDecks = (): void => {
    const refs = deckVals.filter((v) => v !== "auto");
    cfg.deckRefs = refs.length === deckVals.length ? refs : [];
  };
  const rebuildDecks = (): void => {
    deckWrap.replaceChildren();
    deckVals.length = 0;
    const n = Math.max(1, app.rules.deckSize);
    const opts = app.comboOptions();
    for (let i = 0; i < n; i++) {
      // humans default to DISTINCT combos so a 3on3 deck starts legal
      const fallback = cfg.kind === "bot" ? "auto" : (opts[i]?.value ?? opts[0]?.value ?? "auto");
      deckVals.push(cfg.deckRefs[i] ?? fallback);
      const idx = i;
      const b = button(labelFor(deckVals[idx]!), () => {
        openGallery(
          ZH.deck,
          comboItems(app, cfg.kind === "bot"),
          deckVals[idx]!,
          (key) => {
            deckVals[idx] = key;
            b.textContent = labelFor(key);
            syncDecks();
          },
          () => {},
          COMBO_FILTERS,
          "grid",
        );
      }, "btn small");
      deckWrap.append(b);
    }
    syncDecks();
  };

  const launcherSel = select(
    LAUNCHER_KINDS.map((k) => ({
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
  if (lockKind) {
    kindSel.value = lockKind;
    kindSel.setAttribute("disabled", "");
  }
  card.append(row(kindSel), humanRow, botRows, deckHeader, deckWrap);
  syncKind();
  return card;
}

export function rulesPicker(app: GameApp, onChange?: () => void): HTMLElement {
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
    app.rules.xtremeDashEnabled = true; // both official stadiums have X-lines
    app.view.setStadium(app.stadium());
    savePrefs({
      rulesPreset: presetSel.value,
      pointsToWin: app.rules.pointsToWin,
      stadium: app.rules.stadium,
    });
    onChange?.(); // e.g. 3on3 needs three deck pickers per slot
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

/** Rehydrate a saved slot config, dropping combo refs that no longer resolve. */
function restoreSlot(app: GameApp, saved: unknown, i: number): SlotConfig {
  const base = defaultSlot(i);
  if (!saved || typeof saved !== "object") return base;
  const sv = saved as Partial<SlotConfig>;
  const s: SlotConfig = {
    ...base,
    ...sv,
    bot: { ...base.bot, ...(sv.bot ?? {}) },
    deckRefs: [...(sv.deckRefs ?? [])],
  };
  s.deckRefs = s.deckRefs.filter((ref) => {
    try {
      app.resolveComboRef(ref);
      return true;
    } catch {
      return false;
    }
  });
  return s;
}

/** 3on3 legality check for human-picked decks; returns an error text. */
function humanDeckError(app: GameApp, s: SlotConfig): string | null {
  if (s.kind !== "human" || app.rules.deckSize <= 1 || s.deckRefs.length <= 1) return null;
  const deck = s.deckRefs.map((r) => {
    try {
      return app.resolveComboRef(r);
    } catch {
      return null;
    }
  });
  if (deck.some((d) => d === null)) return ZH.deckDupError;
  const err = deckDuplicateError(
    app.rules,
    deck as NonNullable<(typeof deck)[number]>[],
    (cat, key) => app.index.get(cat as Parameters<typeof app.index.get>[0], key)?.group ?? key,
  );
  return err ? ZH.deckDupError : null;
}

export function showQuickSetup(app: GameApp): void {
  const o = overlay();
  const panel = el("div", { class: "panel" });
  const savedQuick = getPrefs().quickSlots;
  const a = restoreSlot(app, savedQuick?.[0], 0);
  const b = restoreSlot(app, savedQuick?.[1], 1);
  const slotsBox = el("div", { style: "display:flex; flex-direction:column; gap:8px; width:100%" });
  // rules changes (e.g. switching to 3on3) re-render the deck pickers
  const renderSlots = (): void => {
    slotsBox.replaceChildren(
      // P1 defaults to the signed-in human but may be a bot too — with both
      // slots as bots this is effectively a self-playing demo mode
      slotEditor(app, a, fmt(ZH.playerN, { n: 1 }), () => showQuickSetup(app)),
      slotEditor(app, b, fmt(ZH.playerN, { n: 2 }), () => showQuickSetup(app), "bot"),
    );
    prefetchSlotVersus(app, a);
    prefetchSlotVersus(app, b);
  };
  const picker = rulesPicker(app, renderSlots);
  renderSlots();
  panel.append(
    el("div", { class: "title", style: "font-size:22px" }, ZH.menu.quick),
    picker,
    slotsBox,
    button(ZH.start, () => {
      const dupErr = humanDeckError(app, a);
      if (dupErr) {
        window.alert(dupErr);
        return;
      }
      app.enableGyroByDefault(); // inside the click gesture for iOS permission
      savePrefs({
        ...(a.kind === "human" ? { name: a.name, launcher: a.launcher } : {}),
        quickSlots: [a, b], // whole setup persists to the next match
      });
      void runMatch(
        app,
        [a, b],
        () => app.showMenu(),
        { onAbort: () => showQuickSetup(app) }, // 放棄 → back to setup
        "快速對戰",
      );
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

  const savedTour = getPrefs().tourSetup;
  const countSel = select(
    [2, 3, 4, 6, 8, 12, 16].map((n) => ({ value: String(n), label: `${n} 人` })),
    String(savedTour?.count ?? 4),
  );
  const fmtSel = select(
    [
      { value: "singleElim", label: ZH.singleElim },
      { value: "roundRobin", label: ZH.roundRobin },
    ],
    savedTour?.format === "roundRobin" ? "roundRobin" : "singleElim",
  );
  const slotsWrap = el("div", { style: "display:flex; flex-direction:column; gap:8px; width:100%" });
  let slots: SlotConfig[] = [];
  const rebuild = (): void => {
    const n = Number(countSel.value);
    slots = Array.from(
      { length: n },
      (_, i) => slots[i] ?? restoreSlot(app, savedTour?.slots?.[i], i),
    );
    slots.length = n;
    slotsWrap.replaceChildren(
      ...slots.map((s, i) =>
        slotEditor(
          app,
          s,
          fmt(ZH.playerN, { n: i + 1 }),
          () => showTournamentSetup(app),
          i === 0 ? undefined : "bot", // P1 human or bot (all-bot = demo)
        ),
      ),
    );
  };
  countSel.addEventListener("change", rebuild);
  rebuild();

  panel.append(
    rulesPicker(app, () => rebuild()), // 3on3 re-renders slot deck pickers
    row(countSel, fmtSel),
    slotsWrap,
    button(ZH.start, () => {
      for (const s of slots) {
        const dupErr = humanDeckError(app, s);
        if (dupErr) {
          window.alert(`${s.name}：${dupErr}`);
          return;
        }
      }
      savePrefs({
        tourSetup: { count: slots.length, format: fmtSel.value, slots }, // persists to next time
      });
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
