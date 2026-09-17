import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { canonicalTransactions, statementLines } from "../../src/db/schema";
import { openWorkspace, type WorkspaceScope } from "../../src/db/workspace-scope";
import { promoteStatement } from "../../src/statements/promote";
import { createTestDb, seedBankAccount, seedWorkspace, type TestDb } from "../helpers/db";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";

let harness: TestDb;

beforeEach(async () => {
  harness = await createTestDb();
});

afterAll(async () => {
  await harness?.close();
});

interface Fixture {
  scope: WorkspaceScope;
  bankAccountId: string;
  statement: (rows: Row[]) => Promise<string>;
}

interface Row {
  date?: string;
  description?: string;
  amount?: bigint;
  direction?: "DEBIT" | "CREDIT";
  reference?: string | null;
}

/** A workspace with one account, and a way to drop a statement's lines straight in. */
async function fixture(): Promise<Fixture> {
  const { user, workspace } = await seedWorkspace(harness.db);
  const account = await seedBankAccount(harness.db, workspace.id);
  const scope = await openWorkspace(harness.db, user.id, workspace.id);

  let sequence = 0;

  const statement = async (rows: Row[]) => {
    sequence += 1;
    const [record] = await harness.db
      .insert(schema.bankStatements)
      .values({
        workspaceId: workspace.id,
        bankAccountId: account.id,
        uploadBatchId: crypto.randomUUID(),
        filename: `statement-${sequence}.pdf`,
        mimeType: "application/pdf",
        storageRef: `workspaces/${workspace.id}/statements/${sequence}/statement.pdf`,
        state: "PARSING",
      })
      .returning();

    if (rows.length === 0) return record.id;

    await harness.db.insert(statementLines).values(
      rows.map((row, index) => ({
        workspaceId: workspace.id,
        statementId: record.id,
        rowIndex: index,
        valueDate: row.date ?? "2023-08-01",
        description: row.description ?? "ACME TRADING",
        amountMinor: row.amount ?? 485000n,
        direction: row.direction ?? ("DEBIT" as const),
        externalReference: row.reference ?? null,
      })),
    );

    return record.id;
  };

  return { scope, bankAccountId: account.id, statement };
}

async function promote(f: Fixture, statementId: string) {
  return promoteStatement(f.scope, statementId, {
    bankAccountId: f.bankAccountId,
    currency: "INR",
  });
}

async function transactions(f: Fixture) {
  const rows = await f.scope.select(canonicalTransactions);
  return rows.sort((a, b) => a.occurrenceIndex - b.occurrenceIndex);
}

describe("promoting a statement for the first time", () => {
  it("creates one canonical transaction per line", async () => {
    const f = await fixture();
    const id = await f.statement([
      { description: "ACME", amount: 485000n },
      { description: "BETA", amount: 100000n, direction: "CREDIT" },
    ]);

    expect(await promote(f, id)).toEqual({ created: 2, linked: 0 });
    expect(await transactions(f)).toHaveLength(2);
  });

  it("links every line to the transaction it produced", async () => {
    const f = await fixture();
    const id = await f.statement([{ description: "ACME" }]);
    await promote(f, id);

    const [line] = await f.scope.select(statementLines, eq(statementLines.statementId, id));
    expect(line.canonicalTransactionId).not.toBeNull();
  });

  it("takes the currency from the account, never from the statement", async () => {
    // spec: Step 3a -- an account's currency is set when it is created and never rewritten.
    const f = await fixture();
    await promote(f, await f.statement([{}]));
    expect((await transactions(f))[0].currency).toBe("INR");
  });

  it("stores the description as printed and as identity", async () => {
    const f = await fixture();
    await promote(f, await f.statement([{ description: "UPI/ACME  TRADING/123" }]));

    const [transaction] = await transactions(f);
    expect(transaction.description).toBe("UPI/ACME  TRADING/123");
    expect(transaction.descriptionNormalized).toBe("upi acme trading 123");
  });
});

