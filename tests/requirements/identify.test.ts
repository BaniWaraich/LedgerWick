/**
 * Deciding which payments need a document.
 *
 * spec: docs/workflows/identifying-invoices.md
 *
 * The classifier is a fake throughout. What is being tested is not whether a model can tell
 * a software subscription from a bank charge -- no test settles that, and
 * `docs/testing-strategy.md` puts it on the other side of the line, with the evals. What is
 * tested here is everything around the judgment: that a second run is silent, that a
 * question never stalls the run, that a credit never becomes a requirement, and that none of
 * it reaches another workspace.
 */

import { eq } from "drizzle-orm";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "../../src/db/schema";
import {
  canonicalTransactions,
  clarificationQuestions,
  invoiceRequirements,
  reconciliationRuns,
} from "../../src/db/schema";
import { openWorkspace, type WorkspaceScope } from "../../src/db/workspace-scope";
import type { ClassifyTransactions, TransactionBrief } from "../../src/requirements/contracts";
import { identifyRequirements } from "../../src/requirements/identify";
import { createTestDb, seedBankAccount, seedWorkspace, type TestDb } from "../helpers/db";

let harness: TestDb;

beforeEach(async () => {
  harness = await createTestDb();
});

afterAll(async () => {
  await harness.close();
});

interface Payment {
  description?: string;
  amount?: bigint;
  direction?: "DEBIT" | "CREDIT";
  date?: string;
}

interface Fixture {
  scope: WorkspaceScope;
  workspaceId: string;
  payment: (payment?: Payment) => Promise<string>;
  knows: (kind: string, key: string, value: unknown) => Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const { user, workspace } = await seedWorkspace(harness.db);
  const account = await seedBankAccount(harness.db, workspace.id);
  const scope = await openWorkspace(harness.db, user.id, workspace.id);

  let sequence = 0;

  return {
    scope,
    workspaceId: workspace.id,
    payment: async (payment: Payment = {}) => {
      sequence += 1;
      const description = payment.description ?? "ANTHROPIC*CLAUDE";
      const [row] = await harness.db
        .insert(canonicalTransactions)
        .values({
          workspaceId: workspace.id,
          bankAccountId: account.id,
          valueDate: payment.date ?? "2026-04-15",
          amountMinor: payment.amount ?? 485000n,
          direction: payment.direction ?? "DEBIT",
          currency: "INR",
          description,
          descriptionNormalized: description.toLowerCase(),
          occurrenceIndex: sequence,
        })
        .returning();
      return row.id;
    },
    knows: async (kind, key, value) => {
      await harness.db
        .insert(schema.businessKnowledge)
        .values({ workspaceId: workspace.id, kind, key, value });
    },
  };
}

/** A classifier that says every payment needs a document, and remembers what it was asked. */
function alwaysRequires(): ClassifyTransactions & { seen: TransactionBrief[]; calls: number } {
  const fake = Object.assign(
    async (request: { transactions: TransactionBrief[] }) => {
      fake.seen.push(...request.transactions);
      fake.calls += 1;
      return {
        ok: true as const,
        value: {
          judgements: request.transactions.map((transaction) => ({
            index: transaction.index,
            vendorGuess: "Anthropic",
            businessContext: "Software subscription",
            needsDocument: true,
            reason: "Monthly software subscription, needed for your expense records.",
            confident: true,
            clarification: null,
          })),
        },
      };
    },
    { seen: [] as TransactionBrief[], calls: 0 },
  );
  return fake;
}

/** A classifier that cannot tell, and asks. */
const alwaysAsks: ClassifyTransactions = async ({ transactions }) => ({
  ok: true,
  value: {
    judgements: transactions.map((transaction) => ({
      index: transaction.index,
      vendorGuess: "XYZ Services",
      businessContext: null,
      needsDocument: false,
      reason: null,
      confident: false,
      clarification: {
        question: "What is XYZ Services?",
        options: ["A business vendor", "A personal payment"],
      },
    })),
  },
});

const requirementsOf = (fx: Fixture) => fx.scope.select(invoiceRequirements);
const questionsOf = (fx: Fixture) => fx.scope.select(clarificationQuestions);

