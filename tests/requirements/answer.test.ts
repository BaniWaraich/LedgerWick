/**
 * What the system keeps when the user answers.
 *
 * spec: docs/workflows/identifying-invoices.md §5 Step 5 and §7
 *
 * The product promise being tested is the one in §5: "The system should not repeatedly ask
 * the same question when the answer is already known. Asking twice is worse than not asking:
 * it tells the user their answers go nowhere." That only holds if an answer becomes a fact
 * keyed on something the next payment will also match.
 */

import { and, eq } from "drizzle-orm";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "../../src/db/schema";
import { businessKnowledge, clarificationQuestions } from "../../src/db/schema";
import { openWorkspace, type WorkspaceScope } from "../../src/db/workspace-scope";
import { recordAnswer } from "../../src/requirements/answer";
import { createTestDb, seedBankAccount, seedWorkspace, type TestDb } from "../helpers/db";

let harness: TestDb;

beforeEach(async () => {
  harness = await createTestDb();
});

afterAll(async () => {
  await harness.close();
});

interface Fixture {
  scope: WorkspaceScope;
  ask: (vendorGuess: string | null) => Promise<string>;
}

async function fixture(): Promise<Fixture> {
  const { user, workspace } = await seedWorkspace(harness.db);
  const account = await seedBankAccount(harness.db, workspace.id);
  const scope = await openWorkspace(harness.db, user.id, workspace.id);

  let sequence = 0;

  return {
    scope,
    ask: async (vendorGuess) => {
      sequence += 1;
      const [transaction] = await harness.db
        .insert(schema.canonicalTransactions)
        .values({
          workspaceId: workspace.id,
          bankAccountId: account.id,
          valueDate: "2026-04-21",
          amountMinor: 1850000n,
          direction: "DEBIT",
          currency: "INR",
          description: `UPI/XYZ SERVICES/99${sequence}/ORDER`,
          descriptionNormalized: `upi xyz services 99${sequence} order`,
          occurrenceIndex: sequence,
        })
        .returning();

      const [question] = await harness.db
        .insert(clarificationQuestions)
        .values({
          workspaceId: workspace.id,
          canonicalTransactionId: transaction.id,
          question: "What is XYZ Services?",
          vendorGuess,
          options: ["A business vendor", "A personal payment"],
        })
        .returning();

      return question.id;
    },
  };
}

const knowledgeOf = (fx: Fixture) => fx.scope.select(businessKnowledge);

describe("answering a question", () => {
  it("records the answer against the question", async () => {
    const fx = await fixture();
    const id = await fx.ask("XYZ Services");

    const outcome = await recordAnswer(fx.scope, id, "A business vendor");
    const [question] = await fx.scope.select(clarificationQuestions);

    expect(outcome).toEqual({ recorded: true, learned: true });
    expect(question.answer).toBe("A business vendor");
    expect(question.answeredAt).not.toBeNull();
  });

  it("keeps it as Business Knowledge, keyed on the payee", async () => {
    // docs/domain-model.md invariant 18: knowledge comes only from a confirmed decision,
    // and an answer the user pressed is the only confirmation this system has.
    const fx = await fixture();
    const id = await fx.ask("XYZ Services");

    await recordAnswer(fx.scope, id, "A business vendor");
    const [fact] = await knowledgeOf(fx);

    expect(fact.kind).toBe("vendor");
    expect(fact.key).toBe("xyz services");
    expect(fact.value).toMatchObject({ vendor: "XYZ Services", answer: "A business vendor" });
  });

  it("keys two spellings of one payee to the same fact", async () => {
    // The reason the key is the payee and not the narration: UPI/XYZ SERVICES/991/ORDER
    // and NEFT-DR-XYZ SERVICES share no substring worth matching, so knowledge keyed on
    // the narration would be true of exactly one payment and never fire again.
    const fx = await fixture();

    await recordAnswer(fx.scope, await fx.ask("XYZ Services"), "A business vendor");
    await recordAnswer(fx.scope, await fx.ask("XYZ SERVICES."), "A business vendor");

    expect(await knowledgeOf(fx)).toHaveLength(1);
  });

  it("replaces what we knew when the user changes their mind", async () => {
    // business_knowledge_identity_idx makes (workspace, kind, key) unique, so a later run
    // never has to choose between two contradictory facts about one vendor.
    const fx = await fixture();

    await recordAnswer(fx.scope, await fx.ask("XYZ Services"), "A business vendor");
    await recordAnswer(fx.scope, await fx.ask("XYZ Services"), "A personal payment");

    const facts = await knowledgeOf(fx);
    expect(facts).toHaveLength(1);
    expect(facts[0].value).toMatchObject({ answer: "A personal payment" });
  });
});

