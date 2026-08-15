// Online quick match over the room relay: join by code, exchange decks,
// then per battle exchange seed + launch params and run the identical
// deterministic sim on both devices (docs/PROTOCOL.md).

import type { LaunchParams } from "../core/types";
import type { MatchEngine } from "../game/rules";
import { getPrefs, savePrefs } from "../game/persist";
import { ZH, fmt } from "../i18n/zh";
import { LockstepExchange, RelayClient, defaultRelayWsBase } from "../net/client";
import { button, el, overlay, row, select } from "./dom";
import type { GameApp } from "./app";
import { collectLocalLaunch, runMatch } from "./match";
import type { SlotConfig } from "./setup";

export function showOnline(app: GameApp): void {
  const o = overlay();
  const panel = el("div", { class: "panel" });
  const nameInput = el("input", { type: "text", value: getPrefs().name });
  const roomInput = el("input", { type: "text", placeholder: ZH.roomCode, value: "" });
  const urlInput = el("input", { type: "text", value: defaultRelayWsBase() });
  const status = el("div", { class: "subtitle" }, "");
  const deckSel = select(app.comboOptions());

  const join = async (): Promise<void> => {
    savePrefs({ name: nameInput.value.trim() || "玩家" });
    const room = roomInput.value.trim() || Math.random().toString(36).slice(2, 7);
    roomInput.value = room;
    status.textContent = `${ZH.roomCode}: ${room} — 連線中…`;
    const client = new RelayClient();
    try {
      const slot = await client.connect(urlInput.value.trim(), room, nameInput.value.trim() || "玩家");
      status.textContent = `${ZH.connected}（${ZH.roomCode}: ${room}）｜${ZH.waitingOpponent}`;
      client.onClose = (why) => {
        status.textContent = `${ZH.disconnected}: ${why}`;
      };
      client.onRoom = (players) => {
        if (players.filter(Boolean).length >= 2) {
          void startOnlineMatch(app, client, slot as 0 | 1, deckSel.value, players);
        }
      };
      // maybe both already here
      if (client.players.filter(Boolean).length >= 2) {
        void startOnlineMatch(app, client, slot as 0 | 1, deckSel.value, client.players);
      }
    } catch (err) {
      status.textContent = `${ZH.disconnected}: ${err}`;
    }
  };

  panel.append(
    el("div", { class: "title", style: "font-size:22px" }, ZH.menu.online),
    row(el("span", { class: "label fixed" }, "暱稱"), nameInput),
    row(el("span", { class: "label fixed" }, ZH.roomCode), roomInput),
    row(el("span", { class: "label fixed" }, ZH.deck), deckSel),
    el("div", { class: "label" }, ZH.relayUrl),
    urlInput,
    status,
    button(ZH.joinRoom, () => {
      app.enableGyroByDefault();
      void join();
    }, "btn primary"),
    button(ZH.back, () => app.showMenu()),
  );
  o.append(panel);
  app.setScreen(o);
}

async function startOnlineMatch(
  app: GameApp,
  client: RelayClient,
  mySlot: 0 | 1,
  myDeckRef: string,
  players: string[],
): Promise<void> {
  const exchange = new LockstepExchange(client);
  const myDeck = [app.resolveComboRef(myDeckRef)];
  const remoteDeck = await exchange.exchangeDeck(myDeck);

  const mySlotCfg: SlotConfig = {
    kind: "human",
    name: players[mySlot] || fmt(ZH.playerN, { n: mySlot + 1 }),
    bot: { name: "", skill: "skilled", character: "balanced" },
    deckRefs: [],
    launcher: getPrefs().launcher,
  };
  const remoteSlotCfg: SlotConfig = {
    kind: "bot", // opponent's input arrives over the wire; no local gestures
    name: players[1 - mySlot] || fmt(ZH.playerN, { n: 2 - mySlot }),
    bot: { name: players[1 - mySlot] || "對手", skill: "skilled", character: "balanced" },
    deckRefs: [],
    launcher: "string",
  };
  const slots: [SlotConfig, SlotConfig] =
    mySlot === 0 ? [mySlotCfg, remoteSlotCfg] : [remoteSlotCfg, mySlotCfg];

  // decks by relay slot order (slot0 = beys[0]) on BOTH devices
  const decks = mySlot === 0 ? [myDeck, remoteDeck] : [remoteDeck, myDeck];

  await runMatch(
    app,
    slots,
    () => {
      client.close();
      app.showMenu();
    },
    {
      setup: (engine: MatchEngine) => {
        engine.players[0].deck = decks[0]!;
        engine.players[1].deck = decks[1]!;
      },
      seed: () => exchange.exchangeSeed(),
      launches: async (engine: MatchEngine) => {
        // local human drags; remote side arrives via exchange
        const mine = await collectLocalLaunch(app, engine, mySlot, mySlotCfg.name, getPrefs().launcher);
        if (mine === "matchOver") return "matchOver";
        const theirs = await exchange.exchangeLaunch(mine);
        const pair: [LaunchParams, LaunchParams] =
          mySlot === 0 ? [mine, theirs] : [theirs, mine];
        return pair;
      },
    },
    "線上對戰",
  );
}
