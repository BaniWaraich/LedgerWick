import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import type { ColumnMapping } from "../../src/ai/prompts/map-statement-columns.v1";
import type { ScannedStatement } from "../../src/ai/prompts/read-scanned-statement.v1";
import {
  bankAccounts,
  bankStatements,
  canonicalTransactions,
  statementLines,
} from "../../src/db/schema";
import { openWorkspace, type WorkspaceScope } from "../../src/db/workspace-scope";
import { parseStatement, type ParseDependencies } from "../../src/statements/parse";
import type { MapColumns, ReadScanned } from "../../src/statements/parse-contracts";
import type { ExtractPdfText } from "../../src/statements/source";
import { createTestDb, seedWorkspace, type TestDb } from "../helpers/db";
import { FakeDocumentStore } from "../storage/fake-document-store";

let h: TestDb;

beforeEach(async () => {
  h = await createTestDb();
});

afterAll(async () => {
  await h?.close();
});

/**
 * A CSV statement with a running balance, laid out as a debit/credit pair.
 *
 * Opening 1,20,000.00; one debit of 4,850.00 and one credit of 1,000.00; closing
 * 1,16,150.00. It reconciles, and every test that wants a mismatch breaks it deliberately.
 */
const CSV = [
  "Date,Narration,Ref,Withdrawal,Deposit,Balance",
  "01/08/2023,ACME TRADING,REF1,4850.00,,115150.00",
  "02/08/2023,SALARY,REF2,,1000.00,116150.00",
].join("\n");

const MAPPING: ColumnMapping = {
  headerRow: 0,
  firstDataRow: 1,
  dateColumn: 0,
  dateOrder: "DMY",
  descriptionColumns: [1],
  referenceColumn: 2,
  balanceColumn: 5,
  amountShape: "DEBIT_CREDIT",
  debitColumn: 3,
  creditColumn: 4,
  amountColumn: null,
  indicatorColumn: null,
  decimalSeparator: ".",
  openingBalanceCell: null,
  closingBalanceCell: null,
};

/** A PDF with no text layer, which is what sends a statement down the scanned path. */
const SCANNED_BYTES = new TextEncoder().encode("%PDF-1.7\nno text layer here");

const noPdfText: ExtractPdfText = async () => ({ pages: 1, items: [[]] });

/**
 * A column mapper that answers from a script, and counts how often it was asked.
 *
 * The count is the assertion in several tests below: ADR 0003 allows exactly one re-derive
 * on the deterministic path and none at all on the scanned one, and "how many times was the
 * model called" is the only way to state that as a fact rather than a comment.
 */
function mappingOf(...mappings: (ColumnMapping | null)[]): {
  readonly calls: number;
  fn: MapColumns;
} {
  let calls = 0;
  const fn: MapColumns = async () => {
    const mapping = mappings[Math.min(calls, mappings.length - 1)];
    calls += 1;
    return mapping ? { ok: true, value: mapping } : { ok: false, reason: "no object generated" };
  };
  return {
    get calls() {
      return calls;
    },
    fn,
  };
}

function scannedOf(statement: ScannedStatement | null): {
  readonly calls: number;
  fn: ReadScanned;
} {
  let calls = 0;
  const fn: ReadScanned = async () => {
    calls += 1;
    return statement ? { ok: true, value: statement } : { ok: false, reason: "unreadable" };
  };
  return {
    get calls() {
      return calls;
    },
    fn,
  };
}

const SCAN: ScannedStatement = {
  dateOrder: "DMY",
  decimalSeparator: ".",
  openingBalance: "1,20,000.00",
  closingBalance: "1,16,150.00",
  rows: [
    {
      date: "01/08/2023",
      description: "ACME TRADING",
      debit: "4,850.00",
      credit: null,
      balance: "1,15,150.00",
      reference: null,
    },
    {
      date: "02/08/2023",
      description: "SALARY",
      debit: null,
      credit: "1,000.00",
      balance: "1,16,150.00",
      reference: null,
    },
  ],
};

