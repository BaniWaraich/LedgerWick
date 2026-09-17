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

import { and, eq, sql } from "drizzle-orm";

import { bankAccounts, bankStatements } from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";
import type { Inference } from "../ai/model";
import type { Identification } from "../ai/prompts/identify-statement.v2";
import { currencyFor } from "../money/currencies";
import { accountIdentifierKey, bankNameKey } from "./account-identity";
import type { DocumentStore } from "../storage/document-store";

/** The two kinds of account a statement can belong to. Mirrors `accountKindEnum`. */
type AccountKind = (typeof bankAccounts.$inferInsert)["accountKind"] & {};

/** The model call, as this module needs it. Injected so the branches are testable. */
export type IdentifyDocument = (document: {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
}) => Promise<Inference<Identification>>;

/** Human-readable failures. `§9`: an explanation, not a technical error. */
const NOT_A_STATEMENT =
  "This doesn't look like a bank or credit card statement. Please upload a statement downloaded from your bank or card issuer.";
const UNREADABLE = "We couldn't read this statement. Please try uploading a clearer copy.";
const BYTES_MISSING = "We couldn't open the file that was uploaded. Please upload it again.";
/*
 * Every retry is spent and the statement is still in IDENTIFYING.
 *
 * The wording is deliberately about us rather than about their document: nothing here
 * suggests the statement was at fault, because it was not — `inferStructure` rethrows
 * infrastructure failures precisely so they are not reported as an unreadable document.
 */
