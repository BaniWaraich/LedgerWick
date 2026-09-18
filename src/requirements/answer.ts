/**
 * Turning an answer into something the system will not have to ask again.
 *
 * spec: docs/workflows/identifying-invoices.md §5 Step 5 and §7
 *
 * §5 Step 5: "The user's answer becomes Business Knowledge where it generalizes beyond the
 * transaction that prompted it." `docs/domain-model.md` invariant 18 is the other half --
 * Business Knowledge is created ONLY from a confirmed decision, never from an inference. An
 * answer the user actually typed is the confirmation; nothing else in this system is.
 *
 * ## What is learned, and what is merely recorded
 *
 * The answer is always recorded against the question. It becomes Business Knowledge only
 * when there is a payee to attach it to, because the payee is what makes it general. An
 * answer with nothing to key on -- a payment whose narration was a reference number and
 * nothing else -- still closes the question, and still lets the next run judge that one
 * transaction. It just does not teach us anything about the next payment.
 *
 * Keying on the normalized payee rather than the narration is the whole point:
 * `UPI/XYZ SERVICES/9922/ORDER` and `NEFT-DR-XYZ SERVICES` are the same vendor and share no
 * substring worth matching, so knowledge keyed on the narration would be true of exactly
 * one payment and would quietly never fire again.
 *
 * ## Why answering starts a run rather than deciding on the spot
 *
 * It would be easy to read "A business vendor" and create a requirement from it. That means
 * writing a table mapping option text to a decision -- inventing product, and inventing it
 * in the one place the workflow explicitly leaves to judgment.
 *
 * Instead the answer is stored as fact and the workspace is reconciled again. The
 * transaction still carries no requirement, so `identify.ts` sees it as new, and this time
 * the confirmed fact is in front of the model when it decides. The user's answer is used by
 * exactly the thing that asked for it.
 */

import { and, eq, isNull } from "drizzle-orm";

import { businessKnowledge, clarificationQuestions } from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";

/** What a confirmed answer is filed under. §7's examples are all about a payee. */
const VENDOR = "vendor";

export interface AnswerOutcome {
  /** False when the question was already answered, or is not this workspace's. */
  recorded: boolean;
  /** Whether anything was learned that applies beyond this one transaction. */
  learned: boolean;
}

/**
 * Record what the user said, and keep it if it generalizes.
 *
 * Answering twice is not an error and not a second fact: the second call finds the question
 * already answered and changes nothing, which is what makes a double-submitted form
 * harmless.
 */
export async function recordAnswer(
  scope: WorkspaceScope,
  questionId: string,
  answer: string,
): Promise<AnswerOutcome> {
  const trimmed = answer.trim();
  if (trimmed.length === 0) return { recorded: false, learned: false };

  const [question] = await scope.update(
    clarificationQuestions,
    { answer: trimmed, answeredAt: new Date() },
    and(
      eq(clarificationQuestions.id, questionId),
      // Only an open question. A second submission of the same form finds nothing to
      // update and returns without writing a second fact.
      isNull(clarificationQuestions.answeredAt),
    ),
  );

  if (!question) return { recorded: false, learned: false };

  const key = normalizeVendor(question.vendorGuess);
  if (!key) return { recorded: true, learned: false };

  await learn(scope, key, {
    vendor: question.vendorGuess,
    answer: trimmed,
    question: question.question,
  });

  return { recorded: true, learned: true };
}

/**
 * Write the fact, or replace the one that is there.
 *
 * `business_knowledge_identity_idx` makes `(workspace, kind, key)` unique, so a user
 * changing their mind about a vendor replaces what we knew rather than leaving two
 * contradictory facts for a later run to choose between.
 */
async function learn(scope: WorkspaceScope, key: string, value: unknown): Promise<void> {
  const [existing] = await scope.select(
    businessKnowledge,
    and(eq(businessKnowledge.kind, VENDOR), eq(businessKnowledge.key, key)),
  );

  if (existing) {
    await scope.update(
      businessKnowledge,
      { value, confirmedAt: new Date() },
      eq(businessKnowledge.id, existing.id),
    );
    return;
  }

  await scope.insert(businessKnowledge, { kind: VENDOR, key, value });
}

/**
 * A payee's name, reduced to what two spellings of it have in common.
 *
 * Case and punctuation only -- the same discipline `canonical_transactions`'
 * `descriptionNormalized` keeps, and for the same reason: this is formatting, never
 * interpretation. "Anthropic" and "ANTHROPIC." are one vendor; deciding that "Anthropic"
 * and "Claude" are is a judgment, and it belongs to the model and the user, not here.
 */
function normalizeVendor(name: string | null): string | null {
  if (!name) return null;

  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  return normalized.length === 0 ? null : normalized;
}
