/**
 * Where each requirement belongs in the report.
 *
 * spec: docs/workflows/missing-invoice-report.md §5, §6, §7
 * decision: docs/decisions/0014-report-counts-live-across-the-workspace.md
 *
 * Pure, and the only place the rule is written. Every requirement lands in exactly one
 * bucket, and five of the buckets are documents required. `bucketOf` switches over the
 * state enum exhaustively, so a state added to `docs/state-machines.md` later fails to
 * compile here instead of silently dropping out of the sum.
 */

import type { requirementStateEnum, resolutionMethodEnum } from "../db/schema";

export type RequirementState = (typeof requirementStateEnum.enumValues)[number];
export type ResolutionMethod = (typeof resolutionMethodEnum.enumValues)[number];

export type Bucket = "matched" | "notFound" | "needsReview" | "waiting" | "blocked" | "notRequired";

export function bucketOf(state: RequirementState, method: ResolutionMethod | null): Bucket {
  switch (state) {
    case "RESOLVED":
      // Resolved without being matched: the user said no document is needed, and a
      // transaction that needs none is not missing anything. §5.
      return method === "NOT_REQUIRED" ? "notRequired" : "matched";
    case "NOT_FOUND":
      return "notFound";
    case "NEEDS_REVIEW":
      return "needsReview";
    // FAILED is retried and is not the user's to act on, so it waits with the rest.
    case "IDENTIFIED":
    case "SEARCHING":
    case "EVALUATING":
    case "FAILED":
      return "waiting";
    case "BLOCKED":
      return "blocked";
    default: {
      const unhandled: never = state;
      throw new Error(`No report bucket for requirement state ${String(unhandled)}`);
    }
  }
}

export interface Summary {
  readonly documentsRequired: number;
  readonly matched: number;
  readonly notFound: number;
  readonly needsReview: number;
  readonly waiting: number;
  readonly blocked: number;
  /** Outside documents required, and shown beside it so the number that left is visible. */
  readonly notRequired: number;
}

export function summarize(
  requirements: readonly { state: RequirementState; resolutionMethod: ResolutionMethod | null }[],
): Summary {
  const counts: Record<Bucket, number> = {
    matched: 0,
    notFound: 0,
    needsReview: 0,
    waiting: 0,
    blocked: 0,
    notRequired: 0,
  };

  for (const requirement of requirements) {
    counts[bucketOf(requirement.state, requirement.resolutionMethod)] += 1;
  }

  return {
    ...counts,
    documentsRequired:
      counts.matched + counts.notFound + counts.needsReview + counts.waiting + counts.blocked,
  };
}

/**
 * The requirements that need the user, in the order the queue shows them.
 *
 * The ones asking for a decision first: a queue that buries them under everything still
 * waiting is a queue nobody works through. `IDENTIFIED` is here until retrieval exists
 * (§6, `docs/decisions/0012`). `BLOCKED` never is: it is one connection-level prompt, not
 * a row per requirement.
 */
export const QUEUE_STATES = ["NEEDS_REVIEW", "NOT_FOUND", "IDENTIFIED"] as const;

export type QueueState = (typeof QUEUE_STATES)[number];

/** §7's filters, as they appear in the URL. */
export const FILTERS = ["not-found", "needs-review", "waiting"] as const;

export type Filter = (typeof FILTERS)[number] | "all";

/** Anything that is not a known filter is All. A URL is user input. */
export function parseFilter(value: string | string[] | undefined): Filter {
  return typeof value === "string" && (FILTERS as readonly string[]).includes(value)
    ? (value as Filter)
    : "all";
}

export function statesFor(filter: Filter): readonly QueueState[] {
  switch (filter) {
    case "not-found":
      return ["NOT_FOUND"];
    case "needs-review":
      return ["NEEDS_REVIEW"];
    case "waiting":
      return ["IDENTIFIED"];
    case "all":
      return QUEUE_STATES;
  }
}