const OUR_FAULT =
  "Something went wrong on our side while reading this statement. Please try uploading it again.";

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
  account: {
    bankName: string;
    accountIdentifier: string;
    accountType: string | null;
    accountKind: AccountKind;
    currency: string;
  },
): Promise<string> {
  // Compared the way `bank_accounts_identity_idx` compares them, not literally. A model
  // reporting "AXIS BANK" where it once reported "Axis Bank" is describing the same account,
  // and a literal match here would miss it and then create a second one.
  const existing = await scope.selectOne(
    bankAccounts,
    and(
      sql`lower(${bankAccounts.bankName}) = ${bankNameKey(account.bankName)}`,
      sql`upper(${bankAccounts.accountIdentifier}) = ${accountIdentifierKey(account.accountIdentifier)}`,
    ),
  );
  /*
   * Found, and returned exactly as it is.
   *
   * Nothing this statement says updates the account — not its currency, not its kind. Step
   * 3a: an account's currency is established when it is created and never rewritten, because
   * canonical transactions carry a currency of their own and re-denominating an account
   * re-denominates movements already recorded against it. A statement that disagrees with
   * its account is a question for a person, not a correction to apply here.
   */
  if (existing) return existing.id;

  const [created] = await scope.insert(bankAccounts, {
    bankName: account.bankName,
    accountIdentifier: account.accountIdentifier,
    accountType: account.accountType,
    accountKind: account.accountKind,
    currency: account.currency,
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
 * Give up on a statement whose workflow exhausted its retries.
 *
 * Called from the background workflow's terminal failure handler rather than from
 * `identifyStatement` itself: getting here means the run never completed — a gateway
 * outage, a lapsed card, an expired key — so there is no branch inside identification that
 * could have recorded it. Without this the row would sit in `IDENTIFYING` forever and the
 * polling UI would spin on it, which is the "failure swallowed rather than recorded as
 * state" that `docs/definition-of-done.md` forbids.
 *
 * Scoped like everything else here, so a tampered event carrying another workspace's
 * statement id changes nothing.
 */
export async function recordTerminalFailure(
  scope: WorkspaceScope,
  statementId: string,
): Promise<void> {
  await fail(scope, statementId, OUR_FAULT);
}

/**
 * What identification settled, for the caller that has to decide what happens next.
 *
 * `BOUND` is the only outcome with anything left to do: the statement is in `PARSING` and
 * feature D takes it from there. The others have all ended in persisted state, and the
 * shell sending the event needs to know which is which without re-reading the row.
 */
export type IdentificationOutcome = "BOUND" | "NEEDS_ACCOUNT" | "FAILED" | "ALREADY_SETTLED";

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
): Promise<IdentificationOutcome> {
  const statement = await scope.selectOne(bankStatements, eq(bankStatements.id, statementId));
  // Not this workspace's, or already gone. Nothing to do and nothing to report: the scope
  // has already decided the caller may not see it.
  if (!statement) return "ALREADY_SETTLED";
  if (!IDENTIFIABLE.has(statement.state)) return "ALREADY_SETTLED";

  await scope.update(bankStatements, { state: "IDENTIFYING" }, eq(bankStatements.id, statementId));

  const object = await store.get(statement.storageRef);
  if (!object) {
    // The row points at bytes that are not there. Nothing downstream can proceed, and the
    // user can only be asked to upload it again.
    await fail(scope, statementId, BYTES_MISSING);
    return "FAILED";
  }

  const result = await identify({
    bytes: new Uint8Array(await new Response(object.stream).arrayBuffer()),
    mimeType: statement.mimeType,
    filename: statement.filename,
  });

  if (!result.ok) {
    await fail(scope, statementId, UNREADABLE);
    return "FAILED";
  }

  const identification = result.value;

  if (identification.documentKind === "SOMETHING_ELSE") {
    await fail(scope, statementId, NOT_A_STATEMENT);
    return "FAILED";
  }

  const accountKind: AccountKind =
    identification.documentKind === "CREDIT_CARD_STATEMENT" ? "CREDIT_CARD" : "BANK_ACCOUNT";

  /*
   * The period, only if the document declared one.
   *
   * `0008`: a statement that declares none is no longer failed — it proceeds with no period
   * and feature D derives the range from the transactions it extracts. Both dates or
   * neither: half a range is not a period, and a model that returned only one end has told
   * us nothing we can record as coverage.
   */
  const declaresPeriod = Boolean(identification.periodStart && identification.periodEnd);

  // What the document said, kept whether or not it is enough to bind on. The currency is
  // kept raw, including one we do not support, because it is the only evidence of why a
  // statement ended up waiting for a person.
  const identified = {
    identifiedBankName: identification.bankName,
    identifiedAccountIdentifier: identification.accountIdentifier,
    identifiedAccountType: identification.accountType,
    identifiedAccountKind: accountKind,
    identifiedCurrency: identification.currency,
    periodStart: declaresPeriod ? identification.periodStart : null,
    periodEnd: declaresPeriod ? identification.periodEnd : null,
    periodSource: declaresPeriod ? ("DECLARED" as const) : null,
  };

  const currency = currencyFor(identification.currency);

  /*
   * Step 3a: "A statement is never bound to an account by inference alone when the
   * identifier is absent. If the document does not state which account it covers, the user
   * chooses." The bank name alone is not enough — a business may hold two accounts at one
   * bank.
   *
   * An unknown currency stops us here for the same reason. It is not cosmetic: it is the
   * unit every amount in feature D is read in, and an account's currency is permanent once
   * set. Defaulting it would bake a guess into the one field nothing later can correct —
   * which is how a Bank of Ireland account came to be denominated in rupees.
   */
  if (!identification.bankName || !identification.accountIdentifier || !currency) {
    await scope.update(
      bankStatements,
      { ...identified, state: "NEEDS_ACCOUNT" },
      eq(bankStatements.id, statementId),
    );
    return "NEEDS_ACCOUNT";
  }

  const bankAccountId = await bindAccount(scope, {
    bankName: identification.bankName,
    accountIdentifier: identification.accountIdentifier,
    accountType: identification.accountType,
    accountKind,
    currency: currency.code,
  });

  await scope.update(
    bankStatements,
    { ...identified, bankAccountId, state: "PARSING" },
    eq(bankStatements.id, statementId),
  );

  // Reported rather than published from here, so this module keeps having no dependency on
  // Inngest at all -- the same reason the model is a parameter. The shell sends the event.
  return "BOUND";
}
