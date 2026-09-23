/**
 * Cross-workspace attacks on document understanding.
 *
 * `docs/definition-of-done.md` requires a test that attempts cross-workspace access and
 * expects it to fail, for every feature touching workspace-scoped data. Written as attacks
 * rather than as assertions about filters, in the style of `tests/db/workspace-isolation.
 * test.ts`: a filter can be present and wrong, and only an attempt proves otherwise.
 *
 * Understanding a document writes to five scoped tables -- supporting_documents, invoices,
 * invoice_documents, vendors and vendor_aliases -- so there are five ways for it to leak.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { InvoiceReading } from "../../src/ai/prompts/read-invoice.v1";
import type { ExtractPdfText } from "../../src/documents/contracts";
import { understandDocument, type UnderstandDeps } from "../../src/documents/understand";
import { resolveVendor } from "../../src/documents/vendors";
import * as schema from "../../src/db/schema";
import { WorkspaceScope } from "../../src/db/workspace-scope";
import { documentKey } from "../../src/storage/keys";
import { createTestDb, seedWorkspace, type TestDb } from "../helpers/db";
import { FakeDocumentStore } from "../storage/fake-document-store";

let test: TestDb;

beforeAll(async () => {
  test = await createTestDb();
});

afterAll(async () => {
  await test.close();
});

const reading: InvoiceReading = {
  classification: "IS_INVOICE",
  reason: "A tax invoice from ABC Foods.",
  documentType: "Tax invoice",
  vendor: { legalName: "ABC Foods Private Limited", tradeName: "ABC Foods", aliases: [] },
  invoiceNumber: "INV-2201",
  invoiceDate: { text: "14/04/2026" },
  dateOrder: "DMY",
  currency: "INR",
  decimalSeparator: ".",
  total: { text: "1,20,000.00" },
  tax: null,
  subtotal: null,
};

const pdf = new TextEncoder().encode(
  `%PDF-1.7\n${"ABC Foods Tax Invoice INV-2201 Total Rs. 1,20,000.00 Date 14/04/2026 ".repeat(3)}`,
);

const extractPdfText: ExtractPdfText = async () => ({
  pages: 1,
  items: [
    [{ text: "ABC Foods Tax Invoice INV-2201 Rs. 1,20,000.00 14/04/2026", x: 0, y: 0, width: 400 }],
  ],
});

const deps = (store: FakeDocumentStore): UnderstandDeps => ({
  store,
  extractPdfText,
  read: async () => ({ ok: true, value: reading }),
});

/** Two workspaces, and a stored document belonging to the first. */
async function twoWorkspaces() {
  const store = new FakeDocumentStore();

  const a = await seedWorkspace(test.db, "Victim Business");
  const b = await seedWorkspace(test.db, "Attacker Business");
  const victim = new WorkspaceScope(test.db, a.workspace.id, a.user.id);
  const attacker = new WorkspaceScope(test.db, b.workspace.id, b.user.id);

  const [document] = await victim.insert(schema.supportingDocuments, {
    storageRef: "pending",
    filename: "invoice.pdf",
    mimeType: "application/pdf",
    source: "MANUAL_UPLOAD",
  });
  const stored = await store.put(
    documentKey(a.workspace.id, "documents", document.id, "invoice.pdf"),
    Buffer.from(pdf),
    "application/pdf",
  );
  await victim.update(
    schema.supportingDocuments,
    { storageRef: stored.key },
    eq(schema.supportingDocuments.id, document.id),
  );

  return { store, victim, attacker, documentId: document.id };
}

describe("understanding a document that is not yours", () => {
  it("refuses, and cannot tell the attacker the document exists", async () => {
    // Identical to "no such document", deliberately. Distinguishing the two tells an
    // attacker which ids are real -- the same choice WorkspaceAccessError already made.
    const { store, attacker, documentId } = await twoWorkspaces();

    const outcome = await understandDocument(attacker, documentId, deps(store));

    expect(outcome.state).toBeNull();
    expect(outcome.invoiceId).toBeNull();
  });

  it("does not touch the document it was pointed at", async () => {
    const { store, victim, attacker, documentId } = await twoWorkspaces();

    await understandDocument(attacker, documentId, deps(store));

    const row = await victim.selectOne(
      schema.supportingDocuments,
      eq(schema.supportingDocuments.id, documentId),
    );
    expect(row?.state).toBe("STORED");
    expect(row?.classification).toBeNull();
  });

  it("writes nothing into either workspace", async () => {
    const { store, victim, attacker, documentId } = await twoWorkspaces();

    await understandDocument(attacker, documentId, deps(store));

    for (const scope of [victim, attacker]) {
      expect(await scope.select(schema.invoices)).toHaveLength(0);
      expect(await scope.select(schema.invoiceDocuments)).toHaveLength(0);
      expect(await scope.select(schema.vendors)).toHaveLength(0);
    }
  });

  it("does not read the victim's bytes", async () => {
    // Even the storage key never reaches the attacker's scope, because the row it is on
    // was never selected.
    const { store, attacker, documentId } = await twoWorkspaces();
    let fetched = 0;

    await understandDocument(attacker, documentId, {
      ...deps(store),
      store: {
        ...store,
        get: async (key: string) => {
          fetched += 1;
          return store.get(key);
        },
        put: store.put.bind(store),
        head: store.head.bind(store),
      },
    });

    expect(fetched).toBe(0);
  });
});

describe("what one workspace's understanding leaves visible to another", () => {
  it("keeps the invoice, the join and the vendor to the workspace that produced them", async () => {
    const { store, victim, attacker, documentId } = await twoWorkspaces();

    await understandDocument(victim, documentId, deps(store));

    expect(await victim.select(schema.invoices)).toHaveLength(1);
    expect(await attacker.select(schema.invoices)).toHaveLength(0);
    expect(await attacker.select(schema.invoiceDocuments)).toHaveLength(0);
    expect(await attacker.select(schema.vendors)).toHaveLength(0);
    expect(await attacker.select(schema.vendorAliases)).toHaveLength(0);
  });
});

describe("resolving a vendor across a workspace boundary", () => {
  it("does not find a vendor another workspace already knows", async () => {
    // The alias index is unique on (workspace, normalized alias), so the same company in
    // two workspaces is two vendors. Finding the other one would leak that they share a
    // supplier -- and would attach this workspace's invoice to a row it cannot read.
    const a = await seedWorkspace(test.db);
    const b = await seedWorkspace(test.db);
    const first = new WorkspaceScope(test.db, a.workspace.id, a.user.id);
    const second = new WorkspaceScope(test.db, b.workspace.id, b.user.id);

    const names = { legalName: "ABC Foods Private Limited", tradeName: "ABC Foods", aliases: [] };

    const inFirst = await resolveVendor(first, names);
    const inSecond = await resolveVendor(second, names);

    expect(inFirst).not.toBeNull();
    expect(inSecond).not.toBe(inFirst);

    const secondVendor = await second.selectOne(schema.vendors, eq(schema.vendors.id, inSecond!));
    expect(secondVendor?.workspaceId).toBe(b.workspace.id);
  });

  it("finds the workspace's own vendor on a second call", async () => {
    const { user, workspace } = await seedWorkspace(test.db);
    const scope = new WorkspaceScope(test.db, workspace.id, user.id);
    const names = { legalName: "Zenith Supplies LLP", tradeName: null, aliases: [] };

    const once = await resolveVendor(scope, names);
    const twice = await resolveVendor(scope, names);

    expect(twice).toBe(once);
    expect(await scope.select(schema.vendors)).toHaveLength(1);
  });
});
