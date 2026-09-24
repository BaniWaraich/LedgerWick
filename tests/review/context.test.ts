/**
 * What the review screen is given, and what it is deliberately not given.
 *
 * spec: docs/workflows/invoice-match-review.md §4, §5, §7, §10, §12
 *
 * Integration rather than unit: the thing worth testing is a query read against the grain
 * of how matching stored it, and a mock would return whatever the test set up.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { createTestDb, seedBankAccount, seedWorkspace, type TestDb } from "../helpers/db";
import {
  canonicalTransactions,
  invoiceDocuments,
  invoiceMatchCandidates,
  invoiceRequirements,
  invoices,
  supportingDocuments,
  vendors,
} from "../../src/db/schema";
import { WorkspaceScope } from "../../src/db/workspace-scope";
import { evidenceFor, toStored, describeAll } from "../../src/matching/evidence";
import { reviewContext } from "../../src/review/context";

let h: TestDb;
let scope: WorkspaceScope;
let workspaceId: string;
let bankAccountId: string;
let vendorId: string;

beforeEach(async () => {
  h = await createTestDb();
  const { workspace, user } = await seedWorkspace(h.db);
  workspaceId = workspace.id;
  bankAccountId = (await seedBankAccount(h.db, workspaceId)).id;
  scope = new WorkspaceScope(h.db, workspaceId, user.id);
  const [vendor] = await h.db
    .insert(vendors)
    .values({ workspaceId, name: "Anthropic" })
    .returning();
  vendorId = vendor.id;
});

afterEach(async () => {
  await h.close();
});

async function insertTransaction(overrides: Record<string, unknown> = {}) {
  const [row] = await h.db
    .insert(canonicalTransactions)
    .values({
      workspaceId,
      bankAccountId,
      valueDate: "2026-04-14",
      amountMinor: 2000n,
      direction: "DEBIT" as const,
      currency: "USD",
      description: "ANTHROPIC",
      descriptionNormalized: "anthropic",
      occurrenceIndex: 0,
      ...overrides,
    })
    .returning();
  return row;
}

async function insertRequirement(transactionId: string, overrides: Record<string, unknown> = {}) {
  const [row] = await h.db
    .insert(invoiceRequirements)
    .values({
      workspaceId,
      canonicalTransactionId: transactionId,
      state: "NEEDS_REVIEW",
      reason: "A payment to a software vendor usually has a receipt.",
      businessContext: "Software subscription",
      vendorGuess: "Anthropic",
      ...overrides,
    })
    .returning();
  return row;
}

/** An invoice with its document, as understand.ts leaves them. */
async function insertInvoice(overrides: Record<string, unknown> = {}) {
  const [document] = await h.db
    .insert(supportingDocuments)
    .values({
      workspaceId,
      storageRef: "workspaces/x/documents/secret-key.pdf",
      filename: "Receipt-INV-92831.pdf",
      mimeType: "application/pdf",
      source: "MANUAL_UPLOAD",
      state: "EXTRACTED",
    })
    .returning();

  const [invoice] = await h.db
    .insert(invoices)
    .values({
      workspaceId,
      vendorId,
      invoiceNumber: "INV-92831",
      invoiceDate: "2026-04-14",
      totalMinor: 2000n,
      currency: "USD",
      ...overrides,
    })
    .returning();

  await h.db
    .insert(invoiceDocuments)
    .values({ workspaceId, invoiceId: invoice.id, documentId: document.id, isPrimary: true });

  return { invoice, document };
}

/** A candidate row carrying evidence in the shape matching writes. */
async function proposeFor(
  transaction: Awaited<ReturnType<typeof insertTransaction>>,
  invoiceId: string,
  overrides: Record<string, unknown> = {},
) {
  const evidence = evidenceFor(
    {
      invoiceNumber: "INV-92831",
      invoiceDate: "2026-04-14",
      totalMinor: 2000n,
      currency: "USD",
      vendorId,
      vendorName: "Anthropic",
      vendorKeys: ["anthropic"],
    },
    {
      id: transaction.id,
      valueDate: transaction.valueDate,
      amountMinor: transaction.amountMinor,
      currency: transaction.currency,
      description: transaction.description,
      descriptionNormalized: transaction.descriptionNormalized,
      externalReference: transaction.externalReference,
    },
    { agreement: "RESOLVED" },
    { before: 3, after: 10 },
  );

  const [row] = await h.db
    .insert(invoiceMatchCandidates)
    .values({
      workspaceId,
      invoiceId,
      canonicalTransactionId: transaction.id,
      rank: 0,
      evidence: toStored(evidence),
      modelVerdict: "SAME",
      modelReason: "The description names the same company as the invoice",
      ...overrides,
    })
    .returning();

  return { row, evidence };
}

