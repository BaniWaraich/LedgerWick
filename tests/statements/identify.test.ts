/**
 * Identifying a statement and binding it to an account.
 *
 * spec: docs/workflows/upload-statement.md Step 3, Step 3a · docs/state-machines.md §1
 *
 * The model is a parameter here, so these are tests of the decision, not of a provider.
 * What each branch has to get right is which persisted state the user is left in — that
 * state is the whole output of this step, and the next feature reads nothing else.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createTestDb, seedWorkspace, type TestDb } from "../helpers/db";
import { FakeDocumentStore } from "../storage/fake-document-store";
import { bankAccounts, bankStatements } from "../../src/db/schema";
import { openWorkspace, type WorkspaceScope } from "../../src/db/workspace-scope";
import type { Identification } from "../../src/ai/prompts/identify-statement.v2";
import {
  identifyStatement,
  recordTerminalFailure,
  type IdentifyDocument,
} from "../../src/statements/identify";
import { intakeBatch } from "../../src/statements/intake";

let h: TestDb;
let scope: WorkspaceScope;

beforeAll(async () => {
  h = await createTestDb();
  const alice = await seedWorkspace(h.db, "Alice Traders");
  scope = await openWorkspace(h.db, alice.user.id, alice.workspace.id);
});

afterAll(async () => {
  await h.close();
});

/** A complete, well-identified HDFC statement. Overridden per branch. */
function identification(overrides: Partial<Identification> = {}): Identification {
  return {
    documentKind: "BANK_STATEMENT",
    bankName: "HDFC Bank",
    accountIdentifier: "XXXX1234",
    accountType: "Current",
    currency: "INR",
    periodStart: "2026-03-01",
    periodEnd: "2026-03-31",
    ...overrides,
  };
}

function modelReturning(value: Identification): IdentifyDocument {
  return async () => ({ ok: true, value });
}

const modelThatFails: IdentifyDocument = async () => ({ ok: false, reason: "no object generated" });

/** The gateway never answered — a lapsed card, an expired key, an outage. */
const modelThatIsUnreachable: IdentifyDocument = async () => {
  throw new Error("AI Gateway requires a valid credit card on file to service requests");
};

/** An uploaded, stored statement awaiting identification. */
async function uploaded(store: FakeDocumentStore): Promise<string> {
  const { results } = await intakeBatch(
    scope,
    store,
    [new File(["Date,Amount\n"], "march.csv", { type: "text/csv" })],
    async () => {},
  );
  return results[0].statementId!;
}

async function stateOf(statementId: string) {
  const [row] = await scope.select(bankStatements, eq(bankStatements.id, statementId));
  return row;
}

