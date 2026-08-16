// 多人模式（線上）: host a room (optional password, quick match or
// tournament) or join one. 參賽人數＝加入房間的手機數 — the host presses
// 開始 once everyone is in; nothing is preset. Quick match with exactly two
// phones runs the standard 1v1 rules flow (launch-parameter lockstep);
// three or more phones automatically switch to the non-standard free-for-all
// (大亂鬥): every phone broadcasts its deck/seed/launch each round, every
// client simulates the identical deterministic N-bey battle, the survivor
// takes the round, and the first to FFA_TARGET round wins takes the match.
// Tournaments: all joined humans + the host-chosen number of bots fill a
// bracket; human battles are lockstep, bot-vs-bot battles are simulated by
// the host; results propagate to every client's bracket.

import { PartIndex, deriveBeyParams, resolveCombo } from "../core/derive";
import type { ComboSelection, LaunchParams, WorldConfig } from "../core/types";
import { getAuth } from "../game/auth";
import { BOT_ROSTER, botBuildDeck, botChooseLaunch, type BotProfile } from "../game/bots";
import { getPrefs, recordLaunch, savePrefs } from "../game/persist";
import { MatchEngine, RULE_PRESETS, type RuleSet } from "../game/rules";
import { DT, simulateBattle, step } from "../core/sim";
import { STADIUMS } from "../core/stadium";
import { Tournament, type TournamentSlot } from "../game/tournament";
import { ZH, fmt } from "../i18n/zh";
import {
  FfaExchange,
  LockstepExchange,
  RelayClient,
  defaultRelayWsBase,
  type GameMsg,
} from "../net/client";
import { button, el, overlay, row, select } from "./dom";
import {
  collectLocalLaunch,
  confirmModal,
  flashBanner,
  humanLaunch,
  playBattle,
  runMatch,
  teardownActiveLaunch,
} from "./match";
import { resolveDeck, rulesPicker, slotEditor, type SlotConfig } from "./setup";
import { sfx } from "../audio/sfx";
import type { GameApp } from "./app";

/** free-for-all: first to this many round wins takes the match */
const FFA_TARGET = 3;

interface RoomCfg {
  mode: "quick" | "tournament";
  rules: RuleSet;
  /** tournament only: bots ADDED on top of every joined phone */
  botCount: number;
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
      const room = roomIn.value.trim() || "beyx";
      const pass = passIn.value;
      // build your bey first, then knock
      void chooseOnlineDeck(app, ZH.mode.setupTitle).then((slot) => {
        if (slot) void enterRoom(app, room, pass, null, slot);
        else showOnline(app);
      });
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
  // participants are NEVER preset — they are whoever joins the room. The
  // only host knob is how many bots pad a tournament bracket.
  const botsSel = select(
    Array.from({ length: 8 }, (_, n) => ({ value: String(n), label: `＋${n} ${ZH.bot}` })),
    "3",
  );
  const syncBots = (): void => {
    botsSel.style.display = modeSel.value === "tournament" ? "" : "none";
  };
  modeSel.addEventListener("change", syncBots);
  syncBots();
  panel.append(
    el("div", { class: "title", style: "font-size:22px" }, ZH.mode.hostRoom),
    row(el("span", { class: "label fixed" }, ZH.roomCode), roomIn),
    row(passIn),
    row(modeSel, botsSel),
    el("div", { class: "label" }, ZH.mode.countHint),
    el("div", { class: "label" }, ZH.rules),
    rulesPicker(app),
    button(ZH.createRoom, () => {
      app.enableGyroByDefault();
      const cfg: RoomCfg = {
        mode: modeSel.value as RoomCfg["mode"],
        rules: { ...app.rules },
        botCount: modeSel.value === "tournament" ? Number(botsSel.value) : 0,
        bots: BOT_ROSTER.slice(0, 8),
      };
      const room = roomIn.value.trim() || "beyx";
      const pass = passIn.value;
      void chooseOnlineDeck(app, ZH.mode.setupTitle).then((slot) => {
        if (slot) void enterRoom(app, room, pass, cfg, slot);
        else showHost(app);
      });
    }, "btn primary"),
    button(ZH.back, () => showOnline(app)),
  );
  o.append(panel);
  app.setScreen(o);
}

