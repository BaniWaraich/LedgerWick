/**
 * Serving documents across a workspace boundary.
 *
 * spec: docs/architecture.md §19 · docs/decisions/0007-file-storage.md ·
 * docs/definition-of-done.md ("When it touches documents or credentials")
 *
 * Written as attacks, like tests/db/workspace-isolation.test.ts. Isolation is enforced in
 * application code, so a single missing filter is a data leak and these tests are the only
 * thing standing behind the storage layer.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, seedBankAccount, seedWorkspace, type TestDb } from "../helpers/db";
import { bankStatements, supportingDocuments } from "../../src/db/schema";
import { openWorkspace, type WorkspaceScope } from "../../src/db/workspace-scope";
import { documentKey } from "../../src/storage/keys";
import { serveStatementFile, serveSupportingDocument } from "../../src/storage/serving";
import { FakeDocumentStore } from "./fake-document-store";

let h: TestDb;
let store: FakeDocumentStore;

let aliceScope: WorkspaceScope;
let bobScope: WorkspaceScope;

let aliceStatementId: string;
let aliceDocumentId: string;
let aliceStatementRef: string;

const STATEMENT_BYTES = "Date,Description,Amount\n2026-03-01,ACME,1000\n";
const INVOICE_BYTES = "%PDF-1.7 alice's invoice";

beforeAll(async () => {
  h = await createTestDb();
  store = new FakeDocumentStore();

  const alice = await seedWorkspace(h.db, "Alice Traders");
  const bob = await seedWorkspace(h.db, "Bob Industries");

  aliceScope = await openWorkspace(h.db, alice.user.id, alice.workspace.id);
  bobScope = await openWorkspace(h.db, bob.user.id, bob.workspace.id);

  const account = await seedBankAccount(h.db, alice.workspace.id);

  const statementObject = await store.put(
    documentKey(alice.workspace.id, "statements", "seed-1", "march.csv"),
    Buffer.from(STATEMENT_BYTES),
    "text/csv",
  );
  aliceStatementRef = statementObject.key;

  const [statement] = await aliceScope.insert(bankStatements, {
    bankAccountId: account.id,
    filename: "march.csv",
    mimeType: "text/csv",
    storageRef: statementObject.key,
  });
  aliceStatementId = statement.id;

  const documentObject = await store.put(
    documentKey(alice.workspace.id, "documents", "seed-2", "invoice.pdf"),
    Buffer.from(INVOICE_BYTES),
    "application/pdf",
  );

  const [document] = await aliceScope.insert(supportingDocuments, {
    storageRef: documentObject.key,
    filename: "invoice.pdf",
    mimeType: "application/pdf",
    source: "MANUAL_UPLOAD",
  });
  aliceDocumentId = document.id;
});

afterAll(async () => {
  await h.close();
});

describe("serving a document to its own workspace", () => {
  it("streams the statement bytes that were stored", async () => {
    const response = await serveStatementFile(aliceScope, store, aliceStatementId);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(STATEMENT_BYTES);
    expect(response.headers.get("Content-Type")).toBe("text/csv");
  });

  it("names the file the user uploaded, not the storage key", async () => {
    const response = await serveStatementFile(aliceScope, store, aliceStatementId);

    expect(response.headers.get("Content-Disposition")).toBe('inline; filename="march.csv"');
  });

  it("streams a supporting document", async () => {
    const response = await serveSupportingDocument(aliceScope, store, aliceDocumentId);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(INVOICE_BYTES);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
  });

  it("keeps a document out of any shared cache", async () => {
    const response = await serveSupportingDocument(aliceScope, store, aliceDocumentId);

    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("reaching for another workspace's documents", () => {
  it("refuses a statement belonging to another workspace", async () => {
    const response = await serveStatementFile(bobScope, store, aliceStatementId);

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Date,Description");
  });

  it("refuses a supporting document belonging to another workspace", async () => {
    const response = await serveSupportingDocument(bobScope, store, aliceDocumentId);

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("PDF");
  });

  // 403 would confirm the id exists, which is the fact the boundary exists to withhold.
  it("answers a foreign id exactly as it answers an unknown one", async () => {
    const foreign = await serveStatementFile(bobScope, store, aliceStatementId);
    const unknown = await serveStatementFile(bobScope, store, crypto.randomUUID());

    expect(foreign.status).toBe(unknown.status);
    expect(await foreign.text()).toBe(await unknown.text());
  });

  it("does not leak the document through a malformed id", async () => {
    const response = await serveSupportingDocument(bobScope, store, "' OR 1=1 --");

    expect(response.status).toBe(404);
  });

  it("cannot be handed a storage key instead of a row id", async () => {
    const response = await serveStatementFile(bobScope, store, aliceStatementRef);

    expect(response.status).toBe(404);
  });
});

describe("what the response is allowed to contain", () => {
  // spec: docs/definition-of-done.md — never a public storage URL
  it("never puts the storage reference or a blob url in a response", async () => {
    const response = await serveStatementFile(aliceScope, store, aliceStatementId);
    const headers = JSON.stringify([...response.headers]);
    const body = await response.text();

    expect(headers).not.toContain(aliceStatementRef);
    expect(headers).not.toContain("blob.vercel-storage.com");
    expect(body).not.toContain(aliceStatementRef);
  });

  it("reports a row whose bytes are gone as missing rather than failing", async () => {
    const [orphan] = await aliceScope.insert(supportingDocuments, {
      storageRef: "workspaces/gone/documents/none/x.pdf",
      filename: "x.pdf",
      mimeType: "application/pdf",
      source: "GMAIL",
    });

    const response = await serveSupportingDocument(aliceScope, store, orphan.id);

    expect(response.status).toBe(404);
  });
});
