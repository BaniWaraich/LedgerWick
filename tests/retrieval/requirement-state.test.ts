/**
 * Where retrieval may move a requirement, against the table in the state document.
 *
 * spec: docs/state-machines.md §2, "Transitions made by retrieval"
 */

import { describe, expect, it } from "vitest";

import { afterSearch } from "../../src/retrieval/decide";
import {
  nextRequirementState,
  SEARCHABLE_STATES,
  type RetrievalEvent,
} from "../../src/retrieval/requirement-state";
import { requirementStateEnum } from "../../src/db/schema";

describe("the retrieval transitions", () => {
  it("start a search from every state the document lists, and no other", () => {
    expect([...SEARCHABLE_STATES].sort()).toEqual(
      ["BLOCKED", "FAILED", "IDENTIFIED", "NOT_FOUND"].sort(),
    );
    expect(nextRequirementState("NEEDS_REVIEW", "SEARCH_STARTED")).toBeNull();
    expect(nextRequirementState("EVALUATING", "SEARCH_STARTED")).toBeNull();
  });

  it("let a retried search re-enter SEARCHING", () => {
    expect(nextRequirementState("SEARCHING", "SEARCH_STARTED")).toBe("SEARCHING");
  });

  it("never move a resolved requirement", () => {
    const events: RetrievalEvent[] = [
      "SEARCH_STARTED",
      "DOCUMENTS_FETCHED",
      "SETTLED_NEEDS_REVIEW",
      "SETTLED_NOT_FOUND",
      "SETTLED_BLOCKED",
      "FAILED",
    ];
    for (const event of events) expect(nextRequirementState("RESOLVED", event)).toBeNull();
  });

  it("only send a requirement to review after something was assessed", () => {
    expect(nextRequirementState("SEARCHING", "SETTLED_NEEDS_REVIEW")).toBeNull();
    expect(nextRequirementState("EVALUATING", "SETTLED_NEEDS_REVIEW")).toBe("NEEDS_REVIEW");
  });

  it("only name states the schema has", () => {
    const known = new Set(requirementStateEnum.enumValues);
    for (const state of SEARCHABLE_STATES) expect(known.has(state)).toBe(true);
  });
});

describe("after searching", () => {
  it("downloads whenever something was selected", () => {
    expect(afterSearch({ mailboxes: ["NEEDS_REAUTH"], selected: 1 })).toBe("FETCH");
  });

  it("is not found only when every mailbox was searched", () => {
    // spec: retrieve-invoices §16 — a business outcome, not a failure.
    expect(afterSearch({ mailboxes: ["COMPLETED", "COMPLETED"], selected: 0 })).toBe("NOT_FOUND");
  });

  it("is blocked when a mailbox could not be searched and nothing was found", () => {
    // spec: retrieve-invoices §17 — never "not found" about a place we did not look.
    expect(afterSearch({ mailboxes: ["COMPLETED", "NEEDS_REAUTH"], selected: 0 })).toBe("BLOCKED");
  });
});
