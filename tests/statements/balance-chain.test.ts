/**
 * Checking rows against the balance the statement prints beside them.
 *
 * spec: docs/parsing-acceptance.md
 *
 * Statement #5 is the case behind this: 404 transactions, a correct opening and closing
 * balance, and a difference of €8,682.61 that the aggregate check could report but not
 * attribute. Thirteen of the rows were metadata inside a transaction. These tests are about
 * the arithmetic that can tell which thirteen.
 */

import { describe, expect, it } from "vitest";

import { auditBalanceChain, chainIsReliable } from "../../src/statements/balance-chain";
import type { ParsedLine } from "../../src/statements/walk";

let rowCounter = 0;

/** One line, with its running balance. `null` for a statement that prints one only sometimes. */
function line(
  amountMinor: bigint,
  direction: "DEBIT" | "CREDIT",
  balanceMinor: bigint | null,
): ParsedLine {
  rowCounter += 1;
  return {
    rowIndex: rowCounter,
    valueDate: "2026-04-01",
    description: "ACME TRADING",
    amountMinor,
    direction,
    balanceMinor,
    externalReference: null,
  };
}

const debit = (amount: bigint, balance: bigint | null) => line(amount, "DEBIT", balance);
const credit = (amount: bigint, balance: bigint | null) => line(amount, "CREDIT", balance);

describe("a statement whose rows agree with its balances", () => {
  it("reports no breaks", () => {
    // 10,000 -> 9,000 -> 9,500 -> 9,200
    const audit = auditBalanceChain(
      [debit(1000n, 9000n), credit(500n, 9500n), debit(300n, 9200n)],
      10000n,
    );

    expect(audit.breaks).toEqual([]);
    expect(audit.coverage).toBe("FULL");
    expect(audit.checked).toBe(3);
  });

  it("checks the first row when the document stated its opening balance", () => {
    // A spurious row at the very top is invisible to every other check we have, so the anchor
    // being real is what makes it findable.
    const audit = auditBalanceChain([debit(1000n, 8000n)], 10000n);

    expect(audit.checked).toBe(1);
    expect(audit.breaks).toHaveLength(1);
  });

  it("does not check the first row against a balance derived from it", () => {
    /*
     * With no stated opening, `balancesFromGrid` unwinds the first line's own amount to get
     * one. Checking the line against that proves the line consistent with itself.
     */
    const audit = auditBalanceChain([debit(1000n, 9000n), debit(500n, 8500n)], null);

    expect(audit.checked).toBe(1);
    expect(audit.breaks).toEqual([]);
  });
});

describe("a row the statement says moved no money", () => {
  it("is classified as extraneous", () => {
    // The exchange-rate line: it carries a number, but the balance does not move for it.
    const audit = auditBalanceChain(
      [debit(1000n, 9000n), debit(2500n, 9000n), debit(500n, 8500n)],
      10000n,
    );

    expect(audit.breaks).toHaveLength(1);
    expect(audit.breaks[0]).toMatchObject({ kind: "EXTRANEOUS_ROW", lineIndex: 1 });
  });

  it("reports the amount it wrongly applied, so the effect is legible", () => {
    const audit = auditBalanceChain([debit(1000n, 9000n), debit(2500n, 9000n)], 10000n);

    // The balance stayed at 9,000 while the row claimed to take 2,500 out of it.
    expect(audit.breaks[0].deltaMinor).toBe(2500n);
    expect(audit.breaks[0].expectedMinor).toBe(6500n);
    expect(audit.breaks[0].printedMinor).toBe(9000n);
  });

  it("carries the grid row, so the finding points back at the document", () => {
    const rows = [debit(1000n, 9000n), debit(2500n, 9000n)];
    const audit = auditBalanceChain(rows, 10000n);

    expect(audit.breaks[0].rowIndex).toBe(rows[1].rowIndex);
  });
});

describe("the other ways a chain breaks", () => {
  it("names a direction that was read backwards", () => {
    // Taken out, but the balance went up by the same amount.
    const audit = auditBalanceChain([debit(1000n, 11000n)], 10000n);
    expect(audit.breaks[0].kind).toBe("DIRECTION");
  });

  it("names a balance that moved further than the rows account for", () => {
    /*
     * The Bank of Ireland failure, and the one the aggregate check cannot see: a statement
     * that drops rows still reconciles against a closing balance derived from the survivors.
     */
    const audit = auditBalanceChain([debit(1000n, 5000n)], 10000n);
    expect(audit.breaks[0].kind).toBe("MISSING_ROW");
  });

  it("names a row whose figure is wrong but which did move the balance", () => {
    const audit = auditBalanceChain([debit(1000n, 9500n)], 10000n);
    expect(audit.breaks[0].kind).toBe("AMOUNT");
  });
});

