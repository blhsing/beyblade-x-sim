// Relay client + online lockstep session (docs/PROTOCOL.md).
// The relay wraps client payloads as {type:"msg", from, data}; membership
// arrives as {type:"room"|"welcome"|"error"}. Battle inputs are exchanged,
// then both devices run the identical deterministic sim.

import type { ComboSelection, LaunchParams } from "../core/types";
import { PHYSICS_VERSION } from "../core/sim";
import type { RuleSet } from "../game/rules";

export interface RelayEnvelope {
  type: "welcome" | "room" | "error" | "msg";
  slot: number;
  from?: number;
  name?: string;
  players?: string[];
  reason?: string;
  data?: GameMsg;
}

export type GameMsg =
  | { t: "hello"; name: string; ver: string }
  | { t: "rules"; rules: RuleSet }
  | { t: "deck"; combos: ComboSelection[]; r?: number; pv?: number }
  | { t: "seedq"; q: number; r?: number; pv?: number }
  | { t: "launch"; launch: LaunchParams; r?: number; pv?: number }
  | { t: "hash"; tick: number; h: string }
  | { t: "result"; winner: number | null; draw: boolean; tick: number }
  | { t: "score"; scores: [number, number]; battleIndex: number }
  | { t: "rematch" }
  | { t: "leave" }
  // rooms v2: password knock + host-config + online tournament coordination
  | { t: "knock"; pass: string }
  | { t: "accept"; to?: number; cfg: unknown }
  | { t: "reject"; to?: number }
  | { t: "tbegin"; slots: unknown[] }
  | { t: "tres"; matchId: number; winner: number }
  // quick match v3: host starts when everyone has joined; 3+ phones = FFA.
  // `slots` are the participating relay slots; `round` tags every battle's
  // inputs so a restarted round (after a mid-collection leave) can't mix
  // stale messages into the new collection. `wins` carries the host's
  // authoritative standings so late/rejoined clients stay in sync.
  | { t: "qbegin"; slots: number[]; round: number; wins?: [number, number][] };

/** Base URL of the game websocket for the current page origin/path. */
export function defaultRelayWsBase(): string {
  const loc = window.location;
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  // keep the path base (e.g. /beyblade/ on the Azure tier vapp)
  let base = loc.pathname;
  if (!base.endsWith("/")) base = base.slice(0, base.lastIndexOf("/") + 1);
  if (loc.port === "5173") return `ws://${loc.host}/game`; // vite proxies to the local relay
  return `${proto}//${loc.host}${base}game`.replace(/\/game$/, "/game");
}

