/**
 * Promoting statement lines to canonical transactions.
 *
 * spec: docs/workflows/upload-statement.md Step 5a
 *
 * The correctness heart of feature D, and the one place in the system where deduplication
 * happens: "Before those lines are visible to any later workflow, they are promoted to
 * Canonical Transactions, which is where deduplication happens — once, here, and nowhere
 * else." Every feature after this one assumes each financial movement appears exactly once,
 * and this file is the entirety of that guarantee.
 *
 * ## The identity rule, and why an occurrence index exists
 *
 * Two lines are the same movement when they share a bank account, a value date, a signed
 * amount, a normalized description — and their position within that group. Where the bank
 * supplied a reference, that alone decides it.
 *
 * The position is the subtle part, and Step 5a states the two cases it has to separate in
 * one breath: "Two identical lines in one statement are two transactions; two identical
 * lines in overlapping statements covering the same date are one." A business may
 * legitimately pay the same vendor the same amount twice in one day, and an overlapping
 * statement may show one payment twice. Nothing about the rows tells those apart. What tells
 * them apart is that the first pair arrives together in one file and the second pair arrives
 * in two.
 *
 * So the nth identical line of this statement becomes the nth occurrence on this account. A
 * second upload of the same file finds every occurrence already there and links to all of
 * them; a genuine second payment arrives as a line with no occurrence left to claim, and
 * creates one.
 *
 * ## One group, two ways of matching within it
 *
 * `canonical_transactions_identity_idx` covers the composite key **and** the occurrence
 * index, and it is unconditional — it applies to transactions carrying a bank reference
 * exactly as to those without one. The occurrence index is therefore a seat number in the
 * composite group, and every transaction in that group needs its own however it was
 * identified. Two payments differing only by their UTR still cannot both be occurrence zero.
 *
 * Matching within a group is a separate question from seating, and the two are kept apart:
 *
 * - A line **with** a reference is matched by that reference alone, as Step 5a requires.
 * - A line **without** one is matched positionally, and only against transactions that
 *   themselves have no reference. A transaction identified by a UTR is a specific movement;
 *   a line carrying no reference has no way to claim it, and claiming it by position would
 *   be a guess. Step 5a settles which way to be wrong: "Where the rule is uncertain, it
 *   should create two transactions rather than merge."
 *
 * ## Why it reads the lines back from the database
 *
 * This runs in a background workflow and may run twice (`docs/architecture.md §16`). Its
 * idempotency comes from the lines themselves: a line already pointing at a canonical
 * transaction is left alone, so a retry after a partial run finishes the job rather than
 * repeating it. Re-parsing instead would risk a second set of lines, and deleting and
 * reinserting them would orphan the canonical transactions they had already created.
 *
 * The unique index is the backstop rather than the mechanism. Where two runs race, the
 * loser's insert raises it — and losing that race means the row it wanted is now there to
 * link to.
 */

import { and, eq } from "drizzle-orm";

import { canonicalTransactions, statementLines } from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";
import { normalizeDescription } from "./description";

/** What one promotion did. Reported so a run can be understood after the fact. */
export interface Promotion {
  /** Lines that produced a canonical transaction which did not exist before. */
  readonly created: number;
  /** Lines that matched a transaction already recorded — an overlap, or a re-upload. */
  readonly linked: number;
}

type StatementLine = typeof statementLines.$inferSelect;
type CanonicalTransaction = typeof canonicalTransactions.$inferSelect;

/** The account a statement is bound to, which is the authority on both of these. */
interface BoundAccount {
  readonly bankAccountId: string;
  /** Step 3a: set when the account is created, never rewritten by a later statement. */
  readonly currency: string;
}

/** Promote every line of one statement. */
export async function promoteStatement(
  scope: WorkspaceScope,
  statementId: string,
  account: BoundAccount,
): Promise<Promotion> {
  const lines = await scope.select(statementLines, eq(statementLines.statementId, statementId));
  lines.sort((a, b) => a.rowIndex - b.rowIndex);

  const groups = new Map<string, StatementLine[]>();
  for (const line of lines) {
    const key = identityKey(line);
    const group = groups.get(key);
    if (group) group.push(line);
    else groups.set(key, [line]);
  }

  let created = 0;
  let linked = 0;

  for (const group of groups.values()) {
    for (const wasCreated of await promoteGroup(scope, account, group)) {
      if (wasCreated) created += 1;
      else linked += 1;
    }
  }

  return { created, linked };
}

/**
 * The composite identity of a line, for grouping this statement's own rows.
 *
 * JSON rather than a joined string, so that no separator has to be chosen. A description can
 * contain any character a separator might use, and a key built by concatenation is one
 * unlucky description away from grouping two different movements together — the false merge
 * Step 5a calls the failure that silently destroys a real payment.
 */
