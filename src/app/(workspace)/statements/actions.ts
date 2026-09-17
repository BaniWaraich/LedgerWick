"use server";

/**
 * What the user can do to a statement from the batch screen.
 *
 * Thin, like `src/app/workspaces/actions.ts`: the scope comes from the session, the work
 * is a function in `src/statements`, and what comes back is either a message for the form
 * or a revalidated page.
 */

import { revalidatePath } from "next/cache";

import { requireScope } from "../../../auth/workspace";
import { inngest, statementBound } from "../../../inngest/client";
import {
  bindStatementToAccount,
  StatementNotWaitingError,
  UnknownBankAccountError,
  UnsupportedCurrencyError,
} from "../../../statements/bind";

export type BindFormState = { error?: string };

export async function bindAccountAction(
  _previous: BindFormState,
  formData: FormData,
): Promise<BindFormState> {
  const scope = await requireScope();

  const statementId = String(formData.get("statementId") ?? "");
  const existingAccountId = String(formData.get("bankAccountId") ?? "");
  const bankName = String(formData.get("bankName") ?? "").trim();
  const accountIdentifier = String(formData.get("accountIdentifier") ?? "").trim();
  const currency = String(formData.get("currency") ?? "")
    .trim()
    .toUpperCase();

  const choice =
    existingAccountId !== ""
      ? { bankAccountId: existingAccountId }
      : { bankName, accountIdentifier, currency };

  if (!("bankAccountId" in choice) && (choice.bankName === "" || choice.accountIdentifier === "")) {
    return { error: "Enter both the bank and the account number." };
  }

  try {
    await bindStatementToAccount(scope, statementId, choice, async (bound) => {
      await inngest.send(
        statementBound.create({
          statementId: bound,
          workspaceId: scope.workspaceId,
          userId: scope.userId,
        }),
      );
    });
  } catch (error) {
    if (error instanceof UnknownBankAccountError) {
      return { error: "Choose an account from this workspace." };
    }
    if (error instanceof UnsupportedCurrencyError) {
      return { error: "Choose a currency from the list." };
    }
    if (error instanceof StatementNotWaitingError) {
      // A stale form, a double submit, or a back button. The statement has already moved
      // on, so there is nothing to fix and nothing to apologize for.
      return {};
    }
    throw error;
  }

  revalidatePath("/statements");
  return {};
}