export class RelayClient {
  ws: WebSocket | null = null;
  slot = -1;
  players: string[] = [];
  onRoom: ((players: string[]) => void) | null = null;
  onMsg: ((from: number, msg: GameMsg) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;

  connect(wsBase: string, room: string, name: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const url = `${wsBase}/${encodeURIComponent(room)}/ws?role=player&name=${encodeURIComponent(name)}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      const fail = (why: string): void => {
        reject(new Error(why));
        this.onClose?.(why);
      };
      ws.onerror = () => fail("connect-error");
      ws.onclose = (e) => fail(e.reason || "closed");
      ws.onmessage = (ev) => {
        let env: RelayEnvelope;
        try {
          env = JSON.parse(String(ev.data)) as RelayEnvelope;
        } catch {
          return;
        }
        if (env.type === "welcome") {
          this.slot = env.slot;
          ws.onclose = (e) => this.onClose?.(e.reason || "closed");
          ws.onerror = () => this.onClose?.("error");
          resolve(env.slot);
        } else if (env.type === "room") {
          this.players = env.players ?? [];
          this.onRoom?.(this.players);
        } else if (env.type === "error") {
          fail(env.reason ?? "error");
        } else if (env.type === "msg" && env.data) {
          this.onMsg?.(env.from ?? -1, env.data);
        }
      };
    });
  }

  send(msg: GameMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws?.close(1000, "bye");
    this.ws = null;
  }
}

/**
 * One online battle's input exchange. Both sides call with their local input
 * providers; resolves with everything needed for the deterministic sim.
 */
export class LockstepExchange {
  private seedqLocal = (Math.random() * 0xffffffff) >>> 0;
  private seedqRemote: number | null = null;
  private remoteDeck: ComboSelection[] | null = null;
  private remoteLaunch: LaunchParams | null = null;
  private physicsVersionMismatch = false;
  private resolvers: (() => void)[] = [];

  /** expectedFrom: relay slot whose messages this exchange listens to
   * (rooms can hold many players — tournaments filter per opponent). */
  constructor(
    private client: RelayClient,
    private expectedFrom: number,
  ) {
    const prev = client.onMsg;
    client.onMsg = (from, msg) => {
      prev?.(from, msg);
      if (from !== this.expectedFrom) return;
      if (msg.t === "seedq" || msg.t === "deck" || msg.t === "launch") {
        // Missing is also incompatible: older clients must never silently
        // lockstep against a different deterministic physics revision.
        if (msg.pv !== PHYSICS_VERSION) {
          this.physicsVersionMismatch = true;
          this.poke();
          return;
        }
      }
      if (msg.t === "seedq") this.seedqRemote = msg.q;
      else if (msg.t === "deck") this.remoteDeck = msg.combos;
      else if (msg.t === "launch") this.remoteLaunch = msg.launch;
      this.poke();
    };
  }

  private poke(): void {
    const rs = this.resolvers;
    this.resolvers = [];
    for (const r of rs) r();
  }

  private waitFor(pred: () => boolean, timeoutMs = 120000): Promise<void> {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const check = (): void => {
        if (this.physicsVersionMismatch) reject(new Error("physics-version-mismatch"));
        else if (pred()) resolve();
        else if (Date.now() - t0 > timeoutMs) reject(new Error("lockstep-timeout"));
        else this.resolvers.push(check);
      };
      check();
    });
  }

  async exchangeDeck(local: ComboSelection[]): Promise<ComboSelection[]> {
    this.client.send({ t: "deck", combos: local, pv: PHYSICS_VERSION });
    await this.waitFor(() => this.remoteDeck !== null);
    return this.remoteDeck!;
  }

  async exchangeSeed(): Promise<number> {
    this.client.send({ t: "seedq", q: this.seedqLocal, pv: PHYSICS_VERSION });
    await this.waitFor(() => this.seedqRemote !== null);
    const seed = (this.seedqLocal ^ this.seedqRemote!) >>> 0;
    this.seedqLocal = (Math.random() * 0xffffffff) >>> 0; // fresh for next battle
    this.seedqRemote = null;
    return seed;
  }

  async exchangeLaunch(local: LaunchParams): Promise<LaunchParams> {
    this.client.send({ t: "launch", launch: local, pv: PHYSICS_VERSION });
    await this.waitFor(() => this.remoteLaunch !== null);
    const remote = this.remoteLaunch!;
    this.remoteLaunch = null;
    return remote;
  }
}

/**
 * N-player input exchange for free-for-all quick matches: every participant
 * broadcasts its deck/seed/launch and collects everyone else's, keyed by
 * relay slot. Waits abort with "player-left" if a participant disconnects
 * mid-collection (the host then restarts the round with the remaining slots).
 */
export class FfaExchange {
  private decks = new Map<number, ComboSelection>();
  private seeds = new Map<number, number>();
  private launches = new Map<number, LaunchParams>();
  private resolvers: (() => void)[] = [];
  private slots: number[] = [];
  private round = -1;
  private left = false;
  private physicsVersionMismatch = false;

  constructor(private client: RelayClient) {
    const prev = client.onMsg;
    client.onMsg = (from, msg) => {
      prev?.(from, msg);
      if (!this.slots.includes(from)) return;
      if ((msg.t === "deck" || msg.t === "seedq" || msg.t === "launch") && msg.r !== this.round) return;
      if ((msg.t === "deck" || msg.t === "seedq" || msg.t === "launch") && msg.pv !== PHYSICS_VERSION) {
        this.physicsVersionMismatch = true;
        this.poke();
        return;
      }
      if (msg.t === "deck") this.decks.set(from, msg.combos[0]!);
      else if (msg.t === "seedq") this.seeds.set(from, msg.q);
      else if (msg.t === "launch") this.launches.set(from, msg.launch);
      this.poke();
    };
    const prevRoom = client.onRoom;
    client.onRoom = (players) => {
      prevRoom?.(players);
      if (this.slots.some((s) => s !== client.slot && !players[s])) {
        this.left = true;
        this.poke();
      }
    };
  }

  /** Reset collection for a battle round (fresh slot list, fresh maps). */
  beginRound(round: number, slots: number[]): void {
    this.round = round;
    this.slots = [...slots];
    this.decks.clear();
    this.seeds.clear();
    this.launches.clear();
    this.left = false;
    this.physicsVersionMismatch = false;
  }

  private poke(): void {
    const rs = this.resolvers;
    this.resolvers = [];
    for (const r of rs) r();
  }

  private waitAll(size: () => number, timeoutMs = 180000): Promise<void> {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const check = (): void => {
        if (this.physicsVersionMismatch) reject(new Error("physics-version-mismatch"));
        else if (this.left) reject(new Error("player-left"));
        else if (size() >= this.slots.length) resolve();
        else if (Date.now() - t0 > timeoutMs) reject(new Error("lockstep-timeout"));
        else this.resolvers.push(check);
      };
      check();
    });
  }

  async exchangeDecks(local: ComboSelection): Promise<Map<number, ComboSelection>> {
    this.decks.set(this.client.slot, local);
    this.client.send({ t: "deck", combos: [local], r: this.round, pv: PHYSICS_VERSION });
    await this.waitAll(() => this.decks.size);
    return this.decks;
  }

  /** XOR of everyone's random word — order-independent, nobody controls it. */
  async exchangeSeed(): Promise<number> {
    const q = (Math.random() * 0xffffffff) >>> 0;
    this.seeds.set(this.client.slot, q);
    this.client.send({ t: "seedq", q, r: this.round, pv: PHYSICS_VERSION });
    await this.waitAll(() => this.seeds.size);
    let seed = 0;
    for (const v of this.seeds.values()) seed = (seed ^ v) >>> 0;
    return seed;
  }

  async exchangeLaunches(local: LaunchParams): Promise<Map<number, LaunchParams>> {
    this.launches.set(this.client.slot, local);
    this.client.send({ t: "launch", launch: local, r: this.round, pv: PHYSICS_VERSION });
    await this.waitAll(() => this.launches.size);
    return this.launches;
  }
}
