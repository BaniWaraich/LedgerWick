import { describe, expect, it } from "vitest";

import { invoiceReadingSchema } from "../../src/ai/prompts/read-invoice.v1";

/** A reading that satisfies the schema, for tests that vary one thing about it. */
const reading = (over: Record<string, unknown> = {}) => ({
  classification: "IS_INVOICE",
  reason: "A tax invoice from ABC Foods for catering, dated 14 April.",
  documentType: "Tax invoice",
  vendor: { legalName: "ABC Foods Private Limited", tradeName: "ABC Foods", aliases: [] },
  invoiceNumber: "INV-2201",
  invoiceDate: { text: "14/04/2026" },
  dateOrder: "DMY",
  currency: "INR",
  decimalSeparator: ".",
  total: { text: "1,20,000.00" },
  tax: { text: "18,305.08" },
  subtotal: { text: "1,01,694.92" },
  ...over,
});

describe("what the schema accepts", () => {
  it("accepts a complete reading", () => {
    expect(invoiceReadingSchema.safeParse(reading()).success).toBe(true);
  });

  it("accepts a receipt with no number, no tax and no subtotal", () => {
    // spec: §6 — "invoice number should not be treated as universally mandatory", and
    // additional fields "should not unnecessarily prevent a valid invoice from being
    // processed". Most Indian receipts look like this.
    const result = invoiceReadingSchema.safeParse(
      reading({ invoiceNumber: null, tax: null, subtotal: null }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts an UNCERTAIN document that still yielded its fields", () => {
    // Uncertainty about what a document is does not make its characters less legible, and
    // the prompt asks for them anyway.
    expect(invoiceReadingSchema.safeParse(reading({ classification: "UNCERTAIN" })).success).toBe(
      true,
    );
  });

  it("accepts a document too damaged to yield anything", () => {
    const result = invoiceReadingSchema.safeParse(
      reading({
        classification: "UNCERTAIN",
        vendor: null,
        invoiceNumber: null,
        invoiceDate: null,
        currency: null,
        total: null,
        tax: null,
        subtotal: null,
      }),
    );
    expect(result.success).toBe(true);
  });
});

describe("what the schema refuses", () => {
  it("refuses a classification outside the three", () => {
    // docs/state-machines.md §3 — three-valued, and "must not be flattened to a boolean".
    expect(invoiceReadingSchema.safeParse(reading({ classification: "MAYBE" })).success).toBe(
      false,
    );
    expect(invoiceReadingSchema.safeParse(reading({ classification: true })).success).toBe(false);
  });

  it("refuses a document that is not an invoice but carries a total anyway", () => {
    // The model contradicting itself. domain-model.md §5.1 forks on this answer, so a
    // delivery note with a total would put a charge nobody made into the accounts.
    const result = invoiceReadingSchema.safeParse(reading({ classification: "IS_NOT_INVOICE" }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path[0])).toContain("total");
  });

  it("accepts a document that is not an invoice and says nothing more", () => {
    const result = invoiceReadingSchema.safeParse(
      reading({
        classification: "IS_NOT_INVOICE",
        invoiceNumber: null,
        total: null,
        tax: null,
        subtotal: null,
      }),
    );
    expect(result.success).toBe(true);
  });

  it("refuses a total with no currency to read it in", () => {
    // Money is stored as integer minor units against a per-currency exponent, so an amount
    // with no currency has nowhere to go. src/money/currencies.ts.
    const result = invoiceReadingSchema.safeParse(reading({ currency: null }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path[0])).toContain("currency");
  });

  it("refuses an empty span, which is not a reading of anything", () => {
    expect(invoiceReadingSchema.safeParse(reading({ total: { text: "" } })).success).toBe(false);
  });

  it("refuses a bare number where a printed span belongs", () => {
    // The whole point of 0010. A number has already been interpreted; characters have not.
    expect(invoiceReadingSchema.safeParse(reading({ total: 120000 })).success).toBe(false);
  });

  it("refuses a reading with no reason, which is what the owner is shown", () => {
    expect(invoiceReadingSchema.safeParse(reading({ reason: "" })).success).toBe(false);
  });
});