/**
 * Your own bey/deck for an online match.
 *
 * Online play used to give you whatever was last saved in the single-player
 * setup — and tournaments simply handed each human an arbitrary official
 * preset — so nobody could actually bring the bey they built. This is the
 * same slot editor the local modes use, locked to "human", shown before the
 * room is entered so the choice is ready to exchange.
 */
function chooseOnlineDeck(app: GameApp, title: string): Promise<SlotConfig | null> {
  return new Promise((resolve) => {
    const prefs = getPrefs();
    const saved = prefs.onlineSlot as SlotConfig | undefined;
    const cfg: SlotConfig = saved
      ? { ...saved, kind: "human", bot: BOT_ROSTER[0]!, name: getAuth()?.nickname ?? saved.name }
      : {
          kind: "human",
          name: getAuth()?.nickname ?? prefs.name,
          bot: BOT_ROSTER[0]!,
          deckRefs: [],
          launcher: prefs.launcher,
        };
    const o = overlay();
    const panel = el("div", { class: "panel", style: "max-height:88vh; overflow-y:auto" });
    const body = el("div", { style: "display:flex; flex-direction:column; gap:8px; width:100%" });
    const render = (): void => {
      body.replaceChildren(slotEditor(app, cfg, ZH.mode.yourBey, render, "human"));
    };
    render();
    panel.append(
      el("div", { class: "title", style: "font-size:20px" }, title),
      el("div", { class: "label" }, ZH.rules),
      rulesPicker(app, render),
      body,
      button(ZH.start, () => {
        savePrefs({ onlineSlot: cfg, launcher: cfg.launcher });
        o.remove();
        resolve(cfg);
      }, "btn primary"),
      button(ZH.back, () => {
        o.remove();
        resolve(null);
      }),
    );
    o.append(panel);
    app.setScreen(o);
  });
}

/** The combos this player brings, resolved from their online slot. */
function myOnlineDeck(app: GameApp, slot: SlotConfig | null): ComboSelection[] {
  if (slot) return resolveDeck(app, slot, 7001);
  return [app.db.combos[0]!.parts];
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

interface QuickBegin {
  slots: number[];
  round: number;
  wins?: [number, number][];
}

/** Latches the newest qbegin from the host so a wait can never miss one
 * that arrived while the client was busy (banner, battle, restart). */
class QbeginWatch {
  latest: QuickBegin | null = null;
  private waiters: (() => void)[] = [];
  private hostGone = false;

  constructor(client: RelayClient) {
    const prev = client.onMsg;
    client.onMsg = (from, msg) => {
      prev?.(from, msg);
      if (msg.t === "qbegin" && from === 0) {
        this.latest = { slots: msg.slots, round: msg.round, wins: msg.wins };
        this.poke();
      }
    };
    const prevRoom = client.onRoom;
    client.onRoom = (players) => {
      prevRoom?.(players);
      if (client.slot !== 0 && !players[0]) {
        this.hostGone = true;
        this.poke();
      }
    };
  }

  private poke(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  wait(afterRound: number): Promise<QuickBegin> {
    return new Promise((resolve, reject) => {
      const check = (): void => {
        if (this.latest && this.latest.round > afterRound) resolve(this.latest);
        else if (this.hostGone) reject(new Error("host-left"));
        else this.waiters.push(check);
      };
      check();
    });
  }
}

/**
 * Latches bracket results as they arrive.
 *
 * The old code installed a listener only at the moment it started waiting,
 * so a result broadcast while this phone was still finishing its own battle
 * animation was missed outright — that phone then sat in the finished match
 * forever while everyone else moved on to the next one. Recording every
 * result as it lands means a late waiter resolves immediately.
 */
class TresWatch {
  private results = new Map<number, number>();
  private waiters: (() => void)[] = [];

  constructor(client: RelayClient) {
    const prev = client.onMsg;
    client.onMsg = (from, msg) => {
      prev?.(from, msg);
      if (msg.t === "tres") {
        this.results.set(msg.matchId, msg.winner);
        const ws = this.waiters;
        this.waiters = [];
        for (const w of ws) w();
      }
    };
  }

  /** Record a result decided locally, so we never wait on our own battle. */
  note(matchId: number, winner: number): void {
    this.results.set(matchId, winner);
  }

  wait(matchId: number): Promise<number> {
    return new Promise((resolve) => {
      const check = (): void => {
        const r = this.results.get(matchId);
        if (r !== undefined) resolve(r);
        else this.waiters.push(check);
      };
      check();
    });
  }
}

/** Both sides must press 再來一場 before an online quick match restarts. */
class RematchWatch {
  private theirs = false;
  private gone = false;
  private waiters: (() => void)[] = [];

  constructor(private client: RelayClient, private oppSlot: number) {
    const prev = client.onMsg;
    client.onMsg = (from, msg) => {
      prev?.(from, msg);
      if (from !== oppSlot) return;
      if (msg.t === "rematch") this.theirs = true;
      else if (msg.t === "leave") this.gone = true;
      this.poke();
    };
    const prevRoom = client.onRoom;
    client.onRoom = (players) => {
      prevRoom?.(players);
      if (!players[oppSlot]) {
        this.gone = true;
        this.poke();
      }
    };
  }

  private poke(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  /** Announce ours, resolve true when theirs is in too. */
  request(): Promise<boolean> {
    this.client.send({ t: "rematch" });
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.theirs) {
          this.theirs = false; // consumed — the next match needs a fresh one
          resolve(true);
        } else if (this.gone) resolve(false);
        else this.waiters.push(check);
      };
      check();
    });
  }
}

