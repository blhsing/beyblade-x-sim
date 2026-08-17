// Derives simulation parameters (BeyParams) from an assembled combo and the
// parts DB. All formulas are deterministic functions of official stats +
// measured weights, with per-category fallbacks for unmeasured parts.

import type {
  BeyParams,
  ComboSelection,
  PartCategory,
  PartEntry,
  PartsDb,
  SpinDir,
} from "./types";

const FALLBACK_WEIGHT_G: Record<PartCategory, number> = {
  blade: 33,
  ratchet: 6.5,
  bit: 2.5,
  lockChip: 1.6,
  mainBlade: 20,
  assistBlade: 8,
  metalBlade: 12,
  overBlade: 6,
};

export class PartIndex {
  private byKey = new Map<string, PartEntry>();
  constructor(db: PartsDb) {
    for (const list of Object.values(db.parts)) {
      for (const p of list) this.byKey.set(`${p.category}:${p.key}`, p);
    }
  }
  get(category: PartCategory, key: string | null): PartEntry | null {
    return key ? (this.byKey.get(`${category}:${key}`) ?? null) : null;
  }
}

export interface ResolvedCombo {
  parts: Partial<Record<PartCategory, PartEntry>>;
  isCx: boolean;
  /** Catalog-only full CX assembly art; excluded from mass/stats component sums. */
  compositeBlade?: PartEntry;
  /** Synthetic assembled Main Blade row for Expand CX; components carry physics. */
  compositeMainBlade?: PartEntry;
}

function samePalette(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every(
    (color, index) => color.toLowerCase() === right[index]?.toLowerCase(),
  );
}

export function resolveCombo(index: PartIndex, sel: ComboSelection): ResolvedCombo {
  const parts: Partial<Record<PartCategory, PartEntry>> = {};
  for (const cat of Object.keys(FALLBACK_WEIGHT_G) as PartCategory[]) {
    const p = index.get(cat, sel[cat]);
    if (p) {
      const variantId = sel.variantIds?.[cat];
      const variant = variantId ? p.variants.find((v) => v.id === variantId) : null;
      parts[cat] = variant
        ? {
            ...p,
            color: variant.colors?.[0] ?? p.color,
            colors: variant.colors?.length ? variant.colors : p.colors,
            variantLabel: variant.label ?? p.variantLabel,
            selectedVariantId: variant.id,
            variantColorOverride:
              !!variant.colors?.length && !samePalette(variant.colors, p.colors),
          }
        : p;
    }
  }
  const isCx = !!parts.lockChip || !!parts.mainBlade;
  const compositeBlade = isCx ? parts.blade : undefined;
  if (isCx) delete parts.blade;
  const isExpandCx = isCx && !!parts.metalBlade && !!parts.overBlade;
  const compositeMainBlade = isExpandCx ? parts.mainBlade : undefined;
  if (isExpandCx) delete parts.mainBlade;
  return { parts, isCx, compositeBlade, compositeMainBlade };
}

/** Validation: a legal combo is Blade+Ratchet+Bit, or the CX stack. */
export function comboError(rc: ResolvedCombo): string | null {
  const p = rc.parts;
  if (!p.ratchet || !p.bit) return "missing-ratchet-or-bit";
  const integratedRatchet = !!p.ratchet.integratedRatchet;
  const integratedConsumer = p.bit.tipFamily === "integrated" || !!p.blade?.integratedRatchet;
  if (integratedRatchet !== integratedConsumer) return "incompatible-integrated-ratchet";
  if (rc.isCx) {
    if (!!p.metalBlade !== !!p.overBlade) return "incomplete-cx";
    const upperComplete = p.mainBlade || (p.metalBlade && p.overBlade);
    if (!p.lockChip || !upperComplete || !p.assistBlade) return "incomplete-cx";
  } else if (!p.blade) {
    return "missing-blade";
  }
  return null;
}

function sumStat(rc: ResolvedCombo, k: "attack" | "defense" | "stamina" | "dash" | "burst"): number {
  let v = 0;
  for (const p of Object.values(rc.parts)) v += p.stats[k];
  return v;
}

function weightOf(p: PartEntry | undefined, cat: PartCategory): number {
  return p ? (p.weightG ?? FALLBACK_WEIGHT_G[cat]) : 0;
}

