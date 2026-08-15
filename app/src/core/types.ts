// Shared types for the parts DB and the simulation core.

export type PartCategory =
  | "blade"
  | "ratchet"
  | "bit"
  | "lockChip"
  | "mainBlade"
  | "assistBlade"
  | "metalBlade"
  | "overBlade";

export type PartType = "attack" | "defense" | "stamina" | "balance" | null;

export type Rotation =
  | "right"
  | "left"
  | "both-right-origin"
  | "both-left-origin"
  | null;

export interface PartStats {
  attack: number;
  defense: number;
  stamina: number;
  dash: number;
  burst: number; // burst resistance
  height: number; // ratchet/assist height, units of 0.1 mm
}

export interface PartEntry {
  key: string; // unique, e.g. "DRANSWORD", "DRANSWORD#2", "3-60", "F"
  group: string;
  category: PartCategory;
  code: string;
  name: { "zh-TW": string; en: string; ja: string };
  variantLabel: string | null;
  type: PartType;
  stats: PartStats;
  rotation: Rotation;
  weightG: number | null;
  diameterMm: number | null;
  line: "BX" | "UX" | "CX" | null;
  fixedBurst: boolean;
  releaseAt: string | null;
  variants: { id: string; setId: string | null }[];
}

export interface PartsDb {
  generatedAt: string;
  source: string;
  statRanges: Record<string, Record<string, number>> | null;
  parts: Record<PartCategory, PartEntry[]>;
  combos: ComboPreset[];
}

export interface ComboPreset {
  code: string;
  line: "BX" | "UX" | "CX" | null;
  releaseAt: string | null;
  parts: ComboSelection;
}

/** A player's assembled bey, referencing part keys (null = slot unused). */
export interface ComboSelection {
  blade: string | null; // BX/UX line main body (null when CX stack used)
  ratchet: string | null;
  bit: string | null;
  lockChip: string | null;
  mainBlade: string | null;
  assistBlade: string | null;
  metalBlade: string | null;
  overBlade: string | null;
}

export type SpinDir = 1 | -1; // +1 right (cw from above), -1 left

/** Physics parameters derived from a combo (see core/derive.ts). */
export interface BeyParams {
  label: string;
  massKg: number;
  radiusM: number;
  inertia: number; // kg·m² about spin axis
  cogHeightM: number;
  attackFactor: number; // tangential impulse scale on contact
  attackVariance: number; // 0..1 randomness of attack impulses
  defenseFactor: number; // reduces received knockback
  burstRes: number; // resistance to burst damage
  dashFactor: number; // xtreme rail acceleration multiplier
  grip: number; // tip traction → traversal drive
  muSpin: number; // spin decay rate (1/s at full contact)
  muMove: number; // translational damping (1/s)
  spinDir: SpinDir;
  fixedBurst: boolean; // cannot burst (integrated/locked ratchet)
  staminaFactor: number; // scales effective spin energy
}

export type LauncherKind = "winder" | "string" | "hold";

export interface LaunchParams {
  sp: number; // shoot power, 0..11000 (Beybattle-Pass-like units)
  aimDeg: number; // -30..30 aim offset from default entry direction
  tiltDeg: number; // -20..20 launcher tilt (affects entry radius)
  launcher: LauncherKind;
  spinDir: SpinDir; // effective direction (dual-spin blades choose)
}

export type FinishType = "spin" | "over" | "burst" | "xtreme";

export interface FinishEvent {
  type: FinishType;
  /** index of the WINNING player (opponent of the finished bey) */
  winner: 0 | 1;
  /** true when the losing bey left without ever contacting the opponent */
  ownFinish: boolean;
  tick: number;
}

export interface SimEvent {
  tick: number;
  kind: "hit" | "wallHit" | "dashStart" | "dashEnd" | "click" | "exit";
  bey: 0 | 1;
  magnitude: number;
}

export interface BeyState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  omega: number; // signed rad/s (sign = spin direction)
  burstDamage: number; // accumulated clicks (bursts at clicksMax)
  alive: boolean;
  exited: "over" | "xtreme" | "top" | null;
  stoppedTick: number; // tick when spin finished (-1 = spinning)
  contacted: boolean; // has touched the opponent at least once
  railTicks: number; // remaining xtreme dash ticks (0 = not dashing)
  railDir: 1 | -1; // tangential direction of current dash
  phase: number; // visual rotation phase (rad)
}

export interface WorldConfig {
  seed: number;
  beys: [BeyParams, BeyParams];
  launches: [LaunchParams, LaunchParams];
  xtremeDashEnabled: boolean;
  clicksMax: number;
  maxTicks: number;
}

export interface WorldState {
  tick: number;
  rng: number;
  beys: [BeyState, BeyState];
  finish: FinishEvent | null;
  /** simultaneous finish in the same tick → draw (no points) */
  draw: boolean;
  events: SimEvent[];
  lastHitTick: number;
}
