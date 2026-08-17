import { describe, expect, it } from "vitest";

import { PHYSICS_VERSION } from "../src/core/sim";
import type { ComboSelection, LaunchParams } from "../src/core/types";
import { replayPhysicsCompatible, type ReplayData } from "../src/game/persist";
import { FfaExchange, LockstepExchange, RelayClient, type GameMsg } from "../src/net/client";

const COMBO: ComboSelection = {
  blade: null,
  ratchet: null,
  bit: null,
  lockChip: null,
  mainBlade: null,
  assistBlade: null,
  metalBlade: null,
  overBlade: null,
};

const LAUNCH: LaunchParams = {
  sp: 9000,
  aimDeg: 0,
  tiltDeg: 0,
  launcher: "string",
  spinDir: 1,
};

function fakeClient(slot = 0): { client: RelayClient; sent: GameMsg[] } {
  const client = new RelayClient();
  const sent: GameMsg[] = [];
  client.slot = slot;
  client.send = (message) => sent.push(message);
  return { client, sent };
}

describe("deterministic physics version boundaries", () => {
  it("stamps every two-player lockstep input and rejects missing/old versions", async () => {
    const { client, sent } = fakeClient();
    const exchange = new LockstepExchange(client, 1);
    const pending = exchange.exchangeDeck([COMBO]);

    expect(sent[0]).toMatchObject({ t: "deck", pv: PHYSICS_VERSION });
    client.onMsg?.(1, { t: "deck", combos: [COMBO] });
    await expect(pending).rejects.toThrow("physics-version-mismatch");
  });

  it("accepts matching lockstep inputs", async () => {
    const { client, sent } = fakeClient();
    const exchange = new LockstepExchange(client, 1);
    const pending = exchange.exchangeLaunch(LAUNCH);

    expect(sent[0]).toMatchObject({ t: "launch", pv: PHYSICS_VERSION });
    client.onMsg?.(1, { t: "launch", launch: LAUNCH, pv: PHYSICS_VERSION });
    await expect(pending).resolves.toEqual(LAUNCH);
  });

  it("stamps FFA input and aborts collection on a mixed physics revision", async () => {
    const { client, sent } = fakeClient();
    const exchange = new FfaExchange(client);
    exchange.beginRound(4, [0, 1]);
    const pending = exchange.exchangeDecks(COMBO);

    expect(sent[0]).toMatchObject({ t: "deck", r: 4, pv: PHYSICS_VERSION });
    client.onMsg?.(1, { t: "deck", combos: [COMBO], r: 4, pv: PHYSICS_VERSION - 1 });
    await expect(pending).rejects.toThrow("physics-version-mismatch");
  });

  it("never silently re-simulates a legacy replay", () => {
    const base = { rules: {}, stadiumKey: "bx10", battles: [] };
    expect(replayPhysicsCompatible(base as ReplayData)).toBe(false);
    expect(replayPhysicsCompatible({ ...base, physicsVersion: PHYSICS_VERSION })).toBe(true);
    expect(replayPhysicsCompatible({ ...base, physicsVersion: PHYSICS_VERSION - 1 })).toBe(false);
  });
});
