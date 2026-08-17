// Bot players: a skill tier (execution quality) × a character archetype
// (deck building + launch style), individually selectable per slot.
// All randomness flows through the deterministic PRNG so bot decisions can be
// replayed from a seed.

import { rngNext } from "../core/fxmath";
import type { PartIndex } from "../core/derive";
import type {
  ComboSelection,
  LaunchParams,
  PartEntry,
  PartsDb,
  SpinDir,
} from "../core/types";
import type { RuleSet } from "./rules";

export type BotSkill = "novice" | "apprentice" | "skilled" | "expert" | "champion";
export type BotCharacter = "aggressive" | "defensive" | "stamina" | "balanced" | "tricky";

export interface BotSkillSpec {
  zh: string;
  spMean: number;
  spSd: number;
  aimSdDeg: number;
  /** 0..1 — how close deck choices are to stat-optimal */
  deckIQ: number;
}

export const BOT_SKILLS: Record<BotSkill, BotSkillSpec> = {
  novice: { zh: "新手", spMean: 5200, spSd: 1400, aimSdDeg: 14, deckIQ: 0.1 },
  apprentice: { zh: "見習", spMean: 6300, spSd: 1100, aimSdDeg: 10, deckIQ: 0.35 },
  skilled: { zh: "高手", spMean: 7400, spSd: 800, aimSdDeg: 7, deckIQ: 0.6 },
  expert: { zh: "達人", spMean: 8300, spSd: 600, aimSdDeg: 5, deckIQ: 0.8 },
  champion: { zh: "冠軍", spMean: 9200, spSd: 450, aimSdDeg: 3, deckIQ: 1.0 },
};

export interface BotCharacterSpec {
  zh: string;
  weights: { attack: number; defense: number; stamina: number; dash: number; burst: number };
  launcher: LaunchParams["launcher"];
  spBias: number;
  prefersLeftSpin: boolean;
}

export const BOT_CHARACTERS: Record<BotCharacter, BotCharacterSpec> = {
  aggressive: {
    zh: "猛攻型",
    weights: { attack: 1.0, defense: 0.1, stamina: 0.1, dash: 0.8, burst: 0.3 },
    launcher: "hold",
    spBias: 500,
    prefersLeftSpin: false,
  },
  defensive: {
    zh: "鐵壁型",
    weights: { attack: 0.15, defense: 1.0, stamina: 0.4, dash: 0.1, burst: 0.8 },
    launcher: "winder",
    spBias: -200,
    prefersLeftSpin: false,
  },
  stamina: {
    zh: "持久型",
    weights: { attack: 0.05, defense: 0.35, stamina: 1.0, dash: 0.05, burst: 0.5 },
    launcher: "string",
    spBias: -900,
    prefersLeftSpin: false,
  },
  balanced: {
    zh: "均衡型",
    weights: { attack: 0.5, defense: 0.5, stamina: 0.5, dash: 0.4, burst: 0.5 },
    launcher: "string",
    spBias: 0,
    prefersLeftSpin: false,
  },
  tricky: {
    zh: "詭道型",
    weights: { attack: 0.45, defense: 0.3, stamina: 0.45, dash: 0.6, burst: 0.4 },
    launcher: "string",
    spBias: 100,
    prefersLeftSpin: true,
  },
};

export interface BotProfile {
  name: string;
  skill: BotSkill;
  character: BotCharacter;
}

/** Named roster with pre-assigned profiles (both axes stay overridable). */
export const BOT_ROSTER: BotProfile[] = [
  { name: "烈火", skill: "champion", character: "aggressive" },
  { name: "小靜", skill: "expert", character: "stamina" },
  { name: "阿鐵", skill: "skilled", character: "defensive" },
  { name: "影狼", skill: "expert", character: "tricky" },
  { name: "飛燕", skill: "apprentice", character: "balanced" },
  { name: "大牛", skill: "skilled", character: "aggressive" },
  { name: "小雨", skill: "apprentice", character: "stamina" },
  { name: "阿丸", skill: "novice", character: "aggressive" },
];

interface RngBox {
  state: number;
}

function rand(box: RngBox): number {
  const r = rngNext(box.state);
  box.state = r.state;
  return r.value;
}

/** Deterministic ~normal via Irwin–Hall (sum of 6 uniforms). */
function gauss(box: RngBox, mean: number, sd: number): number {
  let s = 0;
  for (let i = 0; i < 6; i++) s += rand(box);
  return mean + ((s - 3) / 0.7071) * sd;
}

function scorePart(p: PartEntry, spec: BotCharacterSpec, iq: number, box: RngBox): number {
  const w = spec.weights;
  const s = p.stats;
  const base =
    s.attack * w.attack +
    s.defense * w.defense +
    s.stamina * w.stamina +
    s.dash * w.dash +
    s.burst * w.burst;
  const noise = (rand(box) - 0.5) * 90 * (1 - iq);
  const leftBonus =
    spec.prefersLeftSpin && (p.rotation === "left" || p.rotation === "both-left-origin")
      ? 12
      : 0;
  return base + noise + leftBonus;
}

