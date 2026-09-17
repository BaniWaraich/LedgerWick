import { describe, expect, it } from "vitest";

import type { ColumnMapping } from "../../src/ai/prompts/map-statement-columns.v1";
import { currencyFor } from "../../src/money/currencies";
import { walkStatement } from "../../src/statements/walk";

const INR = currencyFor("INR")!;

/** A debit/credit statement: date, narration, reference, withdrawal, deposit, balance. */
const PAIRED: ColumnMapping = {
  headerRow: 0,
  firstDataRow: 1,
  dateColumn: 0,
  dateOrder: "DMY",
  descriptionColumns: [1],
  referenceColumn: 2,
  balanceColumn: 5,
  amountShape: "DEBIT_CREDIT",
  debitColumn: 3,
  creditColumn: 4,
  amountColumn: null,
  indicatorColumn: null,
  decimalSeparator: ".",
  openingBalanceCell: null,
  closingBalanceCell: null,
};

const HEADER = ["Date", "Narration", "Ref", "Withdrawal", "Deposit", "Balance"];

function walk(rows: string[][], mapping: ColumnMapping = PAIRED) {
  return walkStatement([HEADER, ...rows], mapping, INR);
}

describe("walking a debit and credit statement", () => {
  it("reads a withdrawal", () => {
    const { lines } = walk([["01/08/2023", "ACME TRADING", "REF1", "4,850.00", "", "1,20,000.00"]]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      valueDate: "2023-08-01",
      description: "ACME TRADING",
      amountMinor: 485000n,
      direction: "DEBIT",
      balanceMinor: 12000000n,
      externalReference: "REF1",
    });
  });

  it("reads a deposit", () => {
    const { lines } = walk([["01/08/2023", "SALARY", "", "", "50,000.00", "1,70,000.00"]]);
    expect(lines[0]).toMatchObject({ amountMinor: 5000000n, direction: "CREDIT" });
  });

  it("treats a zero in the unused column as empty", () => {
    // Plenty of banks write 0.00 rather than leaving the cell blank.
    const { lines } = walk([["01/08/2023", "ACME", "", "4,850.00", "0.00", "1,20,000.00"]]);
    expect(lines[0]).toMatchObject({ amountMinor: 485000n, direction: "DEBIT" });
  });

  it("skips a row where both columns are filled", () => {
    // Not a transaction with two amounts: a sign that one of these columns is something
    // else, most often the running balance, which every row fills.
    const { lines, skipped } = walk([["01/08/2023", "ACME", "", "4,850.00", "50.00", "1,20,000"]]);
    expect(lines).toHaveLength(0);
    expect(skipped[0].reason).toBe("both a debit and a credit");
  });

  it("records a negative balance for an overdrawn account", () => {
    const { lines } = walk([["01/08/2023", "ACME", "", "4,850.00", "", "(1,200.00)"]]);
    expect(lines[0].balanceMinor).toBe(-120000n);
  });

  it("carries the row's own index, so a bad line is traceable to the file", () => {
    const { lines } = walk([
      ["01/08/2023", "A", "", "1.00", "", ""],
      ["02/08/2023", "B", "", "2.00", "", ""],
    ]);
    expect(lines.map((line) => line.rowIndex)).toEqual([1, 2]);
  });
});

describe("the rows a statement holds that are not transactions", () => {
  it("skips a repeated header and counts it", () => {
    // Between transactions sit repeated page headers, footers, totals and advertising. The
    // walk has no list of those -- a list would be a per-bank parser by another name.
    const { lines, skipped } = walk([
      ["01/08/2023", "ACME", "", "4,850.00", "", "1,20,000.00"],
      HEADER,
      ["02/08/2023", "BETA", "", "1,000.00", "", "1,19,000.00"],
    ]);

    expect(lines).toHaveLength(2);
    // "no amount" rather than "no date": the amount is what identifies a transaction now,
    // because a date may legitimately be absent on a statement that prints it once a day.
    expect(skipped).toEqual([{ rowIndex: 2, reason: "no amount" }]);
  });

  it("skips a carried-forward line, which has a date and no amount", () => {
    const { lines, skipped } = walk([
      ["01/08/2023", "B/F BROUGHT FORWARD", "", "", "", "1,20,000.00"],
      ["02/08/2023", "ACME", "", "4,850.00", "", "1,15,150.00"],
    ]);

    expect(lines).toHaveLength(1);
    expect(skipped).toEqual([{ rowIndex: 1, reason: "no amount" }]);
  });

  it("skips an empty row", () => {
    const { lines, skipped } = walk([["", "", "", "", "", ""]]);
    expect(lines).toHaveLength(0);
    expect(skipped).toHaveLength(1);
  });

  it("counts every skip, because a wrong mapping skips almost everything", () => {
    // The evidence that matters. A subtly wrong mapping does not throw; it produces a walk
    // with four transactions in it, and a silent skip would hide that entirely.
    const wrong = { ...PAIRED, dateColumn: 1 };
    const { lines, skipped } = walk(
      [
        ["01/08/2023", "ACME", "", "4,850.00", "", "1,20,000.00"],
        ["02/08/2023", "BETA", "", "1,000.00", "", "1,19,000.00"],
      ],
      wrong,
    );

    expect(lines).toHaveLength(0);
    expect(skipped).toHaveLength(2);
  });
});