interface Harness {
  scope: WorkspaceScope;
  statementId: string;
  accountId: string;
  store: FakeDocumentStore;
  run: (overrides?: Partial<ParseDependencies>) => Promise<void>;
  statement: () => Promise<typeof bankStatements.$inferSelect>;
}

async function harness(
  options: {
    reuse?: { scope: WorkspaceScope; accountId: string };
    body?: Uint8Array | string;
    filename?: string;
    mimeType?: string;
    declaredPeriod?: boolean;
    currency?: string;
    bind?: boolean;
    state?: "PARSING" | "COMPLETED" | "NEEDS_ACCOUNT";
    contentHash?: string;
    /** Point the row at bytes that are not there, as a lost blob would. */
    missingBytes?: boolean;
  } = {},
): Promise<Harness> {
  let scope: WorkspaceScope;
  let accountId: string;

  if (options.reuse) {
    scope = options.reuse.scope;
    accountId = options.reuse.accountId;
  } else {
    const { user, workspace } = await seedWorkspace(h.db);
    scope = await openWorkspace(h.db, user.id, workspace.id);
    const [created] = await scope.insert(bankAccounts, {
      bankName: "HDFC Bank",
      accountIdentifier: "XXXX1234",
      currency: options.currency ?? "INR",
    });
    accountId = created.id;
  }
  const account = { id: accountId };
  const workspace = { id: scope.workspaceId };

  const store = new FakeDocumentStore();
  const body = options.body ?? CSV;
  // The fake suffixes the key it is handed, exactly as Vercel Blob does, so what the row
  // holds is the key the store reported rather than the one we asked for.
  const stored = await store.put(
    `workspaces/${workspace.id}/statements/one/statement` as never,
    Buffer.from(typeof body === "string" ? new TextEncoder().encode(body) : body),
    options.mimeType ?? "text/csv",
  );

  const [statement] = await scope.insert(bankStatements, {
    bankAccountId: options.bind === false ? null : account.id,
    uploadBatchId: crypto.randomUUID(),
    filename: options.filename ?? "august.csv",
    mimeType: options.mimeType ?? "text/csv",
    storageRef: options.missingBytes ? `${stored.key}-gone` : stored.key,
    contentHash: options.contentHash ?? null,
    state: options.state ?? "PARSING",
    ...(options.declaredPeriod
      ? { periodStart: "2023-08-01", periodEnd: "2023-08-31", periodSource: "DECLARED" as const }
      : {}),
  });

  return {
    scope,
    statementId: statement.id,
    accountId: account.id,
    store,
    run: (overrides = {}) =>
      parseStatement(
        scope,
        {
          store,
          extractPdfText: noPdfText,
          mapColumns: mappingOf(MAPPING).fn,
          readScanned: scannedOf(SCAN).fn,
          ...overrides,
        },
        statement.id,
      ),
    statement: async () =>
      (await scope.selectOne(bankStatements, eq(bankStatements.id, statement.id)))!,
  };
}

describe("parsing a statement that reconciles", () => {
  it("reaches COMPLETED and VALID", async () => {
    const t = await harness();
    await t.run();

    const row = await t.statement();
    expect(row.state).toBe("COMPLETED");
    expect(row.validationOutcome).toBe("VALID");
  });

  it("records the summary the user is shown", async () => {
    // spec: §7 and §10 -- the count, both balances, and the totals.
    const t = await harness();
    await t.run();

    const row = await t.statement();
    expect(row.lineCount).toBe(2);
    expect(row.openingBalance).toBe(12000000n);
    expect(row.closingBalance).toBe(11615000n);
    expect(row.totalDebits).toBe(485000n);
    expect(row.totalCredits).toBe(100000n);
  });

  it("writes one statement line per transaction", async () => {
    const t = await harness();
    await t.run();

    expect(await t.scope.select(statementLines)).toHaveLength(2);
  });

  it("promotes them to canonical transactions", async () => {
    const t = await harness();
    await t.run();

    expect(await t.scope.select(canonicalTransactions)).toHaveLength(2);
  });

  it("keeps the mapping, so a bad parse can be explained afterwards", async () => {
    const t = await harness();
    await t.run();

    const row = await t.statement();
    expect(row.columnMapping).toMatchObject({ skippedRows: 0 });
  });
});

