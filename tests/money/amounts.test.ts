import { describe, expect, it } from "vitest";

import { readAmount } from "../../src/money/amounts";
import { currencyFor } from "../../src/money/currencies";

const INR = currencyFor("INR")!;
const EUR = currencyFor("EUR")!;
const JPY = currencyFor("JPY")!;
const KWD = currencyFor("KWD")!;

/** The magnitude alone, for the many cases where direction is not what is under test. */
function minor(text: string, currency = INR, separator: "." | "," = "."): bigint | null {
  return readAmount(text, currency, separator)?.minorUnits ?? null;
}

describe("reading a magnitude", () => {
  it("reads a plain amount into minor units", () => {
    expect(minor("1234.56")).toBe(123456n);
  });

  it("reads Indian grouping", () => {
    // spec: upload-statement §4. A lakh is grouped 1,20,000 rather than 120,000, and a
    // parser that assumes three-digit groups throughout still has to survive it.
    expect(minor("1,20,000.00")).toBe(12000000n);
    expect(minor("12,34,56,789.01")).toBe(12345678901n);
  });

  it("pads a short fraction rather than misreading it", () => {
    expect(minor("10.5")).toBe(1050n);
    expect(minor("10.")).toBe(1000n);
    expect(minor(".5")).toBe(50n);
  });

  it("reads a whole amount with no fraction at all", () => {
    expect(minor("4850")).toBe(485000n);
  });

  it("ignores currency symbols, codes and the spaces a PDF leaves behind", () => {
    expect(minor("₹ 4,850.00")).toBe(485000n);
    expect(minor("Rs. 4,850.00")).toBe(485000n);
    expect(minor("INR 4,850.00")).toBe(485000n);
    expect(minor("4 850.00")).toBe(485000n);
    expect(minor("4 850.00")).toBe(485000n);
  });

  it("assembles the number without ever touching a float", () => {
    // parseFloat("1234.56") * 100 is 123455.99999999999, and Step 5 compares these for
    // equality after adding thousands of them together.
    expect(minor("1234.56")).toBe(123456n);
    expect(minor("0.07")).toBe(7n);
    expect(minor("70.07")).toBe(7007n);
  });

  it("reads an amount larger than a double can hold exactly", () => {
    expect(minor("99,99,99,99,99,999.99")).toBe(999999999999999n);
  });
});

describe("grouping that does not group", () => {
  it("refuses a number whose groups are the wrong size", () => {
    // A sample statement printed its opening balance as £40,000,00 -- a typo for £40,000.00
    // -- and it was read as four million pounds, reporting a statement whose transactions
    // reconciled to the penny as out by £3,960,000. Refusing it sends the balance to the
    // fallback ADR 0009 already defines, which gives the right figure.
    expect(minor("40,000,00")).toBeNull();
    expect(minor("1,23,4")).toBeNull();
    expect(minor("12,3456")).toBeNull();
  });

  it("still accepts both conventions", () => {
    expect(minor("120,000.00")).toBe(12000000n);
    expect(minor("1,234,567.89")).toBe(123456789n);
    expect(minor("1,20,000.00")).toBe(12000000n);
    expect(minor("12,34,56,789.01")).toBe(12345678901n);
  });

  it("still accepts a number that needs no grouping at all", () => {
    expect(minor("999.00")).toBe(99900n);
    expect(minor("4850")).toBe(485000n);
  });

  it("checks the whole part, not the fraction", () => {
    expect(minor("1.234,56", EUR, ",")).toBe(123456n);
  });
});

describe("the decimal separator is told, never guessed", () => {
  it("reads a European statement when the mapping says the comma is decimal", () => {
    expect(minor("1.234,56", EUR, ",")).toBe(123456n);
    expect(minor("1.234.567,89", EUR, ",")).toBe(123456789n);
  });

  it("reads the same characters the other way when the mapping says so", () => {
    // The point of asking the file rather than the cell: `1.234` is a thousand in Mumbai
    // and one and a bit in Frankfurt, and the cell alone cannot say which.
    expect(minor("1.234", EUR, ",")).toBe(123400n);
    expect(minor("1,234", INR, ".")).toBe(123400n);

    // And told the other way round it is one rupee and 234 thousandths, which the rupee
    // has no room for — so it is refused rather than quietly rounded to 1.23.
    expect(minor("1.234", INR, ".")).toBeNull();
  });

  it("refuses a cell with two decimal points", () => {
    expect(minor("1.234.56")).toBeNull();
  });
});

describe("minor units follow the currency, not a habit", () => {
  it("scales a yen amount by nothing at all", () => {
    expect(minor("1234", JPY)).toBe(1234n);
  });

  it("accepts a yen amount printed with a zero fraction", () => {
    expect(minor("1,234.00", JPY)).toBe(1234n);
  });

  it("refuses a yen amount with a fraction it cannot hold", () => {
    // Truncating would file a number nobody typed; the currency table exists precisely so
    // this is caught rather than assumed away.
    expect(minor("1,234.50", JPY)).toBeNull();
  });

  it("scales a Kuwaiti dinar by three", () => {
    expect(minor("1.234", KWD)).toBe(1234n);
    expect(minor("1.2", KWD)).toBe(1200n);
  });
});

