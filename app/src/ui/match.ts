// Match orchestration: countdown + launch phase (human drag / bot params),
// visual battle playback of the deterministic sim, scoring per RuleSet,
// mislaunch handling, hot-seat pass-the-phone, and bot fast-forward.

import { deriveBeyParams, resolveCombo, type ResolvedCombo } from "../core/derive";
import type { BeyParams } from "../core/types";
import { DT, createWorld, simulateBattle, step } from "../core/sim";
import type { LaunchParams, WorldConfig, WorldState } from "../core/types";
import { MatchEngine, pointsForFinish, type PlayerSetup } from "../game/rules";
import { botChooseLaunch, botChooseLaunchAdaptive } from "../game/bots";
import { bumpProfile, launchStats, recordLaunch, recordMatch, type ReplayBattle } from "../game/persist";
import { captureLaunch, LAUNCH_WINDOWS } from "../input/launcher";
import { ZH, fmt } from "../i18n/zh";
import { button, el, overlay } from "./dom";
import { sfx } from "../audio/sfx";
import type { GameApp } from "./app";
import { resolveDeck, slotDisplayName, type SlotConfig } from "./setup";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function banner(text: string): HTMLElement {
  const o = overlay("transparent");
  o.append(el("div", { class: "banner-big" }, text));
  document.body.append(o);
  return o;
}

async function flashBanner(text: string, ms = 1400): Promise<void> {
  const b = banner(text);
  await sleep(ms);
  b.remove();
}

function scoreboard(app: GameApp, engine: MatchEngine, names: [string, string]): HTMLElement {
  const bar = el("div", { class: "topbar" });
  const score = el(
    "div",
    { class: "scoreboard" },
    `${names[0]} ${engine.scores[0]}：${engine.scores[1]} ${names[1]}`,
  );
  bar.append(score, el("div", { class: "spacer" }), app.viewControls());
  return bar;
}

/** Human launch: countdown + full-screen drag gesture. The launcher, the
 * player's actual bey, string and winder are a camera-attached 3D rig. */
async function humanLaunch(
  app: GameApp,
  playerName: string,
  side: 0 | 1,
  launcher: LaunchParams["launcher"] = "string",
  rc: ResolvedCombo | null = null,
  beyParams: BeyParams | null = null,
  opp: { rc: ResolvedCombo; params: BeyParams; side: 0 | 1 } | null = null,
): Promise<{ launch: LaunchParams | null; mislaunch: "early" | "late" | "weak" | null }> {
  app.view.mode = app.view.mode === "gyro" ? "gyro" : "launch";
  app.view.launchSide = side;
  if (rc && beyParams) {
    app.view.attachLauncher(rc, beyParams, side === 0 ? 0x3f7bff : 0xff5b4d);
  }
  // the opponent launches at the countdown too — their launcher hovers over
  // their corner and releases exactly on GO SHOOT
  if (opp) app.view.attachOpponentLauncher(opp.rc, opp.params, opp.side);

  const zone = el("div", { class: "launchzone" });
  const hint = el("div", { class: "banner-big", style: "font-size:20px" }, `${playerName}｜${ZH.pullToLaunch}`);
  const calHint = el("div", { class: "label", style: "text-align:center" }, ZH.calibrateHint);
  const count = el("div", { class: "countdown" }, "");
  const meter = el("div", { class: "spmeter" }, el("div", { class: "spfill" }));
  const fill = meter.firstElementChild as HTMLElement;
  zone.append(count, hint, calHint);
  document.body.append(zone, meter);

  const shootAt = Date.now() + 2400;
  const seq = [
    { at: 0, text: "3" },
    { at: 700, text: "2" },
    { at: 1400, text: "1" },
    { at: 2100, text: "GO SHOOT!!" },
  ];
  for (const s of seq) {
    setTimeout(() => {
      count.textContent = s.text;
      sfx.beep(s.text.startsWith("GO"));
    }, s.at + 300);
  }
  if (opp) {
    setTimeout(() => {
      sfx.launch(7500);
      void app.view.playOpponentRelease(opp.side);
    }, Math.max(0, shootAt - Date.now()));
  }

  const result = await captureLaunch(zone, {
    shootAtMs: shootAt,
    ...LAUNCH_WINDOWS,
    onProgress: (sp, pullPx) => {
      fill.style.width = `${Math.min(100, (sp / 11000) * 100)}%`;
      app.view.setLauncherPull(pullPx);
    },
  });

  if (result.mislaunch) {
    app.view.removeLauncher();
    app.view.removeOpponentLauncher(); // re-battle: everyone re-launches
    zone.remove();
    meter.remove();
    return { launch: null, mislaunch: result.mislaunch };
  }
  await app.view.releaseLauncher(); // bey rips off, launcher lifts away
  app.view.removeLauncher();
  app.view.removeOpponentLauncher();
  zone.remove();
  meter.remove();
  const aimDeg = Math.max(-12, Math.min(12, result.releaseOffsetMs / 50));
  return {
    launch: { sp: result.sp, aimDeg, tiltDeg: 0, launcher, spinDir: 1 },
    mislaunch: null,
  };
}