describe("an answer with nothing to generalize over", () => {
  it("still closes the question", async () => {
    // A payment whose narration was a reference number and nothing else. The question is
    // answered and the transaction can be judged; it just teaches us nothing about the next
    // payment, and pretending otherwise would put a useless fact in front of every run.
    const fx = await fixture();
    const id = await fx.ask(null);

    const outcome = await recordAnswer(fx.scope, id, "A business vendor");
    const [question] = await fx.scope.select(clarificationQuestions);

    expect(outcome).toEqual({ recorded: true, learned: false });
    expect(question.answeredAt).not.toBeNull();
    expect(await knowledgeOf(fx)).toHaveLength(0);
  });

  it("learns nothing from a payee that normalizes to nothing", async () => {
    const fx = await fixture();
    const id = await fx.ask("***");

    expect(await recordAnswer(fx.scope, id, "A business vendor")).toEqual({
      recorded: true,
      learned: false,
    });
    expect(await knowledgeOf(fx)).toHaveLength(0);
  });
});

describe("answering twice", () => {
  it("changes nothing and writes no second fact", async () => {
    // A double-submitted form, a back button, a stale tab.
    const fx = await fixture();
    const id = await fx.ask("XYZ Services");

    await recordAnswer(fx.scope, id, "A business vendor");
    const second = await recordAnswer(fx.scope, id, "A personal payment");

    const [question] = await fx.scope.select(clarificationQuestions);
    expect(second).toEqual({ recorded: false, learned: false });
    expect(question.answer).toBe("A business vendor");
    expect(await knowledgeOf(fx)).toHaveLength(1);
  });
});

describe("an answer that is not one", () => {
  it("is refused when it is empty", async () => {
    const fx = await fixture();
    const id = await fx.ask("XYZ Services");

    expect(await recordAnswer(fx.scope, id, "   ")).toEqual({ recorded: false, learned: false });
    expect((await fx.scope.select(clarificationQuestions))[0].answeredAt).toBeNull();
  });
});

describe("workspace isolation", () => {
  it("cannot answer another workspace's question", async () => {
    // Written as an attack: a form posted with a question id from someone else's workspace.
    const theirs = await fixture();
    const id = await theirs.ask("XYZ Services");

    const ours = await fixture();
    const outcome = await recordAnswer(ours.scope, id, "A business vendor");

    expect(outcome).toEqual({ recorded: false, learned: false });
    expect((await theirs.scope.select(clarificationQuestions))[0].answeredAt).toBeNull();
    expect(await knowledgeOf(ours)).toHaveLength(0);
  });

  it("writes what it learns into its own workspace only", async () => {
    const theirs = await fixture();
    const ours = await fixture();

    await recordAnswer(ours.scope, await ours.ask("XYZ Services"), "A business vendor");

    expect(await knowledgeOf(ours)).toHaveLength(1);
    expect(await knowledgeOf(theirs)).toHaveLength(0);
  });

  it("does not collide with another workspace's fact about the same vendor", async () => {
    // (workspace, kind, key) is unique per workspace, not globally. Two businesses may
    // both pay XYZ Services and reach opposite conclusions about them.
    const theirs = await fixture();
    const ours = await fixture();

    await recordAnswer(theirs.scope, await theirs.ask("XYZ Services"), "A personal payment");
    await recordAnswer(ours.scope, await ours.ask("XYZ Services"), "A business vendor");

    const [mine] = await ours.scope.select(
      businessKnowledge,
      and(eq(businessKnowledge.kind, "vendor"), eq(businessKnowledge.key, "xyz services")),
    );

    expect(mine.value).toMatchObject({ answer: "A business vendor" });
  });
});