describe("the period, as coverage", () => {
  it("derives one when the document declared none", async () => {
    // docs/decisions/0008 -- identification records a period only where the document
    // declares one, and parsing supplies the rest from the transactions it extracted.
    const t = await harness();
    await t.run();

    const row = await t.statement();
    expect(row.periodStart).toBe("2023-08-01");
    expect(row.periodEnd).toBe("2023-08-02");
    expect(row.periodSource).toBe("DERIVED");
  });

  it("never overwrites one the document declared", async () => {
    const t = await harness({ declaredPeriod: true });
    await t.run();

    const row = await t.statement();
    expect(row.periodStart).toBe("2023-08-01");
    expect(row.periodEnd).toBe("2023-08-31");
    expect(row.periodSource).toBe("DECLARED");
  });

  it("never reaches COMPLETED without a period at all", async () => {
    const t = await harness();
    await t.run();

    const row = await t.statement();
    expect(row.state).toBe("COMPLETED");
    expect(row.periodStart).not.toBeNull();
    expect(row.periodEnd).not.toBeNull();
  });
});

describe("a statement that does not reconcile", () => {
  /**
   * The same file with the withdrawal and deposit columns swapped.
   *
   * The error ADR 0003 says the balance equation is best at catching: it shifts the total by
   * twice each amount, so it cannot hide. Chosen deliberately after a subtler wrong mapping
   * turned out to reconcile by accident -- which is the "two errors that cancel" blindness
   * the validator's own tests already pin.
   */
  const WRONG: ColumnMapping = { ...MAPPING, debitColumn: 4, creditColumn: 3 };

  it("is re-derived once on the deterministic path", async () => {
    // ADR 0003: on CSV and text PDF a mismatch suggests the mapping may be wrong, and
    // re-deriving it is reasonable.
    const t = await harness();
    const model = mappingOf(WRONG, MAPPING);
    await t.run({ mapColumns: model.fn });

    expect(model.calls).toBe(2);
    expect((await t.statement()).validationOutcome).toBe("VALID");
  });

  it("settles for DISCREPANCY when the second attempt is no better", async () => {
    const t = await harness();
    const model = mappingOf(WRONG, WRONG);
    await t.run({ mapColumns: model.fn });

    const row = await t.statement();
    expect(model.calls).toBe(2);
    expect(row.state).toBe("COMPLETED");
    expect(row.validationOutcome).toBe("DISCREPANCY");
  });

  it("is not re-derived when the first attempt already reconciled", async () => {
    const t = await harness();
    const model = mappingOf(MAPPING);
    await t.run({ mapColumns: model.fn });

    expect(model.calls).toBe(1);
  });

  it("is still COMPLETED, because a discrepancy is not a failure", async () => {
    // spec: §8 -- the system processed the document successfully and simply does not trust
    // the numbers.
    const t = await harness();
    await t.run({ mapColumns: mappingOf(WRONG, WRONG).fn });

    expect((await t.statement()).state).toBe("COMPLETED");
  });
});

describe("a scanned statement", () => {
  it("reaches COMPLETED and VALID when it reconciles", async () => {
    const t = await harness({ body: SCANNED_BYTES, mimeType: "application/pdf" });
    await t.run();

    const row = await t.statement();
    expect(row.state).toBe("COMPLETED");
    expect(row.validationOutcome).toBe("VALID");
  });

  it("is NEVER retried when it does not reconcile", async () => {
    // ADR 0003 and §8: a mismatch here suggests the values may be wrong, and no amount of
    // retrying makes a misread digit correct. This assertion is the rule.
    const t = await harness({ body: SCANNED_BYTES, mimeType: "application/pdf" });
    const model = scannedOf({ ...SCAN, closingBalance: "1,17,000.00" });
    await t.run({ readScanned: model.fn });

    expect(model.calls).toBe(1);
    expect((await t.statement()).validationOutcome).toBe("DISCREPANCY");
  });

  it("never asks for a column mapping", async () => {
    const t = await harness({ body: SCANNED_BYTES, mimeType: "application/pdf" });
    const mapper = mappingOf(MAPPING);
    await t.run({ mapColumns: mapper.fn });

    expect(mapper.calls).toBe(0);
  });

  it("promotes its lines exactly as the deterministic path does", async () => {
    const t = await harness({ body: SCANNED_BYTES, mimeType: "application/pdf" });
    await t.run();

    expect(await t.scope.select(canonicalTransactions)).toHaveLength(2);
  });
});