/** Shared pre-start lobby: live list of joined phones; the host gets the
 * 開始 button, guests wait for the host's begin broadcast. */
function lobbyScreen(
  app: GameApp,
  client: RelayClient,
  title: string,
  opts: {
    isHost: boolean;
    canStart: (players: string[]) => boolean;
    hint: string;
    guestWait: Promise<unknown> | null;
  },
): Promise<"start" | "guest" | "back"> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: "start" | "guest" | "back"): void => {
      if (done) return;
      done = true;
      o.remove();
      resolve(r);
    };
    const o = overlay();
    const panel = el("div", { class: "panel" });
    const count = el("div", { class: "subtitle", style: "font-size:16px" }, "");
    const list = el("div", { class: "label", style: "text-align:center" }, "");
    const startBtn = opts.isHost ? button(ZH.start, () => finish("start"), "btn primary") : null;
    const refresh = (players: string[]): void => {
      const joined = players.filter(Boolean);
      count.textContent = fmt(ZH.mode.joinedCount, { n: joined.length });
      list.textContent = joined.join("、");
      if (startBtn) startBtn.disabled = !opts.canStart(players);
    };
    const prevRoom = client.onRoom;
    client.onRoom = (players) => {
      prevRoom?.(players);
      refresh(players);
    };
    refresh(client.players);
    panel.append(
      el("div", { class: "title", style: "font-size:22px" }, title),
      count,
      list,
      el("div", { class: "label", style: "text-align:center" }, opts.hint),
    );
    if (startBtn) panel.append(startBtn);
    else panel.append(el("div", { class: "subtitle", style: "font-size:15px" }, ZH.mode.waitingHost));
    panel.append(
      button(ZH.back, () => {
        client.close();
        app.showModeSelect();
        finish("back");
      }),
    );
    o.append(panel);
    app.setScreen(o);
    if (opts.guestWait) {
      opts.guestWait.then(
        () => finish("guest"),
        () => {
          client.close();
          app.showModeSelect();
          finish("back");
        },
      );
    }
  });
}

function connectedSlots(client: RelayClient): number[] {
  return client.players.map((n, i) => ({ n, i })).filter((x) => x.n).map((x) => x.i);
}

/** Connect, run the knock/accept password handshake, then dispatch by mode. */
async function enterRoom(
  app: GameApp,
  room: string,
  pass: string,
  hostCfg: RoomCfg | null,
  mySlot: SlotConfig | null = null,
): Promise<void> {
  const status = statusScreen(app, ZH.waitingOpponent);
  const client = new RelayClient();
  client.onClose = (r) => status.set(`${ZH.disconnected}: ${r}`);
  let cfg = hostCfg;
  try {
    const slot = await client.connect(defaultRelayWsBase(), room, getAuth()?.nickname ?? "玩家");
    const isHost = slot === 0;
    if (isHost && !cfg) {
      cfg = { mode: "quick", rules: { ...app.rules }, botCount: 0, bots: BOT_ROSTER.slice(0, 8) };
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
      await onlineQuick(app, client, status, isHost, mySlot);
    } else {
      await onlineTournament(app, client, cfg!, status, isHost, mySlot);
    }
  } catch (err) {
    status.set(String(err instanceof Error ? err.message : err));
    client.close();
  }
}