describe("a requirement that is not there to be reviewed", () => {
  it("answers the same for a stranger's requirement as for one that never existed", async () => {
    const other = await seedWorkspace(h.db, "Attacker Business");
    const attacker = new WorkspaceScope(h.db, other.workspace.id, other.user.id);
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);

    const theirs = await reviewContext(attacker, requirement.id);
    const invented = await reviewContext(attacker, "11111111-1111-4111-8111-111111111111");

    expect(theirs).toBeNull();
    expect(invented).toBeNull();
  });
});

describe("the payment the decision is about", () => {
  it("shows it as the statement showed it", async () => {
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);

    const context = await reviewContext(scope, requirement.id);

    expect(context?.transaction).toEqual({
      id: txn.id,
      valueDate: "2026-04-14",
      amountMinor: 2000n,
      currency: "USD",
      // §4: the description as it appeared on the statement, not a tidied version.
      description: "ANTHROPIC",
      account: "HDFC Bank XXXX1234",
    });
  });

  it("carries why the system believes a document is required", async () => {
    // §4: "why the system believes a document is required" is always shown, because the
    // decision is meaningless without it.
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);

    const context = await reviewContext(scope, requirement.id);

    expect(context?.requirement.reason).toBe(
      "A payment to a software vendor usually has a receipt.",
    );
    expect(context?.requirement.businessContext).toBe("Software subscription");
  });

  it("says when there is nothing left to decide", async () => {
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id, {
      state: "RESOLVED",
      resolutionMethod: "NOT_REQUIRED",
    });

    expect((await reviewContext(scope, requirement.id))?.requirement.isResolved).toBe(true);
  });
});

describe("the candidates, and the case for each", () => {
  it("presents the evidence as sentences", async () => {
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);
    const { invoice } = await insertInvoice();
    const { evidence } = await proposeFor(txn, invoice.id);

    const context = await reviewContext(scope, requirement.id);

    // The same sentences evidence.test.ts pins verbatim against §5's wording.
    expect(context?.candidates[0].evidence).toEqual(describeAll(evidence));
    expect(context?.candidates[0].evidence).toContain("Amount matches exactly");
    expect(context?.candidates[0].evidence).toContain("Dated the same day as the transaction");
  });

  it("hands the page no number it could render as a percentage", async () => {
    // §5: "A percentage tells the user nothing they can check." A page cannot render one
    // it was never given, which is the point of checking the shape rather than the markup.
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);
    const { invoice } = await insertInvoice();
    await proposeFor(txn, invoice.id);

    const context = await reviewContext(scope, requirement.id);
    const serialised = JSON.stringify(context, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );

    expect(serialised).not.toMatch(/\d+\s?%/);
    for (const forbidden of ["rank", "score", "strength", "confidence"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it("reads back amounts the column stored as text", async () => {
    // Evidence goes into jsonb with its amounts as strings, because JSON has no integer
    // big enough to be trusted with money. The sentences must survive the round trip.
    const txn = await insertTransaction({ amountMinor: 2015n });
    const requirement = await insertRequirement(txn.id);
    const { invoice } = await insertInvoice();
    const { evidence } = await proposeFor(txn, invoice.id);

    const context = await reviewContext(scope, requirement.id);

    expect(context?.candidates[0].evidence).toEqual(describeAll(evidence));
    expect(context?.candidates[0].evidence).toContain("Amount is close but not exact");
  });

  it("gathers every document that named this payment", async () => {
    // Read against the grain: matching stores (invoice, transaction) and asks what it
    // proposed for an invoice; review asks which documents named a payment.
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);
    const first = await insertInvoice({ invoiceNumber: "INV-1" });
    const second = await insertInvoice({ invoiceNumber: "INV-2" });
    await proposeFor(txn, first.invoice.id, { rank: 0 });
    await proposeFor(txn, second.invoice.id, { rank: 1 });

    const context = await reviewContext(scope, requirement.id);

    expect(context?.candidates.map((c) => c.invoiceId)).toEqual([
      first.invoice.id,
      second.invoice.id,
    ]);
  });

  it("names where each document came from", async () => {
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);
    const { invoice, document } = await insertInvoice();
    await proposeFor(txn, invoice.id);

    const context = await reviewContext(scope, requirement.id);

    expect(context?.candidates[0].filename).toBe("Receipt-INV-92831.pdf");
    expect(context?.candidates[0].source).toBe("MANUAL_UPLOAD");
    expect(context?.candidates[0].documentId).toBe(document.id);
  });

  it("shows the reader's own sentence, not its verdict as a label", async () => {
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);
    const { invoice } = await insertInvoice();
    await proposeFor(txn, invoice.id);

    const context = await reviewContext(scope, requirement.id);

    expect(context?.candidates[0].modelReason).toBe(
      "The description names the same company as the invoice",
    );
  });
});

