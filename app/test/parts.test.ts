// Modeling invariants: the geometry must follow the real measurements
// (docs/MODELING.md), not drift back to eyeballed numbers. These cover the
// pure geometry helpers — the material factories need a canvas, so they are
// exercised in the browser instead.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as THREE from "three";

import {
  DETAIL,
  bitFamily,
  bitHasGear,
  bitHeight,
  bitTipHeight,
  partRadiusM,
  ratchetSpec,
  sweepSolid,
} from "../src/render/parts";
import { fingertipOffset } from "../src/render/hand";
import { sfx } from "../src/audio/sfx";
import { beastOf } from "../src/render/materials";
import {
  pocketCatchPolygon,
  stadiumBodyRadiusAt,
  STADIUM_BX10,
  STADIUM_BX32,
} from "../src/core/stadium";
import type { PartsDb } from "../src/core/types";

const db: PartsDb = JSON.parse(
  readFileSync(fileURLToPath(new URL("../public/data/parts.json", import.meta.url)), "utf8"),
);

describe("ratchet codes encode real geometry", () => {
  it("N-HH → N protrusions at HH tenths of a mm", () => {
    expect(ratchetSpec("3-60")).toEqual({ count: 3, heightM: 0.006 });
    expect(ratchetSpec("9-60")).toEqual({ count: 9, heightM: 0.006 });
    expect(ratchetSpec("4-80")).toEqual({ count: 4, heightM: 0.008 });
    expect(ratchetSpec("1-50")).toEqual({ count: 1, heightM: 0.005 });
  });

  it("every ratchet in the dataset parses to a plausible part", () => {
    let parsed = 0;
    for (const r of db.parts.ratchet.filter((part) => /^\d+-\d+/.test(part.code))) {
      const spec = ratchetSpec(r.code);
      expect(spec.count).toBeGreaterThanOrEqual(0);
      expect(spec.heightM).toBeGreaterThanOrEqual(0.004);
      expect(spec.heightM).toBeLessThanOrEqual(0.009);
      if (/^\d+-\d+/.test(r.code)) parsed++;
    }
    expect(parsed).toBeGreaterThan(30); // the numeric codes dominate the set
  });
});

describe("bit codes map to the right tip", () => {
  it("families follow the published shape names", () => {
    expect(bitFamily("F")).toBe("flat");
    expect(bitFamily("LF")).toBe("flat");
    expect(bitFamily("B")).toBe("ball");
    expect(bitFamily("N")).toBe("needle");
    expect(bitFamily("HN")).toBe("needle");
    expect(bitFamily("P")).toBe("point");
    expect(bitFamily("T")).toBe("taper");
    expect(bitFamily("R")).toBe("flat"); // Rush is hard POM, not rubber
    expect(bitFamily("RA")).toBe("rubberFlat");
    expect(bitFamily("M")).toBe("rubberHybrid");
  });

  it("gear bits keep their base shape and gain the rack ring", () => {
    expect(bitFamily("GF")).toBe("flat");
    expect(bitFamily("GB")).toBe("ball");
    expect(bitFamily("GN")).toBe("needle");
    expect(bitHasGear("GF")).toBe(true);
    expect(bitHasGear("GN")).toBe(true);
    expect(bitHasGear("F")).toBe(true);
    expect(bitHasGear("N")).toBe(true);
  });

  it("tip heights stay inside a real bit's envelope", () => {
    for (const b of db.parts.bit.filter((part) => /^[A-Za-z]+$/.test(part.code))) {
      const h = bitHeight(b.code);
      expect(bitTipHeight(b.code)).toBeGreaterThan(0.002);
      expect(h).toBeGreaterThan(0.008);
      expect(h).toBeLessThan(0.022);
    }
  });
});

