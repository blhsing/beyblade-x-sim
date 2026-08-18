// Replay player: re-simulates a recorded match from its seeds + launches
// (the deterministic core guarantees the identical battle). Reached from
// 對戰紀錄 or a shared ?replay=<id> link on either tier.

import { deriveBeyParams, resolveCombo } from "../core/derive";
import { DT, step } from "../core/sim";
import type { ComboSelection, LaunchParams, WorldConfig } from "../core/types";
import { replayPhysicsCompatible, type MatchRecord } from "../game/persist";
import { pointsForFinish, type RuleSet } from "../game/rules";
import { ZH, fmt } from "../i18n/zh";
import { button, el, overlay } from "./dom";
import { playBattle } from "./match";
import type { GameApp } from "./app";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function playReplay(app: GameApp, rec: MatchRecord, onDone: () => void): Promise<void> {
  const rep = rec.replay;
  if (!rep || rep.battles.length === 0) {
    onDone();
    return;
  }
  if (!replayPhysicsCompatible(rep)) {
    window.alert("此對戰由不同版本的物理核心錄製，無法精確重播。對戰紀錄仍會保留。");
    onDone();
    return;
  }
  const rules = rep.rules as RuleSet;
  const prevRules = app.rules;
  app.stopMenuCinema();
  app.rules = rules;
  app.view.setStadium(app.stadium());
  app.setScreen(null);
  app.view.mode = "orbit";
  app.view.resetView();

  const names: [string, string] = [rec.players[0]?.name ?? "A", rec.players[1]?.name ?? "B"];
  const scores: [number, number] = [0, 0];
  let aborted = false;

  const bar = el("div", { class: "topbar" });
  const scoreEl = el("div", { class: "scoreboard" }, "");
  const syncScore = (): void => {
    scoreEl.textContent = `▶ ${names[0]} ${scores[0]}：${scores[1]} ${names[1]}`;
  };
  syncScore();
  bar.append(
    scoreEl,
    el("div", { class: "spacer" }),
    app.viewControls(),
    button(ZH.replayExit, () => (aborted = true), "btn small fixed"),
  );
  document.body.append(bar);

  for (const b of rep.battles) {
    if (aborted) break;
    app.frameHook = null;
    const rcA = resolveCombo(app.index, b.deckA as ComboSelection);
    const rcB = resolveCombo(app.index, b.deckB as ComboSelection);
    const pA = deriveBeyParams(rcA);
    const pB = deriveBeyParams(rcB);
    app.view.setBeys({ rc: rcA, params: pA }, { rc: rcB, params: pB });
    await app.view.stageLaunchers(b.launches as [LaunchParams, LaunchParams]);
    const cfg: WorldConfig = {
      seed: b.seed,
      beys: [pA, pB],
      launches: b.launches as [LaunchParams, LaunchParams],
      xtremeDashEnabled: rules.xtremeDashEnabled,
      clicksMax: 4,
      maxTicks: 240 * 180,
    };
    const world = await playBattle(app, cfg, { allowSkip: true, abort: () => aborted });
    if (aborted) break;
    // Replay uses the same live post-finish world as a normal match. Besides
    // keeping the survivor spinning, this gives deterministic Burst bodies
    // time to fall, bounce and settle under the finish banner.
    let afterglowAccumulator = 0;
    app.frameHook = (dt) => {
      afterglowAccumulator += dt;
      let steps = 0;
      while (afterglowAccumulator > DT && steps < 1200) {
        step(world, cfg, app.stadium(), true);
        afterglowAccumulator -= DT;
        steps++;
      }
      app.view.consumeEvents(world);
      app.view.update(world, dt);
    };
    if (world.finish) {
      const f = world.finish;
      scores[f.winner] += pointsForFinish(rules, f);
      syncScore();
      const o = overlay("transparent");
      o.append(
        el("div", { class: "banner-big" }, `${names[f.winner]}｜${ZH.finish[f.type]}！`),
      );
      document.body.append(o);
      await sleep(1500);
      o.remove();
    } else {
      await sleep(600);
    }
    app.frameHook = null;
  }

  app.frameHook = null;
  bar.remove();
  app.view.clearBeys();
  app.rules = prevRules;
  app.view.setStadium(app.stadium());
  app.startMenuCinema();
  if (!aborted) {
    const o = overlay();
    const panel = el("div", { class: "panel" });
    panel.append(
      el("div", { class: "title", style: "font-size:22px" }, fmt(ZH.winner, { name: rec.winner })),
      el("div", { class: "scoreboard" }, `${rec.scores[0]}：${rec.scores[1]}`),
      button(ZH.back, () => {
        o.remove();
        onDone();
      }, "btn primary"),
    );
    o.append(panel);
    app.setScreen(o);
  } else {
    onDone();
  }
}