/** Collect both players' launches; handles mislaunch penalties + restarts. */
async function collectLaunches(
  app: GameApp,
  engine: MatchEngine,
  slots: [SlotConfig, SlotConfig],
  names: [string, string],
  battleSeed: number,
): Promise<[LaunchParams, LaunchParams] | "matchOver"> {
  const bothHuman = slots[0].kind === "human" && slots[1].kind === "human";
  for (;;) {
    const out: LaunchParams[] = [];
    let restart = false;
    for (const side of [0, 1] as const) {
      const s = slots[side];
      const combo = engine.deckOf(side);
      const rc = resolveCombo(app.index, combo);
      const rotation = rc.parts.blade?.rotation ?? rc.parts.lockChip?.rotation ?? "right";
      if (s.kind === "bot") {
        // character-driven and reactive to the opponent's past launches
        const lastDecisive = [...engine.history].reverse().find((h) => h.scorer !== null);
        out.push(
          botChooseLaunchAdaptive(s.bot, rotation, (battleSeed ^ (side + 1) * 0x9e37) >>> 0, {
            oppAvgSp: launchStats()?.avgSp ?? null,
            lostLast: lastDecisive ? lastDecisive.scorer !== side : false,
            battleIndex: engine.battleIndex,
          }),
        );
        continue;
      }
      if (bothHuman && side === 1) {
        await flashBanner(fmt(ZH.passPhone, { name: names[1] }), 1600);
      }
      // the opponent's launcher shows + fires during my countdown
      const oppSide = (1 - side) as 0 | 1;
      const oppRc = resolveCombo(app.index, engine.deckOf(oppSide));
      const opp = { rc: oppRc, params: deriveBeyParams(oppRc), side: oppSide };
      let launched: LaunchParams | null = null;
      while (!launched) {
        const r = await humanLaunch(app, names[side], side, s.launcher, rc, deriveBeyParams(rc), opp);
        if (r.launch) {
          const spinDir =
            rotation === "left" || rotation === "both-left-origin" ? -1 : 1;
          launched = { ...r.launch, spinDir };
          recordLaunch(launched.sp, launched.aimDeg); // feeds bot adaptivity
          break;
        }
        await flashBanner(ZH.mislaunch[r.mislaunch!], 1100);
        const penalty = engine.reportMislaunch(side);
        if (penalty) {
          await flashBanner(ZH.mislaunchPenalty, 1500);
          if (engine.winner !== null) return "matchOver";
          restart = true; // round restarts: recollect everyone
          break;
        }
      }
      if (restart) break;
      out.push(launched!);
    }
    if (!restart) return out as [LaunchParams, LaunchParams];
  }
}

/** Animate one battle world to its end (with bot fast-forward support). */
export function playBattle(
  app: GameApp,
  cfg: WorldConfig,
  opts: { allowSkip: boolean; abort?: () => boolean },
): Promise<WorldState> {
  return new Promise((resolve) => {
    const stadium = app.stadium();
    const world = createWorld(cfg);
    let acc = 0;
    let skipBtn: HTMLElement | null = null;
    if (opts.allowSkip) {
      skipBtn = el("div", { class: "topbar", style: "top:auto; bottom: 12px" });
      skipBtn.append(
        el("div", { class: "spacer" }),
        button("快轉 ⏩", () => {
          while (!world.finish && !world.draw) step(world, cfg, stadium);
        }, "btn small"),
      );
      document.body.append(skipBtn);
    }
    app.frameHook = (dt) => {
      acc += dt;
      let steps = 0;
      while (acc > DT && !world.finish && !world.draw && steps < 2400) {
        step(world, cfg, stadium);
        acc -= DT;
        steps++;
      }
      app.view.consumeEvents(world);
      app.view.update(world, dt);
      if (world.finish || world.draw || opts.abort?.()) {
        app.frameHook = null;
        skipBtn?.remove();
        resolve(world);
      }
    };
  });
}

/** One side's human launch with mislaunch handling (used by online play). */
export async function collectLocalLaunch(
  app: GameApp,
  engine: MatchEngine,
  side: 0 | 1,
  name: string,
  launcher: LaunchParams["launcher"] = "string",
): Promise<LaunchParams | "matchOver"> {
  const combo = engine.deckOf(side);
  const rc = resolveCombo(app.index, combo);
  const rotation = rc.parts.blade?.rotation ?? rc.parts.lockChip?.rotation ?? "right";
  const oppSide = (1 - side) as 0 | 1;
  const oppRc = resolveCombo(app.index, engine.deckOf(oppSide));
  const opp = { rc: oppRc, params: deriveBeyParams(oppRc), side: oppSide };
  for (;;) {
    const r = await humanLaunch(app, name, side, launcher, rc, deriveBeyParams(rc), opp);
    if (r.launch) {
      const spinDir = rotation === "left" || rotation === "both-left-origin" ? -1 : 1;
      recordLaunch(r.launch.sp, r.launch.aimDeg);
      return { ...r.launch, spinDir };
    }
    await flashBanner(ZH.mislaunch[r.mislaunch!], 1100);
    const penalty = engine.reportMislaunch(side);
    if (penalty) {
      await flashBanner(ZH.mislaunchPenalty, 1500);
      if (engine.winner !== null) return "matchOver";
    }
  }
}

