import { describe, expect, it } from "vitest";

import { renderSample } from "../../src/statements/sample";

/** A grid with `count` transaction rows under a header. */
function statement(count: number) {
  const rows = [
    ["HDFC Bank", "", "", ""],
    ["Date", "Narration", "Withdrawal", "Balance"],
  ];
  for (let i = 0; i < count; i += 1) {
    rows.push([`0${(i % 9) + 1}/08/2023`, `PAYMENT ${i}`, "4,850.00", "1,20,000.00"]);
  }
  return rows;
}

describe("what the model is shown", () => {
  it("labels every cell with its own column index", () => {
    // The model's every answer is an index, so an off-by-one maps the balance column as the
    // deposit column. Labelling removes the counting rather than hoping it goes well.
    const sample = renderSample([["01/08/2023", "ACME", "4,850.00"]]);
    expect(sample).toContain('c0="01/08/2023"');
    expect(sample).toContain('c1="ACME"');
    expect(sample).toContain('c2="4,850.00"');
  });

  it("omits empty cells rather than showing a gap to be counted", () => {
    const sample = renderSample([["01/08/2023", "", "", "4,850.00"]]);
    expect(sample).toContain('c0="01/08/2023"');
    expect(sample).toContain('c3="4,850.00"');
    expect(sample).not.toContain('c1=""');
  });

  it("numbers rows with their real index", () => {
    const sample = renderSample(statement(3));
    expect(sample).toContain("row 0 |");
    expect(sample).toContain("row 1 |");
    expect(sample).toContain("row 4 |");
  });

  it("says how large the statement is", () => {
    expect(renderSample(statement(10))).toContain("12 rows and 4 columns");
  });

  it("marks a row with nothing in it", () => {
    expect(renderSample([["", ""]])).toContain("row 0 | (empty)");
  });
});

describe("sampling a long statement", () => {
  const long = statement(400);
  const sample = renderSample(long);

  it("shows the top, where the header and the first transactions are", () => {
    expect(sample).toContain("row 0 |");
    expect(sample).toContain("row 44 |");
  });

  it("shows the bottom, where the closing balance usually is", () => {
    // ADR 0009 asks the model to point at the closing balance, which on many statements is
    // printed under the table. A window from the top alone can never see it.
    expect(sample).toContain(`row ${long.length - 1} |`);
  });

  it("says what it left out rather than eliding it silently", () => {
    expect(sample).toMatch(/rows 45 to \d+ omitted/);
  });

  it("keeps the real row index on the tail rows", () => {
    // A locator is an index into the whole grid. Renumbering the sample would return
    // locators pointing at the wrong place in the document.
    const lines = sample.split("\n").filter((line) => line.startsWith("row "));
    const last = lines[lines.length - 1];
    expect(last.startsWith(`row ${long.length - 1} `)).toBe(true);
  });

  it("does not show every row of a four-hundred-row statement", () => {
    const shown = sample.split("\n").filter((line) => line.startsWith("row ")).length;
    expect(shown).toBeLessThan(long.length);
    expect(shown).toBe(45 + 15);
  });
});

describe("a very long cell", () => {
  it("is truncated rather than allowed to crowd out the row", () => {
    const narration = "X".repeat(200);
    const sample = renderSample([["01/08/2023", narration, "4,850.00"]]);
    expect(sample).toContain("…");
    expect(sample).not.toContain(narration);
    expect(sample).toContain('c2="4,850.00"');
  });
});