describe("failing a statement", () => {
  it("fails when the mapping does not pass its schema", async () => {
    // ADR 0003: "a mapping that fails validation fails the statement rather than being
    // guessed at."
    const t = await harness();
    await t.run({ mapColumns: mappingOf(null).fn });

    const row = await t.statement();
    expect(row.state).toBe("FAILED");
    expect(row.failureReason).toContain("couldn't work out how this statement is laid out");
  });

  it("fails when no transactions could be read", async () => {
    const t = await harness({ body: "Date,Narration,Ref,Withdrawal,Deposit,Balance\n" });
    await t.run();

    const row = await t.statement();
    expect(row.state).toBe("FAILED");
    expect(row.failureReason).toContain("couldn't find any transactions");
  });

  it("fails when the stored bytes are gone", async () => {
    const t = await harness({ missingBytes: true });
    await t.run();

    expect((await t.statement()).failureReason).toContain("couldn't open the file");
  });

  it("fails when the statement is not bound to an account", async () => {
    const t = await harness({ bind: false });
    await t.run();

    expect((await t.statement()).failureReason).toContain("couldn't tell which account");
  });

  it("says a human-readable reason rather than an error code", async () => {
    // spec: §9 -- an explanation, not a generic technical error.
    const t = await harness();
    await t.run({ mapColumns: mappingOf(null).fn });

    const reason = (await t.statement()).failureReason!;
    expect(reason).toMatch(/^[A-Z]/);
    expect(reason).not.toMatch(/Error|undefined|null|\bTS\d/);
  });
});

describe("running the workflow twice", () => {
  it("leaves a COMPLETED statement alone", async () => {
    // docs/architecture.md §16 -- a background workflow may be retried or triggered twice.
    const t = await harness();
    await t.run();
    const first = await t.statement();

    const model = mappingOf(MAPPING);
    await t.run({ mapColumns: model.fn });

    expect(model.calls).toBe(0);
    expect(await t.scope.select(canonicalTransactions)).toHaveLength(2);
    expect((await t.statement()).lineCount).toBe(first.lineCount);
  });

  it("does not write a second set of statement lines", async () => {
    const t = await harness();
    await t.run();

    // Put it back into PARSING, as a crash before the final update would leave it.
    await t.scope.update(
      bankStatements,
      { state: "PARSING" },
      eq(bankStatements.id, t.statementId),
    );
    await t.run();

    expect(await t.scope.select(statementLines)).toHaveLength(2);
    expect(await t.scope.select(canonicalTransactions)).toHaveLength(2);
  });
});

describe("a statement in a state parsing has no business touching", () => {
  it("leaves one waiting for its account alone", async () => {
    const t = await harness({ state: "NEEDS_ACCOUNT" });
    const model = mappingOf(MAPPING);
    await t.run({ mapColumns: model.fn });

    expect(model.calls).toBe(0);
    expect((await t.statement()).state).toBe("NEEDS_ACCOUNT");
  });
});

describe("workspace isolation", () => {
  it("does nothing for a statement id belonging to another workspace", async () => {
    // A tampered event. The scope never returns the row, so nothing is read and nothing is
    // written -- not even a failure.
    const theirs = await harness();
    const { user, workspace } = await seedWorkspace(h.db);
    const attacker = await openWorkspace(h.db, user.id, workspace.id);

    await parseStatement(
      attacker,
      {
        store: theirs.store,
        extractPdfText: noPdfText,
        mapColumns: mappingOf(MAPPING).fn,
        readScanned: scannedOf(SCAN).fn,
      },
      theirs.statementId,
    );

    expect((await theirs.statement()).state).toBe("PARSING");
    expect(await attacker.select(canonicalTransactions)).toHaveLength(0);
    expect(await theirs.scope.select(canonicalTransactions)).toHaveLength(0);
  });
});