describe("a first run over new transactions", () => {
  it("creates one requirement per payment that needs a document", async () => {
    const fx = await fixture();
    await fx.payment();
    await fx.payment({ description: "XYZ SERVICES" });

    const outcome = await identifyRequirements(fx.scope, { classify: alwaysRequires() });

    expect(outcome.state).toBe("COMPLETED");
    expect(outcome.transactionsProcessed).toBe(2);
    expect(outcome.documentsRequired).toBe(2);
    expect(await requirementsOf(fx)).toHaveLength(2);
  });

  it("starts each requirement in IDENTIFIED with the reason the user will read", async () => {
    const fx = await fixture();
    await fx.payment();

    await identifyRequirements(fx.scope, { classify: alwaysRequires() });
    const [requirement] = await requirementsOf(fx);

    expect(requirement.state).toBe("IDENTIFIED");
    expect(requirement.reason).toContain("software subscription");
    expect(requirement.vendorGuess).toBe("Anthropic");
    expect(requirement.businessContext).toBe("Software subscription");
  });

  it("ties every requirement to the run that identified it", async () => {
    const fx = await fixture();
    await fx.payment();

    const outcome = await identifyRequirements(fx.scope, { classify: alwaysRequires() });
    const [requirement] = await requirementsOf(fx);

    expect(requirement.reconciliationRunId).toBe(outcome.runId);
  });

  it("closes the run with what it covered", async () => {
    const fx = await fixture();
    await fx.payment();

    const outcome = await identifyRequirements(fx.scope, { classify: alwaysRequires() });
    const [run] = await fx.scope.select(
      reconciliationRuns,
      eq(reconciliationRuns.id, outcome.runId),
    );

    expect(run.state).toBe("COMPLETED");
    expect(run.finishedAt).not.toBeNull();
    expect(run.transactionsProcessed).toBe(1);
    expect(run.documentsRequired).toBe(1);
  });
});

describe("running it again", () => {
  it("creates nothing the second time", async () => {
    // The definition of done's background-workflow rule: running it twice produces the
    // same result as running it once.
    const fx = await fixture();
    await fx.payment();
    await fx.payment({ description: "XYZ SERVICES" });

    await identifyRequirements(fx.scope, { classify: alwaysRequires() });
    const second = await identifyRequirements(fx.scope, { classify: alwaysRequires() });

    expect(second.state).toBe("COMPLETED");
    expect(second.documentsRequired).toBe(0);
    expect(await requirementsOf(fx)).toHaveLength(2);
  });

  it("does not even ask about a transaction it has already judged", async () => {
    // §5 Step 1. Skipping is what makes the second run cheap, not just harmless -- and
    // paying to re-judge settled transactions is how a run gets slower every month.
    const fx = await fixture();
    await fx.payment();

    await identifyRequirements(fx.scope, { classify: alwaysRequires() });
    const second = alwaysRequires();
    await identifyRequirements(fx.scope, { classify: second });

    expect(second.seen).toHaveLength(0);
    expect(second.calls).toBe(0);
  });

  it("judges only what genuinely arrived since", async () => {
    const fx = await fixture();
    await fx.payment();
    await identifyRequirements(fx.scope, { classify: alwaysRequires() });

    await fx.payment({ description: "NEW VENDOR" });
    const second = alwaysRequires();
    const outcome = await identifyRequirements(fx.scope, { classify: second });

    expect(second.seen.map((t) => t.description)).toEqual(["NEW VENDOR"]);
    expect(outcome.transactionsProcessed).toBe(1);
    expect(await requirementsOf(fx)).toHaveLength(2);
  });
});

describe("a transaction the system cannot determine", () => {
  it("becomes a persisted question rather than a guess", async () => {
    const fx = await fixture();
    const id = await fx.payment({ description: "XYZ SERVICES" });

    const outcome = await identifyRequirements(fx.scope, { classify: alwaysAsks });
    const [question] = await questionsOf(fx);

    expect(outcome.questionsRaised).toBe(1);
    expect(question.canonicalTransactionId).toBe(id);
    expect(question.question).toContain("XYZ Services");
    expect(question.options).toEqual(["A business vendor", "A personal payment"]);
    expect(question.answeredAt).toBeNull();
  });

  it("produces no requirement, because an unconfirmed inference is not a fact", async () => {
    // docs/domain-model.md invariant 18.
    const fx = await fixture();
    await fx.payment();

    await identifyRequirements(fx.scope, { classify: alwaysAsks });

    expect(await requirementsOf(fx)).toHaveLength(0);
  });

  it("does not stop the run reaching COMPLETED", async () => {
    // §6: awaiting answers is not a blocking stage. architecture.md §12C forbids a
    // background workflow suspended on a human, who may simply be asleep.
    const fx = await fixture();
    await fx.payment();

    const outcome = await identifyRequirements(fx.scope, { classify: alwaysAsks });

    expect(outcome.state).toBe("COMPLETED");
  });

  it("does not hold up the transactions the run could determine", async () => {
    const fx = await fixture();
    await fx.payment({ description: "ANTHROPIC" });
    await fx.payment({ description: "XYZ SERVICES" });

    const mixed: ClassifyTransactions = async ({ transactions }) => ({
      ok: true,
      value: {
        judgements: transactions.map((transaction) =>
          transaction.description === "XYZ SERVICES"
            ? {
                index: transaction.index,
                vendorGuess: "XYZ Services",
                businessContext: null,
                needsDocument: false,
                reason: null,
                confident: false,
                clarification: {
                  question: "What is XYZ Services?",
                  options: ["Vendor", "Personal"],
                },
              }
            : {
                index: transaction.index,
                vendorGuess: "Anthropic",
                businessContext: "Software subscription",
                needsDocument: true,
                reason: "Monthly software subscription.",
                confident: true,
                clarification: null,
              },
        ),
      },
    });

    const outcome = await identifyRequirements(fx.scope, { classify: mixed });

    expect(outcome.documentsRequired).toBe(1);
    expect(outcome.questionsRaised).toBe(1);
    expect(outcome.state).toBe("COMPLETED");
  });
});

