/**
 * Writing down something the user confirmed, so the system stops asking.
 *
 * spec: docs/architecture.md §11 · docs/domain-model.md §3.14, invariant 18
 *
 * `architecture.md §11` draws the line this file exists to hold:
 *
 *     AI inference        →  Suggestion
 *     User confirmation   →  Authoritative business knowledge
 *
 * Invariant 18 is the same rule stated as a constraint: "Business Knowledge is created only
 * from a user's confirmed decision." So every caller here must be acting on something a
 * person actually chose, and nothing in this file may be reached from a model's output.
 *
 * ## Why it is its own module
 *
 * It was inside `answer.ts`, private, because answering a clarification question was the
 * only way to confirm anything. Match review is the second: a user saying a payment needs
 * no document has confirmed a fact about that vendor just as squarely.
 *
 * Importing it from `answer.ts` would drag the whole question machinery into a workflow
 * that raises no questions, and would leave that file readable as two stories at once.
 * Copying it would put two read-then-write upserts against
 * `business_knowledge_identity_idx` in the codebase, and the one that got the guard subtly
 * wrong would be whichever was written second -- the argument `link.ts` already makes about
 * resolution writes.
 *
 * ## One key space, deliberately
 *
 * Both callers write `kind = "vendor"` against the same normalized key, so a later
 * confirmation replaces an earlier one rather than sitting beside it. `identify.ts` reads
 * the whole table and cannot tell the two sources apart, which is correct: invariant 18
 * draws no distinction between one confirmation and another.
 */

import { and, eq } from "drizzle-orm";

import { businessKnowledge } from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";

/** What a confirmed fact about a payee is filed under. §7's examples are all about one. */
export const VENDOR = "vendor";

/**
 * Write the fact, or replace the one that is there.
 *
 * `business_knowledge_identity_idx` makes `(workspace, kind, key)` unique, so a user
 * changing their mind about a vendor replaces what we knew rather than leaving two
 * contradictory facts for a later run to choose between.
 */
export async function learn(
  scope: WorkspaceScope,
  kind: string,
  key: string,
  value: unknown,
): Promise<void> {
  const [existing] = await scope.select(
    businessKnowledge,
    and(eq(businessKnowledge.kind, kind), eq(businessKnowledge.key, key)),
  );

  if (existing) {
    await scope.update(
      businessKnowledge,
      { value, confirmedAt: new Date() },
      eq(businessKnowledge.id, existing.id),
    );
    return;
  }

  await scope.insert(businessKnowledge, { kind, key, value });
}

/**
 * A payee's name, reduced to what two spellings of it have in common.
 *
 * Case and punctuation only -- the same discipline `canonical_transactions`'
 * `descriptionNormalized` keeps, and for the same reason: this is formatting, never
 * interpretation. "Anthropic" and "ANTHROPIC." are one vendor; deciding that "Anthropic"
 * and "Claude" are is a judgment, and it belongs to the model and the user, not here.
 *
 * Returns null for a name that reduces to nothing -- a narration that was a reference
 * number and nothing else. The caller treats that as "there is nothing here to generalize
 * over", which is not the same as having learned something empty.
 */
export function normalizeVendor(name: string | null): string | null {
  if (!name) return null;

  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  return normalized.length === 0 ? null : normalized;
}
