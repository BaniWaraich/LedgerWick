import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { storeSupportingDocument } from "../../src/documents/intake";
import * as schema from "../../src/db/schema";
import { WorkspaceScope } from "../../src/db/workspace-scope";
import { workspacePrefix } from "../../src/storage/keys";
import { createTestDb, seedBankAccount, seedWorkspace, type TestDb } from "../helpers/db";
import { FakeDocumentStore } from "../storage/fake-document-store";

let test: TestDb;

beforeAll(async () => {
  test = await createTestDb();
});

afterAll(async () => {
  await test.close();
});

const file = {
  bytes: new TextEncoder().encode("%PDF-1.7\ninvoice"),
  filename: "ABC Foods invoice.pdf",
  contentType: "application/pdf",
};

async function workspace() {
  const { user, workspace } = await seedWorkspace(test.db);
  return {
    scope: new WorkspaceScope(test.db, workspace.id, user.id),
    store: new FakeDocumentStore(),
    workspaceId: workspace.id,
  };
}

describe("storing a supporting document", () => {
  it("creates the row in STORED, before anything is inferred from it", async () => {
    // glossary: every file entering the system is a Supporting Document first.
    const { scope, store } = await workspace();

    const { documentId, started } = await storeSupportingDocument(
      scope,
      store,
      file,
      { source: "MANUAL_UPLOAD" },
      async () => {},
    );

    expect(started).toBe(true);
    const rows = await scope.select(schema.supportingDocuments);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: documentId, state: "STORED", classification: null });
  });

  it("persists the key the store returned, not the key it asked for", async () => {
    // ADR 0007: Blob appends a random suffix, so the requested key is a request rather
    // than a promise. A row holding the wrong one cannot produce its own document.
    const { scope, store } = await workspace();

    await storeSupportingDocument(scope, store, file, { source: "GMAIL" }, async () => {});

    const [row] = await scope.select(schema.supportingDocuments);
    expect(await store.get(row.storageRef)).not.toBeNull();
  });

  it("puts the document under its own workspace's prefix", async () => {
    const { scope, store, workspaceId } = await workspace();

    await storeSupportingDocument(scope, store, file, { source: "MANUAL_UPLOAD" }, async () => {});

    const [row] = await scope.select(schema.supportingDocuments);
    expect(row.storageRef.startsWith(workspacePrefix(workspaceId))).toBe(true);
    expect(row.storageRef).toContain("/documents/");
  });

  it("sanitizes a filename on the way into the key, and keeps the real one on the row", async () => {
    const { scope, store } = await workspace();
    const nasty = { ...file, filename: "../../etc/passwd invoice.pdf" };

    await storeSupportingDocument(scope, store, nasty, { source: "GMAIL" }, async () => {});

    const [row] = await scope.select(schema.supportingDocuments);
    expect(row.storageRef).not.toContain("..");
    expect(row.filename).toBe(nasty.filename);
  });

  it("records where a retrieved document came from, without reading it", async () => {
    // retrieve-invoices.md §11: provenance back to the account, message and attachment.
    // Opaque here on purpose -- feature K owns its shape.
    const { scope, store } = await workspace();
    const provenance = { account: "owner@example.com", messageId: "abc", attachmentId: "1" };

    await storeSupportingDocument(
      scope,
      store,
      file,
      { source: "GMAIL", sourceMetadata: provenance },
      async () => {},
    );

    const [row] = await scope.select(schema.supportingDocuments);
    expect(row.source).toBe("GMAIL");
    expect(row.sourceMetadata).toEqual(provenance);
  });

  it("gives both entry paths the same row, differing only in where it came from", async () => {
    // §11.1: the two entry paths converge, and neither skips what follows.
    const { scope, store } = await workspace();

    await storeSupportingDocument(scope, store, file, { source: "GMAIL" }, async () => {});
    await storeSupportingDocument(scope, store, file, { source: "MANUAL_UPLOAD" }, async () => {});

    const rows = await scope.select(schema.supportingDocuments);
    expect(rows.map((row) => row.state)).toEqual(["STORED", "STORED"]);
    expect(new Set(rows.map((row) => row.source))).toEqual(new Set(["GMAIL", "MANUAL_UPLOAD"]));
  });

  it("asks for the document it just stored to be understood", async () => {
    const { scope, store } = await workspace();
    const asked: string[] = [];

    const { documentId } = await storeSupportingDocument(
      scope,
      store,
      file,
      { source: "MANUAL_UPLOAD" },
      async (id) => void asked.push(id),
    );

    expect(asked).toEqual([documentId]);
  });

  it("keeps the document when the queue is unreachable, and says it did not start", async () => {
    // The definition of done forbids automated deletion, and losing a perfectly good
    // invoice because a queue was down would be the worse outcome by a distance.
    const { scope, store } = await workspace();

    const result = await storeSupportingDocument(
      scope,
      store,
      file,
      { source: "MANUAL_UPLOAD" },
      async () => {
        throw new Error("inngest unreachable");
      },
    );

    expect(result.started).toBe(false);
    const [row] = await scope.select(schema.supportingDocuments);
    expect(row.state).toBe("STORED");
    expect(await store.get(row.storageRef)).not.toBeNull();
  });
});