export interface MatchHooks {
  /** called right after the engine is created (online: patch slot decks) */
  setup?: (engine: MatchEngine) => void;
  /** online: provide launches instead of local collection */
  launches?: (engine: MatchEngine, battleSeed: number) => Promise<[LaunchParams, LaunchParams] | "matchOver">;
  seed?: () => Promise<number>;
}

/** Full match between two configured slots. Calls onDone(winnerIndex). */
export async function runMatch(
  app: GameApp,
  slots: [SlotConfig, SlotConfig],
  onDone: (winner: 0 | 1) => void,
  hooks: MatchHooks = {},
  mode = "快速對戰",
): Promise<void> {
  app.setScreen(null);
  const names: [string, string] = [slotDisplayName(slots[0]), slotDisplayName(slots[1])];
  const players: [PlayerSetup, PlayerSetup] = [
    { name: names[0], kind: slots[0].kind, deck: resolveDeck(app, slots[0], 501) },
    { name: names[1], kind: slots[1].kind, deck: resolveDeck(app, slots[1], 502) },
  ];
  const engine = new MatchEngine(app.rules, players);
  hooks.setup?.(engine);
  const bothBots = slots[0].kind === "bot" && slots[1].kind === "bot";
  let hud = scoreboard(app, engine, names);
  document.body.append(hud);

  await flashBanner(ZH.battleStart, 1000);
  const replayBattles: ReplayBattle[] = [];
  while (engine.winner === null) {
    const combo0 = engine.deckOf(0);
    const combo1 = engine.deckOf(1);
    const rc0 = resolveCombo(app.index, combo0);
    const rc1 = resolveCombo(app.index, combo1);
    const p0 = deriveBeyParams(rc0, { label: app.comboLabel(combo0) });
    const p1 = deriveBeyParams(rc1, { label: app.comboLabel(combo1) });
    app.view.setBeys({ rc: rc0, params: p0 }, { rc: rc1, params: p1 });

    const seed = hooks.seed ? await hooks.seed() : (Math.random() * 0xffffffff) >>> 0;
    const launches = hooks.launches
      ? await hooks.launches(engine, seed)
      : await collectLaunches(app, engine, slots, names, seed);
    if (launches === "matchOver") break;

    app.view.beginCameraEase(0.9); // launcher pulls away → full stadium view
    app.view.mode = app.view.mode === "gyro" ? "gyro" : "orbit";
    const cfg: WorldConfig = {
      seed,
      beys: [p0, p1],
      launches,
      xtremeDashEnabled: app.rules.xtremeDashEnabled,
      clicksMax: 4,
      maxTicks: 240 * 180,
    };
    replayBattles.push({ seed, launches: [launches[0], launches[1]], deckA: combo0, deckB: combo1 });
    const world = await playBattle(app, cfg, { allowSkip: bothBots });

    if (world.finish) {
      const f = world.finish;
      if (f.type === "burst") sfx.burst();
      const pts = pointsForFinish(app.rules, f);
      engine.applyBattle(f, false);
      await flashBanner(
        `${names[f.winner]}｜${ZH.finish[f.type]}！＋${pts} ${ZH.points}${f.ownFinish ? ZH.ownFinish : ""}`,
        1800,
      );
    } else {
      engine.applyBattle(null, true);
      await flashBanner(ZH.draw, 1400);
    }
    hud.remove();
    hud = scoreboard(app, engine, names);
    document.body.append(hud);
  }

  const winner = engine.winner ?? 0;
  hud.remove();
  app.view.clearBeys();
  recordMatch({
    ts: Date.now(),
    mode,
    players: slots.map((s, i) => ({ name: names[i as 0 | 1], kind: s.kind })),
    scores: [engine.scores[0], engine.scores[1]],
    winner: names[winner],
    rules: app.rules.name,
    stadium: app.stadium().labelZh,
    finishes: engine.history
      .filter((h) => h.finish)
      .map((h) => `${h.finish!.type}:${names[h.finish!.winner]}`),
    replay: {
      rules: { ...app.rules },
      stadiumKey: app.rules.stadium,
      battles: replayBattles,
    },
  });
  for (const i of [0, 1] as const) {
    if (slots[i].kind === "human") bumpProfile(names[i], winner === i);
  }
  const o = overlay();
  const panel = el("div", { class: "panel" });
  panel.append(
    el("div", { class: "title", style: "font-size:24px" }, fmt(ZH.winner, { name: names[winner] })),
    el("div", { class: "scoreboard" }, `${engine.scores[0]}：${engine.scores[1]}`),
    button(ZH.next, () => {
      o.remove();
      onDone(winner);
    }, "btn primary"),
  );
  o.append(panel);
  app.setScreen(o);
}
