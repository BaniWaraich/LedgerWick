/**
 * What each row of the export says.
 *
 * spec: docs/workflows/missing-invoice-report.md §9
 * decision: docs/decisions/0017-reconciliation-export.md
 *
 * The file is the complete reconciliation, so every kind of transaction is here, and the
 * one wording that must never slip is claiming "no document needed" for a transaction
 * nobody judged.
 */

import { describe, expect, it } from "vitest";

import type { bankAccounts, canonicalTransactions, invoiceRequirements } from "../../src/db/schema";
import { majorUnits, reconciliationRows, type ExportDocument } from "../../src/export/rows";

type Transaction = typeof canonicalTransactions.$inferSelect;
type Requirement = typeof invoiceRequirements.$inferSelect;
type Account = typeof bankAccounts.$inferSelect;

const account: Account = {
  id: "acc-1",
  workspaceId: "ws",
  bankName: "HDFC Bank",
  accountIdentifier: "XXXX1234",
  accountType: "current",
  accountKind: "BANK_ACCOUNT",
  currency: "INR",
  createdAt: new Date(),
};

let n = 0;
function transaction(over: Partial<Transaction> = {}): Transaction {
  n += 1;
  return {
    id: `tx-${n}`,
    workspaceId: "ws",
    bankAccountId: account.id,
    valueDate: `2026-03-${String(n).padStart(2, "0")}`,
    amountMinor: 123456n,
    direction: "DEBIT",
    currency: "INR",
    description: `PAYMENT ${n}`,
    descriptionNormalized: `payment ${n}`,
    occurrenceIndex: 0,
    externalReference: null,
    createdAt: new Date(),
    ...over,
  };
}

