import { describe, expect, it } from "vitest";

import type { InvoiceReading } from "../../src/ai/prompts/read-invoice.v1";
import { hasMinimumFields, invoiceFieldsFrom } from "../../src/documents/fields";

const reading = (over: Partial<InvoiceReading> = {}): InvoiceReading => ({
  classification: "IS_INVOICE",
  reason: "A tax invoice from ABC Foods.",
  documentType: "Tax invoice",
  vendor: { legalName: "ABC Foods Private Limited", tradeName: "ABC Foods", aliases: [] },
  invoiceNumber: "INV-2201",
  invoiceDate: { text: "14/04/2026" },
  dateOrder: "DMY",
  currency: "INR",
  decimalSeparator: ".",
  total: { text: "1,20,000.00" },
  tax: null,
  subtotal: null,
  ...over,
});

describe("parsing the spans the model reported", () => {
  it("reads lakh grouping the way the rest of the system does", () => {
    // decision 0010, and the reason the model is asked for characters. A model that
    // returned 120000 here would have interpreted the grouping itself; readAmount is what
    // keeps that knowledge in one place.
    expect(invoiceFieldsFrom(reading()).totalMinor).toBe(12_000_000n);
  });

  it("reads a comma decimal separator when the document uses one", () => {
    const fields = invoiceFieldsFrom(
      reading({ currency: "EUR", decimalSeparator: ",", total: { text: "1.234,56" } }),
    );
    expect(fields.totalMinor).toBe(123_456n);
  });

  it("reads a currency with no minor unit at its own exponent", () => {
    // A yen against an assumed exponent of 2 is wrong by a factor of a hundred.
    const fields = invoiceFieldsFrom(reading({ currency: "JPY", total: { text: "12,000" } }));
    expect(fields.currency?.code).toBe("JPY");
    expect(fields.totalMinor).toBe(12_000n);
  });

  it("strips a currency written beside the figure", () => {
    expect(invoiceFieldsFrom(reading({ total: { text: "Rs. 4,850.00" } })).totalMinor).toBe(
      485_000n,
    );
  });

  it("reads the date in the order the document uses", () => {
    expect(invoiceFieldsFrom(reading()).invoiceDate).toBe("2026-04-14");
    expect(invoiceFieldsFrom(reading({ dateOrder: "MDY" })).invoiceDate).toBeNull();
  });

  it("carries the names through untouched, for normalization to deal with", () => {
    expect(invoiceFieldsFrom(reading()).vendor).toEqual({
      legalName: "ABC Foods Private Limited",
      tradeName: "ABC Foods",
      aliases: [],
    });
  });
});

describe("a span that is not a reading of a value", () => {
  it("drops a garbled transcription rather than guessing at it", () => {
    // A scan the model half-read. Stripping the unknown characters would turn this into a
    // confident Rs. 1,874.00 -- the failure src/money/amounts.ts documents.
    const fields = invoiceFieldsFrom(reading({ total: { text: "1,87,4??.00" } }));

    expect(fields.totalMinor).toBeNull();
    expect(fields.unparsed).toContainEqual({ field: "total", text: "1,87,4??.00" });
  });

  it("drops a span that is plainly not money at all", () => {
    const fields = invoiceFieldsFrom(reading({ total: { text: "See attached schedule" } }));
    expect(fields.totalMinor).toBeNull();
    expect(fields.unparsed).toHaveLength(1);
  });

  it("drops a date it cannot read and says so", () => {
    const fields = invoiceFieldsFrom(reading({ invoiceDate: { text: "sometime in April" } }));
    expect(fields.invoiceDate).toBeNull();
    expect(fields.unparsed).toContainEqual({ field: "invoiceDate", text: "sometime in April" });
  });

  it("drops every amount when the currency is one we cannot count in", () => {
    // Not in SUPPORTED_CURRENCIES, so there is no exponent to store it against.
    const fields = invoiceFieldsFrom(
      reading({ currency: "XYZ", total: { text: "500.00" }, tax: { text: "90.00" } }),
    );

    expect(fields.currency).toBeNull();
    expect(fields.totalMinor).toBeNull();
    expect(fields.unparsed.map((entry) => entry.field)).toEqual(["total", "tax"]);
  });

  it("does not record a field the document simply never printed", () => {
    // An absent total and a dropped total must not look alike. Feature D lost a quarter of
    // a statement to exactly that blindness.
    const fields = invoiceFieldsFrom(reading({ total: null, tax: null, subtotal: null }));
    expect(fields.unparsed).toEqual([]);
  });

  it("never throws, whatever it was handed", () => {
    expect(() =>
      invoiceFieldsFrom(
        reading({ vendor: null, invoiceDate: { text: "" }, total: { text: "???" } }),
      ),
    ).not.toThrow();
  });
});

describe("whether enough was obtained to be worth anything", () => {
  it("wants a vendor, a total and a date, and nothing else", () => {
    // spec: §6 — the minimum useful information for automatic reconciliation.
    expect(hasMinimumFields(invoiceFieldsFrom(reading()))).toBe(true);
  });

  it("does not require an invoice number", () => {
    // §6: "invoice number should not be treated as universally mandatory". Most Indian
    // receipts carry none, and refusing them would throw away real expenses.
    const fields = invoiceFieldsFrom(reading({ invoiceNumber: null }));
    expect(hasMinimumFields(fields)).toBe(true);
  });

  it("does not require tax or a subtotal", () => {
    expect(hasMinimumFields(invoiceFieldsFrom(reading({ tax: null, subtotal: null })))).toBe(true);
  });

  it("accepts a vendor known only by one name", () => {
    const fields = invoiceFieldsFrom(
      reading({ vendor: { legalName: "ABC Foods", tradeName: null, aliases: [] } }),
    );
    expect(hasMinimumFields(fields)).toBe(true);
  });

  it.each([
    ["no vendor", { vendor: null }],
    ["a vendor with no name", { vendor: { legalName: null, tradeName: null, aliases: [] } }],
    ["no total", { total: null }],
    ["no date", { invoiceDate: null }],
    ["a total that would not parse", { total: { text: "???" } }],
  ])("refuses %s", (_name, over) => {
    expect(hasMinimumFields(invoiceFieldsFrom(reading(over as Partial<InvoiceReading>)))).toBe(
      false,
    );
  });
});