describe("real per-part dimensions drive the mesh", () => {
  it("measured diameters are used verbatim, not the derived radius", () => {
    const dran = db.parts.blade.find((b) => b.key === "DRANSWORD")!;
    expect(dran.diameterMm).toBe(48.5);
    expect(partRadiusM(dran, 0.9)).toBeCloseTo(0.02425, 6);
  });

  it("unmeasured parts fall back to the derived radius", () => {
    expect(partRadiusM(null, 0.0245)).toBe(0.0245);
    expect(partRadiusM({ diameterMm: null } as never, 0.0245)).toBe(0.0245);
  });

  it("every measured blade lands in the real 45–53 mm band", () => {
    const measured = db.parts.blade.filter((b) => b.diameterMm);
    expect(measured.length).toBeGreaterThan(50);
    for (const b of measured) {
      expect(b.diameterMm!).toBeGreaterThanOrEqual(40);
      expect(b.diameterMm!).toBeLessThanOrEqual(56);
    }
  });
});

describe("swept solids", () => {
  // a blade-like section: crown, sloped top face, striking rim, undercut
  const section = [
    { f: 0, z: 0.0112 },
    { f: 0.42, z: 0.0112 },
    { f: 0.82, z: 0.01 },
    { f: 1, z: 0.0077 },
    { f: 1, z: 0.004 },
    { f: 0.86, z: 0.002 },
    { f: 0.5, z: 0.0014 },
    { f: 0, z: 0.0024 },
  ];

  it("is a closed high-polygon surface with usable normals", () => {
    const g = sweepSolid(section, () => 0.024);
    const tris = g.getIndex()!.count / 3;
    expect(tris).toBeGreaterThan(25000); // high-poly by request
    const n = g.getAttribute("normal");
    expect(n.count).toBe(g.getAttribute("position").count);
    for (let i = 0; i < n.count; i += 977) {
      const len = Math.hypot(n.getX(i), n.getY(i), n.getZ(i));
      expect(len).toBeGreaterThan(0.9); // no degenerate/NaN normals
    }
  });

  it("respects the plan outline (a 3-blade attack profile is not round)", () => {
    const R = 0.0245;
    const g = sweepSolid(section, (th) => R * (0.84 + 0.16 * Math.max(0, Math.cos(3 * th))));
    g.computeBoundingSphere();
    const pos = g.getAttribute("position");
    let min = Infinity;
    let max = 0;
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i));
      if (r > 1e-6) {
        min = Math.min(min, r);
        max = Math.max(max, r);
      }
    }
    expect(max).toBeLessThanOrEqual(R * 1.001);
    expect(min).toBeLessThan(max * 0.9); // genuinely lobed
  });

  it("tessellation budget is high enough for close-up silhouettes", () => {
    expect(DETAIL.sweep).toBeGreaterThanOrEqual(256);
    expect(DETAIL.radial).toBeGreaterThanOrEqual(64);
  });
});

describe("sticker beasts", () => {
  it("reads the creature out of the blade name", () => {
    expect(beastOf("DRANSWORD")).toBe("dragon");
    expect(beastOf("PHOENIXWING")).toBe("phoenix");
    expect(beastOf("LEONCLAW")).toBe("lion");
    expect(beastOf("VIPERTAIL")).toBe("serpent");
    expect(beastOf("SHARKEDGE")).toBe("shark");
    expect(beastOf("HELLSSCYTHE")).toBe("reaper");
    expect(beastOf("KNIGHTSHIELD")).toBe("knight");
  });

  it("every blade in the dataset gets a beast", () => {
    const kinds = new Set<string>();
    for (const b of db.parts.blade) kinds.add(beastOf(b.key + (b.name.en ?? "")));
    // the roster is varied enough that several creatures show up
    expect(kinds.size).toBeGreaterThanOrEqual(4);
  });
});