describe("storing across a workspace boundary", () => {
  it("cannot put a document into another workspace", async () => {
    // The scope injects workspaceId rather than accepting one, so there is no argument
    // to get wrong. This is the test that the property holds through this caller.
    const first = await workspace();
    const second = await workspace();

    await storeSupportingDocument(
      first.scope,
      first.store,
      file,
      { source: "MANUAL_UPLOAD" },
      async () => {},
    );

    expect(await first.scope.select(schema.supportingDocuments)).toHaveLength(1);
    expect(await second.scope.select(schema.supportingDocuments)).toHaveLength(0);
  });
});

describe("an upload that already knows its payment", () => {
  // spec: docs/workflows/invoice-match-review.md §6 — entering from review pre-binds the
  // transaction, and feature G then skips matching entirely.
  it("binds the document to the transaction the user chose", async () => {
    const store = new FakeDocumentStore();
    const seeded = await seedWorkspace(test.db);
    const scope = new WorkspaceScope(test.db, seeded.workspace.id, seeded.user.id);
    const account = await seedBankAccount(test.db, seeded.workspace.id);
    const [txn] = await test.db
      .insert(schema.canonicalTransactions)
      .values({
        workspaceId: seeded.workspace.id,
        bankAccountId: account.id,
        valueDate: "2026-04-14",
        amountMinor: 2000n,
        direction: "DEBIT",
        currency: "INR",
        description: "ANTHROPIC",
        descriptionNormalized: "anthropic",
        occurrenceIndex: 0,
      })
      .returning();

    const { documentId } = await storeSupportingDocument(
      scope,
      store,
      { bytes: new Uint8Array([1]), filename: "invoice.pdf", contentType: "application/pdf" },
      { source: "MANUAL_UPLOAD", canonicalTransactionId: txn.id },
      async () => {},
    );

    const [row] = await test.db
      .select()
      .from(schema.supportingDocuments)
      .where(eq(schema.supportingDocuments.id, documentId));

    expect(row.canonicalTransactionId).toBe(txn.id);
  });

  it("stores the document unbound when the payment is not this workspace's", async () => {
    // A transaction id from the client is a claim. The scope filters the lookup, so
    // another workspace's payment reads as absent -- and the document is still stored,
    // because nothing here is worth losing the file over.
    const store = new FakeDocumentStore();
    const mine = await seedWorkspace(test.db);
    const theirs = await seedWorkspace(test.db, "Someone Else");
    const theirAccount = await seedBankAccount(test.db, theirs.workspace.id);
    const [theirTxn] = await test.db
      .insert(schema.canonicalTransactions)
      .values({
        workspaceId: theirs.workspace.id,
        bankAccountId: theirAccount.id,
        valueDate: "2026-04-14",
        amountMinor: 2000n,
        direction: "DEBIT",
        currency: "INR",
        description: "ANTHROPIC",
        descriptionNormalized: "anthropic",
        occurrenceIndex: 0,
      })
      .returning();

    const scope = new WorkspaceScope(test.db, mine.workspace.id, mine.user.id);
    const { documentId } = await storeSupportingDocument(
      scope,
      store,
      { bytes: new Uint8Array([1]), filename: "invoice.pdf", contentType: "application/pdf" },
      { source: "MANUAL_UPLOAD", canonicalTransactionId: theirTxn.id },
      async () => {},
    );

    const [row] = await test.db
      .select()
      .from(schema.supportingDocuments)
      .where(eq(schema.supportingDocuments.id, documentId));

    expect(row.canonicalTransactionId).toBeNull();
  });

  it("leaves an ordinary upload unbound", async () => {
    const store = new FakeDocumentStore();
    const seeded = await seedWorkspace(test.db);
    const scope = new WorkspaceScope(test.db, seeded.workspace.id, seeded.user.id);

    const { documentId } = await storeSupportingDocument(
      scope,
      store,
      { bytes: new Uint8Array([1]), filename: "invoice.pdf", contentType: "application/pdf" },
      { source: "MANUAL_UPLOAD" },
      async () => {},
    );

    const [row] = await test.db
      .select()
      .from(schema.supportingDocuments)
      .where(eq(schema.supportingDocuments.id, documentId));

    expect(row.canonicalTransactionId).toBeNull();
  });
});
