// Match orchestration: countdown + launch phase (human drag / bot params),
// visual battle playback of the deterministic sim, scoring per RuleSet,
// mislaunch handling, hot-seat pass-the-phone, and bot fast-forward.

import { deriveBeyParams, resolveCombo } from "../core/derive";
import { DT, createWorld, simulateBattle, step } from "../core/sim";
import type { LaunchParams, WorldConfig, WorldState } from "../core/types";
import { MatchEngine, pointsForFinish, type PlayerSetup } from "../game/rules";
import { botChooseLaunch } from "../game/bots";
import { bumpProfile, recordMatch } from "../game/persist";
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

/**
 * First-person launcher graphic: left hand holding a string launcher with
 * the bey seated, right hand on the winder grip; the grip + string follow
 * the drag. Inline SVG, stylized-realistic, no assets.
 */
function launcherSvg(): {
  root: HTMLElement;
  setPull: (px: number) => void;
  playLaunch: () => Promise<void>;
} {
  const wrap = el("div", {
    style:
      "width:min(88vw,420px); pointer-events:none; opacity:.85; transition: transform .85s cubic-bezier(.5,0,.9,.4), opacity .85s ease",
  });
  wrap.innerHTML = `
<svg viewBox="0 0 420 300" xmlns="http://www.w3.org/2000/svg" style="width:100%">
  <defs>
    <linearGradient id="lb" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3b4db0"/><stop offset=".55" stop-color="#26307a"/><stop offset="1" stop-color="#161d4d"/>
    </linearGradient>
    <linearGradient id="skin" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#e8b48f"/><stop offset="1" stop-color="#c98f66"/>
    </linearGradient>
    <radialGradient id="beym" cx=".4" cy=".35" r=".8">
      <stop offset="0" stop-color="#dfe6ff"/><stop offset=".5" stop-color="#7d8dd8"/><stop offset="1" stop-color="#2c3670"/>
    </radialGradient>
  </defs>
  <!-- forearm + left hand gripping the launcher -->
  <path d="M60 300 Q70 230 108 208 L150 236 Q120 262 112 300 Z" fill="url(#skin)"/>
  <ellipse cx="128" cy="216" rx="34" ry="24" fill="url(#skin)"/>
  <!-- launcher body -->
  <g>
    <rect x="96" y="150" rx="18" width="180" height="74" fill="url(#lb)" stroke="#0d1233" stroke-width="3"/>
    <rect x="118" y="164" rx="6" width="70" height="18" fill="#5a6ad0" opacity=".8"/>
    <circle cx="240" cy="187" r="20" fill="#141a45" stroke="#5a6ad0" stroke-width="3"/>
    <!-- string exit + string -->
    <rect x="270" y="178" width="14" height="18" rx="4" fill="#0d1233"/>
    <line id="lstr" x1="284" y1="187" x2="336" y2="187" stroke="#e8ecff" stroke-width="4" stroke-linecap="round"/>
    <!-- winder grip + right hand -->
    <g id="lgrip">
      <rect x="336" y="164" rx="10" width="26" height="46" fill="#c93b3b" stroke="#5d1414" stroke-width="3"/>
      <ellipse cx="366" cy="196" rx="30" ry="22" fill="url(#skin)"/>
      <path d="M352 214 Q372 236 366 300 L412 300 Q416 240 396 210 Z" fill="url(#skin)"/>
    </g>
    <!-- fingers over the body -->
    <path d="M104 206 q22 -18 52 -10 q-20 26 -46 22 Z" fill="url(#skin)"/>
  </g>
  <!-- bey seated under the launcher -->
  <g id="lbey" style="transform-box: fill-box; transform-origin: center">
    <circle cx="186" cy="238" r="26" fill="url(#beym)" stroke="#10163d" stroke-width="3"/>
    <circle cx="186" cy="238" r="9" fill="#1a2255"/>
    <path d="M186 212 l7 12 h-14 Z" fill="#e8ecff" opacity=".85"/>
  </g>
  <!-- pull-direction indicator: chevrons streaming down from the winder grip -->
  <g id="lhint" fill="none" stroke="#ffd766" stroke-width="6" stroke-linecap="round">
    <path class="chev c1" d="M337 224 l12 12 12 -12"/>
    <path class="chev c2" d="M337 244 l12 12 12 -12"/>
    <path class="chev c3" d="M337 264 l12 12 12 -12"/>
  </g>
</svg>`;
  const grip = wrap.querySelector<SVGGElement>("#lgrip")!;
  const str = wrap.querySelector<SVGLineElement>("#lstr")!;
  const hint = wrap.querySelector<SVGGElement>("#lhint")!;
  const bey = wrap.querySelector<SVGGElement>("#lbey")!;
  const setPull = (px: number): void => {
    const d = Math.min(150, px * 0.32);
    if (d > 4) hint.style.opacity = "0";
    grip.setAttribute("transform", `translate(${d * 0.25} ${d})`);
    str.setAttribute("x2", String(336 + d * 0.25));
    str.setAttribute("y2", String(187 + d));
  };
  // the top rips off the launcher and flies toward the stadium while the
  // launcher drops out of view, revealing the battle
  const playLaunch = (): Promise<void> =>
    new Promise((resolve) => {
      const t0 = performance.now();
      const spin = (): void => {
        const t = Math.min(1, (performance.now() - t0) / 700);
        bey.style.transform = `translateY(${-150 * t}px) scale(${1 - 0.55 * t}) rotate(${t * 2200}deg)`;
        bey.style.opacity = String(1 - t * 0.9);
        if (t < 1) requestAnimationFrame(spin);
        else resolve();
      };
      requestAnimationFrame(spin);
      setTimeout(() => {
        wrap.style.transform = "translateY(70vh)";
        wrap.style.opacity = "0";
      }, 180);
    });
  return { root: wrap, setPull, playLaunch };
}