describe("what the model is not allowed to overrule", () => {
  it("never requires a document for money arriving", async () => {
    // docs/domain-model.md §11.1 puts refunds and incoming credits out of V1 scope as a
    // product decision. Not a judgment call, so not delegated -- even when the classifier
    // insists.
    const fx = await fixture();
    await fx.payment({ direction: "CREDIT", description: "REFUND FROM ACME" });

    const outcome = await identifyRequirements(fx.scope, { classify: alwaysRequires() });

    expect(outcome.documentsRequired).toBe(0);
    expect(await requirementsOf(fx)).toHaveLength(0);
    expect(outcome.state).toBe("COMPLETED");
  });

  it("still judges the debits sitting beside a credit", async () => {
    const fx = await fixture();
    await fx.payment({ direction: "CREDIT", description: "REFUND" });
    await fx.payment({ description: "ANTHROPIC" });

    const outcome = await identifyRequirements(fx.scope, { classify: alwaysRequires() });

    expect(outcome.documentsRequired).toBe(1);
  });

  it("ignores a judgement about a transaction it was never shown", async () => {
    // A model answering about row 500 of a 40-row list has told us nothing about row 500,
    // and writing against an index we did not send is how one workspace's judgment lands
    // on another workspace's row.
    const fx = await fixture();
    await fx.payment();

    const strays: ClassifyTransactions = async () => ({
      ok: true,
      value: {
        judgements: [
          {
            index: 500,
            vendorGuess: "Nobody",
            businessContext: null,
            needsDocument: true,
            reason: "Invented.",
            confident: true,
            clarification: null,
          },
        ],
      },
    });

    const outcome = await identifyRequirements(fx.scope, { classify: strays });

    expect(outcome.documentsRequired).toBe(0);
    expect(await requirementsOf(fx)).toHaveLength(0);
  });
});

describe("nothing to do", () => {
  it("is a COMPLETED run, not a failure", async () => {
    // §10: zero invoice requirements is a valid outcome.
    const fx = await fixture();

    const outcome = await identifyRequirements(fx.scope, { classify: alwaysRequires() });

    expect(outcome.state).toBe("COMPLETED");
    expect(outcome.transactionsProcessed).toBe(0);
    expect(outcome.documentsRequired).toBe(0);
  });

  it("is also a COMPLETED run when nothing needs a document", async () => {
    const fx = await fixture();
    await fx.payment({ description: "TRANSFER TO OWN HDFC ACCOUNT" });

    const nothingNeeded: ClassifyTransactions = async ({ transactions }) => ({
      ok: true,
      value: {
        judgements: transactions.map((transaction) => ({
          index: transaction.index,
          vendorGuess: null,
          businessContext: "Internal transfer",
          needsDocument: false,
          reason: null,
          confident: true,
          clarification: null,
        })),
      },
    });

    const outcome = await identifyRequirements(fx.scope, { classify: nothingNeeded });

    expect(outcome.state).toBe("COMPLETED");
    expect(outcome.documentsRequired).toBe(0);
  });
});

