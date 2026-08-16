// 多人模式（線上）: host a room (optional password, quick match or
// tournament with configurable rules and bot participants) or join one.
// Quick: relay slots 0/1 battle with launch-parameter lockstep. Tournament:
// host builds the bracket from joined humans + bots; human battles are
// played by their participants (lockstep), bot-vs-bot battles are simulated
// by the host; results propagate to every client's bracket.

import { PartIndex, deriveBeyParams, resolveCombo } from "../core/derive";
import type { ComboSelection, LaunchParams } from "../core/types";
import { getAuth } from "../game/auth";
import { BOT_ROSTER, botBuildDeck, botChooseLaunch, type BotProfile } from "../game/bots";
import { getPrefs, savePrefs } from "../game/persist";
import { MatchEngine, RULE_PRESETS, type RuleSet } from "../game/rules";
import { simulateBattle } from "../core/sim";
import { STADIUMS } from "../core/stadium";
import { Tournament, type TournamentSlot } from "../game/tournament";
import { ZH, fmt } from "../i18n/zh";
import { LockstepExchange, RelayClient, defaultRelayWsBase, type GameMsg } from "../net/client";
import { button, el, overlay, row, select } from "./dom";
import { collectLocalLaunch, runMatch } from "./match";
import { rulesPicker, type SlotConfig } from "./setup";
import type { GameApp } from "./app";

interface RoomCfg {
  mode: "quick" | "tournament";
  rules: RuleSet;
  totalSlots: number;
  bots: BotProfile[];
}

export function showOnline(app: GameApp): void {
  const o = overlay();
  const panel = el("div", { class: "panel" });
  const nick = getAuth()?.nickname ?? "玩家";
  const roomIn = el("input", { type: "text", placeholder: ZH.roomCode });
  const passIn = el("input", { type: "password", placeholder: ZH.mode.roomPassword });
  panel.append(
    el("div", { class: "title", style: "font-size:22px" }, ZH.mode.multi),
    el("div", { class: "subtitle" }, nick),
    button(ZH.mode.hostRoom, () => showHost(app), "btn primary"),
    el("div", { class: "label" }, ZH.mode.joinExisting),
    row(roomIn, passIn),
    button(ZH.joinRoom, () => {
      app.enableGyroByDefault();
      void enterRoom(app, roomIn.value.trim() || "beyx", passIn.value, null);
    }),
    button(ZH.back, () => app.showModeSelect()),
  );
  o.append(panel);
  app.setScreen(o);
}

function showHost(app: GameApp): void {
  const o = overlay();
  const panel = el("div", { class: "panel", style: "max-height:88vh; overflow-y:auto" });
  const roomIn = el("input", { type: "text" });
  roomIn.value = Math.random().toString(36).slice(2, 7);
  const passIn = el("input", { type: "password", placeholder: ZH.mode.roomPassword });
  const modeSel = select([
    { value: "quick", label: ZH.menu.quick },
    { value: "tournament", label: ZH.menu.tournament },
  ]);
  const slotsSel = select([2, 3, 4, 6, 8].map((n) => ({ value: String(n), label: `${n} 名參賽者` })), "4");
  const botsWrap = el("div", { class: "label" }, "");
  const syncBots = (): void => {
    botsWrap.textContent =
      modeSel.value === "tournament"
        ? `${ZH.mode.botCount}：依加入人數自動補足（電腦名單取自內建選手）`
        : "";
    slotsSel.style.display = modeSel.value === "tournament" ? "" : "none";
  };
  modeSel.addEventListener("change", syncBots);
  syncBots();
  panel.append(
    el("div", { class: "title", style: "font-size:22px" }, ZH.mode.hostRoom),
    row(el("span", { class: "label fixed" }, ZH.roomCode), roomIn),
    row(passIn),
    row(modeSel, slotsSel),
    botsWrap,
    el("div", { class: "label" }, ZH.rules),
    rulesPicker(app),
    button(ZH.createRoom, () => {
      app.enableGyroByDefault();
      const cfg: RoomCfg = {
        mode: modeSel.value as RoomCfg["mode"],
        rules: { ...app.rules },
        totalSlots: Number(slotsSel.value),
        bots: BOT_ROSTER.slice(0, 8),
      };
      void enterRoom(app, roomIn.value.trim() || "beyx", passIn.value, cfg);
    }, "btn primary"),
    button(ZH.back, () => showOnline(app)),
  );
  o.append(panel);
  app.setScreen(o);
}