export function deriveBeyParams(
  rc: ResolvedCombo,
  opts: { label?: string; spinDirOverride?: SpinDir } = {},
): BeyParams {
  const p = rc.parts;
  let massG = 0;
  for (const cat of Object.keys(FALLBACK_WEIGHT_G) as PartCategory[]) {
    massG += weightOf(p[cat], cat);
  }
  const massKg = Math.max(0.025, massG / 1000);

  const bladeLike = p.blade ?? p.mainBlade ?? p.metalBlade;
  const radiusM = ((bladeLike?.diameterMm ?? 49) / 2) / 1000;

  const attack = sumStat(rc, "attack");
  const defense = sumStat(rc, "defense");
  // Shock spreading comes from the upper stack. A Bit already contributes
  // through its dedicated Burst stat; counting its Defense here would make a
  // catalog fixed-resistance Ratchet vary when the Bit changes.
  const burstDefense = defense - (p.bit?.stats.defense ?? 0);
  const stamina = sumStat(rc, "stamina");
  const dash = p.bit?.stats.dash ?? 0;
  // `fixed_burst` in the catalog means the Ratchet supplies a constant
  // Burst-resistance value regardless of the selected Bit. It does NOT make
  // the assembly unburstable. Ordinary Ratchets continue to inherit the
  // Bit's Gear Structure stat.
  const burst = p.ratchet?.fixedBurst
    ? p.ratchet.stats.burst
    : (p.bit?.stats.burst ?? 40);

  // rim-weighted discs (stamina designs) carry more inertia per gram
  const inertiaCoef = 0.5 + 0.3 * Math.min(1, stamina / 137);
  const inertia = inertiaCoef * massKg * radiusM * radiusM;

  // center of gravity height from ratchet height code (units of 0.1 mm)
  const ratchetH = (p.ratchet?.stats.height ?? 60) / 10000; // m
  const cogHeightM = 0.006 + ratchetH + 0.004;

  // tip behaviour from bit code + stats
  const code = p.bit?.code ?? "F";
  const tipAttack = p.bit?.stats.attack ?? 20;
  // Normalized catalogs carry the exact mold family. Keep a conservative
  // fallback for older saves/synthetic fixtures which predate that field.
  const family = p.bit?.tipFamily ?? (
    code === "M" || code === "RA" || (/^R/.test(code) && code !== "R")
      ? "rubberHybrid"
      : code === "R" || (/F/.test(code) && !/^FB/.test(code))
        ? "flat"
        : /N/.test(code) && code !== "Nr"
          ? "needle"
          : /B/.test(code) && !/^BS/.test(code)
            ? "ball"
            : "special"
  );
  const rubber = family === "rubberFlat" || family === "rubberHybrid";
  const flat = family === "flat";
  const needle = family === "needle";
  const ball = family === "ball";
  let grip = 0.25 + tipAttack / 90 + dash / 140;
  let muSpin = 0.05 + tipAttack / 700;
  let muMove = 0.75;
  if (rubber) {
    grip += 0.3;
    muSpin += 0.05;
  } else if (flat) {
    grip += 0.12;
    muSpin += 0.012;
  } else if (needle) {
    grip -= 0.12;
    muSpin -= 0.02;
    muMove += 0.5;
  } else if (ball) {
    grip -= 0.04;
    // The stamina stat already rewards low-loss Ball molds. A positive
    // point-contact floor keeps modern high-stamina builds from coasting to
    // the 180 s match cap while remaining far below Flat/Rubber friction.
    muSpin += 0.03;
    muMove += 0.2;
  }
  muSpin = Math.max(0.02, muSpin - (p.bit?.stats.stamina ?? 20) / 2600);

  const rotation =
    opts.spinDirOverride ??
    (((p.lockChip?.rotation ?? bladeLike?.rotation) === "left" ||
    (p.lockChip?.rotation ?? bladeLike?.rotation) === "both-left-origin"
      ? -1
      : 1) as SpinDir);

  return {
    label: opts.label ?? bladeLike?.name["zh-TW"] ?? "?",
    massKg,
    radiusM,
    inertia,
    cogHeightM,
    attackFactor: 0.5 + attack / 90,
    attackVariance: 0.25 + Math.min(0.35, attack / 400),
    defenseFactor: 1 / (1 + defense / 130),
    // Official Burst resistance is primarily a Bit Gear Structure property.
    // Upper-part defense has only a small secondary shock-spreading effect.
    burstRes: 30 + burst + burstDefense * 0.08,
    dashFactor: 0.6 + dash / 40,
    grip,
    muSpin,
    muMove,
    spinDir: rotation,
    // First Ratchet digit = OUTER attack protrusions ("3-60" → 3). The sim
    // uses their periodicity for exposed impact geometry, never as a count
    // of internal Bit latch teeth or a direct Burst-resistance multiplier.
    latchCount: ratchetLatchCount(p.ratchet),
    staminaFactor: 0.8 + stamina / 250,
  };
}

export function ratchetLatchCount(part: PartEntry | undefined): number {
  if (!part) return 4;
  if (part.integratedRatchet) return 0;
  if (part.code.trim() === "M-85") return 5;
  const match = /^(\d)-\d{2}$/.exec(part.code.trim());
  return match ? Math.min(9, Number.parseInt(match[1]!, 10)) : 4;
}
