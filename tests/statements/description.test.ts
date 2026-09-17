import { describe, expect, it } from "vitest";

import { normalizeDescription } from "../../src/statements/description";

describe("folding away how a description was typeset", () => {
  it("ignores case", () => {
    expect(normalizeDescription("ACME Trading")).toBe(normalizeDescription("acme trading"));
  });

  it("ignores runs of whitespace", () => {
    expect(normalizeDescription("ACME   TRADING")).toBe(normalizeDescription("ACME TRADING"));
    expect(normalizeDescription("ACME\tTRADING\n")).toBe(normalizeDescription("ACME TRADING"));
  });

  it("ignores punctuation", () => {
    // The same movement seen through two exports.
    expect(normalizeDescription("UPI/ACME/123")).toBe(normalizeDescription("UPI ACME 123"));
    expect(normalizeDescription("NEFT-DR-UBIN0539686")).toBe(
      normalizeDescription("NEFT DR UBIN0539686"),
    );
  });

  it("ignores leading and trailing space", () => {
    expect(normalizeDescription("  ACME  ")).toBe("acme");
  });
});

describe("what it refuses to fold", () => {
  it("keeps two genuinely different descriptions different", () => {
    // spec: Step 5a -- normalized for formatting only, never interpreted. Deciding that
    // these are one vendor is entity resolution, and a false merge silently destroys a real
    // payment.
    expect(normalizeDescription("ACME TRADING")).not.toBe(
      normalizeDescription("ACME TRADING PVT LTD"),
    );
  });

  it("keeps the digits that distinguish two references", () => {
    expect(normalizeDescription("UPI/ACME/123")).not.toBe(normalizeDescription("UPI/ACME/124"));
  });

  it("does not merge two words into one", () => {
    expect(normalizeDescription("ACME TRADING")).not.toBe(normalizeDescription("ACMETRADING"));
  });
});

describe("a description that is not in Latin script", () => {
  it("survives rather than being flattened to nothing", () => {
    // Two ways to get this wrong. A rule written in terms of a-z erases the script
    // entirely and merges every transaction that used it. A rule keeping only letters and
    // digits drops the vowel signs -- which are Unicode marks, not letters -- and rewrites
    // मुंबई as म बई before using it as identity.
    expect(normalizeDescription("मुंबई")).toBe("मुंबई");
    expect(normalizeDescription("मुंबई/123")).toBe("मुंबई 123");
    expect(normalizeDescription("मुंबई")).not.toBe(normalizeDescription("दिल्ली"));
  });

  it("still folds punctuation around it", () => {
    expect(normalizeDescription("UPI/मुंबई/123")).toBe(normalizeDescription("UPI मुंबई 123"));
  });
});

describe("an empty description", () => {
  it("normalizes to nothing rather than throwing", () => {
    expect(normalizeDescription("")).toBe("");
    expect(normalizeDescription("///")).toBe("");
  });
});
