/**
 * Steps 4 to 5b of `docs/workflows/upload-statement.md`.
 *
 * Turn a bound statement into statement lines, check them against the statement's own
 * balances, promote them to canonical transactions, and record the period as coverage.
 *
 * The counterpart to `identify.ts`, and written the same way: a function over a scope, a
 * store and injected model calls, so that every branch can be tested without Inngest and
 * without a provider. It runs inside a background workflow, so every branch ends in
 * persisted state and none of them waits for a person (`docs/architecture.md §12C`).
 *
 * ## The one asymmetry that matters
 *
 * `docs/decisions/0003` gives the two paths different treatment when the balances do not
 * agree, and this is where that lives:
 *
 * - On CSV and text PDF a mismatch suggests the **mapping** may be wrong, and re-deriving
 *   it is reasonable. So the mapping is asked for once more, told what did not add up, and
 *   whichever attempt reconciles is kept.
 * - On scanned input a mismatch suggests the **values** may be wrong, and no amount of
 *   retrying makes a misread digit correct. It goes straight to `DISCREPANCY` and is never
 *   retried into acceptance.
 *
 * ## Idempotency
 *
 * A background workflow may run twice (`§16`). This one is idempotent by the statement's
 * own state and by its lines: a statement that has already reached `COMPLETED` is left
 * alone, and a statement whose lines already exist has them read back rather than written
 * again. Promotion is idempotent in its own right — see `promote.ts`.
 */

import { eq } from "drizzle-orm";

import { bankAccounts, bankStatements, statementLines } from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";
import { currencyFor, type Currency } from "../money/currencies";
import type { ColumnMapping } from "../ai/prompts/map-statement-columns.v1";
import type { DocumentStore } from "../storage/document-store";
import type { Grid } from "./csv";
import type { MapColumns, ReadScanned } from "./parse-contracts";
import { promoteStatement } from "./promote";
import { linesFromScanned } from "./scanned";
import { readStatementSource, type ExtractPdfText } from "./source";
import {
  balancesFromGrid,
  balancesFromScanned,
  validate,
  type Balances,
  type Validation,
} from "./validate";
import { walkStatement, type Walk } from "./walk";

/** Human-readable failures. `§9`: an explanation, not a technical error. */
const BYTES_MISSING = "We couldn't open the file that was uploaded. Please upload it again.";
const NO_ACCOUNT = "We couldn't tell which account this statement covers. Please upload it again.";
const UNKNOWN_CURRENCY =
  "This account is held in a currency we can't read amounts in yet. Please get in touch.";
const STRUCTURE_UNREADABLE =
  "We couldn't work out how this statement is laid out. Please upload a clearer copy, or export it as a CSV.";
const NO_TRANSACTIONS =
  "We couldn't find any transactions in this statement. Please check it covers a period with activity.";
const OUR_FAULT =
  "Something went wrong on our side while reading this statement. Please try uploading it again.";

/** States from which parsing is still the right thing to do. */
const PARSEABLE = new Set(["PARSING", "VALIDATING"]);

/** What parsing needs from the world. Injected, so the branches below are testable. */
export interface ParseDependencies {
  readonly store: DocumentStore;
  readonly extractPdfText: ExtractPdfText;
  readonly mapColumns: MapColumns;
  readonly readScanned: ReadScanned;
}

/** One attempt at reading a statement, and how well it reconciled. */
interface Attempt {
  readonly walk: Walk;
  readonly balances: Balances;
  readonly validation: Validation;
  readonly mapping: ColumnMapping | null;
}

/**
 * Give up on a statement whose workflow exhausted its retries.
 *
 * Called from the workflow's terminal failure handler, exactly as `recordTerminalFailure` is
 * in `identify.ts`: getting here means the run never completed, so no branch inside parsing
 * could have recorded it, and without this the row would sit in `PARSING` forever while the
 * polling UI spun on it.
 */
export async function recordTerminalParseFailure(
  scope: WorkspaceScope,
  statementId: string,
): Promise<void> {
  await fail(scope, statementId, OUR_FAULT);
}

/** Parse one bound statement through to `COMPLETED`, or to `FAILED` with a reason. */
export async function parseStatement(
  scope: WorkspaceScope,
  deps: ParseDependencies,
  statementId: string,
): Promise<void> {
  const statement = await scope.selectOne(bankStatements, eq(bankStatements.id, statementId));
  // Not this workspace's, or already gone. The scope has decided the caller may not see it.
  if (!statement) return;
  if (!PARSEABLE.has(statement.state)) return;

  if (!statement.bankAccountId) {
    // Step 3a binds every statement before it reaches PARSING, so this is a broken row
    // rather than a document problem.
    await fail(scope, statementId, NO_ACCOUNT);
    return;
  }

  const account = await scope.selectOne(bankAccounts, eq(bankAccounts.id, statement.bankAccountId));
  if (!account) {
    await fail(scope, statementId, NO_ACCOUNT);
    return;
  }

  const currency = currencyFor(account.currency);
  if (!currency) {
    await fail(scope, statementId, UNKNOWN_CURRENCY);
    return;
  }

  const object = await deps.store.get(statement.storageRef);
  if (!object) {
    await fail(scope, statementId, BYTES_MISSING);
    return;
  }

  const bytes = new Uint8Array(await new Response(object.stream).arrayBuffer());
  const source = await readStatementSource(bytes, deps.extractPdfText);

  const attempt =
    source.path === "TEXT"
      ? await readAsText(deps, source.grid, currency)
      : await readAsScan(deps, source.bytes, currency);

  if (!attempt) {
    await fail(scope, statementId, STRUCTURE_UNREADABLE);
    return;
  }

  if (attempt.walk.lines.length === 0) {
    // Nothing to promote, nothing to derive a period from, and §7 requires transactions for
    // a statement to be considered successfully processed at all.
    await fail(scope, statementId, NO_TRANSACTIONS);
    return;
  }

  await scope.update(bankStatements, { state: "VALIDATING" }, eq(bankStatements.id, statementId));

  await writeLines(scope, statementId, attempt.walk);

  await promoteStatement(scope, statementId, {
    bankAccountId: account.id,
    currency: account.currency,
  });

  const period = coveragePeriod(statement, attempt.walk);

  await scope.update(
    bankStatements,
    {
      state: "COMPLETED",
      validationOutcome: attempt.validation.outcome,
      openingBalance: attempt.balances.opening.minor,
      closingBalance: attempt.balances.closing.minor,
      totalCredits: attempt.validation.totals.credits,
      totalDebits: attempt.validation.totals.debits,
      lineCount: attempt.walk.lines.length,
      columnMapping: {
        mapping: attempt.mapping,
        openingBalanceSource: attempt.balances.opening.source,
        closingBalanceSource: attempt.balances.closing.source,
        skippedRows: attempt.walk.skipped.length,
        differenceMinor: attempt.validation.differenceMinor?.toString() ?? null,
      },
      ...period,
    },
    eq(bankStatements.id, statementId),
  );
}