/** Quick match: everyone in the room plays. 2 phones = 1v1 rules flow;
 * 3+ phones = free-for-all rounds. */
async function onlineQuick(
  app: GameApp,
  client: RelayClient,
  status: { set: (t: string) => void; close: () => void },
  isHost: boolean,
  mySlot: SlotConfig | null,
): Promise<void> {
  const watch = new QbeginWatch(client);
  const exchange = new FfaExchange(client); // idle until beginRound
  status.close();
  const res = await lobbyScreen(app, client, ZH.menu.quick, {
    isHost,
    canStart: (players) => players.filter(Boolean).length >= 2,
    hint: ZH.mode.countHint,
    guestWait: isHost ? null : watch.wait(-1),
  });
  if (res === "back") return;
  let first: QuickBegin;
  if (isHost) {
    first = { slots: connectedSlots(client), round: 0 };
    client.send({ t: "qbegin", slots: first.slots, round: first.round } as GameMsg);
  } else {
    first = watch.latest!;
    if (!first.slots.includes(client.slot)) {
      // the match started before this phone joined — no mid-match entry
      client.close();
      statusScreen(app, ZH.mode.spectating);
      return;
    }
  }
  // 1v1 only ever begins at round 0 with exactly two phones; any later
  // qbegin (a reused seat joining an in-progress session) is FFA.
  if (first.slots.length === 2 && first.round === 0) {
    await quick1v1(app, client, first.slots as [number, number], mySlot);
  } else {
    await ffaSession(app, client, exchange, watch, first, isHost, mySlot);
  }
}

/** Standard online 1v1 between the two relay slots in `pair`. */
async function quick1v1(
  app: GameApp,
  client: RelayClient,
  pair: [number, number],
  mySlot: SlotConfig | null,
): Promise<void> {
  const myIdx = pair.indexOf(client.slot) as 0 | 1;
  const oppSlot = pair[(1 - myIdx) as 0 | 1]!;
  const exchange = new LockstepExchange(client, oppSlot);
  const rematch = new RematchWatch(client, oppSlot);
  const prefs = getPrefs();
  // the bey this player actually configured for the room
  const myDeck = myOnlineDeck(app, mySlot);
  const myCombo: ComboSelection = myDeck[0]!;
  const remoteDeck = await exchange.exchangeDeck(myDeck);
  const names: [string, string] = [
    client.players[pair[0]!] || fmt(ZH.playerN, { n: 1 }),
    client.players[pair[1]!] || fmt(ZH.playerN, { n: 2 }),
  ];
  const decks = myIdx === 0 ? [myDeck, remoteDeck] : [remoteDeck, myDeck];
  const myLauncher = mySlot?.launcher ?? prefs.launcher;
  const slots: [SlotConfig, SlotConfig] = [
    { kind: myIdx === 0 ? "human" : "bot", name: names[0], bot: BOT_ROSTER[0]!, deckRefs: [], launcher: myLauncher },
    { kind: myIdx === 1 ? "human" : "bot", name: names[1], bot: BOT_ROSTER[0]!, deckRefs: [], launcher: myLauncher },
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
        const mine = await collectLocalLaunch(app, engine, myIdx, names[myIdx], getPrefs().launcher);
        if (mine === "matchOver") return "matchOver";
        const theirs = await exchange.exchangeLaunch(mine);
        return (myIdx === 0 ? [mine, theirs] : [theirs, mine]) as [LaunchParams, LaunchParams];
      },
      onAbort: () => {
        // giving up online forfeits: leave the room entirely
        client.send({ t: "leave" });
        client.close();
        app.showModeSelect();
      },
      // both phones must agree before the room replays
      onRematch: () => rematch.request(),
    },
    "線上對戰",
  );
}

