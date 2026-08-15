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
}

export function resolveCombo(index: PartIndex, sel: ComboSelection): ResolvedCombo {
  const parts: Partial<Record<PartCategory, PartEntry>> = {};
  for (const cat of Object.keys(FALLBACK_WEIGHT_G) as PartCategory[]) {
    const p = index.get(cat, sel[cat]);
    if (p) parts[cat] = p;
  }
  return { parts, isCx: !!parts.lockChip || !!parts.mainBlade };
}

/** Validation: a legal combo is Blade+Ratchet+Bit, or the CX stack. */
export function comboError(rc: ResolvedCombo): string | null {
  const p = rc.parts;
  if (!p.ratchet || !p.bit) return "missing-ratchet-or-bit";
  if (rc.isCx) {
    if (!p.lockChip || !p.mainBlade || !p.assistBlade) return "incomplete-cx";
    if (p.blade) return "blade-and-cx";
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

  const bladeLike = p.blade ?? p.mainBlade;
  const radiusM = ((bladeLike?.diameterMm ?? 49) / 2) / 1000;

  const attack = sumStat(rc, "attack");
  const defense = sumStat(rc, "defense");
  const stamina = sumStat(rc, "stamina");
  const dash = p.bit?.stats.dash ?? 0;
  const burst = p.bit?.stats.burst ?? 40;

  // rim-weighted discs (stamina designs) carry more inertia per gram
  const inertiaCoef = 0.5 + 0.3 * Math.min(1, stamina / 137);
  const inertia = inertiaCoef * massKg * radiusM * radiusM;

  // center of gravity height from ratchet height code (units of 0.1 mm)
  const ratchetH = (p.ratchet?.stats.height ?? 60) / 10000; // m
  const cogHeightM = 0.006 + ratchetH + 0.004;

  // tip behaviour from bit code + stats
  const code = p.bit?.code ?? "F";
  const tipAttack = p.bit?.stats.attack ?? 20;
  const rubber = code.startsWith("R") || code === "RA" || code.includes("Rubber");
  const flat = /F/.test(code) && !/^FB/.test(code);
  const needle = /N/.test(code) && code !== "Nr";
  const ball = /B/.test(code) && !/^BS/.test(code);
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
    muSpin -= 0.012;
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
    burstRes: 30 + burst + defense * 0.25,
    dashFactor: 0.6 + dash / 40,
    grip,
    muSpin,
    muMove,
    spinDir: rotation,
    fixedBurst: p.ratchet?.fixedBurst ?? false,
    staminaFactor: 0.8 + stamina / 250,
  };
}