function statusScreen(app: GameApp, text: string): { set: (t: string) => void; close: () => void } {
  const o = overlay();
  const t = el("div", { class: "banner-big", style: "font-size:22px" }, text);
  const back = button(ZH.back, () => {
    o.remove();
    app.showModeSelect();
  });
  o.append(t, back);
  app.setScreen(o);
  return { set: (s) => (t.textContent = s), close: () => o.remove() };
}

/** Connect, run the knock/accept password handshake, then dispatch by mode. */
async function enterRoom(app: GameApp, room: string, pass: string, hostCfg: RoomCfg | null): Promise<void> {
  const status = statusScreen(app, ZH.waitingOpponent);
  const client = new RelayClient();
  client.onClose = (r) => status.set(`${ZH.disconnected}: ${r}`);
  let cfg = hostCfg;
  try {
    const slot = await client.connect(defaultRelayWsBase(), room, getAuth()?.nickname ?? "玩家");
    const isHost = slot === 0;
    if (isHost && !cfg) {
      cfg = { mode: "quick", rules: { ...app.rules }, totalSlots: 2, bots: BOT_ROSTER.slice(0, 8) };
    }
    if (isHost) {
      client.onMsg = (from, msg) => {
        if (msg.t === "knock") {
          client.send(
            msg.pass === (pass ?? "")
              ? ({ t: "accept", to: from, cfg: cfg! } as GameMsg)
              : ({ t: "reject", to: from } as GameMsg),
          );
        }
      };
    } else {
      const accepted = new Promise<RoomCfg>((resolve, reject) => {
        client.onMsg = (from, msg) => {
          if (from !== 0) return;
          if (msg.t === "accept" && (msg.to === slot || msg.to === undefined)) resolve(msg.cfg as RoomCfg);
          if (msg.t === "reject" && (msg.to === slot || msg.to === undefined)) reject(new Error(ZH.mode.wrongPassword));
        };
      });
      client.send({ t: "knock", pass } as GameMsg);
      cfg = await accepted;
      app.rules = { ...RULE_PRESETS.official!, ...cfg.rules };
      app.view.setStadium(app.stadium());
    }
    savePrefs({ rulesPreset: app.rules.name === "官方標準" ? "official" : getPrefs().rulesPreset });
    if (cfg!.mode === "quick") {
      await onlineQuick(app, client, status);
    } else {
      await onlineTournament(app, client, cfg!, status);
    }
  } catch (err) {
    status.set(String(err instanceof Error ? err.message : err));
    client.close();
  }
}

/** Quick: relay slots 0/1 battle (later joiners just watch the room). */
async function onlineQuick(
  app: GameApp,
  client: RelayClient,
  status: { set: (t: string) => void; close: () => void },
): Promise<void> {
  const mySlot = client.slot as 0 | 1;
  if (mySlot > 1) {
    status.set(ZH.mode.waitingHost);
    return;
  }
  await new Promise<void>((resolve) => {
    const check = (): void => {
      if (client.players.filter(Boolean).length >= 2) resolve();
    };
    client.onRoom = check;
    check();
  });
  status.close();

  const exchange = new LockstepExchange(client, (1 - mySlot) as 0 | 1);
  const prefs = getPrefs();
  const myComboRef = prefs.quickSlots?.[0] as SlotConfig | undefined;
  const myCombo: ComboSelection =
    (myComboRef?.deckRefs?.[0] && safeResolve(app, myComboRef.deckRefs[0])) ||
    app.db.combos[0]!.parts;
  const remoteDeck = await exchange.exchangeDeck([myCombo]);
  const names: [string, string] = [
    client.players[0] || fmt(ZH.playerN, { n: 1 }),
    client.players[1] || fmt(ZH.playerN, { n: 2 }),
  ];
  const decks = mySlot === 0 ? [[myCombo], remoteDeck] : [remoteDeck, [myCombo]];
  const slots: [SlotConfig, SlotConfig] = [
    { kind: mySlot === 0 ? "human" : "bot", name: names[0], bot: BOT_ROSTER[0]!, deckRefs: [], launcher: prefs.launcher },
    { kind: mySlot === 1 ? "human" : "bot", name: names[1], bot: BOT_ROSTER[0]!, deckRefs: [], launcher: prefs.launcher },
  ];
  await runMatch(
    app,
    slots,
    () => {
      client.close();
      app.showModeSelect();
    },
    {
      setup: (engine: MatchEngine) => {
        engine.players[0].deck = decks[0]!;
        engine.players[1].deck = decks[1]!;
      },
      seed: () => exchange.exchangeSeed(),
      launches: async (engine: MatchEngine) => {
        const mine = await collectLocalLaunch(app, engine, mySlot, names[mySlot], getPrefs().launcher);
        if (mine === "matchOver") return "matchOver";
        const theirs = await exchange.exchangeLaunch(mine);
        return (mySlot === 0 ? [mine, theirs] : [theirs, mine]) as [LaunchParams, LaunchParams];
      },
    },
    "線上對戰",
  );
}

