/**
 * Where retrieval may move an Invoice Requirement.
 *
 * spec: docs/state-machines.md §2, "Transitions made by retrieval"
 *
 * The table from the state document, as data, in the shape `src/gmail/connection-state.ts`
 * gives the connection machine. Every retrieval write to a requirement's state goes through
 * `moveRequirement`, which is conditional on the requirement being in a state the table
 * allows. So a transition the document does not list cannot happen by way of a code path
 * that forgot to check -- the write simply matches nothing.
 *
 * `RESOLVED` is not here. Every resolution is written by `src/matching/link.ts`, the single
 * funnel `docs/decisions/0012` established, and retrieval reaches it through `linkInvoice`
 * like everything else.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";

import { invoiceRequirements, type requirementStateEnum } from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";

export type RequirementState = (typeof requirementStateEnum.enumValues)[number];

/**
 * What can happen to a requirement during retrieval.
 *
 * - `SEARCH_STARTED`: a search of its mailboxes begins. Also the event a retried search
 *   re-applies, which is why `SEARCHING` is among its sources.
 * - `DOCUMENTS_FETCHED`: at least one document was downloaded and awaits assessment.
 * - `SETTLED_NEEDS_REVIEW`, `SETTLED_NOT_FOUND`, `SETTLED_BLOCKED`: what the evidence came
 *   to, when it did not come to a link.
 * - `FAILED`: infrastructure failed and the retries are spent.
 */
export type RetrievalEvent =
  | "SEARCH_STARTED"
  | "DOCUMENTS_FETCHED"
  | "SETTLED_NEEDS_REVIEW"
  | "SETTLED_NOT_FOUND"
  | "SETTLED_BLOCKED"
  | "FAILED";

const TRANSITIONS: Record<RetrievalEvent, { from: RequirementState[]; to: RequirementState }> = {
  SEARCH_STARTED: {
    from: ["IDENTIFIED", "NOT_FOUND", "BLOCKED", "FAILED", "SEARCHING"],
    to: "SEARCHING",
  },
  DOCUMENTS_FETCHED: { from: ["SEARCHING"], to: "EVALUATING" },
  SETTLED_NEEDS_REVIEW: { from: ["EVALUATING"], to: "NEEDS_REVIEW" },
  SETTLED_NOT_FOUND: { from: ["SEARCHING", "EVALUATING"], to: "NOT_FOUND" },
  SETTLED_BLOCKED: { from: ["SEARCHING", "EVALUATING"], to: "BLOCKED" },
  FAILED: { from: ["SEARCHING", "EVALUATING"], to: "FAILED" },
};

/** The states a search may start from. What the fan-out looks for. */
export const SEARCHABLE_STATES: readonly RequirementState[] =
  TRANSITIONS.SEARCH_STARTED.from.filter((state) => state !== "SEARCHING");

/** The state after `event` from `current`, or null where the table has no such edge. */
export function nextRequirementState(
  current: RequirementState,
  event: RetrievalEvent,
): RequirementState | null {
  const edge = TRANSITIONS[event];
  return edge.from.includes(current) ? edge.to : null;
}

/**
 * Apply `event` to one requirement, if the table allows it from the state it is in now.
 *
 * Returns whether it moved. The condition is in the `where`, not in a read before it, so
 * two workers racing on one requirement cannot both move it, and a user resolving it in
 * the meantime is never undone: a requirement with a resolution method is settled, and no
 * retrieval write touches it -- the same guard `link.ts` holds.
 */
export async function moveRequirement(
  scope: WorkspaceScope,
  requirementId: string,
  event: RetrievalEvent,
): Promise<boolean> {
  const edge = TRANSITIONS[event];

  const moved = await scope.update(
    invoiceRequirements,
    { state: edge.to, updatedAt: new Date() },
    and(
      eq(invoiceRequirements.id, requirementId),
      inArray(invoiceRequirements.state, edge.from),
      isNull(invoiceRequirements.resolutionMethod),
    ),
  );

  return moved.length > 0;
}