/**
 * The deterministic path, with ADR 0003's single re-derive.
 *
 * Returns null when the model could not produce a mapping that passes its schema. ADR 0003:
 * "a mapping that fails validation fails the statement rather than being guessed at."
 */
async function readAsText(
  deps: ParseDependencies,
  grid: Grid,
  currency: Currency,
): Promise<Attempt | null> {
  const first = await attemptText(deps, grid, currency, undefined);
  if (!first) return null;
  if (first.validation.outcome === "VALID") return first;

  // One re-derive, told what did not add up. A mismatch here suggests the mapping may be
  // wrong -- a swapped debit and credit column is exactly the error the balance equation is
  // best at catching -- and unlike the scanned path, re-reading the file costs nothing in
  // accuracy because code reads every value either way.
  const second = await attemptText(deps, grid, currency, describe(first.validation));

  if (!second) return first;
  return second.validation.outcome === "VALID" ? second : first;
}

async function attemptText(
  deps: ParseDependencies,
  grid: Grid,
  currency: Currency,
  problem: string | undefined,
): Promise<Attempt | null> {
  const mapped = await deps.mapColumns({ grid, problem });
  if (!mapped.ok) return null;

  const walk = walkStatement(grid, mapped.value, currency);
  const balances = balancesFromGrid(grid, mapped.value, walk.lines, currency);

  return { walk, balances, validation: validate(walk.lines, balances), mapping: mapped.value };
}

/**
 * The scanned path. No re-derive, ever.
 *
 * `docs/decisions/0003`: a mismatch here means the values may be wrong, and "no amount of
 * retrying makes a misread digit correct". The absence of a second attempt in this function
 * is the rule, and `tests/statements/parse.test.ts` asserts the model is called once.
 */
async function readAsScan(
  deps: ParseDependencies,
  bytes: Uint8Array,
  currency: Currency,
): Promise<Attempt | null> {
  const read = await deps.readScanned({ bytes });
  if (!read.ok) return null;

  const walk = linesFromScanned(read.value, currency);
  const balances = balancesFromScanned(read.value, walk.lines, currency);

  return { walk, balances, validation: validate(walk.lines, balances), mapping: null };
}

/** What to tell the model about the attempt that did not reconcile. */
function describe(validation: Validation): string {
  if (validation.differenceMinor === null) {
    return "The statement's opening and closing balances could not both be found, so the transactions could not be checked.";
  }
  return `The transactions extracted do not reconcile with the statement's balances. They are out by ${validation.differenceMinor} in minor units (credits ${validation.totals.credits}, debits ${validation.totals.debits}).`;
}

/**
 * Write the lines, unless a previous run already did.
 *
 * `statement_lines_row_idx` is unique on (statement, row), so a second write would throw
 * rather than duplicate. Reading them back instead is what lets promotion pick up where a
 * failed run stopped.
 */
async function writeLines(scope: WorkspaceScope, statementId: string, walk: Walk): Promise<void> {
  const existing = await scope.select(statementLines, eq(statementLines.statementId, statementId));
  if (existing.length > 0) return;

  await scope.insert(
    statementLines,
    walk.lines.map((line) => ({
      statementId,
      rowIndex: line.rowIndex,
      valueDate: line.valueDate,
      description: line.description,
      amountMinor: line.amountMinor,
      direction: line.direction,
      balanceMinor: line.balanceMinor,
      externalReference: line.externalReference,
    })),
  );
}

/**
 * Step 5b: the period this statement covers, as Statement Coverage.
 *
 * `docs/decisions/0008`: identification records a period only where the document declared
 * one, and parsing supplies the rest from the transactions it extracted, marked `DERIVED`
 * so that coverage reporting can tell the two apart. A declared period is never overwritten.
 */
function coveragePeriod(
  statement: { periodStart: string | null; periodEnd: string | null },
  walk: Walk,
): { periodStart: string; periodEnd: string; periodSource: "DECLARED" | "DERIVED" } | object {
  if (statement.periodStart && statement.periodEnd) return {};

  const dates = walk.lines.map((line) => line.valueDate).sort();
  return {
    periodStart: dates[0],
    periodEnd: dates[dates.length - 1],
    periodSource: "DERIVED" as const,
  };
}

/** Record a failure as state. `§15`: failures are state, never silently discarded. */
async function fail(scope: WorkspaceScope, statementId: string, reason: string): Promise<void> {
  await scope.update(
    bankStatements,
    { state: "FAILED", failureReason: reason },
    eq(bankStatements.id, statementId),
  );
}
