import { describe, expect, it } from "vitest";

import type { InvoiceReading } from "../../src/ai/prompts/read-invoice.v1";
import { anchored, hasMinimumFields, invoiceFieldsFrom } from "../../src/documents/fields";

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
    expect(fields.unparsed).toContainEqual({
      field: "total",
      text: "1,87,4??.00",
      reason: "UNPARSEABLE",
    });
  });

  it("drops a span that is plainly not money at all", () => {
    const fields = invoiceFieldsFrom(reading({ total: { text: "See attached schedule" } }));
    expect(fields.totalMinor).toBeNull();
    expect(fields.unparsed).toHaveLength(1);
  });

  it("drops a date it cannot read and says so", () => {
    const fields = invoiceFieldsFrom(reading({ invoiceDate: { text: "sometime in April" } }));
    expect(fields.invoiceDate).toBeNull();
    expect(fields.unparsed).toContainEqual({
      field: "invoiceDate",
      text: "sometime in April",
      reason: "UNPARSEABLE",
    });
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

/** A page, as `unpdf` hands it over: runs joined with spaces, no layout left. */
const page =
  "ACME Foods Private Limited Tax Invoice INV-2201 Subtotal \u20b91,01,694.92 GST 18% \u20b918,305.08 Total \u20b91,20,000.00 Date of issue 14/04/2026";

describe("anchoring a span to the document", () => {
  it("accepts characters that are on the page", () => {
    expect(anchored("1,20,000.00", page)).toBe(true);
  });

  it("accepts a currency the model wrote differently", () => {
    // The page prints the rupee sign and the model wrote Rs. Nothing about the amount
    // changed, and readAmount discards both, so rejecting this would drop a correct total.
    expect(anchored("Rs. 1,20,000.00", page)).toBe(true);
  });

  it("accepts a number the PDF split across text runs", () => {
    // pdf.js emits "1,20," and "000.00" as separate runs, and joining them leaves a space
    // no reader would write. That is an artefact of extraction, not a misreading.
    expect(anchored("1,20,000.00", "Total \u20b91,20, 000.00 Date")).toBe(true);
  });

  it("accepts a date written out in words", () => {
    // readDate handles month names, so the model has no reason to reformat one, and the
    // reduction drops the month from both sides anyway.
    expect(anchored("September 1, 2026", "Date of issue September 1, 2026 Amount due")).toBe(true);
  });

  it("rejects a figure that is nowhere on the page", () => {
    // The error this whole check exists for: a total the model produced rather than read.
    expect(anchored("1,50,000.00", page)).toBe(false);
  });

  it("rejects a transposition", () => {
    expect(anchored("1,02,000.00", page)).toBe(false);
  });

  it("rejects a grouping the model normalised rather than copied", () => {
    // 0010's original check catches this one too. Both catching it is not redundancy: this
    // one still works when the currency has no grouping to interpret.
    expect(anchored("120000.00", page)).toBe(false);
  });

  it("has nothing to say about a span with no figures in it", () => {
    // Nothing to verify, and readAmount and readDate refuse it on their own.
    expect(anchored("see attached", page)).toBe(true);
  });

  it("does not claim to catch a mislocation", () => {
    // The limit, asserted so nobody later reads the anchor as more than it is. The subtotal
    // is exactly as present on the page as the total, so a model that transcribed the wrong
    // line passes. Only a person against the corpus finds this.
    expect(anchored("1,01,694.92", page)).toBe(true);
  });
});

describe("what anchoring does to a document's fields", () => {
  it("drops an invented total and says it was not on the page", () => {
    const fields = invoiceFieldsFrom(reading({ total: { text: "1,50,000.00" } }), page);

    expect(fields.totalMinor).toBeNull();
    expect(fields.unparsed).toContainEqual({
      field: "total",
      text: "1,50,000.00",
      reason: "NOT_ON_PAGE",
    });
  });

  it("tells an invented span apart from an unreadable one", () => {
    // The two call for opposite fixes -- a prompt problem against a document problem --
    // so a single "dropped" count would hide which is happening.
    const invented = invoiceFieldsFrom(reading({ total: { text: "9,99,999.00" } }), page);
    const garbled = invoiceFieldsFrom(
      reading({ total: { text: "1,87,4??.00" } }),
      // The garbled figure IS on this page, and so is the date -- so the total is the only
      // field in question, and the reason it was dropped is unambiguous.
      "Total 1,87,4??.00 Date of issue 14/04/2026",
    );

    expect(invented.unparsed[0].reason).toBe("NOT_ON_PAGE");
    expect(garbled.unparsed[0].reason).toBe("UNPARSEABLE");
  });

  it("does not record an invented span twice", () => {
    const fields = invoiceFieldsFrom(reading({ total: { text: "1,50,000.00" } }), page);
    expect(fields.unparsed.filter((entry) => entry.field === "total")).toHaveLength(1);
  });

  it("leaves a document whose figures are all on the page alone", () => {
    const fields = invoiceFieldsFrom(reading(), page);

    expect(fields.totalMinor).toBe(12_000_000n);
    expect(fields.invoiceDate).toBe("2026-04-14");
    expect(fields.unparsed).toEqual([]);
  });

  it("drops an invented date too", () => {
    const fields = invoiceFieldsFrom(reading({ invoiceDate: { text: "01/01/2020" } }), page);

    expect(fields.invoiceDate).toBeNull();
    expect(fields.unparsed[0].reason).toBe("NOT_ON_PAGE");
  });

  it("anchors nothing when the document yielded no text", () => {
    // The visual path. A photograph has no ground truth to check against, and pretending
    // otherwise would drop every field on every scan.
    const fields = invoiceFieldsFrom(reading({ total: { text: "1,50,000.00" } }));

    expect(fields.totalMinor).toBe(15_000_000n);
    expect(fields.unparsed).toEqual([]);
  });

  it("sends a document whose total was invented to UNREADABLE", () => {
    // The outcome that matters: nothing is persisted, rather than a number nobody can find.
    const fields = invoiceFieldsFrom(reading({ total: { text: "1,50,000.00" } }), page);
    expect(hasMinimumFields(fields)).toBe(false);
  });
});