/**
 * Builds a legal deck for the bot: BX/UX-style Blade+Ratchet+Bit combos
 * picked by archetype-weighted stats, honoring the no-duplicate rule.
 */
export function botBuildDeck(
  db: PartsDb,
  profile: BotProfile,
  rules: RuleSet,
  seed: number,
): ComboSelection[] {
  const box: RngBox = { state: seed >>> 0 };
  const skill = BOT_SKILLS[profile.skill];
  const spec = BOT_CHARACTERS[profile.character];

  const rank = (list: PartEntry[]): PartEntry[] =>
    list
      .filter((p) => !(rules.mnBitBanned && p.category === "bit" && p.code === "MN"))
      .map((p) => ({ p, s: scorePart(p, spec, skill.deckIQ, box) }))
      .sort((a, b) => b.s - a.s || a.p.key.localeCompare(b.p.key))
      .map((x) => x.p);

  // This builder assembles three freely interchangeable pieces. Integrated
  // Blade/Ratchet/Bit systems remain available through official presets but
  // cannot be mixed independently here.
  const blades = rank(db.parts.blade.filter((part) => !part.integratedRatchet));
  const ratchets = rank(db.parts.ratchet.filter((part) => !part.integratedRatchet));
  const bits = rank(db.parts.bit.filter((part) => part.tipFamily !== "integrated"));

  const usedGroups = new Set<string>();
  const deck: ComboSelection[] = [];
  for (let slot = 0; slot < Math.max(1, rules.deckSize); slot++) {
    const pick = (ranked: PartEntry[]): PartEntry => {
      for (const p of ranked) {
        if (!rules.noDuplicateParts || !usedGroups.has(`${p.category}:${p.group}`)) {
          usedGroups.add(`${p.category}:${p.group}`);
          return p;
        }
      }
      const last = ranked[ranked.length - 1];
      if (!last) throw new Error("empty part list");
      return last;
    };
    deck.push({
      blade: pick(blades).key,
      ratchet: pick(ratchets).key,
      bit: pick(bits).key,
      lockChip: null,
      mainBlade: null,
      assistBlade: null,
      metalBlade: null,
      overBlade: null,
    });
  }
  return deck;
}

/** One launch decision. Skill controls power consistency and aim. */
export function botChooseLaunch(
  profile: BotProfile,
  bladeRotation: PartEntry["rotation"],
  seed: number,
): LaunchParams {
  const box: RngBox = { state: seed >>> 0 };
  const skill = BOT_SKILLS[profile.skill];
  const spec = BOT_CHARACTERS[profile.character];
  const sp = Math.max(1500, Math.min(11000, gauss(box, skill.spMean + spec.spBias, skill.spSd)));
  const aimDeg = Math.max(-25, Math.min(25, gauss(box, 0, skill.aimSdDeg)));
  const tiltDeg = Math.max(-15, Math.min(15, gauss(box, 0, 4)));
  const spinDir: SpinDir =
    bladeRotation === "left" || bladeRotation === "both-left-origin" ? -1 : 1;
  return { sp, aimDeg, tiltDeg, launcher: spec.launcher, spinDir };
}

export function describeBot(profile: BotProfile): string {
  return `${profile.name}（${BOT_SKILLS[profile.skill].zh}・${BOT_CHARACTERS[profile.character].zh}）`;
}

export interface LaunchContext {
  /** opponent's recent average shoot power (from their launch history) */
  oppAvgSp?: number | null;
  /** did this bot lose the previous decisive battle of the match? */
  lostLast?: boolean;
  battleIndex?: number;
}

/**
 * Character-driven, opponent-reactive launch: starts from the deterministic
 * base launch and applies personality adjustments. Only used in local play —
 * online bot launches stay pure botChooseLaunch so every client derives the
 * identical value from the shared seed.
 */
export function botChooseLaunchAdaptive(
  profile: BotProfile,
  bladeRotation: PartEntry["rotation"],
  seed: number,
  ctx: LaunchContext,
): LaunchParams {
  const l = botChooseLaunch(profile, bladeRotation, seed);
  const hot = (ctx.oppAvgSp ?? 0) > 8200; // opponent launches hard
  const idx = ctx.battleIndex ?? 0;
  switch (profile.character) {
    case "defensive":
      if (hot) {
        l.sp = Math.max(2500, l.sp - 650); // soften: hold the center, absorb
        l.aimDeg *= 0.5;
      }
      break;
    case "stamina":
      if (hot) l.sp = Math.max(2200, l.sp - 550); // outlast the storm
      break;
    case "aggressive":
      if (ctx.lostLast) {
        l.sp = Math.min(11000, l.sp + 400); // double down
        l.aimDeg += l.aimDeg >= 0 ? 4 : -4; // steeper bank
      }
      break;
    case "tricky":
      if (ctx.lostLast) {
        l.aimDeg = -l.aimDeg + (idx % 2 === 0 ? 5 : -5); // switch it up
        l.sp += idx % 2 === 0 ? 420 : -420;
        l.sp = Math.max(2000, Math.min(11000, l.sp));
      }
      break;
    case "balanced":
      l.sp = l.sp * 0.85 + 7800 * 0.15; // regress toward reliable form
      break;
  }
  return l;
}

export { PartIndex };