function identityKey(line: StatementLine): string {
  return JSON.stringify([
    line.valueDate,
    line.amountMinor.toString(),
    line.direction,
    normalizeDescription(line.description),
  ]);
}

/** Every line of this statement that shares one composite identity. */
async function promoteGroup(
  scope: WorkspaceScope,
  account: BoundAccount,
  group: StatementLine[],
): Promise<boolean[]> {
  const first = group[0];
  const descriptionNormalized = normalizeDescription(first.description);

  const existing = await scope.select(
    canonicalTransactions,
    and(
      eq(canonicalTransactions.bankAccountId, account.bankAccountId),
      eq(canonicalTransactions.valueDate, first.valueDate),
      eq(canonicalTransactions.amountMinor, first.amountMinor),
      eq(canonicalTransactions.direction, first.direction),
      eq(canonicalTransactions.descriptionNormalized, descriptionNormalized),
    ),
  );
  existing.sort((a, b) => a.occurrenceIndex - b.occurrenceIndex);

  // The next free seat in this group, taken from the highest occupied index rather than
  // from the count, so a gap left behind by a deletion is never handed out twice.
  let nextOccurrence = existing.reduce(
    (next, transaction) => Math.max(next, transaction.occurrenceIndex + 1),
    0,
  );

  /** Transactions already spoken for: by an earlier line here, or by a previous run. */
  const claimed = new Set(
    group.map((line) => line.canonicalTransactionId).filter((id): id is string => id !== null),
  );

  const results: boolean[] = [];

  for (const line of group) {
    if (line.canonicalTransactionId) {
      // A previous run placed this one. Its seat is taken and its neighbours keep theirs,
      // which is what makes a retry finish the job rather than redo it.
      results.push(false);
      continue;
    }

    const match = line.externalReference
      ? existing.find((transaction) => transaction.externalReference === line.externalReference)
      : existing.find(
          (transaction) => transaction.externalReference === null && !claimed.has(transaction.id),
        );

    if (match) {
      claimed.add(match.id);
      await link(scope, line, match.id);
      results.push(false);
      continue;
    }

    const transaction = await create(scope, account, line, descriptionNormalized, nextOccurrence);
    nextOccurrence = Math.max(nextOccurrence, transaction.occurrenceIndex) + 1;
    existing.push(transaction);
    claimed.add(transaction.id);
    await link(scope, line, transaction.id);
    results.push(true);
  }

  return results;
}

async function create(
  scope: WorkspaceScope,
  account: BoundAccount,
  line: StatementLine,
  descriptionNormalized: string,
  occurrenceIndex: number,
): Promise<CanonicalTransaction> {
  try {
    const [transaction] = await scope.insert(canonicalTransactions, {
      bankAccountId: account.bankAccountId,
      valueDate: line.valueDate,
      amountMinor: line.amountMinor,
      direction: line.direction,
      currency: account.currency,
      description: line.description,
      descriptionNormalized,
      occurrenceIndex,
      externalReference: line.externalReference,
    });
    return transaction;
  } catch (error) {
    // Another run got there first. Losing that race means the row we wanted now exists, so
    // the right response is to go and find it rather than to fail the statement.
    if (!isUniqueViolation(error)) throw error;

    const raced = await scope.selectOne(
      canonicalTransactions,
      line.externalReference
        ? and(
            eq(canonicalTransactions.bankAccountId, account.bankAccountId),
            eq(canonicalTransactions.externalReference, line.externalReference),
          )
        : and(
            eq(canonicalTransactions.bankAccountId, account.bankAccountId),
            eq(canonicalTransactions.valueDate, line.valueDate),
            eq(canonicalTransactions.amountMinor, line.amountMinor),
            eq(canonicalTransactions.direction, line.direction),
            eq(canonicalTransactions.descriptionNormalized, descriptionNormalized),
            eq(canonicalTransactions.occurrenceIndex, occurrenceIndex),
          ),
    );

    if (!raced) throw error;
    return raced;
  }
}

async function link(scope: WorkspaceScope, line: StatementLine, canonicalTransactionId: string) {
  await scope.update(statementLines, { canonicalTransactionId }, eq(statementLines.id, line.id));
}

/** Postgres SQLSTATE 23505. The driver puts it on `cause`; PGlite and postgres-js agree. */
function isUniqueViolation(error: unknown): boolean {
  const pg = ((error as { cause?: unknown })?.cause ?? error) as { code?: string };
  return pg?.code === "23505";
}