/** Human launch: countdown + drag gesture. Returns params or a mislaunch. */
async function humanLaunch(
  app: GameApp,
  playerName: string,
  side: 0 | 1,
  launcher: LaunchParams["launcher"] = "string",
): Promise<{ launch: LaunchParams | null; mislaunch: "early" | "late" | "weak" | null }> {
  app.view.mode = app.view.mode === "gyro" ? "gyro" : "launch";
  app.view.launchSide = side;

  const zone = el("div", { class: "launchzone" });
  const hint = el("div", { class: "banner-big", style: "font-size:20px" }, `${playerName}｜${ZH.pullToLaunch}`);
  const calHint = el("div", { class: "label", style: "text-align:center" }, ZH.calibrateHint);
  const count = el("div", { class: "countdown" }, "");
  const meter = el("div", { class: "spmeter" }, el("div", { class: "spfill" }));
  const fill = meter.firstElementChild as HTMLElement;
  const rig = launcherSvg();
  zone.append(count, hint, calHint, rig.root);
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

  const result = await captureLaunch(zone, {
    shootAtMs: shootAt,
    ...LAUNCH_WINDOWS,
    onProgress: (sp, pullPx) => {
      fill.style.width = `${Math.min(100, (sp / 11000) * 100)}%`;
      rig.setPull(pullPx);
    },
  });

  if (result.mislaunch) {
    zone.remove();
    meter.remove();
    return { launch: null, mislaunch: result.mislaunch };
  }
  await rig.playLaunch(); // show the top leaving the launcher
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
        out.push(botChooseLaunch(s.bot, rotation, (battleSeed ^ (side + 1) * 0x9e37) >>> 0));
        continue;
      }
      if (bothHuman && side === 1) {
        await flashBanner(fmt(ZH.passPhone, { name: names[1] }), 1600);
      }
      let launched: LaunchParams | null = null;
      while (!launched) {
        const r = await humanLaunch(app, names[side], side, s.launcher);
        if (r.launch) {
          const spinDir =
            rotation === "left" || rotation === "both-left-origin" ? -1 : 1;
          launched = { ...r.launch, spinDir };
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
  opts: { allowSkip: boolean },
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
      if (world.finish || world.draw) {
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
  for (;;) {
    const r = await humanLaunch(app, name, side, launcher);
    if (r.launch) {
      const spinDir = rotation === "left" || rotation === "both-left-origin" ? -1 : 1;
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