function safeResolve(app: GameApp, ref: string): ComboSelection | null {
  try {
    return app.resolveComboRef(ref);
  } catch {
    return null;
  }
}

/** Host-orchestrated online tournament: joined humans + bots fill the rest. */
async function onlineTournament(
  app: GameApp,
  client: RelayClient,
  cfg: RoomCfg,
  status: { set: (t: string) => void; close: () => void },
): Promise<void> {
  const isHost = client.slot === 0;
  const index = new PartIndex(app.db);

  // ---- roster assembly (host presses start; everyone receives it) --------
  let tSlots: (TournamentSlot & { relaySlot: number | null })[] = [];
  const begun = new Promise<void>((resolve) => {
    const prev = client.onMsg;
    client.onMsg = (from, msg) => {
      prev?.(from, msg);
      if (msg.t === "tbegin" && from === 0) {
        tSlots = msg.slots as typeof tSlots;
        resolve();
      }
    };
  });
  if (isHost) {
    await new Promise<void>((resolve) => {
      status.set(`${ZH.waitingOpponent}（${ZH.tapToContinue}）`);
      const startBtn = button(ZH.start, () => resolve(), "btn primary");
      startBtn.style.cssText = "position:fixed;bottom:18vh;left:25vw;right:25vw;z-index:30";
      document.body.append(startBtn);
      const cleanup = (): void => startBtn.remove();
      void begun.finally(cleanup);
      setTimeout(() => {
        /* host can start any time; button removed when tbegin sent */
      }, 0);
    });
    const humans = client.players.map((n, i) => ({ n, i })).filter((x) => x.n);
    const total = Math.max(cfg.totalSlots, humans.length);
    tSlots = [];
    for (const h of humans.slice(0, total)) {
      tSlots.push({
        name: h.n,
        kind: "human",
        bot: BOT_ROSTER[0]!,
        deck: [app.db.combos[h.i % app.db.combos.length]!.parts],
        relaySlot: h.i,
      });
    }
    let bi = 0;
    while (tSlots.length < total) {
      const profile = cfg.bots[bi % cfg.bots.length]!;
      tSlots.push({
        name: profile.name,
        kind: "bot",
        bot: profile,
        deck: botBuildDeck(app.db, profile, cfg.rules, 5000 + bi * 131),
        relaySlot: null,
      });
      bi++;
    }
    client.send({ t: "tbegin", slots: tSlots } as GameMsg);
  }
  await begun.catch(() => {});
  if (tSlots.length === 0) return;
  status.close();

  const tour = new Tournament(tSlots, "singleElim");
  const myRelay = client.slot;

  // bracket loop — everyone advances the same bracket from broadcast results
  for (;;) {
    const match = tour.next();
    if (!match) break;
    const a = tSlots[match.a!]!;
    const b = tSlots[match.b!]!;
    const iAmA = a.relaySlot === myRelay;
    const iAmB = b.relaySlot === myRelay;

    if (iAmA || iAmB) {
      // I fight this one: human-vs-human uses lockstep with the other relay
      // slot; human-vs-bot computes the bot deterministically from matchId.
      const opp = iAmA ? b : a;
      const winner = await playOnlineTourMatch(app, client, index, cfg, match.id, a, b, iAmA ? 0 : 1, opp.relaySlot);
      if ((iAmA && winner === 0) || (iAmB && winner === 1)) {
        client.send({ t: "tres", matchId: match.id, winner: match.a! } as GameMsg);
        tour.report(match.id, match.a!);
        continue;
      } else if (iAmA || iAmB) {
        client.send({ t: "tres", matchId: match.id, winner: iAmA ? match.b! : match.a! } as GameMsg);
        tour.report(match.id, iAmA ? match.b! : match.a!);
        continue;
      }
    } else if (isHost && a.relaySlot === null && b.relaySlot === null) {
      // bot vs bot: host simulates headless and broadcasts the result
      const winner = simulateBotMatch(app, index, cfg.rules, a, b, 9000 + match.id * 17);
      const winSlot = winner === 0 ? match.a! : match.b!;
      client.send({ t: "tres", matchId: match.id, winner: winSlot } as GameMsg);
      tour.report(match.id, winSlot);
      continue;
    } else {
      // someone else's battle: wait for its result
      const winSlot = await new Promise<number>((resolve) => {
        const prev = client.onMsg;
        client.onMsg = (from, msg) => {
          prev?.(from, msg);
          if (msg.t === "tres" && msg.matchId === match.id) resolve(msg.winner as number);
        };
      });
      tour.report(match.id, winSlot);
      const st = statusScreen(app, `${a.name} vs ${b.name}｜${ZH.mode.waitingHost}`);
      st.close();
      continue;
    }
  }
  const champ = tour.champion !== null ? tSlots[tour.champion]!.name : "?";
  const done = statusScreen(app, fmt(ZH.champion, { name: champ }));
  void done;
  client.close();
}

