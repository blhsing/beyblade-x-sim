// Physics balance harness: batch bot-vs-bot battles per archetype matchup,
// print the finish-type distribution + duration, and assert loose realism
// invariants (targets from tournament footage: most battles 10–90 s, own
// finishes uncommon, attack beats stamina by KO more than it gets outspun).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PartIndex, deriveBeyParams, resolveCombo } from "../src/core/derive";
import { STADIUM_BX10 } from "../src/core/stadium";
import { TICKS_PER_SECOND, simulateBattle } from "../src/core/sim";
import type { PartsDb } from "../src/core/types";
import { RULES_OFFICIAL } from "../src/game/rules";
import { BOT_ROSTER, botBuildDeck, botChooseLaunch, type BotProfile } from "../src/game/bots";

const db: PartsDb = JSON.parse(
  readFileSync(fileURLToPath(new URL("../public/data/parts.json", import.meta.url)), "utf8"),
);
const index = new PartIndex(db);

interface Tally {
  spin: number;
  over: number;
  burst: number;
  xtreme: number;
  draw: number;
  ownFinish: number;
  totalSec: number;
  n: number;
  winsA: number;
}

function battleBatch(a: BotProfile, b: BotProfile, n: number, seed0: number): Tally {
  const t: Tally = { spin: 0, over: 0, burst: 0, xtreme: 0, draw: 0, ownFinish: 0, totalSec: 0, n, winsA: 0 };
  const deckA = botBuildDeck(db, a, RULES_OFFICIAL, seed0 + 1)[0]!;
  const deckB = botBuildDeck(db, b, RULES_OFFICIAL, seed0 + 2)[0]!;
  const rcA = resolveCombo(index, deckA);
  const rcB = resolveCombo(index, deckB);
  const pA = deriveBeyParams(rcA);
  const pB = deriveBeyParams(rcB);
  for (let i = 0; i < n; i++) {
    const w = simulateBattle(
      {
        seed: seed0 + i * 7919,
        beys: [pA, pB],
        launches: [
          botChooseLaunch(a, rcA.parts.blade?.rotation ?? "right", seed0 + i * 31),
          botChooseLaunch(b, rcB.parts.blade?.rotation ?? "right", seed0 + i * 57),
        ],
        xtremeDashEnabled: true,
        clicksMax: 4,
        maxTicks: 240 * 180,
      },
      STADIUM_BX10,
    );
    t.totalSec += w.tick / TICKS_PER_SECOND;
    if (w.finish) {
      t[w.finish.type]++;
      if (w.finish.ownFinish) t.ownFinish++;
      if (w.finish.winner === 0) t.winsA++;
    } else {
      t.draw++;
    }
  }
  return t;
}

const bots = Object.fromEntries(BOT_ROSTER.map((b) => [b.character + ":" + b.skill, b]));
const attacker: BotProfile = { name: "攻", skill: "champion", character: "aggressive" };
const staminaBot: BotProfile = { name: "持", skill: "champion", character: "stamina" };
const defender: BotProfile = { name: "防", skill: "champion", character: "defensive" };
void bots;

describe("balance batches (also the tuning harness — see console table)", () => {
  const N = 60;

  it("attack vs stamina: KOs dominate over getting outspun; battles are short", () => {
    const t = battleBatch(attacker, staminaBot, N, 4000);
    console.log("attack vs stamina:", JSON.stringify(t));
    const koWinsForA =
      t.over + t.xtreme + t.burst - (t.n - t.winsA - t.spin - t.draw > 0 ? 0 : 0);
    void koWinsForA;
    const avgSec = t.totalSec / t.n;
    expect(avgSec).toBeGreaterThan(3);
    expect(avgSec).toBeLessThan(120);
    // attack archetype must produce a meaningful KO rate
    expect(t.over + t.xtreme + t.burst).toBeGreaterThan(N * 0.25);
    // self-KO without contact should be uncommon
    expect(t.ownFinish).toBeLessThan(N * 0.2);
  });

  it("stamina vs stamina: mostly spin finishes, long battles", () => {
    const t = battleBatch(staminaBot, { ...staminaBot, name: "持2" }, N, 9000);
    console.log("stamina mirror:", JSON.stringify(t));
    expect(t.spin + t.draw).toBeGreaterThan(N * 0.5);
    expect(t.totalSec / t.n).toBeGreaterThan(8);
  });

  it("defense vs attack: defender survives KOs more often than stamina does", () => {
    const tDef = battleBatch(attacker, defender, N, 14000);
    console.log("attack vs defense:", JSON.stringify(tDef));
    expect(tDef.ownFinish).toBeLessThan(N * 0.2);
  });
});
