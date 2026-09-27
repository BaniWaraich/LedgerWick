/**
 * What a statement's state means to the person looking at it.
 *
 * `docs/state-machines.md §1`, verbatim. The UI does not invent its own wording. Kept here
 * because more than one page shows a statement's state, and two copies of this map would
 * drift apart the first time one of them was edited.
 */
export const STATEMENT_MESSAGES: Record<string, string> = {
  UPLOADING: "Uploading your statement…",
  IDENTIFYING: "Identifying your bank…",
  NEEDS_ACCOUNT: "Tell us which account this statement covers.",
  PARSING: "Extracting transactions…",
  VALIDATING: "Checking your transactions…",
  COMPLETED: "Statement processed.",
  FAILED: "We couldn't process this statement.",
};

/** States where a workflow is still running, and a page showing it should keep looking. */
export const STATEMENT_IN_FLIGHT = new Set(["UPLOADING", "IDENTIFYING", "PARSING", "VALIDATING"]);
