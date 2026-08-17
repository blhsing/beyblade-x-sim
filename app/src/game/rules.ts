// RuleSet: every tournament rule that varies is a field here.
// Defaults = TAKARA TOMY official 1v1 (docs/RULES.md). The match engine only
// reads this object, so WBO/custom variants are pure data.

import type { ComboSelection, FinishEvent, FinishType, PartCategory } from "../core/types";

export interface RuleSet {
  name: string;
  pointsToWin: number;
  finishPoints: Record<FinishType, number>;
  /** self-KO without contact scores only 1 for the opponent */
  ownFinishRule: boolean;
  format: "single" | "3on3" | "wboDeck";
  deckSize: number;
  noDuplicateParts: boolean;
  cxLockChipException: boolean;
  counterPick: boolean;
  reorderOnTie: boolean;
  mislaunchPenalty: boolean;
  relaunchesPerBattle: number;
  stadium: "bx10" | "wide";
  xtremeDashEnabled: boolean;
  drawPolicy: "noPoints" | "suddenDeath";
  mnBitBanned: boolean;
}

export const RULES_OFFICIAL: RuleSet = {
  name: "官方標準",
  pointsToWin: 4,
  finishPoints: { spin: 1, over: 2, burst: 2, xtreme: 3 },
  ownFinishRule: true,
  format: "single",
  deckSize: 1,
  noDuplicateParts: true,
  cxLockChipException: true,
  counterPick: false,
  reorderOnTie: true,
  mislaunchPenalty: true,
  relaunchesPerBattle: 0,
  stadium: "bx10",
  xtremeDashEnabled: true,
  drawPolicy: "noPoints",
  mnBitBanned: false,
};

export const RULE_PRESETS: Record<string, RuleSet> = {
  official: RULES_OFFICIAL,
  official3on3: { ...RULES_OFFICIAL, name: "官方 3on3", format: "3on3", deckSize: 3 },
  wbo: {
    ...RULES_OFFICIAL,
    name: "WBO 標準",
    relaunchesPerBattle: 1,
    mnBitBanned: true,
  },
  wboFinal: {
    ...RULES_OFFICIAL,
    name: "WBO 決賽",
    pointsToWin: 7,
    format: "wboDeck",
    deckSize: 3,
    counterPick: true,
    relaunchesPerBattle: 1,
    mnBitBanned: true,
  },
};

export function pointsForFinish(rules: RuleSet, finish: FinishEvent): number {
  if (finish.ownFinish && rules.ownFinishRule) return 1;
  return rules.finishPoints[finish.type];
}

export interface PlayerSetup {
  name: string;
  kind: "human" | "bot";
  deck: ComboSelection[]; // length = rules.deckSize
}

export type MatchPhase = "battle" | "finished";

export interface BattleOutcome {
  finish: FinishEvent | null;
  draw: boolean;
  pointsAwarded: number;
  scorer: 0 | 1 | null;
}

/**
 * Tracks one match between two players: scores, 3on3 slot rotation,
 * mislaunch counters, and the win condition.
 */
export class MatchEngine {
  readonly scores: [number, number] = [0, 0];
  readonly mislaunches: [number, number] = [0, 0];
  readonly history: BattleOutcome[] = [];
  battleIndex = 0;

  constructor(
    readonly rules: RuleSet,
    readonly players: [PlayerSetup, PlayerSetup],
  ) {}

  get winner(): 0 | 1 | null {
    if (this.scores[0] >= this.rules.pointsToWin) return 0;
    if (this.scores[1] >= this.rules.pointsToWin) return 1;
    return null;
  }

  get phase(): MatchPhase {
    return this.winner === null ? "battle" : "finished";
  }

  /** Deck slot each player fields for the upcoming battle. */
  slotFor(player: 0 | 1): number {
    if (this.rules.deckSize <= 1) return 0;
    return this.battleIndex % this.rules.deckSize;
  }

  deckOf(player: 0 | 1): ComboSelection {
    const deck = this.players[player].deck;
    const combo = deck[this.slotFor(player) % deck.length];
    if (!combo) throw new Error("empty deck slot");
    return combo;
  }

  /**
   * Official mislaunch rule: 2 accumulated in a round → opponent +1 point,
   * round restarts. Scoring resets the scorer's counter.
   * Returns true when a penalty point was awarded.
   */
  reportMislaunch(player: 0 | 1): boolean {
    if (!this.rules.mislaunchPenalty || this.winner !== null) return false;
    this.mislaunches[player]++;
    if (this.mislaunches[player] >= 2) {
      this.mislaunches[player] = 0;
      const opponent = (1 - player) as 0 | 1;
      this.scores[opponent]++;
      this.history.push({
        finish: null,
        draw: false,
        pointsAwarded: 1,
        scorer: opponent,
      });
      return true;
    }
    return false;
  }

  /** Record a completed battle simulation result. */
  applyBattle(finish: FinishEvent | null, draw: boolean): BattleOutcome {
    if (this.winner !== null) throw new Error("match already finished");
    let outcome: BattleOutcome;
    if (draw || !finish) {
      // 平手: no points; same slots re-battle (battleIndex unchanged)
      outcome = { finish: null, draw: true, pointsAwarded: 0, scorer: null };
    } else {
      const pts = pointsForFinish(this.rules, finish);
      this.scores[finish.winner] += pts;
      this.mislaunches[finish.winner] = 0;
      this.battleIndex++;
      outcome = { finish, draw: false, pointsAwarded: pts, scorer: finish.winner };
    }
    this.history.push(outcome);
    return outcome;
  }
}

/** 3on3 deck legality: no part group may repeat across the deck. */
export function deckDuplicateError(
  rules: RuleSet,
  deck: ComboSelection[],
  groupOf: (category: PartCategory, key: string) => string | null,
): string | null {
  if (!rules.noDuplicateParts || deck.length <= 1) return null;
  const seen = new Set<string>();
  const cxOncePerChip = new Set<string>(); // 戰神/帝王 exception
  const categories: PartCategory[] = [
    "blade", "ratchet", "bit", "lockChip",
    "mainBlade", "assistBlade", "metalBlade", "overBlade",
  ];
  for (const combo of deck) {
    for (const cat of categories) {
      const key = combo[cat];
      if (!key) continue;
      const group = groupOf(cat, key) ?? key;
      const tag = `${cat}:${group}`;
      if (cat === "lockChip" && rules.cxLockChipException) {
        const restricted = group === "VALKYRIE" || group === "EMPEROR";
        if (restricted) {
          if (cxOncePerChip.has(group)) return `duplicate-lockchip:${group}`;
          cxOncePerChip.add(group);
        }
        continue; // other lock chips may repeat
      }
      if (seen.has(tag)) return `duplicate:${tag}`;
      seen.add(tag);
    }
  }
  return null;
}
