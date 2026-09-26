/**
 * What retrieval asks Gmail for.
 *
 * spec: docs/workflows/retrieve-invoices.md §6, §7, §8
 */

import { describe, expect, it } from "vitest";

import { keywordQuery, searchTerm, searchWindow, vendorQuery } from "../../src/retrieval/query";

describe("the search window", () => {
  it("covers seven days either side of the transaction", () => {
    // spec: retrieve-invoices §7
    const w = searchWindow("2026-04-14");

    expect(w.start).toBe("2026-04-07");
    expect(w.end).toBe("2026-04-21");
  });

  it("is sent as epoch seconds covering whole days, the last one included", () => {
    const w = searchWindow("2026-04-14");

    expect(w.afterEpoch).toBe(Date.parse("2026-04-07T00:00:00Z") / 1000);
    expect(w.beforeEpoch).toBe(Date.parse("2026-04-22T00:00:00Z") / 1000);
  });

  it("crosses a month and a year boundary without drama", () => {
    expect(searchWindow("2026-01-03")).toMatchObject({ start: "2025-12-27", end: "2026-01-10" });
  });
});

describe("the queries", () => {
  const w = searchWindow("2026-04-14");

  it("never mention an amount", () => {
    // spec: retrieve-invoices §8 — amount is a matching signal, never a search requirement.
    const queries = [vendorQuery(w, ["Anthropic", "Claude AI"]) ?? "", keywordQuery(w)];
    for (const query of queries) {
      expect(query).not.toMatch(/\d+\.\d{2}|₹|\$|rs\.?\s*\d/i);
    }
  });

  it("both require a PDF attachment and the window", () => {
    for (const query of [vendorQuery(w, ["Anthropic"]) ?? "", keywordQuery(w)]) {
      expect(query).toContain("has:attachment filename:pdf");
      expect(query).toContain(`after:${w.afterEpoch} before:${w.beforeEpoch}`);
    }
  });

  it("search a one-word vendor as a phrase and as a sender", () => {
    expect(vendorQuery(w, ["Anthropic"])).toContain('("Anthropic" OR from:Anthropic)');
  });

  it("search a several-word vendor as a phrase only", () => {
    const query = vendorQuery(w, ["ABC Foods Private Limited"]) ?? "";
    expect(query).toContain('"ABC Foods Private Limited"');
    expect(query).not.toContain("from:ABC");
  });

  it("do not search for the same name twice", () => {
    const query = vendorQuery(w, ["Anthropic", "Anthropic"]) ?? "";
    expect(query.match(/"Anthropic"/g)).toHaveLength(1);
  });

  it("have no vendor pass when there is no name to look for", () => {
    expect(vendorQuery(w, [])).toBeNull();
    expect(vendorQuery(w, ["  ", "-"])).toBeNull();
  });

  it("look for invoice words in the keyword pass", () => {
    expect(keywordQuery(w)).toContain('(invoice OR receipt OR bill OR "tax invoice" OR');
  });
});

describe("a name as a search term", () => {
  it("cannot smuggle an operator into the query", () => {
    expect(searchTerm('Acme: Labs "Pro"')).toBe('"Acme Labs Pro"');
    expect(searchTerm("-spam")).toBe('"spam"');
    expect(searchTerm("(from:evil)")).toBe('"from evil"');
  });
});