describe("a single amount column carrying its own sign", () => {
  const signedMapping: ColumnMapping = {
    ...PAIRED,
    amountShape: "SIGNED_AMOUNT",
    debitColumn: null,
    creditColumn: null,
    amountColumn: 3,
  };

  it("reads a minus as money out", () => {
    const { lines } = walk([["01/08/2023", "ACME", "", "-4,850.00", "", ""]], signedMapping);
    expect(lines[0]).toMatchObject({ amountMinor: 485000n, direction: "DEBIT" });
  });

  it("reads brackets as money out", () => {
    const { lines } = walk([["01/08/2023", "ACME", "", "(4,850.00)", "", ""]], signedMapping);
    expect(lines[0].direction).toBe("DEBIT");
  });

  it("reads a Dr printed inside the amount cell", () => {
    const { lines } = walk([["01/08/2023", "ACME", "", "4,850.00 Dr", "", ""]], signedMapping);
    expect(lines[0].direction).toBe("DEBIT");
  });

  it("reads an unsigned value as money in", () => {
    // What an unsigned number in a signed column means arithmetically. If the mapping is
    // wrong about this, the balance check is what says so.
    const { lines } = walk([["01/08/2023", "SALARY", "", "50,000.00", "", ""]], signedMapping);
    expect(lines[0].direction).toBe("CREDIT");
  });
});

describe("an amount column with a separate indicator", () => {
  const indicated: ColumnMapping = {
    ...PAIRED,
    amountShape: "AMOUNT_WITH_INDICATOR",
    debitColumn: null,
    creditColumn: null,
    amountColumn: 3,
    indicatorColumn: 4,
  };

  it("reads Dr and Cr", () => {
    const { lines } = walk(
      [
        ["01/08/2023", "ACME", "", "4,850.00", "Dr", ""],
        ["02/08/2023", "SALARY", "", "50,000.00", "Cr", ""],
      ],
      indicated,
    );
    expect(lines.map((line) => line.direction)).toEqual(["DEBIT", "CREDIT"]);
  });

  it("reads however the bank abbreviates it", () => {
    // The same column is written Dr, DR, D, Debit and Dr. by different banks, and
    // occasionally by one bank on different pages.
    const rows = [
      ["01/08/2023", "A", "", "1.00", "DR", ""],
      ["02/08/2023", "B", "", "1.00", "D", ""],
      ["03/08/2023", "C", "", "1.00", "Debit", ""],
      ["04/08/2023", "D", "", "1.00", "credit", ""],
      ["05/08/2023", "E", "", "1.00", "+", ""],
    ];
    const { lines } = walk(rows, indicated);
    expect(lines.map((line) => line.direction)).toEqual([
      "DEBIT",
      "DEBIT",
      "DEBIT",
      "CREDIT",
      "CREDIT",
    ]);
  });

  it("falls back to the amount cell when the indicator is not one it knows", () => {
    const { lines } = walk([["01/08/2023", "A", "", "-1.00", "???", ""]], indicated);
    expect(lines[0].direction).toBe("DEBIT");
  });
});

