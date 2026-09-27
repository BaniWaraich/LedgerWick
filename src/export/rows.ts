/**
 * What each row of the Excel export says.
 *
 * spec: docs/workflows/missing-invoice-report.md §9
 * decision: docs/decisions/0017-reconciliation-export.md · 0014 (the bucket rule)
 *
 * Pure. One row per canonical transaction: the export is the complete reconciliation, not
 * the queue. A requirement is placed by `bucketOf`, the same function that counts the §5
 * summary, so the file and the report cannot disagree about any requirement.
 *
 * The wording is careful in one place. A transaction with no requirement is not
 * necessarily one that was judged to need no document -- identification may never have
 * finished with it (`0014`, Consequences) -- so the file says what the system knows and
 * no more.
 */

import type {
  bankAccounts,
  canonicalTransactions,
  invoiceRequirements,
  resolutionMethodEnum,
} from "../db/schema";
import { currencyFor } from "../money/currencies";
import { bucketOf, type Bucket } from "../report/summary";

type Transaction = typeof canonicalTransactions.$inferSelect;
type Requirement = typeof invoiceRequirements.$inferSelect;
type Account = typeof bankAccounts.$inferSelect;
type ResolutionMethod = (typeof resolutionMethodEnum.enumValues)[number];

/** A document a row links to. An id and a name -- never a storage reference. */
export interface ExportDocument {
  readonly id: string;
  readonly filename: string;
}

export interface ExportRow {
  /** ISO date, as stored. The workbook turns it into a real date cell. */
  readonly date: string;
  readonly account: string;
  readonly description: string;
  readonly direction: "Debit" | "Credit";
  /** Major units, exactly: parsed from a decimal string, never divided as a float. */
  readonly amount: number;
  readonly currency: string;
  readonly vendor: string | null;
  readonly documentNeeded: string;
  /** The §5 line the requirement is counted in. Null when there is no requirement. */
  readonly status: string | null;
  readonly howResolved: string | null;
  readonly reason: string | null;
  readonly document: ExportDocument | null;
}

export interface ReconciliationState {
  readonly transactions: readonly Transaction[];
  readonly requirements: readonly Requirement[];
  readonly accounts: readonly Account[];
  /** The document each transaction is linked to, keyed by transaction id. */
  readonly documents: ReadonlyMap<string, ExportDocument>;
  /** Transactions a Clarification Question is still open about. */
  readonly awaitingAnswer: ReadonlySet<string>;
}

/** The report's line names, as a person reads them in a spreadsheet. */
const STATUS: Record<Bucket, string> = {
  matched: "Matched",
  notFound: "Not found",
  needsReview: "Needs review",
  waiting: "Waiting for a document",
  blocked: "Waiting on a mailbox",
  notRequired: "No document needed",
};

function howResolved(method: ResolutionMethod): string | null {
  switch (method) {
    case "AUTO_RETRIEVED":
      return "Retrieved from email";
    case "AUTO_MATCHED":
      return "Matched automatically";
    case "USER_CONFIRMED":
      return "Confirmed by you";
    case "USER_LINKED":
      return "Linked by you";
    // Said by the Document needed column; saying it twice would read as two facts.
    case "NOT_REQUIRED":
      return null;
    default: {
      const unhandled: never = method;
      throw new Error(`No wording for resolution method ${String(unhandled)}`);
    }
  }
}

/**
 * Minor units to a number of major units, exactly.
 *
 * The integer is split as text, the way `src/money/format.ts` does it, and the resulting
 * decimal string is parsed once. Dividing a bigint-turned-number by 100 would be the one
 * float operation the money code refuses to do.
 *
 * A currency this system does not know throws. Its exponent is unknown, so any number
 * written would be a guess that could be wrong by a factor of a hundred -- in the one file
 * that leaves the product. A failed export says so; a wrong amount does not.
 */
export function majorUnits(minor: bigint, code: string): number {
  const currency = currencyFor(code);
  if (!currency) throw new Error(`Cannot export an amount in unknown currency ${code}`);

  const scale = 10n ** BigInt(currency.exponent);
  const negative = minor < 0n;
  const magnitude = negative ? -minor : minor;
  const whole = (magnitude / scale).toString();
  const fraction = (magnitude % scale).toString().padStart(currency.exponent, "0");
  const text = currency.exponent === 0 ? whole : `${whole}.${fraction}`;

  return Number(`${negative ? "-" : ""}${text}`);
}

function documentNeeded(
  bucket: Bucket | null,
  transactionId: string,
  awaitingAnswer: ReadonlySet<string>,
): string {
  if (bucket === "notRequired") return "No — marked by you";
  if (bucket !== null) return "Yes";
  // No requirement: say what is known, never "no document needed". §9.
  return awaitingAnswer.has(transactionId)
    ? "Waiting for your answer"
    : "No document identified as needed";
}

function accountName(account: Account | undefined): string {
  return account ? `${account.bankName} ${account.accountIdentifier}` : "";
}

/** Every transaction in the workspace, as the rows of the export, oldest first. */
export function reconciliationRows(state: ReconciliationState): ExportRow[] {
  const accountById = new Map(state.accounts.map((account) => [account.id, account]));
  const requirementByTransaction = new Map(
    state.requirements.map((requirement) => [requirement.canonicalTransactionId, requirement]),
  );

  return state.transactions
    .map((transaction) => {
      const requirement = requirementByTransaction.get(transaction.id);
      const bucket = requirement ? bucketOf(requirement.state, requirement.resolutionMethod) : null;

      return {
        date: transaction.valueDate,
        account: accountName(accountById.get(transaction.bankAccountId)),
        description: transaction.description,
        direction: transaction.direction === "DEBIT" ? "Debit" : "Credit",
        amount: majorUnits(transaction.amountMinor, transaction.currency),
        currency: transaction.currency,
        vendor: requirement?.vendorGuess ?? null,
        documentNeeded: documentNeeded(bucket, transaction.id, state.awaitingAnswer),
        status: bucket ? STATUS[bucket] : null,
        howResolved:
          bucket === "matched" && requirement?.resolutionMethod
            ? howResolved(requirement.resolutionMethod)
            : null,
        reason: requirement?.reason ?? null,
        document: state.documents.get(transaction.id) ?? null,
      } satisfies ExportRow;
    })
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.account.localeCompare(b.account) ||
        a.description.localeCompare(b.description),
    );
}
