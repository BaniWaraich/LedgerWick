/**
 * Writing down a fact the user confirmed.
 *
 * spec: docs/architecture.md §11 · docs/domain-model.md invariant 18
 *
 * These were implicit in `answer.test.ts` when this code lived inside `answer.ts` — they
 * were reachable only by answering a clarification question. Match review is about to be a
 * second caller, so the behaviour is worth pinning down on its own rather than through one
 * of its callers.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { createTestDb, seedWorkspace, type TestDb } from "../helpers/db";
import { businessKnowledge } from "../../src/db/schema";
import { WorkspaceScope } from "../../src/db/workspace-scope";
import { learn, normalizeVendor, VENDOR } from "../../src/requirements/knowledge";

let h: TestDb;
let scope: WorkspaceScope;

beforeEach(async () => {
  h = await createTestDb();
  const { workspace, user } = await seedWorkspace(h.db);
  scope = new WorkspaceScope(h.db, workspace.id, user.id);
});

afterEach(async () => {
  await h.close();
});

describe("reducing a payee to something two spellings share", () => {
  it("ignores case and punctuation", () => {
    expect(normalizeVendor("ANTHROPIC.")).toBe("anthropic");
    expect(normalizeVendor("Anthropic")).toBe("anthropic");
  });

  it("collapses the separators a bank rail puts between fields", () => {
    // `UPI/XYZ SERVICES/9922/ORDER` and `NEFT-DR-XYZ SERVICES` are the same vendor and
    // share no substring worth matching until the punctuation goes.
    expect(normalizeVendor("UPI/XYZ SERVICES/9922")).toBe("upi xyz services 9922");
    expect(normalizeVendor("NEFT-DR-XYZ SERVICES")).toBe("neft dr xyz services");
  });

  it("gives back nothing for a name that is not one", () => {
    // A narration that was a reference number and nothing else. The caller reads this as
    // "there is nothing here to generalize over", which is not the same as learning
    // something empty.
    expect(normalizeVendor("")).toBeNull();
    expect(normalizeVendor("   ")).toBeNull();
    expect(normalizeVendor("!!!")).toBeNull();
    expect(normalizeVendor(null)).toBeNull();
  });

  it("does not interpret, only format", () => {
    // Deciding that "Anthropic" and "Claude" are one vendor is a judgment, and it belongs
    // to the model and the user. This function must never make it.
    expect(normalizeVendor("Claude")).not.toBe(normalizeVendor("Anthropic"));
  });
});

describe("writing a confirmed fact", () => {
  it("records it the first time", async () => {
    await learn(scope, VENDOR, "anthropic", { answer: "A business vendor" });

    const [row] = await h.db.select().from(businessKnowledge);
    expect(row.kind).toBe("vendor");
    expect(row.key).toBe("anthropic");
    expect(row.value).toEqual({ answer: "A business vendor" });
  });

  it("replaces it when the user changes their mind", async () => {
    // business_knowledge_identity_idx makes (workspace, kind, key) unique, so a second
    // confirmation replaces the first rather than leaving two contradictory facts for a
    // later run to choose between.
    await learn(scope, VENDOR, "anthropic", { answer: "A business vendor" });
    const [first] = await h.db.select().from(businessKnowledge);

    await learn(scope, VENDOR, "anthropic", { answer: "Actually personal" });

    const rows = await h.db.select().from(businessKnowledge);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toEqual({ answer: "Actually personal" });
    expect(rows[0].confirmedAt.getTime()).toBeGreaterThanOrEqual(first.confirmedAt.getTime());
  });

  it("keeps facts about different vendors apart", async () => {
    await learn(scope, VENDOR, "anthropic", { answer: "A business vendor" });
    await learn(scope, VENDOR, "adobe", { answer: "A business vendor" });

    expect(await h.db.select().from(businessKnowledge)).toHaveLength(2);
  });

  it("keeps facts of different kinds apart under one key", async () => {
    // `kind` is free text and the unique index spans it, so a second kind is a second
    // fact rather than a collision. Nothing writes a second kind yet; this says what
    // happens when something does.
    await learn(scope, VENDOR, "anthropic", { answer: "A business vendor" });
    await learn(scope, "payment-pattern", "anthropic", { answer: "Monthly" });

    expect(await h.db.select().from(businessKnowledge)).toHaveLength(2);
  });
});

describe("two workspaces confirming the same thing", () => {
  it("does not collide, and neither can see the other", async () => {
    // The unique index is scoped to the workspace. Two businesses both paying Anthropic
    // is the ordinary case, not a conflict.
    const other = await seedWorkspace(h.db, "Someone Else");
    const theirs = new WorkspaceScope(h.db, other.workspace.id, other.user.id);

    await learn(scope, VENDOR, "anthropic", { answer: "A business vendor" });
    await learn(theirs, VENDOR, "anthropic", { answer: "Personal" });

    expect(await h.db.select().from(businessKnowledge)).toHaveLength(2);
    expect(await scope.select(businessKnowledge)).toHaveLength(1);
    expect((await scope.select(businessKnowledge))[0].value).toEqual({
      answer: "A business vendor",
    });
  });

  it("does not let one workspace overwrite another's fact", async () => {
    const other = await seedWorkspace(h.db, "Someone Else");
    const theirs = new WorkspaceScope(h.db, other.workspace.id, other.user.id);

    await learn(scope, VENDOR, "anthropic", { answer: "A business vendor" });
    const [mine] = await scope.select(businessKnowledge);

    await learn(theirs, VENDOR, "anthropic", { answer: "Personal" });

    const [unchanged] = await h.db
      .select()
      .from(businessKnowledge)
      .where(eq(businessKnowledge.id, mine.id));
    expect(unchanged.value).toEqual({ answer: "A business vendor" });
  });
});
