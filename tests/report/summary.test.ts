/**
 * Every requirement, counted once.
 *
 * spec: docs/workflows/missing-invoice-report.md §5, §7
 * decision: docs/decisions/0014-report-counts-live-across-the-workspace.md
 */

import { describe, expect, it } from "vitest";

import { requirementStateEnum, resolutionMethodEnum } from "../../src/db/schema";
import {
  bucketOf,
  FILTERS,
  parseFilter,
  QUEUE_STATES,
  statesFor,
  summarize,
  type ResolutionMethod,
} from "../../src/report/summary";

const STATES = requirementStateEnum.enumValues;
const METHODS = resolutionMethodEnum.enumValues;

describe("bucketOf", () => {
  it("counts a resolved requirement as matched however it was linked", () => {
    for (const method of METHODS.filter((m) => m !== "NOT_REQUIRED")) {
      expect(bucketOf("RESOLVED", method)).toBe("matched");
    }
  });

  it("keeps a requirement the user said needs no document out of matched", () => {
    expect(bucketOf("RESOLVED", "NOT_REQUIRED")).toBe("notRequired");
  });

  it("places the states the user acts on in their own lines", () => {
    expect(bucketOf("NOT_FOUND", null)).toBe("notFound");
    expect(bucketOf("NEEDS_REVIEW", null)).toBe("needsReview");
    expect(bucketOf("BLOCKED", null)).toBe("blocked");
  });

  it("counts everything still in progress, failures included, as waiting", () => {
    for (const state of ["IDENTIFIED", "SEARCHING", "EVALUATING", "FAILED"] as const) {
      expect(bucketOf(state, null)).toBe("waiting");
    }
  });
});

describe("summarize", () => {
  it("sums to documents required for every state and method there is", () => {
    const every = STATES.flatMap((state) =>
      (state === "RESOLVED" ? METHODS : [null]).map((method) => ({
        state,
        resolutionMethod: method as ResolutionMethod | null,
      })),
    );

    const summary = summarize(every);

    expect(
      summary.matched + summary.notFound + summary.needsReview + summary.waiting + summary.blocked,
    ).toBe(summary.documentsRequired);
    // Nothing is lost: the lines together account for every requirement.
    expect(summary.documentsRequired + summary.notRequired).toBe(every.length);
  });

  it("leaves no-document-needed out of documents required", () => {
    const summary = summarize([
      { state: "RESOLVED", resolutionMethod: "NOT_REQUIRED" },
      { state: "NOT_FOUND", resolutionMethod: null },
    ]);

    expect(summary.documentsRequired).toBe(1);
    expect(summary.notRequired).toBe(1);
  });

  it("reports zero of everything for a workspace with no requirements", () => {
    expect(summarize([])).toEqual({
      documentsRequired: 0,
      matched: 0,
      notFound: 0,
      needsReview: 0,
      waiting: 0,
      blocked: 0,
      notRequired: 0,
    });
  });
});

describe("filters", () => {
  it("treats a missing or unknown filter as all", () => {
    expect(parseFilter(undefined)).toBe("all");
    expect(parseFilter("RESOLVED")).toBe("all");
    expect(parseFilter(["not-found", "waiting"])).toBe("all");
  });

  it("accepts each filter the page offers", () => {
    for (const filter of FILTERS) expect(parseFilter(filter)).toBe(filter);
  });

  it("never lets any filter reach a resolved or blocked requirement", () => {
    for (const filter of [...FILTERS, "all"] as const) {
      const states: readonly string[] = statesFor(filter);
      expect(states).not.toContain("RESOLVED");
      expect(states).not.toContain("BLOCKED");
    }
  });

  it("shows every queue state under all, decisions first", () => {
    expect(statesFor("all")).toEqual(QUEUE_STATES);
    expect(QUEUE_STATES[0]).toBe("NEEDS_REVIEW");
  });
});