describe("what the system did", () => {
  it("counts a rejected candidate without showing it again", async () => {
    // §7: a rejection is evidence and must never look like the user having taken no
    // action -- so it is counted. And it must not be asked again -- so it is not shown.
    const txn = await insertTransaction();
    const { invoice, document } = await insertInvoice();
    const requirement = await insertRequirement(txn.id, {
      state: "NOT_FOUND",
      rejectedDocumentIds: [document.id],
    });
    await proposeFor(txn, invoice.id);

    const context = await reviewContext(scope, requirement.id);

    expect(context?.candidates).toHaveLength(0);
    expect(context?.whatWeDid.rejectedPreviously).toBe(1);
    expect(context?.whatWeDid.candidatesConsidered).toBe(1);
  });

  it("survives a rejection column holding something unexpected", async () => {
    const txn = await insertTransaction();
    const { invoice } = await insertInvoice();
    const requirement = await insertRequirement(txn.id, {
      rejectedDocumentIds: { not: "an array" },
    });
    await proposeFor(txn, invoice.id);

    expect((await reviewContext(scope, requirement.id))?.candidates).toHaveLength(1);
  });

  it("says when the shortlist was not everything", async () => {
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);
    const { invoice } = await insertInvoice();
    await proposeFor(txn, invoice.id, { truncated: true });

    expect((await reviewContext(scope, requirement.id))?.whatWeDid.truncated).toBe(true);
  });

  it("claims no mailbox was searched, because none was", async () => {
    // §4 wants which accounts were searched over what window. Nothing records a search
    // until features J and K, and inventing one would be worse than saying none.
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);

    expect((await reviewContext(scope, requirement.id))?.whatWeDid.searchedMailboxes).toEqual([]);
  });
});

describe("previewing a document", () => {
  it("gives an application route, never a storage reference", async () => {
    // §5 and architecture.md §19: the preview serves the original stored file through an
    // authorized application route, never a public storage URL.
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);
    const { invoice, document } = await insertInvoice();
    await proposeFor(txn, invoice.id);

    const context = await reviewContext(scope, requirement.id);
    const serialised = JSON.stringify(context, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );

    expect(context?.candidates[0].previewHref).toBe(`/api/documents/${document.id}`);
    expect(serialised).not.toContain("workspaces/x/documents/secret-key.pdf");
    expect(serialised).not.toContain("storageRef");
  });
});

describe("offering to generalize", () => {
  it("offers it when there is a vendor to key the fact on", async () => {
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);

    expect((await reviewContext(scope, requirement.id))?.requirement.canGeneralize).toBe(true);
  });

  it("does not offer it when the narration named nobody", async () => {
    // A choice that silently does nothing is worse than not offering it.
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id, { vendorGuess: null });

    expect((await reviewContext(scope, requirement.id))?.requirement.canGeneralize).toBe(false);
  });
});

describe("opening the screen and walking away", () => {
  it("writes nothing at all", async () => {
    // §10: "The user may leave at any point. The requirement keeps its state, nothing is
    // lost, and it remains in the action queue." Reading a screen must not be a decision.
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);
    const { invoice } = await insertInvoice();
    await proposeFor(txn, invoice.id);

    const snapshot = async () => ({
      requirements: await h.db.select().from(invoiceRequirements),
      candidates: await h.db.select().from(invoiceMatchCandidates),
      invoices: await h.db.select().from(invoices),
      documents: await h.db.select().from(supportingDocuments),
    });

    const before = await snapshot();
    await reviewContext(scope, requirement.id);
    await reviewContext(scope, requirement.id);
    const after = await snapshot();

    expect(after).toEqual(before);
  });

  it("leaves the requirement in the state that put it in the queue", async () => {
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);

    await reviewContext(scope, requirement.id);

    const [row] = await h.db
      .select()
      .from(invoiceRequirements)
      .where(eq(invoiceRequirements.id, requirement.id));
    expect(row.state).toBe("NEEDS_REVIEW");
    expect(row.resolutionMethod).toBeNull();
  });
});
