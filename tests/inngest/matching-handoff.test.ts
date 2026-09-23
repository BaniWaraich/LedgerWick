/**
 * When understanding a document hands over to matching.
 *
 * spec: docs/state-machines.md §3 · docs/decisions/0010, 0011
 *
 * The branch is one line in an Inngest shell, and it is the line that decides whether a
 * document ever reaches matching at all. Getting it wrong in the generous direction sends
 * unreadable documents to a matcher with nothing to match; in the strict direction, an
 * invoice is extracted and then silently never looked for.
 */

import { describe, expect, it } from "vitest";

import type { UnderstandingOutcome } from "../../src/documents/understand";
import { leavesAnInvoice } from "../../src/documents/understand";

const outcome = (over: Partial<UnderstandingOutcome> = {}): UnderstandingOutcome => ({
  state: "EXTRACTED",
  invoiceId: "11111111-1111-4111-8111-111111111111",
  reason: "A tax invoice from ABC Foods.",
  ...over,
});

describe("handing a document over to matching", () => {
  it("hands over an invoice that was extracted", () => {
    expect(leavesAnInvoice(outcome())).toBe(true);
  });

  it("does not hand over a document nobody could read", () => {
    // UNREADABLE is an outcome, not a failure. The document stays stored and the user may
    // link it by hand -- but there is no invoice for matching to work from.
    expect(leavesAnInvoice(outcome({ state: "UNREADABLE", invoiceId: null }))).toBe(false);
  });

  it("does not hand over a document that was not an invoice", () => {
    expect(leavesAnInvoice(outcome({ state: "NOT_AN_INVOICE", invoiceId: null }))).toBe(false);
  });

  it("does not hand over a document another attempt already finished", () => {
    // A null state means understandDocument left it alone -- already terminal, or not
    // this workspace's. Re-announcing it would match an invoice twice.
    expect(leavesAnInvoice(outcome({ state: null, invoiceId: null }))).toBe(false);
  });

  it("does not hand over an extraction that produced no invoice row", () => {
    // Belt and braces: EXTRACTED without an invoiceId should not happen, and if it does,
    // sending the event would name an invoice that is not there.
    expect(leavesAnInvoice(outcome({ invoiceId: null }))).toBe(false);
  });
});