describe("re-uploading a statement that has already been processed", () => {
  it("produces zero new canonical transactions", async () => {
    // The guarantee the whole pipeline rests on: "Re-uploading a statement that has already
    // been processed therefore produces no new Canonical Transactions, which is what makes
    // the whole pipeline safe to re-run."
    const f = await fixture();
    const rows: Row[] = [
      { description: "ACME", amount: 485000n },
      { description: "BETA", amount: 100000n, direction: "CREDIT" },
      { description: "GAMMA", amount: 250000n },
    ];

    await promote(f, await f.statement(rows));
    expect(await transactions(f)).toHaveLength(3);

    const again = await promote(f, await f.statement(rows));
    expect(again).toEqual({ created: 0, linked: 3 });
    expect(await transactions(f)).toHaveLength(3);
  });

  it("links the second upload's lines to the first upload's transactions", async () => {
    const f = await fixture();
    const first = await f.statement([{ description: "ACME" }]);
    await promote(f, first);
    const second = await f.statement([{ description: "ACME" }]);
    await promote(f, second);

    const [a] = await f.scope.select(statementLines, eq(statementLines.statementId, first));
    const [b] = await f.scope.select(statementLines, eq(statementLines.statementId, second));
    expect(b.canonicalTransactionId).toBe(a.canonicalTransactionId);
  });
});

describe("overlapping statements", () => {
  it("produce one transaction with two statement lines", async () => {
    // Statement A covers Apr 1 - May 9, statement B covers May 1 - Jun 1, and both show the
    // May 5 payment to ACME.
    const f = await fixture();
    const shared: Row = { date: "2023-05-05", description: "ACME", amount: 485000n };

    await promote(f, await f.statement([{ date: "2023-04-02", description: "OLD" }, shared]));
    await promote(f, await f.statement([shared, { date: "2023-05-30", description: "NEW" }]));

    const all = await transactions(f);
    expect(all).toHaveLength(3);

    const acme = all.find((t) => t.descriptionNormalized === "acme")!;
    const lines = await f.scope.select(
      statementLines,
      eq(statementLines.canonicalTransactionId, acme.id),
    );
    expect(lines).toHaveLength(2);
  });

  it("keeps the statement line of each, because it is the evidence", async () => {
    const f = await fixture();
    const shared: Row = { date: "2023-05-05", description: "ACME" };
    await promote(f, await f.statement([shared]));
    await promote(f, await f.statement([shared]));

    expect(await f.scope.select(statementLines)).toHaveLength(2);
  });
});

describe("two identical payments on one day", () => {
  it("stay two transactions when they arrive in one statement", async () => {
    // spec: Step 5a -- "Two identical lines in one statement are two transactions; two
    // identical lines in overlapping statements covering the same date are one." Nothing
    // about the rows tells these apart; what does is that they arrived together.
    const f = await fixture();
    const twice: Row = { date: "2023-08-01", description: "ACME", amount: 485000n };

    expect(await promote(f, await f.statement([twice, twice]))).toEqual({
      created: 2,
      linked: 0,
    });

    const all = await transactions(f);
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.occurrenceIndex)).toEqual([0, 1]);
  });

  it("become one when they arrive in two overlapping statements", async () => {
    const f = await fixture();
    const once: Row = { date: "2023-08-01", description: "ACME", amount: 485000n };

    await promote(f, await f.statement([once]));
    await promote(f, await f.statement([once]));

    expect(await transactions(f)).toHaveLength(1);
  });

  it("survive a re-upload of the statement that had both", async () => {
    const f = await fixture();
    const twice: Row = { date: "2023-08-01", description: "ACME", amount: 485000n };

    await promote(f, await f.statement([twice, twice]));
    const again = await promote(f, await f.statement([twice, twice]));

    expect(again).toEqual({ created: 0, linked: 2 });
    expect(await transactions(f)).toHaveLength(2);
  });

  it("add a third only when a third genuinely arrives", async () => {
    const f = await fixture();
    const row: Row = { date: "2023-08-01", description: "ACME", amount: 485000n };

    await promote(f, await f.statement([row, row]));
    const third = await promote(f, await f.statement([row, row, row]));

    expect(third).toEqual({ created: 1, linked: 2 });
    expect(await transactions(f)).toHaveLength(3);
  });
});

describe("a bank reference", () => {
  it("decides identity on its own", async () => {
    // spec: Step 5a -- a reference "takes priority over the composite rule above and is
    // used alone", so a bank rewording its own descriptions between exports is survivable.
    const f = await fixture();
    await promote(f, await f.statement([{ description: "ACME TRADING", reference: "UTR123" }]));
    await promote(f, await f.statement([{ description: "ACME TRDG PVT", reference: "UTR123" }]));

    expect(await transactions(f)).toHaveLength(1);
  });

  it("separates rows that would otherwise look identical", async () => {
    const f = await fixture();
    const id = await f.statement([
      { description: "ACME", reference: "UTR1" },
      { description: "ACME", reference: "UTR2" },
    ]);

    expect(await promote(f, id)).toEqual({ created: 2, linked: 0 });
  });

  it("is stored on the transaction as well as on the line", async () => {
    const f = await fixture();
    await promote(f, await f.statement([{ reference: "UTR123" }]));
    expect((await transactions(f))[0].externalReference).toBe("UTR123");
  });
});