describe("a statement that names its account", () => {
  it("creates the account, binds it, and moves to PARSING", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);

    await identifyStatement(scope, store, modelReturning(identification()), id);

    const row = await stateOf(id);
    expect(row.state).toBe("PARSING");
    expect(row.periodStart).toBe("2026-03-01");
    expect(row.periodEnd).toBe("2026-03-31");
    expect(row.bankAccountId).not.toBeNull();

    const [account] = await scope.select(bankAccounts, eq(bankAccounts.id, row.bankAccountId!));
    expect(account.bankName).toBe("HDFC Bank");
    expect(account.accountIdentifier).toBe("XXXX1234");
    expect(account.currency).toBe("INR");
  });

  it("reuses the account a previous statement created", async () => {
    const store = new FakeDocumentStore();
    const first = await uploaded(store);
    const second = await uploaded(store);

    await identifyStatement(scope, store, modelReturning(identification()), first);
    await identifyStatement(scope, store, modelReturning(identification()), second);

    // Step 3a: the same identifier in the same workspace is the same account, not a
    // second one — coverage and canonical dedup in feature D depend on this holding.
    expect((await stateOf(second)).bankAccountId).toBe((await stateOf(first)).bankAccountId);
  });

  it("reuses the account when the model spells the bank differently", async () => {
    const store = new FakeDocumentStore();
    const first = await uploaded(store);
    const second = await uploaded(store);
    const account = { bankName: "AXIS BANK", accountIdentifier: "921010042890365" };

    await identifyStatement(scope, store, modelReturning(identification(account)), first);
    await identifyStatement(
      scope,
      store,
      // The same statement, read again. This is what actually happened: two uploads of
      // axis-bank.pdf produced "AXIS BANK" and "Axis Bank", and a literal match made two
      // accounts for one. Canonical transactions are keyed on the account, so the split
      // would have double-counted every payment on it.
      modelReturning(identification({ ...account, bankName: "Axis Bank" })),
      second,
    );

    expect((await stateOf(second)).bankAccountId).toBe((await stateOf(first)).bankAccountId);
    expect(
      await scope.select(bankAccounts, eq(bankAccounts.accountIdentifier, "921010042890365")),
    ).toHaveLength(1);
  });

  it("keeps what the document said alongside the binding", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);

    await identifyStatement(scope, store, modelReturning(identification()), id);

    const row = await stateOf(id);
    expect(row.identifiedBankName).toBe("HDFC Bank");
    expect(row.identifiedAccountIdentifier).toBe("XXXX1234");
    expect(row.identifiedAccountType).toBe("Current");
    expect(row.periodSource).toBe("DECLARED");
  });

  it("opens the account in the currency the document named", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);

    // The Bank of Ireland regression: an Irish current account was created as INR because
    // the currency was a constant rather than something read off the document.
    await identifyStatement(
      scope,
      store,
      modelReturning(
        identification({
          bankName: "Bank of Ireland",
          accountIdentifier: "75069408",
          currency: "EUR",
        }),
      ),
      id,
    );

    const row = await stateOf(id);
    expect(row.state).toBe("PARSING");
    const account = await scope.selectOne(bankAccounts, eq(bankAccounts.id, row.bankAccountId!));
    expect(account!.currency).toBe("EUR");
  });

  it("does not re-denominate an account a later statement disagrees with", async () => {
    const store = new FakeDocumentStore();
    const first = await uploaded(store);
    const second = await uploaded(store);
    const account = identification({
      bankName: "Barclays",
      accountIdentifier: "9911",
      currency: "GBP",
    });

    await identifyStatement(scope, store, modelReturning(account), first);
    await identifyStatement(scope, store, modelReturning({ ...account, currency: "USD" }), second);

    // Step 3a: currency is established at creation and never rewritten. Canonical
    // transactions carry their own currency, so flipping the account's would re-denominate
    // movements already recorded against it.
    const row = await stateOf(second);
    const bound = await scope.selectOne(bankAccounts, eq(bankAccounts.id, row.bankAccountId!));
    expect(bound!.currency).toBe("GBP");
  });
});

describe("a credit card statement", () => {
  it("is a statement, and binds to an account of that kind", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);

    // The ICICI regression: a card statement was FAILED as "not a bank statement". A
    // business charges expenses to a card and those transactions need invoices too.
    await identifyStatement(
      scope,
      store,
      modelReturning(
        identification({
          documentKind: "CREDIT_CARD_STATEMENT",
          bankName: "ICICI Bank",
          accountIdentifier: "XXXX9012",
        }),
      ),
      id,
    );

    const row = await stateOf(id);
    expect(row.state).toBe("PARSING");
    expect(row.identifiedAccountKind).toBe("CREDIT_CARD");
    const account = await scope.selectOne(bankAccounts, eq(bankAccounts.id, row.bankAccountId!));
    expect(account!.accountKind).toBe("CREDIT_CARD");
  });
});