/** Free-for-all rounds: N phones broadcast inputs, everyone simulates the
 * same N-bey battle; survivor takes the round, first to FFA_TARGET wins. */
async function ffaSession(
  app: GameApp,
  client: RelayClient,
  exchange: FfaExchange,
  watch: QbeginWatch,
  first: QuickBegin,
  isHost: boolean,
  mySlot: SlotConfig | null,
): Promise<void> {
  const prefs = getPrefs();
  // the bey this player configured before entering the room
  const myCombo: ComboSelection = myOnlineDeck(app, mySlot)[0]!;
  const wins = new Map<number, number>();
  let cur = first;
  let aborted = false;
  // resolves the moment 放棄 is confirmed, so an in-flight launch gesture
  // unwinds instead of leaving the session running behind the menu
  let fireAbort: () => void = () => {};
  const abortSignal = new Promise<void>((res) => {
    fireAbort = () => res();
  });
  let bar: HTMLElement | null = null;
  let waitOverlay: HTMLElement | null = null; // whichever wait UI is up right now

  const nameOf = (s: number): string => client.players[s] || fmt(ZH.playerN, { n: s + 1 });

  const cleanup = (): void => {
    bar?.remove();
    bar = null;
    waitOverlay?.remove();
    waitOverlay = null;
    app.frameHook = null;
    app.view.clearBeys();
    app.startMenuCinema();
    client.close();
    app.showModeSelect();
  };
  const giveUp = (): void => {
    void confirmModal(ZH.confirmGiveUp).then((yes) => {
      if (!yes) return;
      aborted = true;
      fireAbort();
      teardownActiveLaunch();
      client.send({ t: "leave" });
      cleanup();
    });
  };
  const showBar = (order: number[]): void => {
    bar?.remove();
    bar = el("div", { class: "topbar" });
    const line = order.map((s) => `${nameOf(s)} ${wins.get(s) ?? 0}`).join("｜");
    bar.append(
      el("div", { class: "scoreboard", style: "font-size:15px" }, `${ZH.mode.ffa}｜${line}`),
      el("div", { class: "spacer" }),
      app.viewControls(),
      button(ZH.giveUp, giveUp, "btn small fixed"),
    );
    document.body.append(bar);
  };
  /** guests adopt the host's authoritative standings from each qbegin */
  const applyWins = (list?: [number, number][]): void => {
    if (!list) return;
    wins.clear();
    for (const [s, n] of list) wins.set(s, n);
  };
  applyWins(first.wins);

  /** next round / round restart: host recomputes + broadcasts, guests resync */
  const reformed = async (): Promise<boolean> => {
    if (isHost) {
      const remaining = cur.slots.filter((s) => s === client.slot || !!client.players[s]);
      cur = { slots: remaining, round: cur.round + 1 };
      if (remaining.length >= 2) {
        client.send({
          t: "qbegin",
          slots: cur.slots,
          round: cur.round,
          wins: [...wins.entries()],
        } as GameMsg);
      }
      return true;
    }
    try {
      cur = await watch.wait(cur.round);
      applyWins(cur.wins);
      return true;
    } catch {
      return false; // host left → session over
    }
  };

  sfx.setScore("battleBalance");
  await flashBanner(`${ZH.mode.ffa}｜${fmt(ZH.mode.ffaTarget, { n: FFA_TARGET })}`, 1500);
  for (;;) {
    if (aborted) return;
    if (cur.slots.length < 2 || !cur.slots.includes(client.slot)) break;
    exchange.beginRound(cur.round, cur.slots);
    const order = [...cur.slots].sort((a, b) => a - b);
    try {
      app.stopMenuCinema();
      app.setScreen(null);
      app.view.setStadium(app.stadium());
      app.view.clearBeys(); // beys live in the launchers until GO SHOOT
      showBar(order);

      const decks = await exchange.exchangeDecks(myCombo);
      const seed = await exchange.exchangeSeed();
      if (aborted) return;
      const rcs = order.map((s) => resolveCombo(app.index, decks.get(s)!));
      const params = rcs.map((rc, i) => deriveBeyParams(rc, { label: nameOf(order[i]!) }));
      const myIdx = order.indexOf(client.slot);
      const rot =
        rcs[myIdx]!.parts.blade?.rotation ?? rcs[myIdx]!.parts.lockChip?.rotation ?? "right";

      // my launch — a mislaunch simply retries (non-standard mode, no penalty)
      let mine: LaunchParams | null = null;
      while (!mine) {
        if (aborted) return;
        const r = await humanLaunch(
          app,
          nameOf(client.slot),
          (myIdx % 2) as 0 | 1,
          prefs.launcher,
          rcs[myIdx]!,
          params[myIdx]!,
          null,
          abortSignal,
        );
        if (r.aborted || aborted) return;
        if (r.launch) {
          recordLaunch(r.launch.sp, r.launch.aimDeg);
          const spinDir = rot === "left" || rot === "both-left-origin" ? -1 : 1;
          mine = { ...r.launch, spinDir };
        } else {
          await flashBanner(ZH.mislaunch[r.mislaunch!], 900);
        }
      }
      // others may still be pulling — keep the room informed while we wait
      const wo = overlay("transparent");
      wo.append(el("div", { class: "banner-big", style: "font-size:20px" }, ZH.waitingOpponent));
      document.body.append(wo);
      waitOverlay = wo;
      let launches: Map<number, LaunchParams>;
      try {
        launches = await exchange.exchangeLaunches(mine);
      } finally {
        wo.remove();
        if (waitOverlay === wo) waitOverlay = null;
      }
      if (aborted) return;

      app.view.setBeysList(order.map((_, i) => ({ rc: rcs[i]!, params: params[i]! })));
      app.view.beginCameraEase(0.9);
      app.view.mode = app.view.mode === "gyro" ? "gyro" : "orbit";
      const wcfg: WorldConfig = {
        seed,
        beys: params,
        launches: order.map((s) => launches.get(s)!),
        xtremeDashEnabled: app.rules.xtremeDashEnabled,
        clicksMax: 4,
        maxTicks: 240 * 180,
      };
      const world = await playBattle(app, wcfg, { abort: () => aborted });
      if (aborted) return;

      // action keeps running under the banners (afterglow)
      let acc = 0;
      app.frameHook = (dt) => {
        acc += dt;
        let steps = 0;
        while (acc > DT && steps < 1200) {
          step(world, wcfg, app.stadium(), true);
          acc -= DT;
          steps++;
        }
        app.view.consumeEvents(world);
        app.view.update(world, dt);
      };

      const winSlot =
        world.ffaWinner !== null && world.ffaWinner >= 0 ? order[world.ffaWinner]! : null;
      if (winSlot !== null) wins.set(winSlot, (wins.get(winSlot) ?? 0) + 1);
      showBar(order);
      await flashBanner(
        winSlot !== null ? fmt(ZH.winner, { name: nameOf(winSlot) }) : ZH.draw,
        1700,
      );
      if (aborted) return;
      if (winSlot !== null && (wins.get(winSlot) ?? 0) >= FFA_TARGET) {
        await flashBanner(fmt(ZH.champion, { name: nameOf(winSlot) }), 2400);
        break;
      }

      // between rounds: the host advances everyone (stadium stays live).
      // If 放棄 fires during these waits, cleanup() already ran and the
      // pending promise is simply abandoned — nothing after it executes.
      if (isHost) {
        await new Promise<void>((resolve) => {
          const o = overlay("transparent");
          waitOverlay = o;
          const panel = el("div", { class: "panel" });
          panel.append(
            button(ZH.next, () => {
              o.remove();
              waitOverlay = null;
              resolve();
            }, "btn primary"),
          );
          o.append(panel);
          document.body.append(o);
        });
        const ok = await reformed();
        if (!ok) break;
        if (cur.slots.length < 2) break;
      } else {
        const o = overlay("transparent");
        waitOverlay = o;
        o.append(el("div", { class: "panel" }, el("div", { class: "subtitle" }, ZH.mode.waitingHost)));
        document.body.append(o);
        try {
          cur = await watch.wait(cur.round);
          applyWins(cur.wins);
        } catch {
          break; // host left
        } finally {
          o.remove();
          if (waitOverlay === o) waitOverlay = null;
        }
      }
    } catch (err) {
      if (aborted) return;
      teardownActiveLaunch();
      app.frameHook = null;
      if (err instanceof Error && err.message === "player-left") {
        await flashBanner(ZH.mode.playerLeftRestart, 1100);
        if (aborted) return;
        const ok = await reformed();
        if (ok && cur.slots.length >= 2) continue;
        break;
      }
      break; // lockstep timeout / unexpected → leave the session
    }
  }
  if (!aborted) cleanup();
}