describe("what makes two movements different", () => {
  it("separates two amounts", async () => {
    const f = await fixture();
    await promote(f, await f.statement([{ amount: 100n }, { amount: 200n }]));
    expect(await transactions(f)).toHaveLength(2);
  });

  it("separates two directions", async () => {
    const f = await fixture();
    const id = await f.statement([
      { amount: 100n, direction: "DEBIT" },
      { amount: 100n, direction: "CREDIT" },
    ]);
    await promote(f, id);
    expect(await transactions(f)).toHaveLength(2);
  });

  it("separates two dates", async () => {
    const f = await fixture();
    await promote(f, await f.statement([{ date: "2023-08-01" }, { date: "2023-08-02" }]));
    expect(await transactions(f)).toHaveLength(2);
  });

  it("does not separate two spellings of one description", async () => {
    // Formatting only. The same movement seen through two exports.
    const f = await fixture();
    await promote(f, await f.statement([{ description: "UPI/ACME/123" }]));
    await promote(f, await f.statement([{ description: "upi acme 123" }]));
    expect(await transactions(f)).toHaveLength(1);
  });
});

describe("running promotion twice", () => {
  it("changes nothing the second time", async () => {
    // docs/architecture.md §16 -- a background workflow may be retried or triggered twice.
    const f = await fixture();
    const id = await f.statement([{ description: "ACME" }, { description: "BETA" }]);

    expect(await promote(f, id)).toEqual({ created: 2, linked: 0 });
    expect(await promote(f, id)).toEqual({ created: 0, linked: 2 });
    expect(await transactions(f)).toHaveLength(2);
  });

  it("finishes a run that stopped halfway rather than repeating it", async () => {
    const f = await fixture();
    const row: Row = { date: "2023-08-01", description: "ACME", amount: 485000n };
    const id = await f.statement([row, row, row]);

    await promote(f, id);

    // Undo the last line's link, as a crash between the insert and the update would.
    const lines = await f.scope.select(statementLines, eq(statementLines.statementId, id));
    const last = lines.sort((a, b) => a.rowIndex - b.rowIndex)[2];
    await f.scope.update(
      statementLines,
      { canonicalTransactionId: null },
      eq(statementLines.id, last.id),
    );

    expect(await promote(f, id)).toEqual({ created: 0, linked: 3 });
    expect(await transactions(f)).toHaveLength(3);
  });
});

describe("a statement with nothing in it", () => {
  it("promotes nothing rather than failing", async () => {
    const f = await fixture();
    expect(await promote(f, await f.statement([]))).toEqual({ created: 0, linked: 0 });
  });
});

describe("workspace isolation", () => {
  it("never matches a transaction belonging to another workspace", async () => {
    // Written as an attack. Two workspaces, identical statements, and the second must not
    // see the first's transactions -- isolation is enforced in application code, so it is
    // only as good as the tests that try to break it.
    const first = await fixture();
    await promote(first, await first.statement([{ description: "ACME" }]));

    const second = await fixture();
    const created = await promote(second, await second.statement([{ description: "ACME" }]));

    expect(created).toEqual({ created: 1, linked: 0 });
    expect(await transactions(second)).toHaveLength(1);
    expect(await transactions(first)).toHaveLength(1);
  });

  it("promotes nothing for a statement id belonging to another workspace", async () => {
    // A tampered event carrying someone else's statement id writes nothing at all, because
    // the scope never returns its lines.
    const first = await fixture();
    const theirs = await first.statement([{ description: "ACME" }]);

    const second = await fixture();
    expect(await promote(second, theirs)).toEqual({ created: 0, linked: 0 });
    expect(await transactions(second)).toHaveLength(0);
    expect(await transactions(first)).toHaveLength(0);
  });

  it("does not let one workspace's account absorb another's transactions", async () => {
    const first = await fixture();
    const second = await fixture();

    // The attack: promote our own statement, but claim their bank account.
    const ours = await second.statement([{ description: "ACME" }]);
    await promoteStatement(second.scope, ours, {
      bankAccountId: first.bankAccountId,
      currency: "INR",
    });

    // The row is written into the caller's own workspace whatever account id it named,
    // because `scope.insert` injects the workspace rather than accepting one.
    expect(await transactions(first)).toHaveLength(0);
  });
});