describe("a statement that declares no period", () => {
  it("is processed anyway, with the period left for parsing to derive", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);

    await identifyStatement(
      scope,
      store,
      modelReturning(identification({ periodStart: null, periodEnd: null })),
      id,
    );

    const row = await stateOf(id);
    /*
     * The Bank of Ireland regression, and the reason the model invented a period at all:
     * the only alternative on offer was to have the document thrown away. `0008` removes
     * that pressure. Double-counting is prevented by canonical transaction identity, not
     * by dates, so a statement with no declared period is safe to process — feature D
     * derives the range from the transactions and marks it DERIVED.
     */
    expect(row.state).toBe("PARSING");
    expect(row.periodStart).toBeNull();
    expect(row.periodEnd).toBeNull();
    expect(row.periodSource).toBeNull();
    expect(row.bankAccountId).not.toBeNull();
  });

  it("treats half a range as no range at all", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);

    await identifyStatement(scope, store, modelReturning(identification({ periodEnd: null })), id);

    // A start with no end is not a period. Recording it would give coverage an open range
    // that nothing can close.
    const row = await stateOf(id);
    expect(row.periodStart).toBeNull();
    expect(row.periodSource).toBeNull();
  });
});

describe("a statement whose currency we cannot determine", () => {
  it("waits for the user rather than assuming one", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);
    const accountsBefore = (await scope.select(bankAccounts)).length;

    await identifyStatement(scope, store, modelReturning(identification({ currency: null })), id);

    const row = await stateOf(id);
    // An account's currency is permanent, so an assumption here is permanent too.
    // Defaulting to INR is how a Bank of Ireland account came to hold rupees.
    expect(row.state).toBe("NEEDS_ACCOUNT");
    expect(row.bankAccountId).toBeNull();
    expect(await scope.select(bankAccounts)).toHaveLength(accountsBefore);
  });

  it("keeps an unsupported code so the gap is visible", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);

    await identifyStatement(scope, store, modelReturning(identification({ currency: "XYZ" })), id);

    const row = await stateOf(id);
    expect(row.state).toBe("NEEDS_ACCOUNT");
    // The raw answer survives validation: a statement waiting here is only debuggable if
    // what the model actually said is still on the row.
    expect(row.identifiedCurrency).toBe("XYZ");
  });
});

describe("a statement being identified", () => {
  it("is marked in flight before the model is asked", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);
    let stateWhenAsked: string | undefined;

    // spec: docs/state-machines.md §1 — UPLOADING → IDENTIFYING. The mark has to land
    // before the call, not after it: the polling UI reads this row to show movement, and
    // the workflow's terminal failure handler recognises an abandoned run by finding the
    // statement still sitting here.
    const model: IdentifyDocument = async (document) => {
      stateWhenAsked = (await stateOf(id)).state;
      return modelReturning(identification())(document);
    };

    await identifyStatement(scope, store, model, id);

    expect(stateWhenAsked).toBe("IDENTIFYING");
  });
});

describe("a statement that does not name its account", () => {
  it("waits for the user rather than guessing", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);
    const accountsBefore = (await scope.select(bankAccounts)).length;

    await identifyStatement(
      scope,
      store,
      modelReturning(identification({ accountIdentifier: null })),
      id,
    );

    const row = await stateOf(id);
    // Step 3a: "A statement is never bound to an account by inference alone when the
    // identifier is absent."
    expect(row.state).toBe("NEEDS_ACCOUNT");
    expect(row.bankAccountId).toBeNull();
    // The period is still known, and what the document did say is shown to the user.
    expect(row.periodStart).toBe("2026-03-01");
    expect(row.identifiedBankName).toBe("HDFC Bank");
    // Nothing was created on the strength of a bank name alone.
    expect(await scope.select(bankAccounts)).toHaveLength(accountsBefore);
  });
});

