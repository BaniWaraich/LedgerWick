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
import { headers } from "next/headers";

import { requireScope } from "../../../auth/workspace";
import { linkOrigin, requestExport } from "../../../export/exports";
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

/**
 * Ask for an Excel export of the whole reconciliation.
 *
 * `architecture.md §12B`: this records the request and returns. The file is built by the
 * `generate-export` workflow; nothing here reads the reconciliation or writes a file, and
 * the page shows the export's state from the database until it is ready.
 *
 * The link origin is this request's own (`docs/decisions/0017`): the browser's `Origin`
 * header, which Next already checks against the host before running a server action.
 */
export async function requestExportAction(): Promise<void> {
  const scope = await requireScope();
  const incoming = await headers();
  const origin =
    linkOrigin(incoming.get("origin")) ??
    linkOrigin(`${incoming.get("x-forwarded-proto") ?? "https"}://${incoming.get("host")}`);

  // No origin means no link in the file could be right. Refusing is better than a file
  // full of links to nowhere; a browser posting a form always sends one.
  if (!origin) throw new Error("Cannot tell where this application is served from");

  // Refused only before any run exists, and the page offers no button then.
  await requestExport(scope, origin, (event) => inngest.send(event));

  revalidatePath("/reconciliation");
}
