import { describe, expect, it } from "vitest";

import { currencyFor, isKnownCurrency, SUPPORTED_CURRENCIES } from "../../src/money/currencies";

describe("looking up a currency", () => {
  it("finds one by its code", () => {
    expect(currencyFor("INR")?.code).toBe("INR");
  });

  it("tolerates the case and spacing a model returns", () => {
    // The argument comes from a model reading a document, where "inr " is the same answer
    // as "INR".
    expect(currencyFor("inr")?.code).toBe("INR");
    expect(currencyFor(" EUR ")?.code).toBe("EUR");
  });

  it("returns null for a code this system does not know", () => {
    // Not an error: `docs/decisions/0008` makes this the user's question, and an unknown
    // code is a gap to fill rather than a bug to route around.
    expect(currencyFor("XYZ")).toBeNull();
    expect(currencyFor("ZWL")).toBeNull();
  });

  it("returns null rather than throwing on an absent answer", () => {
    expect(currencyFor(null)).toBeNull();
    expect(currencyFor(undefined)).toBeNull();
    expect(currencyFor("")).toBeNull();
  });

  it("does not accept a name or a symbol as a code", () => {
    expect(currencyFor("Rupees")).toBeNull();
    expect(currencyFor("₹")).toBeNull();
  });
});

describe("minor units", () => {
  it("knows that most currencies have two", () => {
    expect(currencyFor("INR")?.exponent).toBe(2);
    expect(currencyFor("EUR")?.exponent).toBe(2);
    expect(currencyFor("USD")?.exponent).toBe(2);
  });

  it("knows the yen has none", () => {
    // The reason this table exists. ADR 0004 stores money as integer minor units and
    // accepted that "minor-unit exponents vary by currency"; an amount in yen read against
    // an assumed exponent of 2 is wrong by a factor of a hundred, not merely mislabelled.
    expect(currencyFor("JPY")?.exponent).toBe(0);
  });

  it("knows the Gulf dinars have three", () => {
    expect(currencyFor("KWD")?.exponent).toBe(3);
    expect(currencyFor("BHD")?.exponent).toBe(3);
  });

  it("derives an exact multiplier without touching a float", () => {
    const rupee = currencyFor("INR")!;
    const yen = currencyFor("JPY")!;

    expect(10n ** BigInt(rupee.exponent)).toBe(100n);
    expect(10n ** BigInt(yen.exponent)).toBe(1n);
  });
});

describe("the supported table", () => {
  it("holds only well-formed ISO 4217 codes", () => {
    for (const currency of SUPPORTED_CURRENCIES) {
      expect(currency.code).toMatch(/^[A-Z]{3}$/);
      expect([0, 2, 3]).toContain(currency.exponent);
      expect(currency.name).not.toBe("");
    }
  });

  it("lists each currency once", () => {
    const codes = SUPPORTED_CURRENCIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("agrees with the lookup for every entry", () => {
    for (const currency of SUPPORTED_CURRENCIES) {
      expect(isKnownCurrency(currency.code)).toBe(true);
      expect(currencyFor(currency.code)).toEqual(currency);
    }
  });
});