function requirement(tx: Transaction, over: Partial<Requirement> = {}): Requirement {
  return {
    id: `req-${tx.id}`,
    workspaceId: "ws",
    canonicalTransactionId: tx.id,
    state: "IDENTIFIED",
    reconciliationRunId: null,
    reason: "A supplier payment.",
    vendorGuess: "Adobe",
    businessContext: null,
    resolutionMethod: null,
    resolvedDocumentId: null,
    rejectedDocumentIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function rowsFor(
  pairs: [Transaction, Requirement | null][],
  extra: { documents?: Map<string, ExportDocument>; awaitingAnswer?: Set<string> } = {},
) {
  return reconciliationRows({
    transactions: pairs.map(([tx]) => tx),
    requirements: pairs.flatMap(([, req]) => (req ? [req] : [])),
    accounts: [account],
    documents: extra.documents ?? new Map(),
    awaitingAnswer: extra.awaitingAnswer ?? new Set(),
  });
}

describe("the complete reconciliation", () => {
  it("has a row for every transaction, not only the unresolved ones", () => {
    const matched = transaction();
    const notFound = transaction();
    const review = transaction();
    const notRequired = transaction();
    const none = transaction({ direction: "CREDIT" });

    const rows = rowsFor([
      [
        matched,
        requirement(matched, {
          state: "RESOLVED",
          resolutionMethod: "AUTO_RETRIEVED",
          resolvedDocumentId: "doc-1",
        }),
      ],
      [notFound, requirement(notFound, { state: "NOT_FOUND" })],
      [review, requirement(review, { state: "NEEDS_REVIEW" })],
      [
        notRequired,
        requirement(notRequired, { state: "RESOLVED", resolutionMethod: "NOT_REQUIRED" }),
      ],
      [none, null],
    ]);

    expect(rows.map((row) => [row.description, row.documentNeeded, row.status])).toEqual([
      [matched.description, "Yes", "Matched"],
      [notFound.description, "Yes", "Not found"],
      [review.description, "Yes", "Needs review"],
      [notRequired.description, "No — marked by you", "No document needed"],
      [none.description, "No document identified as needed", null],
    ]);
  });

  it("places every requirement state in the report's own line", () => {
    const states = [
      ["IDENTIFIED", "Waiting for a document"],
      ["SEARCHING", "Waiting for a document"],
      ["EVALUATING", "Waiting for a document"],
      ["FAILED", "Waiting for a document"],
      ["BLOCKED", "Waiting on a mailbox"],
    ] as const;

    const pairs = states.map(([state]) => {
      const tx = transaction();
      return [tx, requirement(tx, { state })] as [Transaction, Requirement];
    });

    expect(rowsFor(pairs).map((row) => row.status)).toEqual(states.map(([, label]) => label));
  });

  it("says how each match was made, and nothing for a payment marked as needing none", () => {
    const methods = [
      ["AUTO_RETRIEVED", "Retrieved from email"],
      ["AUTO_MATCHED", "Matched automatically"],
      ["USER_CONFIRMED", "Confirmed by you"],
      ["USER_LINKED", "Linked by you"],
      ["NOT_REQUIRED", null],
    ] as const;

    const pairs = methods.map(([method]) => {
      const tx = transaction();
      return [tx, requirement(tx, { state: "RESOLVED", resolutionMethod: method })] as [
        Transaction,
        Requirement,
      ];
    });

    expect(rowsFor(pairs).map((row) => row.howResolved)).toEqual(methods.map(([, how]) => how));
  });

  it("never claims a transaction nobody judged needs no document", () => {
    const unjudged = transaction();
    const asked = transaction();

    const rows = rowsFor(
      [
        [unjudged, null],
        [asked, null],
      ],
      { awaitingAnswer: new Set([asked.id]) },
    );

    expect(rows.map((row) => row.documentNeeded)).toEqual([
      "No document identified as needed",
      "Waiting for your answer",
    ]);
    expect(rows.every((row) => row.documentNeeded !== "No document needed")).toBe(true);
  });

  it("carries the document a transaction is linked to, and none where there is none", () => {
    const linked = transaction();
    const waiting = transaction();
    const document = { id: "doc-9", filename: "adobe-march.pdf" };

    const rows = rowsFor(
      [
        [linked, requirement(linked, { state: "RESOLVED", resolutionMethod: "USER_LINKED" })],
        [waiting, requirement(waiting)],
      ],
      { documents: new Map([[linked.id, document]]) },
    );

    expect(rows[0].document).toEqual(document);
    expect(rows[1].document).toBeNull();
  });

  it("orders rows by date, then account", () => {
    const later = transaction({ valueDate: "2026-04-02" });
    const earlier = transaction({ valueDate: "2026-01-15" });

    const rows = rowsFor([
      [later, null],
      [earlier, null],
    ]);

    expect(rows.map((row) => row.date)).toEqual(["2026-01-15", "2026-04-02"]);
  });

  it("names the account and the direction as a person reads them", () => {
    const credit = transaction({ direction: "CREDIT" });
    const [row] = rowsFor([[credit, null]]);

    expect(row.account).toBe("HDFC Bank XXXX1234");
    expect(row.direction).toBe("Credit");
    expect(row.amount).toBe(1234.56);
    expect(row.currency).toBe("INR");
  });

  it("is empty for a workspace with no transactions", () => {
    expect(rowsFor([])).toEqual([]);
  });
});

describe("amounts", () => {
  it("reads minor units at the currency's own exponent", () => {
    expect(majorUnits(123456n, "INR")).toBe(1234.56);
    expect(majorUnits(123456n, "JPY")).toBe(123456);
    expect(majorUnits(123456n, "KWD")).toBe(123.456);
    expect(majorUnits(5n, "INR")).toBe(0.05);
  });

  it("is exact for a crore", () => {
    expect(majorUnits(1234567890123n, "INR")).toBe(12345678901.23);
  });

  it("refuses a currency whose exponent it does not know, rather than guess", () => {
    expect(() => majorUnits(100n, "XYZ")).toThrow(/unknown currency XYZ/);
  });
});
