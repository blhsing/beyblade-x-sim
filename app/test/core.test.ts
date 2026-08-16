import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { datan2, dsin, dcos, hashFloats } from "../src/core/fxmath";
import { PartIndex, deriveBeyParams, resolveCombo, comboError } from "../src/core/derive";
import { STADIUM_BX10, type StadiumSpec } from "../src/core/stadium";
import { createWorld, hashWorld, simulateBattle, step } from "../src/core/sim";
import type { BeyParams, LaunchParams, PartsDb, WorldConfig } from "../src/core/types";
import { MatchEngine, RULES_OFFICIAL, RULE_PRESETS, deckDuplicateError, pointsForFinish } from "../src/game/rules";
import { BOT_ROSTER, botBuildDeck, botChooseLaunch } from "../src/game/bots";

const db: PartsDb = JSON.parse(
  readFileSync(fileURLToPath(new URL("../public/data/parts.json", import.meta.url)), "utf8"),
);
const index = new PartIndex(db);

const baseParams = (over: Partial<BeyParams> = {}): BeyParams => ({
  label: "T",
  massKg: 0.036,
  radiusM: 0.0245,
  inertia: 0.6 * 0.036 * 0.0245 * 0.0245,
  cogHeightM: 0.016,
  attackFactor: 1,
  attackVariance: 0.2,
  defenseFactor: 0.8,
  burstRes: 120,
  dashFactor: 1,
  grip: 0.4,
  muSpin: 0.05,
  muMove: 0.9,
  spinDir: 1,
  fixedBurst: false,
  latchCount: 4,
  staminaFactor: 1,
  ...over,
});

const baseLaunch = (over: Partial<LaunchParams> = {}): LaunchParams => ({
  sp: 7000,
  aimDeg: 0,
  tiltDeg: 0,
  launcher: "string",
  spinDir: 1,
  ...over,
});

const cfg = (
  a: BeyParams,
  b: BeyParams,
  seed = 42,
  over: Partial<WorldConfig> = {},
): WorldConfig => ({
  seed,
  beys: [a, b],
  launches: [baseLaunch(), baseLaunch()],
  xtremeDashEnabled: true,
  clicksMax: 4,
  maxTicks: 240 * 120,
  ...over,
});

const FLAT: StadiumSpec = {
  ...STADIUM_BX10,
  dishDepth: 0,
  rimRise: 0,
  rimBaseSlope: 0,
  railArcs: [],
  pockets: [],
};

describe("deterministic math", () => {
  it("dsin/dcos match native within 5e-6", () => {
    for (let i = -700; i <= 700; i++) {
      const x = i * 0.01;
      expect(Math.abs(dsin(x) - Math.sin(x))).toBeLessThan(5e-6);
      expect(Math.abs(dcos(x) - Math.cos(x))).toBeLessThan(5e-6);
    }
  });
  it("datan2 matches native within 1e-4", () => {
    for (let a = -3.1; a <= 3.1; a += 0.037) {
      const y = Math.sin(a) * 2.5;
      const x = Math.cos(a) * 2.5;
      expect(Math.abs(datan2(y, x) - Math.atan2(y, x))).toBeLessThan(1e-4);
    }
  });
  it("hashFloats is order- and value-sensitive", () => {
    expect(hashFloats([1, 2, 3])).not.toEqual(hashFloats([3, 2, 1]));
    expect(hashFloats([1, 2, 3])).toEqual(hashFloats([1, 2, 3]));
  });
});

describe("simulation determinism", () => {
  it("identical config → identical world hash after 5000 ticks", () => {
    const c = cfg(baseParams(), baseParams({ muSpin: 0.06 }));
    const w1 = createWorld(c);
    const w2 = createWorld(c);
    for (let i = 0; i < 5000; i++) {
      step(w1, c, STADIUM_BX10);
      step(w2, c, STADIUM_BX10);
    }
    expect(hashWorld(w1)).toEqual(hashWorld(w2));
  });
  it("different seed → different trajectory", () => {
    const a = simulateBattle(cfg(baseParams(), baseParams(), 1), STADIUM_BX10);
    const b = simulateBattle(cfg(baseParams(), baseParams(), 2), STADIUM_BX10);
    expect(hashWorld(a)).not.toEqual(hashWorld(b));
  });
});