describe("the reference column", () => {
  it("keeps a real reference", () => {
    const { lines } = walk([["01/08/2023", "A", "N155180555427618", "1.00", "", ""]]);
    expect(lines[0].externalReference).toBe("N155180555427618");
  });

  it("discards a placeholder of zeros", () => {
    // Not untidiness -- a serious bug. canonical_transactions_reference_idx makes a
    // reference identity on its own, so a hundred rows sharing one placeholder would
    // collapse into a single transaction: the false merge Step 5a calls the failure that
    // silently destroys a real payment.
    const { lines } = walk([
      ["01/08/2023", "A", "000000000000000", "1.00", "", ""],
      ["02/08/2023", "B", "000000000000000", "2.00", "", ""],
      ["03/08/2023", "C", "-", "3.00", "", ""],
      ["04/08/2023", "D", "", "4.00", "", ""],
    ]);
    expect(lines.map((line) => line.externalReference)).toEqual([null, null, null, null]);
  });
});

describe("the description", () => {
  it("joins the columns the mapping names, in order", () => {
    const split = { ...PAIRED, descriptionColumns: [1, 2], referenceColumn: null };
    const { lines } = walk([["01/08/2023", "UPI", "ACME TRADING", "1.00", "", ""]], split);
    expect(lines[0].description).toBe("UPI ACME TRADING");
  });

  it("collapses the whitespace a PDF leaves in it", () => {
    const { lines } = walk([["01/08/2023", "ACME   TRADING\n MUMBAI", "", "1.00", "", ""]]);
    expect(lines[0].description).toBe("ACME TRADING MUMBAI");
  });

  it("skips a description column that is empty on this row", () => {
    const split = { ...PAIRED, descriptionColumns: [1, 2], referenceColumn: null };
    const { lines } = walk([["01/08/2023", "", "ACME", "1.00", "", ""]], split);
    expect(lines[0].description).toBe("ACME");
  });
});

describe("where the walk starts", () => {
  it("begins at the row the mapping names and not before", () => {
    const { lines } = walk(
      [
        ["01/08/2023", "TITLE ROW THAT LOOKS LIKE DATA", "", "9.99", "", ""],
        ["02/08/2023", "ACME", "", "1.00", "", ""],
      ],
      { ...PAIRED, firstDataRow: 2 },
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].description).toBe("ACME");
  });

  it("survives a mapping that points past the end of the grid", () => {
    expect(
      walk([["01/08/2023", "A", "", "1.00", "", ""]], { ...PAIRED, firstDataRow: 99 }),
    ).toEqual({ lines: [], skipped: [] });
  });

  it("survives a mapping naming a column the grid does not have", () => {
    const { lines, skipped } = walk([["01/08/2023", "A", "", "1.00", "", ""]], {
      ...PAIRED,
      debitColumn: 42,
      creditColumn: 43,
    });
    expect(lines).toHaveLength(0);
    expect(skipped[0].reason).toBe("no amount");
  });
});

describe("a statement that prints the date only when it changes", () => {
  // Bank of Ireland does this. Requiring a date on every row threw away 238 of its 335
  // payments -- 71% of a real statement, silently -- and reported a discrepancy of
  // €14,349.88 rather than saying anything about the rows it had dropped.

  it("carries the date forward to the rows beneath it", () => {
    const { lines } = walk([
      ["01/08/2023", "FIRST OF THE DAY", "", "10.00", "", ""],
      ["", "SECOND OF THE DAY", "", "20.00", "", ""],
      ["", "THIRD OF THE DAY", "", "30.00", "", ""],
      ["02/08/2023", "NEXT DAY", "", "40.00", "", ""],
    ]);

    expect(lines).toHaveLength(4);
    expect(lines.map((line) => line.valueDate)).toEqual([
      "2023-08-01",
      "2023-08-01",
      "2023-08-01",
      "2023-08-02",
    ]);
  });

  it("never carries a date backward", () => {
    // A date belongs to the rows beneath it and nothing above it.
    const { lines, skipped } = walk([
      ["", "BEFORE ANY DATE", "", "10.00", "", ""],
      ["02/08/2023", "AFTER", "", "20.00", "", ""],
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0].description).toBe("AFTER");
    expect(skipped[0]).toEqual({ rowIndex: 1, reason: "no date" });
  });

  it("still refuses a row that has a date and no amount", () => {
    const { lines, skipped } = walk([
      ["01/08/2023", "ACME", "", "10.00", "", ""],
      ["02/08/2023", "B/F CARRIED FORWARD", "", "", "", "1,00,000.00"],
    ]);

    expect(lines).toHaveLength(1);
    expect(skipped[0].reason).toBe("no amount");
  });
});

