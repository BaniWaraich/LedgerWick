/**
 * The facts matching decides from, and the sentences they become.
 *
 * spec: docs/workflows/manual-invoice-upload.md §9 ·
 * docs/workflows/invoice-match-review.md §5
 *
 * Pure, so no database and no model. The sentences are asserted verbatim because they are
 * the product: `§5` is explicit that the user is shown the evidence rather than a score,
 * and a sentence that drifts is a sentence nobody noticed changing.
 */

import { describe as suite, expect, it } from "vitest";

import {
  daysBetween,
  describe,
  describeAll,
  evidenceFor,
  vendorKeyAppearsIn,
  type Evidence,
  type InvoiceFacts,
  type TransactionFacts,
} from "../../src/matching/evidence";

const WINDOW = { before: 3, after: 10 };

function invoice(overrides: Partial<InvoiceFacts> = {}): InvoiceFacts {
  return {
    invoiceNumber: "INV-92831",
    invoiceDate: "2026-04-14",
    totalMinor: 2000n,
    currency: "USD",
    vendorId: "vendor-1",
    vendorName: "Anthropic",
    vendorKeys: ["anthropic"],
    ...overrides,
  };
}

function transaction(overrides: Partial<TransactionFacts> = {}): TransactionFacts {
  return {
    id: "txn-1",
    valueDate: "2026-04-14",
    amountMinor: 2000n,
    currency: "USD",
    description: "ANTHROPIC",
    descriptionNormalized: "anthropic",
    externalReference: null,
    ...overrides,
  };
}

function pick<K extends Evidence["kind"]>(list: Evidence[], kind: K) {
  return list.find((e) => e.kind === kind) as Extract<Evidence, { kind: K }>;
}

suite("counting days between two dates", () => {
  it("counts forwards as positive", () => {
    expect(daysBetween("2026-04-14", "2026-04-17")).toBe(3);
  });

  it("counts backwards as negative", () => {
    expect(daysBetween("2026-04-17", "2026-04-14")).toBe(-3);
  });

  it("crosses a month boundary", () => {
    expect(daysBetween("2026-04-29", "2026-05-02")).toBe(3);
  });

  it("is unmoved by a daylight-saving change", () => {
    // Parsed as UTC precisely so a 23-hour local day cannot round to zero and make two
    // dates look like the same day.
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
  });
});

suite("what the amounts say", () => {
  it("calls an identical amount exact", () => {
    const found = pick(
      evidenceFor(invoice(), transaction(), { agreement: "NONE" }, WINDOW),
      "AMOUNT",
    );

    expect(found.agreement).toBe("EXACT");
    expect(found.deltaMinor).toBe(0n);
  });

  it("calls a fee-sized difference near, and keeps both figures", () => {
    const found = pick(
      evidenceFor(invoice(), transaction({ amountMinor: 2015n }), { agreement: "NONE" }, WINDOW),
      "AMOUNT",
    );

    // Near is evidence worth showing and is never enough to link on -- the automatic
    // tolerance in thresholds.ts is zero.
    expect(found.agreement).toBe("NEAR");
    expect(found.deltaMinor).toBe(15n);
    expect(found.invoiceMinor).toBe(2000n);
    expect(found.transactionMinor).toBe(2015n);
  });

  it("calls a wholly different amount different", () => {
    const found = pick(
      evidenceFor(invoice(), transaction({ amountMinor: 990000n }), { agreement: "NONE" }, WINDOW),
      "AMOUNT",
    );

    expect(found.agreement).toBe("DIFFERENT");
  });

  it("does not call a cross-currency amount a mismatch", () => {
    // domain-model.md FX: a currency mismatch is weak corroborating evidence in a wide
    // band, never a standalone refutation. $20 against Rs 1,700 is the §8 example.
    const found = pick(
      evidenceFor(
        invoice(),
        transaction({ amountMinor: 170000n, currency: "INR" }),
        { agreement: "NONE" },
        WINDOW,
      ),
      "AMOUNT",
    );

    expect(found.agreement).toBe("FX_BAND");
  });

  it("says so when the document gave no amount", () => {
    const found = pick(
      evidenceFor(invoice({ totalMinor: null }), transaction(), { agreement: "NONE" }, WINDOW),
      "AMOUNT",
    );

    expect(found.agreement).toBe("DIFFERENT");
    expect(found.deltaMinor).toBeNull();
    expect(describe(found)).toBe("No amount was read from this document");
  });
});

suite("what the dates say", () => {
  it("recognises the same day", () => {
    const found = pick(
      evidenceFor(invoice(), transaction(), { agreement: "NONE" }, WINDOW),
      "DATE",
    );

    expect(found.agreement).toBe("SAME_DAY");
    expect(found.offsetDays).toBe(0);
  });

  it("accepts a payment that settled days later", () => {
    // §8: "an invoice dated one day may legitimately correspond to a bank transaction
    // occurring several days later due to payment or settlement timing."
    const found = pick(
      evidenceFor(
        invoice(),
        transaction({ valueDate: "2026-04-21" }),
        { agreement: "NONE" },
        WINDOW,
      ),
      "DATE",
    );

    expect(found.agreement).toBe("WITHIN_WINDOW");
    expect(found.offsetDays).toBe(7);
  });

  it("puts a payment well before the invoice outside the window", () => {
    // The window is asymmetric: a business pays on or after an invoice is issued.
    const found = pick(
      evidenceFor(
        invoice(),
        transaction({ valueDate: "2026-04-04" }),
        { agreement: "NONE" },
        WINDOW,
      ),
      "DATE",
    );

    expect(found.agreement).toBe("OUTSIDE");
    expect(found.offsetDays).toBe(-10);
  });

  it("says so when the document gave no date", () => {
    const found = pick(
      evidenceFor(invoice({ invoiceDate: null }), transaction(), { agreement: "NONE" }, WINDOW),
      "DATE",
    );

    expect(found.agreement).toBe("OUTSIDE");
    expect(found.offsetDays).toBeNull();
  });
});

