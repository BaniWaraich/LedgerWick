/**
 * When two statements describe the same movement.
 *
 * spec: docs/workflows/upload-statement.md Step 5a
 *
 * The description half of the canonical transaction identity rule, and the sibling of
 * `account-identity.ts`, written in the same spirit and for the same reason: the comparison
 * that decides whether two rows are one payment should live in one place, next to the index
 * that enforces it.
 *
 * Step 5a is explicit about how far this may go: *"Normalized description means the raw
 * description with case, runs of whitespace, and punctuation normalized. It is deliberately
 * conservative: descriptions are normalized for formatting only, never interpreted."*
 *
 * So it folds away how a bank typeset a description and nothing else. `UPI/ACME/123` and
 * `UPI ACME 123` are the same movement seen through two exports. `ACME TRADING` and `ACME
 * TRADING PVT LTD` are not, and deciding that they are would be entity resolution — which
 * has real false positives, and which Step 5a says to resolve the other way: *"Where the
 * rule is uncertain, it should create two transactions rather than merge."*
 *
 * The direction of that asymmetry is the whole design. A missed duplicate shows up to the
 * user as a repeated row they can see; a false merge silently destroys a real payment.
 */

/**
 * Anything that is not a letter, a digit or a combining mark is typesetting, and becomes a
 * space.
 *
 * The marks are not an afterthought. A vowel sign in Devanagari -- the `ु` and `ं` in
 * `मुंबई` -- is Unicode category Mark rather than Letter, so a rule that kept only letters
 * and digits turned that word into `म बई`. That is not a cosmetic problem: it is a
 * description silently rewritten before being used as identity, which is how two different
 * payments come to share a normalized form. The same applies to Arabic and Hebrew points and
 * to every other Indic script.
 */
const NOT_ALPHANUMERIC = /[^\p{L}\p{N}\p{M}]+/gu;

/**
 * A description as identity rather than as text.
 *
 * Unicode-aware on purpose: a description may carry Devanagari, and a rule written in terms
 * of `a-z` would flatten a whole script to nothing and merge every transaction that used it.
 */
export function normalizeDescription(description: string): string {
  return description.toLowerCase().replace(NOT_ALPHANUMERIC, " ").trim();
}