describe("a narration that is taller than the figures beside it", () => {
  // ICICI renders one transaction as three baselines: narration, then the date and amounts,
  // then more narration, with the numbers centred against the text. Reading the description
  // off the amount's own row found one for 98 of 728 transactions.

  it("gathers the line above and the line below", () => {
    const { lines } = walk([
      ["", "UPI/123456789/PART ONE", "", "", "", ""],
      ["01/08/2023", "", "", "4,850.00", "", "1,20,000.00"],
      ["", "PART TWO", "", "", "", ""],
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0].description).toBe("UPI/123456789/PART ONE PART TWO");
  });

  it("reads the gathered lines in the order they appear on the page", () => {
    const { lines } = walk([
      ["", "FIRST", "", "", "", ""],
      ["01/08/2023", "MIDDLE", "", "4,850.00", "", ""],
      ["", "LAST", "", "", "", ""],
    ]);

    expect(lines[0].description).toBe("FIRST MIDDLE LAST");
  });

  it("gives each transaction the narration nearest to it", () => {
    const { lines } = walk([
      ["", "BELONGS TO A", "", "", "", ""],
      ["01/08/2023", "", "", "10.00", "", ""],
      ["", "ALSO A", "", "", "", ""],
      ["", "BELONGS TO B", "", "", "", ""],
      ["02/08/2023", "", "", "20.00", "", ""],
      ["", "ALSO B", "", "", "", ""],
    ]);

    expect(lines).toHaveLength(2);
    expect(lines[0].description).toBe("BELONGS TO A ALSO A");
    expect(lines[1].description).toBe("BELONGS TO B ALSO B");
  });

  it("does not absorb a repeated column header", () => {
    // The guard that matters. A header has text in the date and amount columns too, so it
    // is not a bare line of narration and never joins the transaction beside it.
    const { lines } = walk([
      ["01/08/2023", "ACME", "", "10.00", "", ""],
      HEADER,
      ["02/08/2023", "BETA", "", "20.00", "", ""],
    ]);

    expect(lines.map((line) => line.description)).toEqual(["ACME", "BETA"]);
  });

  it("does not absorb a totals row", () => {
    const { lines } = walk([
      ["01/08/2023", "ACME", "", "10.00", "", ""],
      ["", "TOTAL", "", "10.00", "", ""],
    ]);

    // The totals row carries an amount, so it is read as a transaction rather than as
    // narration -- wrong, but visibly wrong: it shifts the balance and the check catches it.
    expect(lines[0].description).toBe("ACME");
  });

  it("does not reach a stray line far from any transaction", () => {
    const { lines } = walk([
      ["01/08/2023", "ACME", "", "10.00", "", ""],
      ["", "", "", "", "", ""],
      ["", "", "", "", "", ""],
      ["", "AN ADDRESS BLOCK FAR BELOW", "", "", "", ""],
    ]);

    expect(lines[0].description).toBe("ACME");
  });
});

describe("a continuation row whose column the mapping did not name", () => {
  it("is still read, because a bare row is narration and nothing else", () => {
    // A wrapped narration does not break along the columns a model chose. Asked to name
    // ICICI's description columns it answered [2,3,4] once and [3,4] the next time, and the
    // second answer stranded fragments in a column nobody had claimed -- leaving 26
    // transactions with no description at all.
    // Column 2 is named by nothing here: not the description, not the reference.
    const unnamed = { ...PAIRED, referenceColumn: null };
    const { lines } = walk(
      [
        ["", "", "STRANDED IN COLUMN 2", "", "", ""],
        ["01/08/2023", "ACME", "", "4,850.00", "", ""],
      ],
      unnamed,
    );

    expect(lines[0].description).toBe("STRANDED IN COLUMN 2 ACME");
  });

  it("never turns a structural cell into narration", () => {
    // The transaction's own row is read through the mapping, because it has a date, an
    // amount and a balance on it. Only a continuation row is read wholesale.
    const { lines } = walk([["01/08/2023", "ACME", "REF9", "4,850.00", "", "1,20,000.00"]]);

    expect(lines[0].description).toBe("ACME");
    expect(lines[0].externalReference).toBe("REF9");
  });

  it("does not gather a row that has anything structural on it", () => {
    const { lines } = walk([
      ["", "", "", "", "", "1,20,000.00"],
      ["01/08/2023", "ACME", "", "4,850.00", "", ""],
    ]);

    expect(lines[0].description).toBe("ACME");
  });
});