describe("a statement we cannot use", () => {
  it("fails when the document is neither a bank nor a card statement", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);

    await identifyStatement(
      scope,
      store,
      modelReturning(identification({ documentKind: "SOMETHING_ELSE" })),
      id,
    );

    const row = await stateOf(id);
    expect(row.state).toBe("FAILED");
    expect(row.failureReason).toMatch(/bank or credit card statement/);
  });

  it("does not blame the document when the model was unreachable", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);

    // Observed for real on 2026-09-15: the gateway refused every request because no card
    // was on file. Marking the statement unreadable would permanently fail a perfectly
    // good document because of our billing, so the error propagates instead and the
    // workflow retries. docs/definition-of-done.md: recoverable and non-recoverable
    // failures are distinguished.
    await expect(identifyStatement(scope, store, modelThatIsUnreachable, id)).rejects.toThrow(
      /credit card/,
    );

    // Left mid-flight for the retry, never FAILED.
    expect((await stateOf(id)).state).toBe("IDENTIFYING");
    expect((await stateOf(id)).failureReason).toBeNull();
  });

  it("fails when the model cannot answer", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);

    await identifyStatement(scope, store, modelThatFails, id);

    const row = await stateOf(id);
    // A failed inference is an outcome recorded as state, not an exception that takes the
    // workflow down (definition of done, "When it touches an LLM").
    expect(row.state).toBe("FAILED");
    expect(row.failureReason).toMatch(/couldn't read this statement/);
  });
});

describe("a workflow that never completed", () => {
  it("records FAILED once the retries are spent", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);

    // What the gateway outage of 2026-09-15 would have produced: three retries, every one
    // of them rethrowing, the statement still mid-flight.
    await expect(identifyStatement(scope, store, modelThatIsUnreachable, id)).rejects.toThrow();
    expect((await stateOf(id)).state).toBe("IDENTIFYING");

    await recordTerminalFailure(scope, id);

    const row = await stateOf(id);
    // Left in IDENTIFYING it would spin in the polling UI forever, which is the failure
    // swallowed rather than recorded as state that docs/definition-of-done.md forbids.
    expect(row.state).toBe("FAILED");
    expect(row.bankAccountId).toBeNull();
  });

  it("blames us rather than the document", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);

    await recordTerminalFailure(scope, id);

    // The document was never at fault — nothing was ever read. A reason suggesting the
    // statement was unclear would send the user off to re-scan a perfectly good file.
    const reason = (await stateOf(id)).failureReason!;
    expect(reason).toMatch(/on our side/);
    expect(reason).not.toMatch(/clearer copy|doesn't look like/);
  });

  it("does nothing for a statement belonging to another workspace", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);

    const carol = await seedWorkspace(h.db, "Carol Exports");
    const carolScope = await openWorkspace(h.db, carol.user.id, carol.workspace.id);

    // The shape of a tampered event reaching the failure handler: Carol's scope, Alice's
    // statement id.
    await recordTerminalFailure(carolScope, id);

    expect((await stateOf(id)).state).toBe("UPLOADING");
  });
});

describe("running identification again", () => {
  it("changes nothing once the statement has moved on", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);

    await identifyStatement(scope, store, modelReturning(identification()), id);
    const afterFirst = await stateOf(id);

    // A replayed event, or a retry after the step already committed. A second account, or
    // a rebinding, would be the damage.
    await identifyStatement(
      scope,
      store,
      modelReturning(identification({ accountIdentifier: "XXXX9999" })),
      id,
    );

    const afterSecond = await stateOf(id);
    expect(afterSecond.state).toBe("PARSING");
    expect(afterSecond.bankAccountId).toBe(afterFirst.bankAccountId);
    expect(
      await scope.select(bankAccounts, eq(bankAccounts.accountIdentifier, "XXXX9999")),
    ).toHaveLength(0);
  });

  it("does nothing for a statement belonging to another workspace", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);

    const bob = await seedWorkspace(h.db, "Bob Industries");
    const bobScope = await openWorkspace(h.db, bob.user.id, bob.workspace.id);

    // The shape of a tampered event: Bob's scope, Alice's statement id.
    await identifyStatement(bobScope, store, modelReturning(identification()), id);

    expect((await stateOf(id)).state).toBe("UPLOADING");
    expect(await bobScope.select(bankAccounts)).toHaveLength(0);
  });
});
