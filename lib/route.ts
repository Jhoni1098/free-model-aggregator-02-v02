// lib/route.ts — spreading a trial's calls across the free catalog.
//
// The brief rates fourteen free OpenRouter models. A router that always
// dials the highest-rated one hammers a single model until that model
// rate-limits, and then every later prompt pays for it. This router instead
// charges each model for the calls it has already taken: every attempt on a
// model knocks 60 milli off its score, up to 180 milli after three attempts,
// so a model that has served three prompts falls below the next-best fresh
// model and the traffic rotates. A model that has refused twice running
// loses a further 25 milli, because a model refusing in a row is probably
// rate-limited or down, not merely busy.
//
// The discount is what moves the order, not the rating alone: the top model
// (1475) starts 172 milli clear of the next tier, so it still leads for its
// first three prompts, then drops to 1295 — below the 1303 model — and a
// fresh model takes over. After three attempts on every model the whole
// field is discounted alike and the raw ratings decide again, which is the
// right behaviour: spreading is about not exhausting one model early, not
// about avoiding good models.
//
// What a prompt needs (tools, vision, JSON, minimum context) is a gate, not
// a preference: a model that cannot meet a requirement never appears in the
// ranking for that prompt, however high its rating. Ties in the discounted
// score go to the model used least so far, then to the smaller id, so the
// ranking is a pure function of the brief and the calls already made — no
// clock, no randomness, and a replay sees the same order.

import { capabilitiesOf, meetsRequirements, type ModelRow, type Requirement } from './providers.ts';

/** Attempts on one model before its discount stops growing. */
export const SPREAD_CAP = 3;
/** Milli knocked off a model's score per attempt on it. */
export const SPREAD_PER_ATTEMPT = 60;
/** Largest spread discount one model can carry (3 attempts x 60). */
export const SPREAD_MAX = 180;
/** Milli knocked off a model refusing twice in a row. */
export const REFUSAL_PENALTY = 25;
/** Consecutive refusals before the refusal penalty applies. */
export const REFUSAL_STREAK = 2;

/** One model eligible for this prompt, with the score it was ranked on. */
export interface Pick {
  id: string;
  baseRating: number;
  score: number;
  row: ModelRow;
}

/** What the router remembers about one model. */
interface LedgerEntry {
  uses: number;
  refusalsInARow: number;
}

export class SpreadRouter {
  private readonly ledger = new Map<string, LedgerEntry>();
  private readonly catalog: readonly ModelRow[];

  constructor(catalog: readonly ModelRow[]) {
    this.catalog = catalog;
  }

  private entryFor(id: string): LedgerEntry {
    const found = this.ledger.get(id);
    if (found !== undefined) return found;
    const fresh: LedgerEntry = { uses: 0, refusalsInARow: 0 };
    this.ledger.set(id, fresh);
    return fresh;
  }

  usesOf(id: string): number {
    return this.ledger.get(id)?.uses ?? 0;
  }

  /** Record one dial: a success clears the refusal streak, a refusal grows it. */
  record(id: string, succeeded: boolean): void {
    const entry = this.entryFor(id);
    entry.uses += 1;
    entry.refusalsInARow = succeeded ? 0 : entry.refusalsInARow + 1;
  }

  /** A model's score for this prompt: rating, less what it has already spent. */
  scoreFor(id: string, baseRating: number): number {
    const entry = this.ledger.get(id);
    if (entry === undefined) return baseRating;
    let cut = Math.min(entry.uses * SPREAD_PER_ATTEMPT, SPREAD_MAX);
    if (entry.refusalsInARow >= REFUSAL_STREAK) cut += REFUSAL_PENALTY;
    return baseRating - cut;
  }

  /** Every eligible free model, best first for this prompt. */
  orderFor(needs: Requirement): Pick[] {
    const picks: Pick[] = [];
    for (const row of this.catalog) {
      if (!row.free) continue;
      if (!meetsRequirements(needs, capabilitiesOf(row))) continue;
      picks.push({ id: row.id, baseRating: row.rating_milli, score: this.scoreFor(row.id, row.rating_milli), row });
    }
    picks.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aUses = this.usesOf(a.id);
      const bUses = this.usesOf(b.id);
      if (aUses !== bUses) return aUses - bUses;
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    });
    return picks;
  }
}