suite("where the invoice number turned up", () => {
  it("prefers the bank's own reference to free text", () => {
    const found = pick(
      evidenceFor(
        invoice(),
        transaction({ externalReference: "INV92831", description: "ANTHROPIC INV-92831" }),
        { agreement: "NONE" },
        WINDOW,
      ),
      "INVOICE_NUMBER",
    );

    // A number in a UTR is a stronger claim than the same string somewhere in a narration.
    expect(found.agreement).toBe("IN_EXTERNAL_REFERENCE");
  });

  it("finds a number written with different punctuation", () => {
    const found = pick(
      evidenceFor(
        invoice(),
        transaction({ description: "ANTHROPIC PMT INV92831" }),
        { agreement: "NONE" },
        WINDOW,
      ),
      "INVOICE_NUMBER",
    );

    expect(found.agreement).toBe("IN_DESCRIPTION");
  });

  it("distinguishes a number that is missing from one that was never read", () => {
    const missing = pick(
      evidenceFor(invoice(), transaction(), { agreement: "NONE" }, WINDOW),
      "INVOICE_NUMBER",
    );
    const never = pick(
      evidenceFor(invoice({ invoiceNumber: null }), transaction(), { agreement: "NONE" }, WINDOW),
      "INVOICE_NUMBER",
    );

    // "Checked, and it disagreed" is a different fact from "nothing to check". §6 says an
    // invoice number is not universally mandatory, so ABSENT must not read as a failure.
    expect(missing.agreement).toBe("NOT_PRESENT");
    expect(never.agreement).toBe("ABSENT");
  });
});

suite("finding a vendor's name in a bank description", () => {
  it("sees through a payment processor's prefix", () => {
    // §7's own example: RAZORPAY*ABCFOODS and ABC Foods Private Limited are one vendor.
    expect(vendorKeyAppearsIn(["abcfoods"], "razorpayabcfoods")).toBe(true);
  });

  it("does not match on an empty key", () => {
    // A description that normalized to nothing must not match everything.
    expect(vendorKeyAppearsIn([""], "anthropic")).toBe(false);
  });
});

suite("the sentences the review screen prints", () => {
  it("reads as §5 does for a candidate that agrees", () => {
    const lines = describeAll(
      evidenceFor(invoice(), transaction(), { agreement: "RESOLVED" }, WINDOW),
    );

    expect(lines).toEqual([
      "Amount matches exactly",
      "Dated the same day as the transaction",
      "Vendor matches ANTHROPIC in the transaction description",
      "Invoice number not present in the transaction description",
    ]);
  });

  it("says nothing about a currency that agrees", () => {
    // Silence is the right output for a fact with nothing to report. A line reading
    // "Currency matches" on every candidate teaches the reader to skip the list.
    const lines = describeAll(
      evidenceFor(invoice(), transaction(), { agreement: "RESOLVED" }, WINDOW),
    );

    expect(lines.some((line) => line.includes("USD"))).toBe(false);
  });

  it("names both currencies when they differ", () => {
    const lines = describeAll(
      evidenceFor(
        invoice(),
        transaction({ currency: "INR", amountMinor: 170000n }),
        { agreement: "RESOLVED" },
        WINDOW,
      ),
    );

    expect(lines).toContain("Invoice is in USD, the payment in INR");
  });

  it("puts the invoice before the transaction when the payment came later", () => {
    const evidence = pick(
      evidenceFor(
        invoice(),
        transaction({ valueDate: "2026-04-15" }),
        { agreement: "NONE" },
        WINDOW,
      ),
      "DATE",
    );

    expect(describe(evidence)).toBe("Dated 1 day before the transaction");
  });

  it("puts the invoice after the transaction when the payment came first", () => {
    const evidence = pick(
      evidenceFor(
        invoice(),
        transaction({ valueDate: "2026-04-12" }),
        { agreement: "NONE" },
        WINDOW,
      ),
      "DATE",
    );

    expect(describe(evidence)).toBe("Dated 2 days after the transaction");
  });

  it("distinguishes a confirmed alias from a bare name appearing in the text", () => {
    const resolved = evidenceFor(invoice(), transaction(), { agreement: "ALIAS" }, WINDOW);
    const contains = evidenceFor(
      invoice(),
      transaction(),
      { agreement: "NORMALIZED_CONTAINS" },
      WINDOW,
    );

    expect(describeAll(resolved)).toContain("Vendor is a known alias of ANTHROPIC");
    expect(describeAll(contains)).toContain("Vendor name appears in ANTHROPIC");
  });
});