function simulateBotMatch(
  app: GameApp,
  index: PartIndex,
  rules: RuleSet,
  a: TournamentSlot,
  b: TournamentSlot,
  seed: number,
): 0 | 1 {
  const engine = new MatchEngine({ ...rules }, [
    { name: a.name, kind: "bot", deck: a.deck },
    { name: b.name, kind: "bot", deck: b.deck },
  ]);
  let guard = 0;
  while (engine.winner === null && guard++ < 60) {
    const rcA = resolveCombo(index, engine.deckOf(0));
    const rcB = resolveCombo(index, engine.deckOf(1));
    const w = simulateBattle(
      {
        seed: seed + guard * 977,
        beys: [deriveBeyParams(rcA), deriveBeyParams(rcB)],
        launches: [
          botChooseLaunch(a.bot!, rcA.parts.blade?.rotation ?? "right", seed + guard * 3),
          botChooseLaunch(b.bot!, rcB.parts.blade?.rotation ?? "right", seed + guard * 7),
        ],
        xtremeDashEnabled: rules.xtremeDashEnabled,
        clicksMax: 4,
        maxTicks: 240 * 120,
      },
      STADIUMS[rules.stadium] ?? STADIUMS.bx10!,
    );
    engine.applyBattle(w.finish, w.draw);
  }
  return (engine.winner ?? 0) as 0 | 1;
}

/** One tournament match where I participate (0 = I'm side A). */
async function playOnlineTourMatch(
  app: GameApp,
  client: RelayClient,
  index: PartIndex,
  cfg: RoomCfg,
  matchId: number,
  a: TournamentSlot,
  b: TournamentSlot,
  mySide: 0 | 1,
  oppRelay: number | null,
): Promise<0 | 1> {
  void index;
  const prefs = getPrefs();
  const slots: [SlotConfig, SlotConfig] = [
    { kind: a.kind, name: a.name, bot: a.bot ?? BOT_ROSTER[0]!, deckRefs: [], launcher: prefs.launcher },
    { kind: b.kind, name: b.name, bot: b.bot ?? BOT_ROSTER[0]!, deckRefs: [], launcher: prefs.launcher },
  ];
  // my local view: my side is human; the opponent acts remotely/bot-driven
  slots[mySide].kind = "human";
  slots[(1 - mySide) as 0 | 1].kind = "bot";
  const exchange = oppRelay !== null ? new LockstepExchange(client, oppRelay) : null;
  let winner: 0 | 1 = 0;
  await runMatch(
    app,
    slots,
    (w) => {
      winner = w;
    },
    {
      setup: (engine: MatchEngine) => {
        engine.players[0].deck = a.deck;
        engine.players[1].deck = b.deck;
      },
      seed: exchange
        ? () => exchange.exchangeSeed()
        : () => Promise.resolve((0x51ed + matchId * 7919) >>> 0),
      launches: async (engine: MatchEngine) => {
        const mine = await collectLocalLaunch(app, engine, mySide, slots[mySide].name, prefs.launcher);
        if (mine === "matchOver") return "matchOver";
        let theirs: LaunchParams;
        if (exchange) {
          theirs = await exchange.exchangeLaunch(mine);
        } else {
          const oppSlot = (1 - mySide) as 0 | 1;
          const rcO = resolveCombo(app.index, engine.deckOf(oppSlot));
          theirs = botChooseLaunch(
            slots[oppSlot].bot,
            rcO.parts.blade?.rotation ?? "right",
            matchId * 131 + engine.battleIndex * 17,
          );
        }
        return (mySide === 0 ? [mine, theirs] : [theirs, mine]) as [LaunchParams, LaunchParams];
      },
    },
    "線上對戰",
  );
  return winner;
}
