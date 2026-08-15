// Tournament structures: single elimination (with byes + optional 3rd-place
// match) and round robin. Slots are named humans or bots (docs/PLAN.md §6.1).

import type { BotProfile } from "./bots";
import type { ComboSelection } from "../core/types";

export interface TournamentSlot {
  name: string;
  kind: "human" | "bot";
  bot?: BotProfile;
  deck: ComboSelection[];
}

export interface TourMatch {
  id: number;
  round: number;
  a: number | null; // slot index (null = TBD/bye)
  b: number | null;
  winner: number | null;
  isThirdPlace?: boolean;
}

export type TournamentFormat = "singleElim" | "roundRobin";

export class Tournament {
  readonly matches: TourMatch[] = [];
  readonly wins: number[];
  champion: number | null = null;
  third: number | null = null;

  constructor(
    readonly slots: TournamentSlot[],
    readonly format: TournamentFormat,
    readonly thirdPlaceMatch = true,
  ) {
    this.wins = slots.map(() => 0);
    if (format === "roundRobin") {
      let id = 0;
      for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
          this.matches.push({ id: id++, round: 0, a: i, b: j, winner: null });
        }
      }
    } else {
      this.buildBracket();
    }
  }

  private buildBracket(): void {
    const n = this.slots.length;
    const size = 1 << Math.ceil(Math.log2(Math.max(2, n)));
    // standard seeding order so byes spread out
    const seedOrder = (m: number): number[] =>
      m === 1 ? [0] : seedOrder(m / 2).flatMap((s) => [s, m - 1 - s]);
    const seeds = seedOrder(size).map((s) => (s < n ? s : null));
    let id = 0;
    let roundMatches: TourMatch[] = [];
    for (let i = 0; i < size; i += 2) {
      roundMatches.push({ id: id++, round: 0, a: seeds[i] ?? null, b: seeds[i + 1] ?? null, winner: null });
    }
    this.matches.push(...roundMatches);
    let round = 1;
    while (roundMatches.length > 1) {
      const next: TourMatch[] = [];
      for (let i = 0; i < roundMatches.length; i += 2) {
        next.push({ id: id++, round, a: null, b: null, winner: null });
      }
      this.matches.push(...next);
      roundMatches = next;
      round++;
    }
    if (this.thirdPlaceMatch && this.slots.length > 3) {
      this.matches.push({ id: id++, round, a: null, b: null, winner: null, isThirdPlace: true });
    }
    this.resolveByes();
  }

  private resolveByes(): void {
    for (const m of this.matches) {
      if (m.winner === null && m.round === 0) {
        if (m.a !== null && m.b === null) this.report(m.id, m.a);
        else if (m.a === null && m.b !== null) this.report(m.id, m.b);
      }
    }
  }

  /** Next playable match (both slots known, no winner). */
  next(): TourMatch | null {
    return (
      this.matches.find((m) => m.winner === null && m.a !== null && m.b !== null) ?? null
    );
  }

  report(matchId: number, winnerSlot: number): void {
    const m = this.matches.find((x) => x.id === matchId);
    if (!m || m.winner !== null) return;
    m.winner = winnerSlot;
    this.wins[winnerSlot] = (this.wins[winnerSlot] ?? 0) + 1;
    if (this.format === "roundRobin") {
      if (this.matches.every((x) => x.winner !== null)) {
        this.champion = this.wins.indexOf(Math.max(...this.wins));
      }
      return;
    }
    const loser = m.a === winnerSlot ? m.b : m.a;
    // feed winner into the next round's slot
    const sameRound = this.matches.filter((x) => x.round === m.round && !x.isThirdPlace);
    const idx = sameRound.indexOf(m);
    const nextRound = this.matches.filter((x) => x.round === m.round + 1 && !x.isThirdPlace);
    if (nextRound.length > 0) {
      const target = nextRound[Math.floor(idx / 2)]!;
      if (idx % 2 === 0) target.a = winnerSlot;
      else target.b = winnerSlot;
      // losers of the semifinals feed the 3rd-place match
      if (nextRound.length === 1 && loser !== null) {
        const tp = this.matches.find((x) => x.isThirdPlace);
        if (tp) {
          if (tp.a === null) tp.a = loser;
          else tp.b = loser;
        }
      }
      this.resolveByes();
    } else if (m.isThirdPlace) {
      this.third = winnerSlot;
    } else {
      this.champion = winnerSlot;
    }
  }

  /** Round-robin standings, best first. */
  standings(): { slot: number; wins: number }[] {
    return this.slots
      .map((_, i) => ({ slot: i, wins: this.wins[i] ?? 0 }))
      .sort((a, b) => b.wins - a.wins);
  }
}