describe("the mapping is pinned to the document", () => {
  /** The same file, mapped one way and then the other, as the model actually behaved. */
  const OTHER: ColumnMapping = { ...MAPPING, descriptionColumns: [1, 2] };

  it("reuses the mapping already derived for these exact bytes", async () => {
    // Not an optimisation. description_normalized is part of canonical identity, so a model
    // that answers differently on a second upload makes the same payment look like a
    // different one.
    const first = await harness({ contentHash: "sha-1" });
    await first.run({ mapColumns: mappingOf(MAPPING).fn });

    const second = await harness({
      contentHash: "sha-1",
      reuse: { scope: first.scope, accountId: first.accountId },
    });
    const model = mappingOf(OTHER);
    await second.run({ mapColumns: model.fn });

    // The model was never asked, so it could not answer differently.
    expect(model.calls).toBe(0);
    expect((await second.statement()).state).toBe("COMPLETED");
  });

  it("produces no new canonical transactions on a re-upload", async () => {
    // The guarantee the whole phase rests on, and the one a wandering mapping broke: two
    // uploads of one real ICICI statement created 212 transactions that already existed.
    const first = await harness({ contentHash: "sha-2" });
    await first.run({ mapColumns: mappingOf(MAPPING).fn });
    const before = await first.scope.select(canonicalTransactions);

    const second = await harness({
      contentHash: "sha-2",
      reuse: { scope: first.scope, accountId: first.accountId },
    });
    await second.run({ mapColumns: mappingOf(OTHER).fn });

    const after = await first.scope.select(canonicalTransactions);
    expect(after).toHaveLength(before.length);
    expect(await second.scope.select(statementLines)).toHaveLength(4);
  });

  it("asks the model for a document it has not seen", async () => {
    const first = await harness({ contentHash: "sha-3" });
    await first.run({ mapColumns: mappingOf(MAPPING).fn });

    const different = await harness({
      contentHash: "sha-DIFFERENT",
      reuse: { scope: first.scope, accountId: first.accountId },
    });
    const model = mappingOf(MAPPING);
    await different.run({ mapColumns: model.fn });

    expect(model.calls).toBe(1);
  });

  it("asks the model when the statement has no digest at all", async () => {
    const t = await harness();
    const model = mappingOf(MAPPING);
    await t.run({ mapColumns: model.fn });

    expect(model.calls).toBe(1);
  });

  it("never inherits another workspace's mapping", async () => {
    // Scoped like every other read. Two workspaces may hold the same document; neither may
    // see the other's anything.
    const theirs = await harness({ contentHash: "shared-bytes" });
    await theirs.run({ mapColumns: mappingOf(MAPPING).fn });

    const ours = await harness({ contentHash: "shared-bytes" });
    const model = mappingOf(MAPPING);
    await ours.run({ mapColumns: model.fn });

    expect(model.calls).toBe(1);
  });

  it("falls back to the model when the stored mapping no longer fits its schema", async () => {
    const first = await harness({ contentHash: "sha-legacy" });
    await first.run({ mapColumns: mappingOf(MAPPING).fn });

    // A column that has held earlier shapes. It should send the statement back to the model
    // rather than crash the walk.
    await first.scope.update(
      bankStatements,
      { columnMapping: { mapping: { dateColumn: "not a number" } } },
      eq(bankStatements.id, first.statementId),
    );

    const second = await harness({
      contentHash: "sha-legacy",
      reuse: { scope: first.scope, accountId: first.accountId },
    });
    const model = mappingOf(MAPPING);
    await second.run({ mapColumns: model.fn });

    expect(model.calls).toBe(1);
    expect((await second.statement()).state).toBe("COMPLETED");
  });
});