describe("battle outcomes", () => {
  it("flat stadium spin race: lower spin friction outlasts", () => {
    const durable = baseParams({ muSpin: 0.03, grip: 0, muMove: 3 });
    const weary = baseParams({ muSpin: 0.09, grip: 0, muMove: 3 });
    const w = simulateBattle(
      cfg(durable, weary, 7, { xtremeDashEnabled: false }),
      FLAT,
    );
    expect(w.finish?.type).toBe("spin");
    expect(w.finish?.winner).toBe(0);
  });

  it("glass-cannon matchup ends in a burst", () => {
    const smasher = baseParams({ attackFactor: 9, fixedBurst: true, grip: 0.9 });
    const victim = baseParams({ burstRes: 6, defenseFactor: 1 });
    const noExit: StadiumSpec = { ...STADIUM_BX10, exitSpeed: 99, pockets: [], coverGaps: [] };
    const w = simulateBattle(cfg(smasher, victim, 3), noExit);
    expect(w.finish?.type).toBe("burst");
    expect(w.finish?.winner).toBe(0);
  });

  it("spent beys resting in contact stop clashing", () => {
    // After a match is decided the view keeps stepping the world so the
    // action does not freeze. Two dead-still beys touching each other still
    // overlap every tick, and the clash event used to fire on a tick gap
    // alone — so sparks and clang went on forever.
    const c = cfg(baseParams(), baseParams());
    const w = createWorld(c);
    const [a, b] = w.beys as [(typeof w.beys)[number], (typeof w.beys)[number]];
    for (const s of [a, b]) {
      s.airborne = false;
      s.z = 0;
      s.vz = 0;
      s.vx = 0;
      s.vy = 0;
      s.omega = 0.5; // spun down to a standstill
    }
    // park them overlapping, as two settled beys leaning together
    const touch = c.beys[0]!.radiusM + c.beys[1]!.radiusM;
    a.x = -touch * 0.45;
    a.y = 0;
    b.x = touch * 0.45;
    b.y = 0;

    w.events.length = 0;
    for (let i = 0; i < 2400; i++) step(w, c, STADIUM_BX10, true); // 10 s afterglow
    expect(w.events.filter((e) => e.kind === "hit")).toHaveLength(0);
  });

  it("real clashes still register as hits", () => {
    const w = simulateBattle(cfg(baseParams({ attackFactor: 3 }), baseParams(), 5), STADIUM_BX10);
    expect(w.events.filter((e) => e.kind === "hit").length).toBeGreaterThan(0);
  });

  it("a ratchet's tooth count is its burst resistance", () => {
    // The ratchet code is the geometry: more protrusions share the latch
    // load, so a 9-60 must survive far longer than a 3-60 under the same
    // beating. This was inverted-by-omission before — the tooth count did
    // nothing at all, and three qualifying hits cracked anything.
    const smasher = baseParams({ attackFactor: 9, fixedBurst: true, grip: 0.9 });
    const noExit: StadiumSpec = { ...STADIUM_BX10, exitSpeed: 99, pockets: [], coverGaps: [] };
    const survivedTicks = (latchCount: number): number => {
      const victim = baseParams({ burstRes: 60, defenseFactor: 1, latchCount });
      const w = simulateBattle(cfg(smasher, victim, 3), noExit);
      return w.finish?.type === "burst" ? w.tick : Number.POSITIVE_INFINITY;
    };
    expect(survivedTicks(9)).toBeGreaterThan(survivedTicks(3));
  });

  it("a hit at the burst threshold barely moves the latch", () => {
    // damage comes from the impulse ABOVE the threshold, so a marginal
    // joint hit must not advance the lock by a meaningful fraction of the
    // 4 clicks that crack a bey
    const glancer = baseParams({ attackFactor: 0.35, grip: 0.2 });
    const victim = baseParams({ burstRes: 60, latchCount: 3 });
    const noExit: StadiumSpec = { ...STADIUM_BX10, exitSpeed: 99, pockets: [], coverGaps: [] };
    const w = simulateBattle(cfg(glancer, victim, 11), noExit);
    expect(w.finish?.type).not.toBe("burst");
  });

  it("bey shot into the central pocket = xtreme finish; untouched = own finish", () => {
    const c = cfg(baseParams(), baseParams());
    const w = createWorld(c);
    for (const b of w.beys) {
      b.airborne = false; // test drives grounded dynamics directly
      b.z = 0;
      b.vz = 0;
    }
    const b0 = w.beys[0]!;
    b0.x = 0;
    b0.y = -0.09;
    b0.vx = 0;
    b0.vy = -2.4; // well above railBreakSpeed: sails over the rack into the pocket
    for (let i = 0; i < 240 && !w.finish; i++) step(w, c, STADIUM_BX10);
    expect(w.finish?.type).toBe("xtreme");
    expect(w.finish?.winner).toBe(1);
    expect(w.finish?.ownFinish).toBe(true);
    expect(pointsForFinish(RULES_OFFICIAL, w.finish!)).toBe(1);
  });
});

