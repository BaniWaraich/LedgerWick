"use server";

/**
 * Answering a question the system could not answer for itself.
 *
 * Thin, like `src/app/(workspace)/statements/actions.ts`: the scope comes from the session,
 * the work is a function in `src/requirements`, and what comes back is a revalidated page.
 *
 * Answering starts a reconciliation run. `answer.ts` explains why that is better than
 * deciding here -- in short, the transaction still carries no requirement, so the next run
 * treats it as new and judges it with the confirmed fact in hand. The user's answer is used
 * by exactly the thing that asked for it, and no table mapping option text to a decision
 * has to be invented.
 */

import { revalidatePath } from "next/cache";

import { requireScope } from "../../../auth/workspace";
import { inngest, reconciliationRequested } from "../../../inngest/client";
import { recordAnswer } from "../../../requirements/answer";

export type AnswerFormState = { error?: string };

export async function answerQuestionAction(
  _previous: AnswerFormState,
  formData: FormData,
): Promise<AnswerFormState> {
  const scope = await requireScope();

  const questionId = String(formData.get("questionId") ?? "");
  const answer = String(formData.get("answer") ?? "");

  if (answer.trim() === "") return { error: "Choose one of the answers." };

  const outcome = await recordAnswer(scope, questionId, answer);

  // A stale form, a double submit, or a back button: the question has already been
  // answered, so there is nothing to fix and nothing to apologize for.
  if (outcome.recorded) {
    await inngest.send(
      reconciliationRequested.create({
        workspaceId: scope.workspaceId,
        userId: scope.userId,
      }),
    );
  }

  revalidatePath("/reconciliation/questions");
  revalidatePath("/reconciliation");

  return {};
}
