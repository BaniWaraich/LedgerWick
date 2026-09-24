"use server";

/**
 * The decision the user made, on its way to being applied.
 *
 * spec: docs/workflows/invoice-match-review.md §5, §6, §7
 *
 * Thin, like `reconciliation/actions.ts` and `documents/actions.ts`: the scope comes from
 * the session, the work is a function in `src/review`, and what comes back is either a
 * sentence for the form or a revalidated page.
 *
 * One action for every outcome rather than four. The screen is one form with several
 * submit buttons -- the idiom `questions/answer-form.tsx` already uses -- so the decision
 * arrives as a value in the form data, and routing on it here keeps the branch in one
 * readable place instead of four near-identical actions.
 *
 * "Upload the document" is not here, and needs no server code: it is a link to
 * `/documents/upload?transaction=…`, which already binds the transaction at intake and
 * resolves `USER_LINKED` when matching short-circuits on it.
 */

import { revalidatePath } from "next/cache";

import { requireScope } from "../../../../auth/workspace";
import {
  confirmCandidate,
  linkExistingDocument,
  markNotRequired,
  rejectAllCandidates,
  type ResolveOutcome,
} from "../../../../review/resolve";

export type ReviewFormState = { error?: string };

/** What the buttons on the review screen submit. */
const DECISIONS = [
  "CONFIRM",
  "LINK_EXISTING",
  "REJECT_ALL",
  "NOT_REQUIRED_PAYMENT",
  "NOT_REQUIRED_VENDOR",
] as const;

type Decision = (typeof DECISIONS)[number];

function isDecision(value: string): value is Decision {
  return (DECISIONS as readonly string[]).includes(value);
}

export async function resolveRequirementAction(
  _previous: ReviewFormState,
  formData: FormData,
): Promise<ReviewFormState> {
  const scope = await requireScope();

  const requirementId = String(formData.get("requirementId") ?? "");
  const decision = String(formData.get("decision") ?? "");

  if (!isDecision(decision)) return { error: "Choose one of the options." };

  let outcome: ResolveOutcome;

  switch (decision) {
    case "CONFIRM": {
      const invoiceId = String(formData.get("invoiceId") ?? "");
      if (invoiceId === "") return { error: "Choose the document this payment was for." };
      outcome = await confirmCandidate(scope, requirementId, invoiceId);
      break;
    }
    case "LINK_EXISTING": {
      const documentId = String(formData.get("documentId") ?? "");
      if (documentId === "") return { error: "Choose a document to link." };
      outcome = await linkExistingDocument(scope, requirementId, documentId);
      break;
    }
    case "REJECT_ALL":
      outcome = await rejectAllCandidates(scope, requirementId);
      break;
    case "NOT_REQUIRED_PAYMENT":
      outcome = await markNotRequired(scope, requirementId, "THIS_PAYMENT");
      break;
    case "NOT_REQUIRED_VENDOR":
      outcome = await markNotRequired(scope, requirementId, "THIS_VENDOR");
      break;
  }

  if (!outcome.resolved) return { error: outcome.reason };

  revalidatePath("/reconciliation");
  revalidatePath(`/reconciliation/${requirementId}`);

  return {};
}