function safeResolve(app: GameApp, ref: string): ComboSelection | null {
  try {
    return app.resolveComboRef(ref);
  } catch {
    return null;
  }
}

/** Host-orchestrated online tournament: every joined phone plays, plus the
 * host-chosen number of bots. */
async function onlineTournament(
  app: GameApp,
  client: RelayClient,
  cfg: RoomCfg,
  status: { set: (t: string) => void; close: () => void },
  isHost: boolean,
  mySlot: SlotConfig | null = null,
): Promise<void> {
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
  // Every human announces the bey they built; the host seeds the bracket
  // with those instead of handing out arbitrary official presets.
  const brought = new Map<number, ComboSelection[]>();
  brought.set(client.slot, myOnlineDeck(app, mySlot));
  {
    const prev = client.onMsg;
    client.onMsg = (from, msg) => {
      prev?.(from, msg);
      if (msg.t === "deck" && msg.r === undefined) brought.set(from, msg.combos);
    };
  }
  client.send({ t: "deck", combos: myOnlineDeck(app, mySlot) } as GameMsg);

  status.close();
  const res = await lobbyScreen(app, client, ZH.menu.tournament, {
    isHost,
    canStart: (players) => players.filter(Boolean).length + cfg.botCount >= 2,
    hint: `${ZH.mode.countHint}｜${ZH.mode.botCount}：＋${cfg.botCount}`,
    guestWait: isHost ? null : begun,
  });
  if (res === "back") return;
  if (isHost) {
    // participants = every phone in the room right now + the bot padding
    const humans = client.players.map((n, i) => ({ n, i })).filter((x) => x.n);
    const total = humans.length + cfg.botCount;
    tSlots = [];
    for (const h of humans) {
      tSlots.push({
        name: h.n,
        kind: "human",
        bot: BOT_ROSTER[0]!,
        // the deck that phone announced; the preset is only a fallback for
        // a client that somehow never sent one
        deck: brought.get(h.i) ?? [app.db.combos[h.i % app.db.combos.length]!.parts],
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
  if (tSlots.length === 0) return;

  const tour = new Tournament(tSlots, "singleElim");
  const myRelay = client.slot;
  // must exist BEFORE the bracket loop: results broadcast while this phone
  // is mid-battle have to be latched, not missed
  const tres = new TresWatch(client);

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
      if (winner === "aborted") return; // gave up → forfeited the tournament
      const winSlot =
        (iAmA && winner === 0) || (iAmB && winner === 1)
          ? match.a!
          : iAmA
            ? match.b!
            : match.a!;
      client.send({ t: "tres", matchId: match.id, winner: winSlot } as GameMsg);
      tres.note(match.id, winSlot);
      tour.report(match.id, winSlot);
      continue;
    } else if (isHost && a.relaySlot === null && b.relaySlot === null) {
      // bot vs bot: host simulates headless and broadcasts the result
      const winner = simulateBotMatch(app, index, cfg.rules, a, b, 9000 + match.id * 17);
      const winSlot = winner === 0 ? match.a! : match.b!;
      client.send({ t: "tres", matchId: match.id, winner: winSlot } as GameMsg);
      tres.note(match.id, winSlot);
      tour.report(match.id, winSlot);
      continue;
    } else {
      // someone else's battle: wait for its result (latched, so one that
      // already arrived resolves at once instead of hanging this phone)
      tour.report(match.id, await tres.wait(match.id));
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
): Promise<0 | 1 | "aborted"> {
  void index;
  const prefs = getPrefs();
  let aborted = false;
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
      onAbort: () => {
        aborted = true; // forfeits the whole online tournament
        client.send({ t: "leave" });
        client.close();
        app.showModeSelect();
      },
    },
    "線上對戰",
  );
  return aborted ? "aborted" : winner;
}