describe("free-for-all (N beys)", () => {
  const ffaCfg = (n: number, seed = 17): WorldConfig => ({
    seed,
    beys: Array.from({ length: n }, (_, i) =>
      baseParams({ muSpin: 0.04 + i * 0.012, attackFactor: 1 + (i % 2) * 2 }),
    ),
    launches: Array.from({ length: n }, () => baseLaunch()),
    xtremeDashEnabled: true,
    clicksMax: 4,
    maxTicks: 240 * 120,
  });

  it("4-bey world is deterministic (identical hash after 5000 ticks)", () => {
    const c = ffaCfg(4);
    const w1 = createWorld(c);
    const w2 = createWorld(c);
    for (let i = 0; i < 5000; i++) {
      step(w1, c, STADIUM_BX10);
      step(w2, c, STADIUM_BX10);
    }
    expect(hashWorld(w1)).toEqual(hashWorld(w2));
  });

  it("free-for-all resolves a winner with a full elimination order", () => {
    const c = ffaCfg(4, 23);
    const w = simulateBattle(c, STADIUM_BX10);
    expect(w.ffaWinner).not.toBeNull();
    expect(w.finish).toBeNull(); // 2-player finish path unused for N>2
    if (w.ffaWinner! >= 0) {
      expect(w.eliminatedOrder).not.toContain(w.ffaWinner);
      // decisive (non-timeout) ending: everyone else was eliminated
      if (w.tick < c.maxTicks) expect(w.eliminatedOrder).toHaveLength(c.beys.length - 1);
    }
    const seen = new Set(w.eliminatedOrder);
    expect(seen.size).toBe(w.eliminatedOrder.length); // no duplicates
  });

  it("3-bey entry spread keeps all beys inside the dish at launch", () => {
    const c = ffaCfg(3, 5);
    const w = createWorld(c);
    for (const b of w.beys) {
      expect(Math.hypot(b.x, b.y)).toBeLessThan(STADIUM_BX10.rWall);
    }
    const angles = w.beys.map((b) => Math.atan2(b.y, b.x));
    // distinct entry directions (even circular spread)
    expect(new Set(angles.map((a) => a.toFixed(2))).size).toBe(3);
  });

  it("2-bey battles still use the standard finish pipeline", () => {
    const w = simulateBattle(cfg(baseParams(), baseParams({ muSpin: 0.08 }), 9), STADIUM_BX10);
    expect(w.finish !== null || w.draw).toBe(true);
    expect(w.ffaWinner).toBeNull();
  });
});