describe("when the model cannot answer", () => {
  it("records the run as FAILED rather than crashing", async () => {
    // The definition of done: schema validation failure is handled and does not crash the
    // workflow. `inferStructure` rethrows infrastructure failures, so only this reaches us.
    const fx = await fixture();
    await fx.payment();

    const refuses: ClassifyTransactions = async () => ({
      ok: false,
      reason: "no object generated",
    });
    const outcome = await identifyRequirements(fx.scope, { classify: refuses });

    expect(outcome.state).toBe("FAILED");
    expect(outcome.failure).toContain("no object generated");
    expect(await requirementsOf(fx)).toHaveLength(0);
  });

  it("leaves no run stuck in RUNNING", async () => {
    // A run left RUNNING is a spinner that never stops.
    const fx = await fixture();
    await fx.payment();

    const refuses: ClassifyTransactions = async () => ({ ok: false, reason: "unusable" });
    const outcome = await identifyRequirements(fx.scope, { classify: refuses });
    const [run] = await fx.scope.select(
      reconciliationRuns,
      eq(reconciliationRuns.id, outcome.runId),
    );

    expect(run.state).toBe("FAILED");
    expect(run.finishedAt).not.toBeNull();
  });

  it("records the run as FAILED when the infrastructure breaks, and rethrows", async () => {
    const fx = await fixture();
    await fx.payment();

    const breaks: ClassifyTransactions = async () => {
      throw new Error("gateway unreachable");
    };

    await expect(identifyRequirements(fx.scope, { classify: breaks })).rejects.toThrow(
      "gateway unreachable",
    );

    const [run] = await fx.scope.select(reconciliationRuns);
    expect(run.state).toBe("FAILED");
  });
});

describe("what the model is told", () => {
  it("is given the facts the user has already confirmed", async () => {
    // §5 Step 4: check what you know before asking. The cheapest way never to ask a settled
    // question is for the answer to be in front of the model when it decides whether to ask.
    const fx = await fixture();
    await fx.payment();
    await fx.knows("vendor", "anthropic", { classification: "business supplier" });

    const classifier = alwaysRequires();
    let known: unknown;
    await identifyRequirements(fx.scope, {
      classify: async (request) => {
        known = request.known;
        return classifier(request);
      },
    });

    expect(known).toEqual([
      { kind: "vendor", key: "anthropic", value: { classification: "business supplier" } },
    ]);
  });

  it("is never given an id it could write against", async () => {
    const fx = await fixture();
    await fx.payment();

    const classifier = alwaysRequires();
    await identifyRequirements(fx.scope, { classify: classifier });

    expect(classifier.seen[0]).not.toHaveProperty("id");
    expect(Object.keys(classifier.seen[0]).sort()).toEqual([
      "account",
      "amountMinor",
      "currency",
      "description",
      "direction",
      "index",
      "valueDate",
    ]);
  });
});

describe("workspace isolation", () => {
  it("never judges a transaction belonging to another workspace", async () => {
    // Written as an attack. Isolation lives in application code, so it is only as good as
    // the tests that try to break it.
    const theirs = await fixture();
    await theirs.payment({ description: "THEIR VENDOR" });

    const ours = await fixture();
    await ours.payment({ description: "OUR VENDOR" });

    const classifier = alwaysRequires();
    await identifyRequirements(ours.scope, { classify: classifier });

    expect(classifier.seen.map((t) => t.description)).toEqual(["OUR VENDOR"]);
    expect(await requirementsOf(theirs)).toHaveLength(0);
  });

  it("never reads another workspace's confirmed facts", async () => {
    const theirs = await fixture();
    await theirs.knows("vendor", "secret", { classification: "theirs alone" });

    const ours = await fixture();
    await ours.payment();

    let known: unknown;
    const classifier = alwaysRequires();
    await identifyRequirements(ours.scope, {
      classify: async (request) => {
        known = request.known;
        return classifier(request);
      },
    });

    expect(known).toEqual([]);
  });

  it("writes its requirements and questions into its own workspace only", async () => {
    const theirs = await fixture();
    const ours = await fixture();
    await ours.payment();

    await identifyRequirements(ours.scope, { classify: alwaysRequires() });

    expect(await requirementsOf(ours)).toHaveLength(1);
    expect(await requirementsOf(theirs)).toHaveLength(0);
    expect(await questionsOf(theirs)).toHaveLength(0);
  });

  it("does not let one workspace's run be seen by another", async () => {
    const ours = await fixture();
    await ours.payment();
    const outcome = await identifyRequirements(ours.scope, { classify: alwaysRequires() });

    const theirs = await fixture();
    const stolen = await theirs.scope.select(
      reconciliationRuns,
      eq(reconciliationRuns.id, outcome.runId),
    );

    expect(stolen).toEqual([]);
  });
});
