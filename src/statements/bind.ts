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

import { and, eq, sql } from "drizzle-orm";

import { bankAccounts, bankStatements } from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";
import { currencyFor } from "../money/currencies";
import { accountIdentifierKey, bankNameKey } from "./account-identity";

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

/**
 * The chosen currency is not one this system can count in.
 *
 * A currency arriving from a form is a client value and gets the same treatment as a chosen
 * account id: checked, never trusted. `src/money/currencies.ts` explains why the list is
 * short — an account opened in a currency whose minor-unit exponent we do not know cannot
 * have its amounts read correctly, so accepting one would be worse than refusing it.
 */
export class UnsupportedCurrencyError extends Error {
  constructor() {
    super("That currency is not supported");
    this.name = "UnsupportedCurrencyError";
  }
}

/**
 * Sends the event that starts parsing. Injected, exactly as `intake.ts` injects its own.
 *
 * This half of Step 3a runs in a request rather than in a workflow, so there is no `step`
 * to send through. Keeping it a parameter is what lets the binding rules be tested without
 * Inngest, and it means a send that fails leaves the statement bound and in `PARSING` --
 * recoverable -- rather than rolling back the user's answer.
 */
export type PublishBound = (statementId: string) => Promise<void>;

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
  choice:
    { bankAccountId: string } | { bankName: string; accountIdentifier: string; currency: string },
  publish: PublishBound,
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
    // Checked against what this system can count in, not taken on the form's word — the
    // same treatment a chosen account id gets two lines above.
    const currency = currencyFor(choice.currency);
    if (!currency) throw new UnsupportedCurrencyError();

    /*
     * "Create" can turn out to mean "the one you already have".
     *
     * A user typing `axis bank` where `AXIS BANK` exists is naming that account, not asking
     * for a second one — and `bank_accounts_identity_idx` now agrees, so inserting would
     * raise a unique violation rather than quietly duplicating. Binding to what is there is
     * both what they meant and the only outcome that keeps Step 5a's deduplication intact.
     *
     * The existing account keeps its currency, exactly as it does in `identify.ts`: a
     * currency typed into this form does not re-denominate an account that already has
     * transactions coming.
     */
    const existing = await scope.selectOne(
      bankAccounts,
      and(
        sql`lower(${bankAccounts.bankName}) = ${bankNameKey(choice.bankName)}`,
        sql`upper(${bankAccounts.accountIdentifier}) = ${accountIdentifierKey(choice.accountIdentifier)}`,
      ),
    );

    if (existing) {
      bankAccountId = existing.id;
    } else {
      const [created] = await scope.insert(bankAccounts, {
        bankName: choice.bankName,
        accountIdentifier: choice.accountIdentifier,
        accountType: statement.identifiedAccountType,
        // What the document said it was, where it said anything. A user correcting the
        // account is not also telling us the document was a card when it was not.
        accountKind: statement.identifiedAccountKind ?? "BANK_ACCOUNT",
        currency: currency.code,
      });
      bankAccountId = created.id;
    }
  }

  await scope.update(
    bankStatements,
    { bankAccountId, state: "PARSING" },
    eq(bankStatements.id, statementId),
  );

  // After the state is persisted, never before. The database is the source of truth for
  // where this statement has got to (`architecture.md §2.2`), and an event sent first would
  // race a workflow against the row it is about to read.
  await publish(statementId);
}
