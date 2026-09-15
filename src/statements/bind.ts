/**
 * The user answering the question `NEEDS_ACCOUNT` asks.
 *
 * Step 3a: when the document does not say which account it covers, the user chooses an
 * existing Bank Account or creates one. This is the other half of that branch — the half
 * that runs in a request, because a person is now present.
 *
 * Both paths go through the scope, so a chosen account id coming from a form is checked
 * against the workspace rather than trusted: the definition of done requires exactly that
 * of any identifier arriving from a client.
 */

import { eq } from "drizzle-orm";

import { bankAccounts, bankStatements } from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";

/** The currency a user-created account is opened in. See `identify.ts`. */
const DEFAULT_CURRENCY = "INR";

export class StatementNotWaitingError extends Error {
  constructor() {
    super("That statement is not waiting for an account");
    this.name = "StatementNotWaitingError";
  }
}

export class UnknownBankAccountError extends Error {
  constructor() {
    super("No such bank account in this workspace");
    this.name = "UnknownBankAccountError";
  }
}

/** The accounts a user may bind a statement to. Scoped, so the list cannot leak. */
export async function accountsForBinding(scope: WorkspaceScope) {
  return scope.select(bankAccounts);
}

/**
 * Bind a waiting statement to an account, and let parsing proceed.
 *
 * Only a statement in `NEEDS_ACCOUNT` may be bound. That guard is what stops a stale form,
 * a double submit, or a back button from rebinding a statement that is already parsed —
 * the same state-based idempotency identification uses.
 */
export async function bindStatementToAccount(
  scope: WorkspaceScope,
  statementId: string,
  choice: { bankAccountId: string } | { bankName: string; accountIdentifier: string },
): Promise<void> {
  const statement = await scope.selectOne(bankStatements, eq(bankStatements.id, statementId));
  if (!statement || statement.state !== "NEEDS_ACCOUNT") throw new StatementNotWaitingError();

  let bankAccountId: string;

  if ("bankAccountId" in choice) {
    // Checked against the workspace, not taken on the form's word.
    const account = await scope.selectOne(bankAccounts, eq(bankAccounts.id, choice.bankAccountId));
    if (!account) throw new UnknownBankAccountError();
    bankAccountId = account.id;
  } else {
    const [created] = await scope.insert(bankAccounts, {
      bankName: choice.bankName,
      accountIdentifier: choice.accountIdentifier,
      accountType: statement.identifiedAccountType,
      currency: DEFAULT_CURRENCY,
    });
    bankAccountId = created.id;
  }

  await scope.update(
    bankStatements,
    { bankAccountId, state: "PARSING" },
    eq(bankStatements.id, statementId),
  );
}
