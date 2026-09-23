/**
 * Reading what the database actually said.
 *
 * Several places in this system lean on a unique index rather than checking first, because
 * a check-then-write has a window and concurrent work sits in it: `promote.ts` on the
 * canonical identity index, `resolveVendor` on the alias index, `linkInvoice` on the
 * invoice-to-transaction index. All of them have to recognise a unique violation to tell
 * "someone got here first" from "something is broken".
 *
 * Drizzle wraps the driver error and puts the original on `cause`, so a check for
 * `error.code` on the object it hands you reads as correct and never matches. That mistake
 * was made twice -- once here and once in `src/matching/link.ts` -- before a test caught
 * it, and its failure mode is quiet in the worst way: the swallow stops swallowing and an
 * ordinary race becomes an error the user sees.
 *
 * So it lives in one place, with the unwrapping in it.
 */

/** The driver's own error object, from wherever the layers above have put it. */
function driverError(error: unknown): { code?: string; constraint?: string } | null {
  if (typeof error !== "object" || error === null) return null;

  const cause = (error as { cause?: unknown }).cause;
  const inner = typeof cause === "object" && cause !== null ? cause : error;

  return inner as { code?: string; constraint?: string };
}

/**
 * Whether a write failed because a unique index already held the row.
 *
 * `23505` is Postgres' `unique_violation`. `tests/helpers/db.ts` asserts on the same code,
 * and pins the constraint name too, so a test fails when the right error arrives from the
 * wrong index.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const driver = driverError(error);
  if (driver?.code !== "23505") return false;

  return constraint === undefined || driver.constraint === constraint;
}