describe("rules & match engine", () => {
  const players = (): [any, any] => [
    { name: "A", kind: "human", deck: [{}, {}, {}] },
    { name: "B", kind: "bot", deck: [{}, {}, {}] },
  ];

  it("official scoring reaches 4 and stops", () => {
    const m = new MatchEngine(RULES_OFFICIAL, players());
    m.applyBattle({ type: "over", winner: 0, ownFinish: false, tick: 1 }, false);
    expect(m.scores).toEqual([2, 0]);
    m.applyBattle({ type: "spin", winner: 1, ownFinish: false, tick: 1 }, false);
    m.applyBattle({ type: "xtreme", winner: 0, ownFinish: false, tick: 1 }, false);
    expect(m.scores).toEqual([5, 1]);
    expect(m.winner).toBe(0);
    expect(() =>
      m.applyBattle({ type: "spin", winner: 1, ownFinish: false, tick: 1 }, false),
    ).toThrow();
  });

  it("own finish scores 1 regardless of zone", () => {
    const m = new MatchEngine(RULES_OFFICIAL, players());
    m.applyBattle({ type: "xtreme", winner: 1, ownFinish: true, tick: 1 }, false);
    expect(m.scores).toEqual([0, 1]);
  });

  it("two mislaunches in a round give the opponent a point", () => {
    const m = new MatchEngine(RULES_OFFICIAL, players());
    expect(m.reportMislaunch(0)).toBe(false);
    expect(m.reportMislaunch(0)).toBe(true);
    expect(m.scores).toEqual([0, 1]);
    expect(m.mislaunches[0]).toBe(0);
  });

  it("3on3 rotates slots on decisive battles, not on draws", () => {
    const m = new MatchEngine(RULE_PRESETS.official3on3!, players());
    expect(m.slotFor(0)).toBe(0);
    m.applyBattle(null, true);
    expect(m.slotFor(0)).toBe(0);
    m.applyBattle({ type: "spin", winner: 0, ownFinish: false, tick: 1 }, false);
    expect(m.slotFor(0)).toBe(1);
  });

  it("deck duplicate validation flags repeated groups", () => {
    const rules = RULE_PRESETS.official3on3!;
    const groupOf = (_c: any, key: string) => key.split("#")[0] ?? key;
    const empty = {
      blade: null, ratchet: null, bit: null, lockChip: null,
      mainBlade: null, assistBlade: null, metalBlade: null, overBlade: null,
    };
    const ok = deckDuplicateError(
      rules,
      [
        { ...empty, blade: "A", ratchet: "3-60", bit: "F" },
        { ...empty, blade: "B", ratchet: "4-80", bit: "N" },
      ],
      groupOf,
    );
    expect(ok).toBeNull();
    const dup = deckDuplicateError(
      rules,
      [
        { ...empty, blade: "A", ratchet: "3-60", bit: "F" },
        { ...empty, blade: "A#2", ratchet: "4-80", bit: "N" },
      ],
      groupOf,
    );
    expect(dup).toContain("duplicate");
  });
});

describe("parts DB integration", () => {
  it("official preset combos resolve and derive plausible physics", () => {
    const preset = db.combos.find((c) => c.code === "DRANSWORD")!;
    const rc = resolveCombo(index, preset.parts);
    expect(comboError(rc)).toBeNull();
    const p = deriveBeyParams(rc);
    expect(p.massKg).toBeGreaterThan(0.03);
    expect(p.massKg).toBeLessThan(0.08);
    expect(p.radiusM).toBeGreaterThan(0.02);
    expect(p.spinDir).toBe(1);
  });

  it("bots build legal decks deterministically", () => {
    const rules = RULE_PRESETS.official3on3!;
    const bot = BOT_ROSTER[0]!;
    const d1 = botBuildDeck(db, bot, rules, 123);
    const d2 = botBuildDeck(db, bot, rules, 123);
    expect(d1).toEqual(d2);
    expect(d1).toHaveLength(3);
    const groupOf = (cat: any, key: string) =>
      index.get(cat, key)?.group ?? key;
    expect(deckDuplicateError(rules, d1, groupOf)).toBeNull();
    for (const combo of d1) {
      const rc = resolveCombo(index, combo);
      expect(comboError(rc)).toBeNull();
    }
  });

  it("bot launches stay in legal ranges", () => {
    for (let seed = 0; seed < 50; seed++) {
      const l = botChooseLaunch(BOT_ROSTER[0]!, "right", seed);
      expect(l.sp).toBeGreaterThanOrEqual(1500);
      expect(l.sp).toBeLessThanOrEqual(11000);
      expect(Math.abs(l.aimDeg)).toBeLessThanOrEqual(25);
    }
  });

  it("full bot-vs-bot battle completes with a finish", () => {
    const rules = RULES_OFFICIAL;
    const dA = botBuildDeck(db, BOT_ROSTER[0]!, rules, 11)[0]!;
    const dB = botBuildDeck(db, BOT_ROSTER[1]!, rules, 22)[0]!;
    const pA = deriveBeyParams(resolveCombo(index, dA));
    const pB = deriveBeyParams(resolveCombo(index, dB));
    const w = simulateBattle(
      {
        seed: 99,
        beys: [pA, pB],
        launches: [
          botChooseLaunch(BOT_ROSTER[0]!, "right", 5),
          botChooseLaunch(BOT_ROSTER[1]!, "right", 6),
        ],
        xtremeDashEnabled: true,
        clicksMax: 4,
        maxTicks: 240 * 120,
      },
      STADIUM_BX10,
    );
    expect(w.finish !== null || w.draw).toBe(true);
  });
});
