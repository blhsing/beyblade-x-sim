// Relay client + online lockstep session (docs/PROTOCOL.md).
// The relay wraps client payloads as {type:"msg", from, data}; membership
// arrives as {type:"room"|"welcome"|"error"}. Battle inputs are exchanged,
// then both devices run the identical deterministic sim.

import type { ComboSelection, LaunchParams } from "../core/types";
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
  | { t: "deck"; combos: ComboSelection[] }
  | { t: "seedq"; q: number }
  | { t: "launch"; launch: LaunchParams }
  | { t: "hash"; tick: number; h: string }
  | { t: "result"; winner: number | null; draw: boolean; tick: number }
  | { t: "score"; scores: [number, number]; battleIndex: number }
  | { t: "rematch" }
  | { t: "leave" };

/** Base URL of the game websocket for the current page origin/path. */
export function defaultRelayWsBase(): string {
  const loc = window.location;
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  // keep the path base (e.g. /beyblade/ on the Azure tier vapp)
  let base = loc.pathname;
  if (!base.endsWith("/")) base = base.slice(0, base.lastIndexOf("/") + 1);
  if (loc.port === "5173") return `ws://${loc.hostname}:8080/game`; // vite dev → local relay
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
  private resolvers: (() => void)[] = [];

  constructor(private client: RelayClient) {
    const prev = client.onMsg;
    client.onMsg = (from, msg) => {
      prev?.(from, msg);
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
        if (pred()) resolve();
        else if (Date.now() - t0 > timeoutMs) reject(new Error("lockstep-timeout"));
        else this.resolvers.push(check);
      };
      check();
    });
  }

  async exchangeDeck(local: ComboSelection[]): Promise<ComboSelection[]> {
    this.client.send({ t: "deck", combos: local });
    await this.waitFor(() => this.remoteDeck !== null);
    return this.remoteDeck!;
  }

  async exchangeSeed(): Promise<number> {
    this.client.send({ t: "seedq", q: this.seedqLocal });
    await this.waitFor(() => this.seedqRemote !== null);
    const seed = (this.seedqLocal ^ this.seedqRemote!) >>> 0;
    this.seedqLocal = (Math.random() * 0xffffffff) >>> 0; // fresh for next battle
    this.seedqRemote = null;
    return seed;
  }

  async exchangeLaunch(local: LaunchParams): Promise<LaunchParams> {
    this.client.send({ t: "launch", launch: local });
    await this.waitFor(() => this.remoteLaunch !== null);
    const remote = this.remoteLaunch!;
    this.remoteLaunch = null;
    return remote;
  }
}