describe("what the cell says about direction", () => {
  it("reports a leading minus without folding it into the magnitude", () => {
    expect(readAmount("-1,200.00", INR)).toEqual({
      minorUnits: 120000n,
      sign: "NEGATIVE",
      marker: null,
    });
  });

  it("reports the unicode minus and the en dash a PDF exports", () => {
    expect(readAmount("−1200", INR)?.sign).toBe("NEGATIVE");
    expect(readAmount("–1200", INR)?.sign).toBe("NEGATIVE");
  });

  it("reports a trailing minus", () => {
    expect(readAmount("1200.00-", INR)?.sign).toBe("NEGATIVE");
  });

  it("reports a parenthesised amount as negative", () => {
    expect(readAmount("(1,200.00)", INR)).toEqual({
      minorUnits: 120000n,
      sign: "NEGATIVE",
      marker: null,
    });
  });

  it("reports a printed Dr or Cr marker", () => {
    expect(readAmount("1,200.00 Dr", INR)?.marker).toBe("DEBIT");
    expect(readAmount("1,200.00 CR", INR)?.marker).toBe("CREDIT");
    expect(readAmount("Dr. 1,200.00", INR)?.marker).toBe("DEBIT");
  });

  it("keeps the sign and the marker apart when a cell carries both", () => {
    // They can disagree, and reconciling them against the mapping is the walker's job.
    expect(readAmount("(1,200.00) DR", INR)).toEqual({
      minorUnits: 120000n,
      sign: "NEGATIVE",
      marker: "DEBIT",
    });
  });

  it("does not find a marker inside a word", () => {
    expect(readAmount("100 MCR", INR)?.marker).toBeNull();
  });

  it("leaves an unsigned, unmarked amount saying nothing about direction", () => {
    expect(readAmount("1200.00", INR)).toEqual({ minorUnits: 120000n, sign: null, marker: null });
  });
});

describe("declining to read", () => {
  it("returns null for an empty cell", () => {
    expect(minor("")).toBeNull();
    expect(minor("   ")).toBeNull();
  });

  it("returns null for the dashes and words that stand in for nil", () => {
    expect(minor("-")).toBeNull();
    expect(minor("—")).toBeNull();
    expect(minor("NIL")).toBeNull();
    expect(minor("N/A")).toBeNull();
  });

  it("returns null for a column header", () => {
    // This is what keeps a repeated header out of the statement lines: the walker asks for
    // an amount, does not get one, and skips the row.
    expect(minor("Withdrawal (Dr)")).toBeNull();
    expect(minor("Amount")).toBeNull();
    expect(minor("Balance")).toBeNull();
  });

  it("returns null for a bare marker with no amount behind it", () => {
    expect(minor("Cr")).toBeNull();
  });

  it("refuses a cell with a character it does not recognise", () => {
    // Found while testing the scanned path. Discarding anything non-numeric turned a
    // garbled transcription into a confident wrong number -- `1,87,4??.00` lost its two
    // question marks and parsed cleanly as 1874.00, on the one path where ADR 0003 says
    // there is no deterministic layer beneath to catch a misread digit.
    expect(minor("1,87,4??.00")).toBeNull();
    expect(minor("4,850.00 *")).toBeNull();
    expect(minor("48#50.00")).toBeNull();
  });

  it("refuses an identifier that happens to sit in an amount column", () => {
    // Found on two real statements. An IBAN in a column the mapping called "credit" was
    // read as 1.49e18 minor units, and a page footer as a ₹11,95,001 credit -- both became
    // transactions and broke their statement's balance by exactly their own size. A
    // currency is written beside an amount, never threaded through it.
    expect(minor("IE12 BOFI 9000 1775 0694 08", EUR)).toBeNull();
    expect(minor("PAN AAACI1195B STC No 12345")).toBeNull();
    expect(minor("MHW1-WBG-M-03-Mar")).toBeNull();
  });

  it("refuses a bank code that runs straight into its digits", () => {
    // An IFSC code in a column the mapping had called "credit" lost its four letters and
    // arrived as a ₹202.00 receipt -- exactly the amount a real ICICI statement then failed
    // to reconcile by. A currency word is separated from its number; an identifier is not.
    expect(minor("ICIC0000202")).toBeNull();
    expect(minor("HDFC0001116")).toBeNull();
    expect(minor("UTIB0000870")).toBeNull();
  });

  it("still reads a currency word that is properly separated", () => {
    expect(minor("Rs. 4,850.00")).toBe(485000n);
    expect(minor("Rs.4,850.00")).toBe(485000n);
    expect(minor("INR 4,850.00")).toBe(485000n);
  });

  it("still discards the currency symbols and spaces that are only decoration", () => {
    expect(minor("₹4,850.00")).toBe(485000n);
    expect(minor("₨ 4,850.00")).toBe(485000n);
  });
});
