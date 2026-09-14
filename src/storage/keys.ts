/**
 * Where a workspace's documents live in the store.
 *
 * ADR 0007: "Blob keys are workspace-prefixed, so a leaked or guessed key is still
 * useless without the authorizing route." The prefix is not the authorization check —
 * `requireScope` plus a scoped row lookup is. It is what makes a stray key legible as
 * belonging to someone, and what would make a per-workspace deletion possible later.
 *
 * Pure functions over strings, so the traversal cases below are testable without a store.
 */

/** The two kinds of document this system stores, and the schema table each belongs to. */
export type DocumentKind = "statements" | "documents";

/** Anything that cannot appear in a path segment we construct. */
const UNSAFE_SEGMENT = /[^a-zA-Z0-9._-]+/g;

/**
 * Reduce a user-supplied filename to something safe to concatenate into a key.
 *
 * The filename arrives from an upload or from a Gmail attachment header — neither is
 * trustworthy, and both end up inside a path. Separators and traversal segments are
 * removed rather than escaped: the filename is kept only so a stored object is
 * recognizable to a human reading the store, and the row already holds the real one.
 */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(UNSAFE_SEGMENT, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 120);
  return cleaned === "" ? "document" : cleaned;
}

/**
 * The key for one document.
 *
 * `uniqueSegment` separates two uploads of the same filename in the same workspace. It is
 * supplied by the caller — usually the row's id — rather than generated here, so the key
 * is a pure function of its inputs and a test can assert the whole string.
 */
export function documentKey(
  workspaceId: string,
  kind: DocumentKind,
  uniqueSegment: string,
  filename: string,
): string {
  return `workspaces/${workspaceId}/${kind}/${uniqueSegment}/${sanitizeFilename(filename)}`;
}

/** The prefix every key for a workspace shares. */
export function workspacePrefix(workspaceId: string): string {
  return `workspaces/${workspaceId}/`;
}