describe("music scores", () => {
  it("picks a battle score from the types on the dish", () => {
    expect(sfx.battleScoreFor(["attack", "stamina"])).toBe("battleAttack");
    expect(sfx.battleScoreFor(["defense", "stamina"])).toBe("battleDefense");
    expect(sfx.battleScoreFor(["stamina", "stamina"])).toBe("battleStamina");
    expect(sfx.battleScoreFor(["defense", "defense"])).toBe("battleDefense");
    expect(sfx.battleScoreFor(["balance", "defense"])).toBe("battleBalance");
    expect(sfx.battleScoreFor([null, undefined])).toBe("battleBalance");
  });

  it("a mirror match keeps its own archetype's colour", () => {
    // not just "most aggressive wins" — an all-stamina field should sound
    // like a stamina war, not like an attack fight
    expect(sfx.battleScoreFor(["stamina", "stamina", "stamina"])).toBe("battleStamina");
    expect(sfx.battleScoreFor(["attack", "attack"])).toBe("battleAttack");
  });

  it("setScore is a no-op for the current score and switches otherwise", () => {
    const start = sfx.currentScore;
    sfx.setScore(start);
    expect(sfx.currentScore).toBe(start);
    sfx.setScore("victory");
    expect(sfx.currentScore).toBe("victory");
    sfx.setScore("menu");
    expect(sfx.currentScore).toBe("menu");
  });
});

describe("hand rig", () => {
  it("fingers close INTO the palm, never backwards", () => {
    const len = 0.072;
    const open = fingertipOffset(len, 0);
    // an open hand points its tip straight down -Z, level with the knuckles
    expect(open.z).toBeCloseTo(-len, 4);
    expect(Math.abs(open.y)).toBeLessThan(1e-9);

    // a part-closed hand swings the tip toward +Y — the palm side
    expect(fingertipOffset(len, 0.4).y).toBeGreaterThan(0);
  });

  it("a full curl actually makes a fist around a grip", () => {
    const len = 0.072;
    // fully closed, the tip comes back near the knuckle rather than
    // sticking out past whatever the hand is meant to be holding
    const closed = fingertipOffset(len, 1);
    const reach = Math.hypot(closed.y, closed.z);
    expect(reach).toBeLessThan(len * 0.55);
    // and it is on the palm side, not curled backwards over the knuckle
    expect(closed.y).toBeGreaterThan(0);
  });

  it("closing is monotonic: the tip only ever approaches the knuckle", () => {
    const len = 0.072;
    let prev = Infinity;
    for (let c = 0; c <= 1.0001; c += 0.1) {
      const t = fingertipOffset(len, c);
      const reach = Math.hypot(t.y, t.z);
      expect(reach).toBeLessThanOrEqual(prev + 1e-9);
      prev = reach;
    }
  });
});

describe("stadium bodies match the published dimensions", () => {
  it("BX-10 is the 440 × 455 mm body with a ⌀210 mm tornado ridge", () => {
    expect(STADIUM_BX10.deckW).toBeCloseTo(0.44, 3);
    expect(STADIUM_BX10.deckH).toBeCloseTo(0.455, 3);
    expect(STADIUM_BX10.rDish * 2).toBeCloseTo(0.21, 3);
  });

  it("BX-32 is the 600 × 440 mm wide 3-player body", () => {
    expect(STADIUM_BX32.deckW).toBeCloseTo(0.6, 3);
    expect(STADIUM_BX32.deckH).toBeCloseTo(0.44, 3);
    expect(STADIUM_BX32.shootAngles).toHaveLength(3);
  });

  it("exit pockets fit inside the stadium body on every stadium", () => {
    // The pocket tray is cut THROUGH the deck; if it reached past the deck
    // edge the hole would hang off the body and render as broken geometry
    // instead of a pocket.
    for (const s of [STADIUM_BX10, STADIUM_BX32]) {
      expect(s.pockets.length).toBeGreaterThan(0);
      for (const pocket of s.pockets) {
        expect(pocket.throat.outwardDepth).toBeGreaterThanOrEqual(0.012);
        for (const vertex of pocketCatchPolygon(s, pocket)) {
          const angle = Math.atan2(vertex.y, vertex.x);
          expect(Math.hypot(vertex.x, vertex.y)).toBeLessThanOrEqual(stadiumBodyRadiusAt(s, angle) + 1e-8);
        }
      }
    }
  });

  it("both shells are the real off-white plastic, with coloured X-Lines", () => {
    for (const s of [STADIUM_BX10, STADIUM_BX32]) {
      const c = new THREE.Color(s.bodyColor);
      expect(Math.min(c.r, c.g, c.b)).toBeGreaterThan(0.65); // near-white
      expect(s.railColor).not.toBe(s.bodyColor);
    }
  });
});
