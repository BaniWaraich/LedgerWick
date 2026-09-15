/**
 * Step 3 and Step 3a of `docs/workflows/upload-statement.md`.
 *
 * Decide whether the uploaded file is a bank statement, read what it says about itself,
 * and bind it to exactly one Bank Account in the workspace — creating that account, or
 * handing the question to the user when the document does not answer it.
 *
 * Runs inside a background workflow, so every branch ends in persisted state and none of
 * them waits for a person (`docs/architecture.md §12C`). The model is a parameter rather
 * than an import, so the branches below can be tested without one.
 */

import { and, eq } from "drizzle-orm";

import { bankAccounts, bankStatements } from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";
import type { Inference } from "../ai/model";
import type { Identification } from "../ai/prompts/identify-statement.v1";
import type { DocumentStore } from "../storage/document-store";

/** The model call, as this module needs it. Injected so the branches are testable. */
export type IdentifyDocument = (document: {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
}) => Promise<Inference<Identification>>;

/** Human-readable failures. `§9`: an explanation, not a technical error. */
const NOT_A_STATEMENT =
  "This doesn't look like a bank statement. Please upload a statement downloaded from your bank.";
const NO_PERIOD =
  "We couldn't tell which dates this statement covers, so we can't use it. Please upload a copy that shows the statement period.";
const UNREADABLE = "We couldn't read this statement. Please try uploading a clearer copy.";
const BYTES_MISSING = "We couldn't open the file that was uploaded. Please upload it again.";

/**
 * The currency a new account is created in.
 *
 * Phase 1 is India-first and the bound account is what determines how a statement's
 * amounts are read (Step 3a). A multi-currency business is a real case and not this
 * phase's; when it arrives, it arrives as a question asked at account creation rather
 * than as a guess made here.
 */
const DEFAULT_CURRENCY = "INR";

/** States from which identification is still the right thing to do. */
const IDENTIFIABLE = new Set(["UPLOADING", "IDENTIFYING"]);

/**
 * Find the workspace's account for this identifier, or create it.
 *
 * Every read goes through the scope, so the search cannot leave the workspace — Step 3a
 * calls that absolute, and `tests/db/workspace-isolation.test.ts` attacks it. Matching is
 * on bank plus identifier, which is the schema's own uniqueness rule for an account.
 */
async function bindAccount(
  scope: WorkspaceScope,
  bankName: string,
  accountIdentifier: string,
  accountType: string | null,
): Promise<string> {
  const existing = await scope.selectOne(
    bankAccounts,
    and(eq(bankAccounts.bankName, bankName), eq(bankAccounts.accountIdentifier, accountIdentifier)),
  );
  if (existing) return existing.id;

  const [created] = await scope.insert(bankAccounts, {
    bankName,
    accountIdentifier,
    accountType,
    currency: DEFAULT_CURRENCY,
  });
  return created.id;
}

/** Record a failure as state. `§15`: failures are state, never silently discarded. */
async function fail(scope: WorkspaceScope, statementId: string, reason: string): Promise<void> {
  await scope.update(
    bankStatements,
    { state: "FAILED", failureReason: reason },
    eq(bankStatements.id, statementId),
  );
}

/**
 * Identify one statement and bind it, or stop somewhere the user can act.
 *
 * Idempotent by state rather than by a flag: a statement that has moved past
 * identification is left exactly as it is, so a replayed event, a retry, or two deliveries
 * of the same event cannot create a second account or overwrite a binding.
 */
export async function identifyStatement(
  scope: WorkspaceScope,
  store: DocumentStore,
  identify: IdentifyDocument,
  statementId: string,
): Promise<void> {
  const statement = await scope.selectOne(bankStatements, eq(bankStatements.id, statementId));
  // Not this workspace's, or already gone. Nothing to do and nothing to report: the scope
  // has already decided the caller may not see it.
  if (!statement) return;
  if (!IDENTIFIABLE.has(statement.state)) return;

  await scope.update(bankStatements, { state: "IDENTIFYING" }, eq(bankStatements.id, statementId));

  const object = await store.get(statement.storageRef);
  if (!object) {
    // The row points at bytes that are not there. Nothing downstream can proceed, and the
    // user can only be asked to upload it again.
    await fail(scope, statementId, BYTES_MISSING);
    return;
  }

  const result = await identify({
    bytes: new Uint8Array(await new Response(object.stream).arrayBuffer()),
    mimeType: statement.mimeType,
    filename: statement.filename,
  });

  if (!result.ok) {
    await fail(scope, statementId, UNREADABLE);
    return;
  }

  const identification = result.value;

  if (!identification.isBankStatement) {
    await fail(scope, statementId, NOT_A_STATEMENT);
    return;
  }

  // Step 3: "The statement period is required. A statement whose period cannot be
  // determined cannot be used for coverage tracking and must be treated as FAILED rather
  // than silently accepted."
  if (!identification.periodStart || !identification.periodEnd) {
    await fail(scope, statementId, NO_PERIOD);
    return;
  }

  // What the document said, kept whether or not it is enough to bind on.
  const identified = {
    identifiedBankName: identification.bankName,
    identifiedAccountIdentifier: identification.accountIdentifier,
    identifiedAccountType: identification.accountType,
    periodStart: identification.periodStart,
    periodEnd: identification.periodEnd,
  };

  // Step 3a: "A statement is never bound to an account by inference alone when the
  // identifier is absent. If the document does not state which account it covers, the user
  // chooses." The bank name alone is not enough — a business may hold two accounts at one
  // bank.
  if (!identification.bankName || !identification.accountIdentifier) {
    await scope.update(
      bankStatements,
      { ...identified, state: "NEEDS_ACCOUNT" },
      eq(bankStatements.id, statementId),
    );
    return;
  }

  const bankAccountId = await bindAccount(
    scope,
    identification.bankName,
    identification.accountIdentifier,
    identification.accountType,
  );

  await scope.update(
    bankStatements,
    { ...identified, bankAccountId, state: "PARSING" },
    eq(bankStatements.id, statementId),
  );
}
