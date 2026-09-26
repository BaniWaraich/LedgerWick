/**
 * What a requirement comes to, from everything retrieval found for it.
 *
 * spec: docs/workflows/retrieve-invoices.md §12, §13, §16, §17 · decision:
 * docs/decisions/0016-retrieval-proposes-settle-decides.md
 */

import { describe, expect, it } from "vitest";

import {
  decideRetrieval,
  RETRIEVAL_TERMS,
  type Assessment,
  type SettleInput,
} from "../../src/retrieval/decide";

const T = "txn-1";

function invoice(over: Partial<Assessment> = {}): Assessment {
  return {
    documentId: "doc-1",
    state: "EXTRACTED",
    classification: "IS_INVOICE",
    invoiceId: "inv-1",
    candidateTransactionIds: [T],
    autoMatchTransactionId: T,
    blockedBy: null,
    ...over,
  };
}

function input(over: Partial<SettleInput> = {}): SettleInput {
  return {
    transactionId: T,
    assessments: [invoice()],
    rejected: new Set(),
    mailboxes: [{ outcome: "COMPLETED", truncated: false }],
    selectionExhaustive: true,
    ...over,
  };
}

describe("an automatic link", () => {
  it("is made when one document supports the payment on strong evidence", () => {
    expect(decideRetrieval(input())).toEqual({
      kind: "AUTO",
      documentId: "doc-1",
      invoiceId: "inv-1",
    });
  });

  /*
   * Each term removed in turn must downgrade to review, never to a link. The list is
   * derived from the terms themselves, so a term added later is covered by name.
   */
  const breakers: Record<string, Partial<SettleInput>> = {
    "one document supports this payment": {
      assessments: [invoice(), invoice({ documentId: "doc-2", invoiceId: "inv-2" })],
    },
    "matching chose this payment for it": {
      assessments: [invoice({ autoMatchTransactionId: null, blockedBy: "the model agrees" })],
    },
    "it reads as an invoice": { assessments: [invoice({ classification: "UNCERTAIN" })] },
    "every mailbox was searched": {
      mailboxes: [
        { outcome: "COMPLETED", truncated: false },
        { outcome: "NEEDS_REAUTH", truncated: false },
      ],
    },
    "nothing found was left unread": { selectionExhaustive: false },
  };

  it("names a breaker for every term", () => {
    expect(Object.keys(breakers).sort()).toEqual([...RETRIEVAL_TERMS].sort());
  });

  for (const term of RETRIEVAL_TERMS) {
    it(`is not made without: ${term}`, () => {
      expect(decideRetrieval(input(breakers[term]))).toEqual({
        kind: "NEEDS_REVIEW",
        blockedBy: term,
      });
    });
  }

  it("is not made when a search pass was truncated", () => {
    const outcome = decideRetrieval(
      input({ mailboxes: [{ outcome: "COMPLETED", truncated: true }] }),
    );
    expect(outcome).toEqual({ kind: "NEEDS_REVIEW", blockedBy: "nothing found was left unread" });
  });

  it("is not made to a different payment matching preferred", () => {
    const elsewhere = invoice({
      candidateTransactionIds: ["txn-other", T],
      autoMatchTransactionId: "txn-other",
    });
    expect(decideRetrieval(input({ assessments: [elsewhere] }))).toMatchObject({
      kind: "NEEDS_REVIEW",
    });
  });
});

describe("what is put in front of the user", () => {
  it("includes a document nobody could read", () => {
    const unreadable = invoice({
      state: "UNREADABLE",
      classification: null,
      invoiceId: null,
      candidateTransactionIds: [],
      autoMatchTransactionId: null,
    });
    expect(decideRetrieval(input({ assessments: [unreadable] })).kind).toBe("NEEDS_REVIEW");
  });

  it("excludes a document read as not an invoice", () => {
    // Settled 2026-09-26: recorded, not offered. retrieve-invoices §11.1.
    const notInvoice = invoice({
      state: "NOT_AN_INVOICE",
      classification: "IS_NOT_INVOICE",
      invoiceId: null,
      candidateTransactionIds: [],
      autoMatchTransactionId: null,
    });
    expect(decideRetrieval(input({ assessments: [notInvoice] }))).toEqual({ kind: "NOT_FOUND" });
  });

  it("excludes an invoice whose own evidence never named this payment", () => {
    const unrelated = invoice({
      candidateTransactionIds: ["txn-other"],
      autoMatchTransactionId: "txn-other",
    });
    expect(decideRetrieval(input({ assessments: [unrelated] }))).toEqual({ kind: "NOT_FOUND" });
  });

  it("excludes a document the user already rejected, and lets the rest decide", () => {
    // spec: invoice-match-review §7 — a later run does not present them again.
    const rejected = invoice({ documentId: "doc-rejected", invoiceId: "inv-r" });
    const outcome = decideRetrieval(
      input({ assessments: [rejected, invoice()], rejected: new Set(["doc-rejected"]) }),
    );
    expect(outcome).toMatchObject({ kind: "AUTO", documentId: "doc-1" });
  });
});

describe("when nothing is plausible", () => {
  it("is NOT_FOUND when every mailbox was searched", () => {
    expect(decideRetrieval(input({ assessments: [] }))).toEqual({ kind: "NOT_FOUND" });
  });

  it("is BLOCKED when a mailbox could not be searched", () => {
    // spec: retrieve-invoices §17 — never "not found" about a place we did not look.
    const outcome = decideRetrieval(
      input({ assessments: [], mailboxes: [{ outcome: "NEEDS_REAUTH", truncated: false }] }),
    );
    expect(outcome).toEqual({ kind: "BLOCKED" });
  });
});
