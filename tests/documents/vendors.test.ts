import { describe, expect, it } from "vitest";

import { normalizeVendorName, vendorLookupKeys } from "../../src/documents/vendors";

describe("the worked example the spec sets", () => {
  it("resolves all three forms of one vendor to one key", () => {
    // spec: manual-invoice-upload §7. This is the bar the whole file exists to clear: an
    // invoice's legal name, the same vendor's trade name, and how a payment processor
    // wrote it on a bank statement.
    const legal = normalizeVendorName("ABC Foods Private Limited");
    const trade = normalizeVendorName("ABC Foods");
    const statement = normalizeVendorName("RAZORPAY*ABCFOODS");

    expect(legal).toBe("abcfoods");
    expect(trade).toBe(legal);
    expect(statement).toBe(legal);
  });
});

describe("corporate form", () => {
  it.each([
    ["Acme Pvt Ltd", "acme"],
    ["Acme Pvt. Ltd.", "acme"],
    ["Acme Private Limited", "acme"],
    ["Acme Limited", "acme"],
    ["Acme LLP", "acme"],
    ["Acme Inc", "acme"],
    ["Acme Inc.", "acme"],
    ["Acme Corporation", "acme"],
    ["Acme GmbH", "acme"],
    ["Acme Pte Ltd", "acme"],
  ])("takes %s down to %s", (given, expected) => {
    expect(normalizeVendorName(given)).toBe(expected);
  });

  it("takes off every trailing suffix, not merely the last one", () => {
    // `Acme Holdings Limited` against `Acme` is the case that made this a loop.
    expect(normalizeVendorName("Acme Holdings Limited")).toBe("acme");
  });

  it("leaves a suffix alone when it is the name", () => {
    // Not a corporate form here — it is what the company is called. Stripping it would
    // leave an empty key and merge every such vendor into one.
    expect(normalizeVendorName("Limited")).toBe("limited");
    expect(normalizeVendorName("Inc")).toBe("inc");
  });

  it("does not eat a word that merely ends in a suffix", () => {
    expect(normalizeVendorName("Danco")).toBe("danco");
    expect(normalizeVendorName("Zinc")).toBe("zinc");
  });
});

describe("payment processors", () => {
  it.each([
    ["RAZORPAY*ABCFOODS", "abcfoods"],
    ["PAYU/ABC FOODS", "abcfoods"],
    ["BILLDESK-ACME", "acme"],
    ["CCAVENUE*ACME", "acme"],
    ["PAYTM*ACME", "acme"],
    ["STRIPE*ACME", "acme"],
  ])("takes the processor off the front of %s", (given, expected) => {
    expect(normalizeVendorName(given)).toBe(expected);
  });

  it("leaves a vendor whose name sits before the star alone", () => {
    // The ambiguity the closed list exists for. `ANTHROPIC*CLAUDE` and `RAZORPAY*ABCFOODS`
    // have the same shape and opposite meanings, and only knowing which names are
    // processors tells them apart. Guessing here would take ANTHROPIC off an Anthropic
    // invoice and lose the vendor entirely.
    expect(normalizeVendorName("ANTHROPIC*CLAUDE")).toBe("anthropicclaude");
  });
});

describe("bank rails and references", () => {
  it("strips a transfer rail and its reference", () => {
    expect(normalizeVendorName("NEFT-DR-ABCD0001234-XYZ SERVICES")).toBe("xyzservices");
  });

  it("strips a UPI prefix and its handle reference", () => {
    expect(normalizeVendorName("UPI/AMAZON PAY/9922/ORDER")).toBe("amazonpay9922order");
  });

  it("drops a trailing reference number", () => {
    expect(normalizeVendorName("ANTHROPIC*CLAUDE 8829")).toBe("anthropicclaude");
  });

  it("keeps a small number that is part of the name", () => {
    // Four digits is the bar precisely so that these survive. Losing them would merge two
    // genuinely different vendors, which is the worse error of the two.
    expect(normalizeVendorName("Studio 5")).toBe("studio5");
    expect(normalizeVendorName("Formula 1 Hotels")).toBe("formula1hotels");
  });
});

describe("the shape of the key", () => {
  it("ignores case, punctuation and spacing", () => {
    const forms = ["ACME Foods", "acme foods", "Acme  Foods", "Acme-Foods", "Acme.Foods"];
    expect(new Set(forms.map(normalizeVendorName))).toEqual(new Set(["acmefoods"]));
  });

  it("returns nothing for a description that names no vendor", () => {
    // A narration that was only a reference number. Empty is not the same as unseen, and
    // the caller has to tell the two apart.
    expect(normalizeVendorName("   ")).toBe("");
    expect(normalizeVendorName("---")).toBe("");
  });

  it("does not merge two different vendors that share a prefix", () => {
    expect(normalizeVendorName("Acme Foods")).not.toBe(normalizeVendorName("Acme Foundry"));
  });
});

describe("the keys worth trying for one vendor", () => {
  it("takes every name an invoice gives and normalizes each", () => {
    // spec: §7 — legal name, trade name and aliases must all be capable of resolving to
    // the same vendor, so all of them are searched for.
    expect(vendorLookupKeys(["ABC Foods Private Limited", "ABC Foods", "ABCF"])).toEqual([
      "abcfoods",
      "abcf",
    ]);
  });

  it("drops nulls and blanks without the caller thinking about it", () => {
    expect(vendorLookupKeys([null, "Acme", undefined, "   "])).toEqual(["acme"]);
  });

  it("keeps the best name first", () => {
    // Order is the caller's search order, so the name the document was most confident
    // about has to stay at the front.
    expect(vendorLookupKeys(["Acme Pvt Ltd", "Zenith"])[0]).toBe("acme");
  });

  it("has nothing to offer for a document that named nobody", () => {
    expect(vendorLookupKeys([null, "", "  "])).toEqual([]);
  });
});
