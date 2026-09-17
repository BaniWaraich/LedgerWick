import { describe, expect, it } from "vitest";

import { currencyFor } from "../../src/money/currencies";
import { formatAmount } from "../../src/money/format";

const INR = currencyFor("INR")!;
const USD = currencyFor("USD")!;
const JPY = currencyFor("JPY")!;
const KWD = currencyFor("KWD")!;
const CHF = currencyFor("CHF")!;

describe("showing an amount", () => {
  it("puts the decimal point where the currency says", () => {
    expect(formatAmount(485000n, INR)).toBe("₹4,850.00");
    expect(formatAmount(7n, INR)).toBe("₹0.07");
  });

  it("shows a currency with no minor unit as a whole number", () => {
    expect(formatAmount(1234n, JPY)).toBe("¥1,234");
  });

  it("shows a currency with three minor digits", () => {
    expect(formatAmount(1234n, KWD)).toBe("KWD 1.234");
  });

  it("shows a negative amount, because an account can be overdrawn", () => {
    expect(formatAmount(-120000n, INR)).toBe("-₹1,200.00");
  });

  it("shows zero", () => {
    expect(formatAmount(0n, INR)).toBe("₹0.00");
  });

  it("falls back to the ISO code where a symbol would be ambiguous", () => {
    // The same care identify-statement.v2 takes over reading one: a bare $ is USD, SGD,
    // AUD, CAD and HKD among others.
    expect(formatAmount(100n, CHF)).toBe("CHF 1.00");
  });
});

describe("grouping", () => {
  it("groups rupees in lakhs and crores", () => {
    // An Indian business reads 1,20,000 and would have to stop and count the digits in
    // 120,000 -- and this figure is about to be checked against their own bank statement.
    expect(formatAmount(12000000n, INR)).toBe("₹1,20,000.00");
    expect(formatAmount(12345678901n, INR)).toBe("₹12,34,56,789.01");
  });

  it("groups everything else in thousands", () => {
    expect(formatAmount(12000000n, USD)).toBe("$120,000.00");
    expect(formatAmount(123456789n, USD)).toBe("$1,234,567.89");
  });

  it("does not group what does not need it", () => {
    expect(formatAmount(10000n, INR)).toBe("₹100.00");
    expect(formatAmount(99900n, INR)).toBe("₹999.00");
    expect(formatAmount(100000n, INR)).toBe("₹1,000.00");
  });

  it("stays exact past what a float could hold", () => {
    // bigint throughout, like the rest of the money code. A crore is not a special case
    // here, it is a longer string.
    expect(formatAmount(999999999999999n, INR)).toBe("₹99,99,99,99,99,999.99");
  });
});
