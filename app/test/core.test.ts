import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { datan2, dsin, dcos, hashFloats } from "../src/core/fxmath";
import {
  PartIndex,
  deriveBeyParams,
  resolveCombo,
  comboError,
  ratchetLatchCount,
} from "../src/core/derive";
import { pocketExitTarget, STADIUM_BX10, type StadiumSpec } from "../src/core/stadium";
import { createWorld, hashWorld, latchImpactResponse, POCKET_DWELL_TICKS, simulateBattle, step } from "../src/core/sim";
import type { BeyParams, LaunchParams, PartCategory, PartsDb, WorldConfig } from "../src/core/types";
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
    const smasher = baseParams({ attackFactor: 9, burstRes: 10_000, grip: 0.9 });
    const victim = baseParams({ burstRes: 6, defenseFactor: 1 });
    const noExit: StadiumSpec = { ...STADIUM_BX10, exitSpeed: 99, pockets: [], coverGaps: [] };
    const w = simulateBattle(cfg(smasher, victim, 3), noExit);
    expect(w.finish?.type).toBe("burst");
    expect(w.finish?.winner).toBe(0);
  });

  it("a late release enters the stadium late", () => {
    // Players do not let go on the same frame. A delayed launch must be
    // held out of play — not silently teleported in with everyone else.
    const c = cfg(baseParams(), baseParams(), 21, {
      launches: [baseLaunch(), baseLaunch({ delayTicks: 240 })], // 1 s later
    });
    const w = createWorld(c);
    expect(w.beys[1]!.pendingTicks).toBe(240);
    for (let i = 0; i < 120; i++) step(w, c, STADIUM_BX10);
    // half a second in: the prompt bey is playing, the late one has not moved
    expect(w.beys[1]!.pendingTicks).toBeGreaterThan(0);
    expect(w.beys[0]!.airborne || Math.hypot(w.beys[0]!.vx, w.beys[0]!.vy) > 0).toBe(true);
    const held = { x: w.beys[1]!.x, y: w.beys[1]!.y };
    for (let i = 0; i < 60; i++) step(w, c, STADIUM_BX10);
    expect(w.beys[1]!.x).toBe(held.x);
    expect(w.beys[1]!.y).toBe(held.y);
    // …and once its moment comes it does join in
    for (let i = 0; i < 200; i++) step(w, c, STADIUM_BX10);
    expect(w.beys[1]!.pendingTicks).toBe(0);
  });

  it("launch delay is deterministic", () => {
    const c = cfg(baseParams(), baseParams(), 33, {
      launches: [baseLaunch({ delayTicks: 37 }), baseLaunch({ delayTicks: 111 })],
    });
    const a = simulateBattle(c, STADIUM_BX10);
    const b = simulateBattle(c, STADIUM_BX10);
    expect(hashWorld(a)).toEqual(hashWorld(b));
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

  it("Ratchet perimeter protrusions do not multiply Bit Burst resistance", () => {
    // N in N-HH describes OUTER attack protrusions, not internal latch teeth.
    // Identical Bits therefore have identical yield under identical torque.
    const impact = {
      normalImpulse: 0.02,
      incomingSmash: 0.05,
      attackerSpinDir: 1 as const,
      currentClicks: 0,
    };
    const three = latchImpactResponse(baseParams({ burstRes: 60, latchCount: 3 }), impact);
    const nine = latchImpactResponse(baseParams({ burstRes: 60, latchCount: 9 }), impact);
    expect(nine.yieldLoad).toBe(three.yieldLoad);
    expect(nine.detentDelta).toBe(three.detentDelta);
  });

  it("a hit at the burst threshold barely moves the latch", () => {
    // slip comes from load ABOVE the yield threshold, so a marginal
    // joint hit must not advance the lock by a meaningful fraction of the
    // Four latch detents that release (Burst) the bey; no part is cracked.
    const glancer = baseParams({ attackFactor: 0.35, grip: 0.2 });
    const victim = baseParams({ burstRes: 60, latchCount: 3 });
    const noExit: StadiumSpec = { ...STADIUM_BX10, exitSpeed: 99, pockets: [], coverGaps: [] };
    const w = simulateBattle(cfg(glancer, victim, 11), noExit);
    expect(w.finish?.type).not.toBe("burst");
  });

  it("a fully stopped untouched Bey in the central tray = own Xtreme Finish", () => {
    const c = cfg(baseParams(), baseParams());
    const w = createWorld(c);
    for (const b of w.beys) {
      b.airborne = false; // test drives grounded dynamics directly
      b.z = 0;
      b.vz = 0;
    }
    const b0 = w.beys[0]!;
    const pocket = STADIUM_BX10.pockets[1]!;
    const target = pocketExitTarget(STADIUM_BX10, pocket);
    b0.x = target.x;
    b0.y = target.y;
    b0.vx = 0;
    b0.vy = 0;
    b0.omega = 0;
    b0.pocketIndex = 1;
    b0.pocketDwell = POCKET_DWELL_TICKS - 1;
    b0.railTicks = -1;
    step(w, c, STADIUM_BX10);
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
  it("contains no blank catalog artifacts and every source variant resolves", () => {
    for (const entries of Object.values(db.parts)) {
      for (const part of entries) {
        expect(part.key.trim()).not.toBe("");
        expect(part.code.trim() !== "" || part.key.endsWith("-integrated")).toBe(true);
      }
    }
    for (const preset of db.combos) {
      for (const [category, id] of Object.entries(preset.parts.variantIds ?? {})) {
        const key = preset.parts[category as keyof typeof preset.parts];
        expect(typeof key).toBe("string");
        const part = index.get(category as PartCategory, key as string);
        expect(part?.variants.some((variant) => variant.id === id)).toBe(true);
      }
    }
  });

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

  it("every normalized official product is a legal, renderable assembly", () => {
    for (const preset of db.combos) {
      expect(comboError(resolveCombo(index, preset.parts)), preset.code).toBeNull();
    }
  });

  it("uses physical Ratchet latch counts for exceptional molds", () => {
    const byCode = (code: string) => db.parts.ratchet.find((part) => part.code === code);
    expect(ratchetLatchCount(byCode("0-60"))).toBe(0);
    expect(ratchetLatchCount(byCode("M-85"))).toBe(5);
    expect(ratchetLatchCount(db.parts.ratchet.find((part) => part.integratedRatchet))).toBe(0);
  });

  it("restores each official preset's source palette", () => {
    const preset = db.combos.find((c) => c.code === "DRANSWORD")!;
    expect(preset.parts.variantIds?.blade).toBeTruthy();
    const base = index.get("blade", preset.parts.blade)!;
    const source = base.variants.find((v) => v.id === preset.parts.variantIds!.blade)!;
    const rc = resolveCombo(index, preset.parts);
    expect(rc.parts.blade?.colors).toEqual(source.colors);
    expect(rc.parts.ratchet?.colors?.length).toBeGreaterThan(1);
    expect(rc.parts.bit?.gearTeeth).toBe(12);
  });

  it("resolves classic and Expand CX as physical component stacks", () => {
    const classicPreset = db.combos.find((c) => c.code === "PERSEUSDARKB")!;
    const classic = resolveCombo(index, classicPreset.parts);
    expect(comboError(classic)).toBeNull();
    expect(classic.compositeBlade?.key).toBeTruthy();
    expect(classic.parts.blade).toBeUndefined();
    expect(classic.parts.mainBlade).toBeTruthy();

    const expandPreset = db.combos.find((c) => c.code === "BAHAMUTBLITZBK")!;
    const expand = resolveCombo(index, expandPreset.parts);
    expect(comboError(expand)).toBeNull();
    expect(expand.compositeMainBlade).toBeTruthy();
    expect(expand.parts.mainBlade).toBeUndefined();
    expect(expand.parts.metalBlade).toBeTruthy();
    expect(expand.parts.overBlade).toBeTruthy();

    const partial = resolveCombo(index, { ...expandPreset.parts, overBlade: null });
    expect(comboError(partial)).toBe("incomplete-cx");
    expect(partial.parts.mainBlade).toBeTruthy();
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