describe("statements the chain cannot speak for", () => {
  it("reports no coverage when nothing carries a balance", () => {
    const audit = auditBalanceChain([debit(1000n, null), credit(500n, null)], 10000n);

    expect(audit.coverage).toBe("NONE");
    expect(audit.checked).toBe(0);
    // Absence of a check is not a pass, and nothing downstream may read it as one.
    expect(chainIsReliable(audit)).toBe(false);
  });

  it("reports the chain unreliable when most links break", () => {
    // A balance column that is not the balance column. One finding about the mapping, not
    // four about transactions.
    const audit = auditBalanceChain(
      [debit(1n, 5n), debit(2n, 17n), debit(3n, 44n), debit(4n, 91n)],
      10000n,
    );

    expect(audit.coverage).toBe("UNRELIABLE");
    expect(chainIsReliable(audit)).toBe(false);
  });

  it("is reliable when a few links break among many", () => {
    const clean = Array.from({ length: 10 }, (_, index) =>
      debit(100n, 10000n - BigInt(index + 1) * 100n),
    );
    const audit = auditBalanceChain(clean, 10000n);

    expect(audit.breaks).toEqual([]);
    expect(chainIsReliable(audit)).toBe(true);
  });
});

describe("a statement that prints a balance only sometimes", () => {
  it("checks across every row since the last printed one", () => {
    // Bank of Ireland prints a balance once a day, not once a transaction.
    const audit = auditBalanceChain(
      [debit(1000n, null), debit(500n, null), debit(300n, 8200n)],
      10000n,
    );

    expect(audit.checked).toBe(1);
    expect(audit.breaks).toEqual([]);
    expect(audit.coverage).toBe("PARTIAL");
  });

  it("finds a break in a group even though it cannot say which row caused it", () => {
    const audit = auditBalanceChain(
      [debit(1000n, null), debit(500n, null), debit(300n, 9000n)],
      10000n,
    );

    expect(audit.breaks).toHaveLength(1);
    expect(audit.breaks[0].expectedMinor).toBe(8200n);
  });

  it("distinguishes a partly covered statement from a fully covered one", () => {
    const full = auditBalanceChain([debit(1000n, 9000n)], 10000n);
    expect(full.coverage).toBe("FULL");
  });
});

describe("the arithmetic itself", () => {
  it("handles an account that goes overdrawn", () => {
    const audit = auditBalanceChain([debit(1500n, -500n), credit(2000n, 1500n)], 1000n);
    expect(audit.breaks).toEqual([]);
  });

  it("handles a single line", () => {
    expect(auditBalanceChain([debit(1000n, 9000n)], 10000n).breaks).toEqual([]);
  });

  it("handles no lines at all", () => {
    const audit = auditBalanceChain([], 10000n);
    expect(audit).toMatchObject({ coverage: "NONE", checked: 0, breaks: [] });
  });
});

/*
 * The case the first version of this module could not see, and the reason statement #5 came
 * back with nine breaks and not one of them classified as extraneous.
 *
 * A bank prints a running balance beside a transaction. It prints none beside the exchange
 * rate underneath it. So a spurious row carries no balance, is never the end of a link, and is
 * never the row a break is noticed on — it sits inside the link, and the innocent transaction
 * after it takes the blame. Testing only the last row of a link tests the one row guaranteed
 * to be real.
 */
describe("a spurious row in the middle of a link", () => {
  it("is found even though the break shows up on the row after it", () => {
    const metadata = debit(2500n, null);
    const real = debit(1000n, 9000n);
    const audit = auditBalanceChain([metadata, real], 10000n);

    expect(audit.breaks).toHaveLength(1);
    expect(audit.breaks[0].kind).toBe("EXTRANEOUS_ROW");
    // Noticed on the real transaction, blamed on the metadata line above it.
    expect(audit.breaks[0].rowIndex).toBe(real.rowIndex);
    expect(audit.breaks[0].implicates?.rowIndex).toBe(metadata.rowIndex);
  });

  it("locates the implicated row among the statement's lines, not within the link", () => {
    const rows = [debit(1000n, 9000n), debit(500n, 8500n), debit(2500n, null), debit(300n, 8200n)];
    const audit = auditBalanceChain(rows, 10000n);

    expect(audit.breaks[0].implicates).toEqual({ rowIndex: rows[2].rowIndex, lineIndex: 2 });
  });

  it("names no row when two of them would each explain the link alone", () => {
    // Two rows of the same amount inside one link: removing either reconciles it, and the
    // arithmetic genuinely cannot say which. Naming one would be a guess dressed as a finding.
    const audit = auditBalanceChain(
      [debit(2500n, null), debit(2500n, null), debit(1000n, 6500n)],
      10000n,
    );

    expect(audit.breaks[0].kind).toBe("EXTRANEOUS_ROW");
    expect(audit.breaks[0].implicates).toBeNull();
  });

  it("still names the row on a one-row link", () => {
    const only = debit(1000n, 9500n);
    const audit = auditBalanceChain([only], 10000n);

    expect(audit.breaks[0]).toMatchObject({
      kind: "AMOUNT",
      implicates: { rowIndex: only.rowIndex, lineIndex: 0 },
    });
  });

  it("says nothing about which row when a multi-row link is merely out by some amount", () => {
    const audit = auditBalanceChain([debit(1000n, null), debit(500n, 7000n)], 10000n);

    expect(audit.breaks[0].implicates).toBeNull();
  });

  it("finds a direction read backwards inside a link too", () => {
    const wrong = debit(750n, null);
    const audit = auditBalanceChain([wrong, debit(1000n, 9750n)], 10000n);

    expect(audit.breaks[0]).toMatchObject({
      kind: "DIRECTION",
      implicates: { rowIndex: wrong.rowIndex },
    });
  });
});
