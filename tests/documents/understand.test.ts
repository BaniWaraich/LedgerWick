import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { InvoiceReading } from "../../src/ai/prompts/read-invoice.v1";
import type { ReadInvoice, ExtractPdfText } from "../../src/documents/contracts";
import { understandDocument, type UnderstandDeps } from "../../src/documents/understand";
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

const reading = (over: Partial<InvoiceReading> = {}): InvoiceReading => ({
  classification: "IS_INVOICE",
  reason: "A tax invoice from ABC Foods for catering, dated 14 April.",
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
  ...over,
});

/** Stand-in for a text PDF, with enough text to clear the usable-text bar. */
const textPdf = new TextEncoder().encode(
  `%PDF-1.7\n${"ABC Foods Private Limited Tax Invoice INV-2201 Total Rs. 1,20,000.00 Date 14/04/2026 ".repeat(3)}`,
);

const extractText: ExtractPdfText = async () => ({
  pages: 1,
  items: [
    [
      {
        text: "ABC Foods Private Limited Tax Invoice INV-2201 Total Rs. 1,20,000.00 Date 14/04/2026",
        x: 0,
        y: 0,
        width: 400,
      },
    ],
  ],
});

/** A workspace with one stored document in it, ready to understand. */
async function seedDocument(bytes: Uint8Array = textPdf) {
  const { user, workspace } = await seedWorkspace(test.db);
  const scope = new WorkspaceScope(test.db, workspace.id, user.id);
  const store = new FakeDocumentStore();

  const [document] = await scope.insert(schema.supportingDocuments, {
    storageRef: "pending",
    filename: "invoice.pdf",
    mimeType: "application/pdf",
    source: "MANUAL_UPLOAD",
  });

  const stored = await store.put(
    documentKey(workspace.id, "documents", document.id, "invoice.pdf"),
    Buffer.from(bytes),
    "application/pdf",
  );
  await scope.update(
    schema.supportingDocuments,
    { storageRef: stored.key },
    eq(schema.supportingDocuments.id, document.id),
  );

  return { scope, store, workspace, user, documentId: document.id };
}

const depsReading = (value: InvoiceReading, store: FakeDocumentStore): UnderstandDeps => ({
  store,
  extractPdfText: extractText,
  read: async () => ({ ok: true, value }),
});

const documentRow = async (scope: WorkspaceScope, documentId: string) =>
  scope.selectOne(schema.supportingDocuments, eq(schema.supportingDocuments.id, documentId));

describe("a document that turns out to be an invoice", () => {
  it("walks STORED to EXTRACTED and records what it believes", async () => {
    const { scope, store, documentId } = await seedDocument();

    const outcome = await understandDocument(scope, documentId, depsReading(reading(), store));

    expect(outcome.state).toBe("EXTRACTED");
    const row = await documentRow(scope, documentId);
    expect(row?.state).toBe("EXTRACTED");
    expect(row?.classification).toBe("IS_INVOICE");
  });

  it("writes the values code parsed, not the characters the model reported", async () => {
    const { scope, store, documentId } = await seedDocument();

    const outcome = await understandDocument(scope, documentId, depsReading(reading(), store));

    const invoice = await scope.selectOne(
      schema.invoices,
      eq(schema.invoices.id, outcome.invoiceId!),
    );
    expect(invoice?.totalMinor).toBe(12_000_000n);
    expect(invoice?.currency).toBe("INR");
    expect(invoice?.invoiceDate).toBe("2026-04-14");
    expect(invoice?.invoiceNumber).toBe("INV-2201");
  });

  it("leaves the invoice unlinked, because linking is not this feature's decision", async () => {
    // manual-invoice-upload.md §14. Feature G links it, with evidence this pipeline does
    // not have; the partial unique index is what lets many unlinked invoices coexist.
    const { scope, store, documentId } = await seedDocument();

    const outcome = await understandDocument(scope, documentId, depsReading(reading(), store));

    const invoice = await scope.selectOne(
      schema.invoices,
      eq(schema.invoices.id, outcome.invoiceId!),
    );
    expect(invoice?.canonicalTransactionId).toBeNull();
  });

  it("joins the invoice to the document it was read from", async () => {
    const { scope, store, documentId } = await seedDocument();

    const outcome = await understandDocument(scope, documentId, depsReading(reading(), store));

    const joins = await scope.select(schema.invoiceDocuments);
    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({
      invoiceId: outcome.invoiceId,
      documentId,
      isPrimary: true,
    });
  });

  it("records the vendor, with every alias unconfirmed", async () => {
    // domain-model.md invariant 18 and architecture.md §11: an invoice is evidence, not a
    // decision. Only feature H, acting on a confirmation, may set `confirmed`.
    const { scope, store, documentId } = await seedDocument();

    await understandDocument(scope, documentId, depsReading(reading(), store));

    const vendors = await scope.select(schema.vendors);
    expect(vendors).toHaveLength(1);
    expect(vendors[0].legalName).toBe("ABC Foods Private Limited");

    const aliases = await scope.select(schema.vendorAliases);
    expect(aliases.length).toBeGreaterThan(0);
    expect(aliases.every((alias) => alias.confirmed === false)).toBe(true);
  });

  it("reuses a vendor a previous document already established", async () => {
    const { scope, store, documentId } = await seedDocument();
    await understandDocument(scope, documentId, depsReading(reading(), store));

    // A second document, naming the same company the way a different vendor would print it.
    const [second] = await scope.insert(schema.supportingDocuments, {
      storageRef: (
        await store.put(
          documentKey(scope.workspaceId, "documents", "second", "b.pdf"),
          Buffer.from(textPdf),
          "application/pdf",
        )
      ).key,
      filename: "b.pdf",
      mimeType: "application/pdf",
      source: "GMAIL",
    });

    await understandDocument(
      scope,
      second.id,
      depsReading(
        reading({ vendor: { legalName: "ABC Foods Pvt. Ltd.", tradeName: null, aliases: [] } }),
        store,
      ),
    );

    expect(await scope.select(schema.vendors)).toHaveLength(1);
  });
});

describe("a document that turns out not to be an invoice", () => {
  it("reaches NOT_AN_INVOICE and creates no invoice", async () => {
    const { scope, store, documentId } = await seedDocument();

    const outcome = await understandDocument(
      scope,
      documentId,
      depsReading(
        reading({
          classification: "IS_NOT_INVOICE",
          reason: "A delivery note listing items with no prices.",
          invoiceNumber: null,
          total: null,
          tax: null,
          subtotal: null,
        }),
        store,
      ),
    );

    expect(outcome.state).toBe("NOT_AN_INVOICE");
    expect(outcome.invoiceId).toBeNull();
    expect(await scope.select(schema.invoices)).toHaveLength(0);
  });

  it("keeps the bytes, because an outcome is not a failure", async () => {
    // state-machines.md §3: a document that reaches STORED is never deleted by an
    // automated process, and the user may still link it by hand.
    const { scope, store, documentId } = await seedDocument();
    const before = store.size;

    await understandDocument(
      scope,
      documentId,
      depsReading(
        reading({
          classification: "IS_NOT_INVOICE",
          invoiceNumber: null,
          total: null,
          tax: null,
          subtotal: null,
        }),
        store,
      ),
    );

    expect(store.size).toBe(before);
    const row = await documentRow(scope, documentId);
    expect(await store.get(row!.storageRef)).not.toBeNull();
  });
});

describe("a document nothing could be got from", () => {
  it("is UNREADABLE when the model could not answer usably", async () => {
    // inferStructure has already decided this will not improve on a retry.
    const { scope, store, documentId } = await seedDocument();
    const read: ReadInvoice = async () => ({ ok: false, reason: "no object generated" });

    const outcome = await understandDocument(scope, documentId, {
      store,
      extractPdfText: extractText,
      read,
    });

    expect(outcome.state).toBe("UNREADABLE");
    expect((await documentRow(scope, documentId))?.state).toBe("UNREADABLE");
    expect(await scope.select(schema.invoices)).toHaveLength(0);
  });

  it("is UNREADABLE when the file is neither a PDF nor an image", async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
    const { scope, store, documentId } = await seedDocument(zip);

    const outcome = await understandDocument(scope, documentId, depsReading(reading(), store));

    expect(outcome.state).toBe("UNREADABLE");
  });

  it("is UNREADABLE when it was read but named no vendor, amount or date", async () => {
    // §6's minimum. §11's sentence to the user is about details, not about text, which is
    // why this lands here and not in NOT_AN_INVOICE.
    const { scope, store, documentId } = await seedDocument();

    const outcome = await understandDocument(
      scope,
      documentId,
      depsReading(reading({ vendor: null, invoiceDate: null, currency: null, total: null }), store),
    );

    expect(outcome.state).toBe("UNREADABLE");
    expect(await scope.select(schema.invoices)).toHaveLength(0);
  });

  it("still records what it believed about a document it could not read", async () => {
    // domain-model.md §9 Rule 3: "identify a document as an invoice but fail to extract
    // sufficient information... These outcomes must remain distinguishable."
    const { scope, store, documentId } = await seedDocument();

    await understandDocument(
      scope,
      documentId,
      depsReading(reading({ vendor: null, invoiceDate: null, currency: null, total: null }), store),
    );

    const row = await documentRow(scope, documentId);
    expect(row?.state).toBe("UNREADABLE");
    expect(row?.classification).toBe("IS_INVOICE");
  });

  it("is UNREADABLE when the row outlived its bytes", async () => {
    const { scope, store, documentId } = await seedDocument();
    await scope.update(
      schema.supportingDocuments,
      { storageRef: "workspaces/x/documents/gone/invoice.pdf" },
      eq(schema.supportingDocuments.id, documentId),
    );

    const outcome = await understandDocument(scope, documentId, depsReading(reading(), store));

    expect(outcome.state).toBe("UNREADABLE");
  });
});

describe("an UNCERTAIN document", () => {
  it("is EXTRACTED when its fields came out, with the uncertainty kept", async () => {
    // state-machines.md §3 forbids flattening classification to a boolean. State records
    // what was obtained; classification records what is believed. They stay separate.
    const { scope, store, documentId } = await seedDocument();

    const outcome = await understandDocument(
      scope,
      documentId,
      depsReading(reading({ classification: "UNCERTAIN" }), store),
    );

    expect(outcome.state).toBe("EXTRACTED");
    const row = await documentRow(scope, documentId);
    expect(row?.classification).toBe("UNCERTAIN");
    expect(outcome.invoiceId).not.toBeNull();
  });

  it("is never written to the database as IS_NOT_INVOICE", async () => {
    const { scope, store, documentId } = await seedDocument();

    await understandDocument(
      scope,
      documentId,
      depsReading(reading({ classification: "UNCERTAIN" }), store),
    );

    expect((await documentRow(scope, documentId))?.classification).not.toBe("IS_NOT_INVOICE");
  });
});

describe("running it twice", () => {
  it("creates one invoice and one join row, not two", async () => {
    // architecture.md §16 names invoice extraction among the workflows that must survive
    // being run twice. A retry after a timeout that had in fact succeeded is ordinary.
    const { scope, store, documentId } = await seedDocument();

    const first = await understandDocument(scope, documentId, depsReading(reading(), store));
    const second = await understandDocument(scope, documentId, depsReading(reading(), store));

    expect(second.invoiceId).toBe(first.invoiceId);
    expect(await scope.select(schema.invoices)).toHaveLength(1);
    expect(await scope.select(schema.invoiceDocuments)).toHaveLength(1);
  });

  it("does not ask the model again about a document already understood", async () => {
    const { scope, store, documentId } = await seedDocument();
    await understandDocument(scope, documentId, depsReading(reading(), store));

    let asked = 0;
    await understandDocument(scope, documentId, {
      store,
      extractPdfText: extractText,
      read: async () => {
        asked += 1;
        return { ok: true, value: reading() };
      },
    });

    expect(asked).toBe(0);
  });

  it("finishes a document whose first attempt died after writing the invoice", async () => {
    const { scope, store, documentId } = await seedDocument();
    await understandDocument(scope, documentId, depsReading(reading(), store));

    // Put the document back mid-flight, as a crash between the two writes would leave it.
    await scope.update(
      schema.supportingDocuments,
      { state: "CLASSIFYING", classification: null },
      eq(schema.supportingDocuments.id, documentId),
    );

    await understandDocument(scope, documentId, depsReading(reading(), store));

    expect(await scope.select(schema.invoices)).toHaveLength(1);
    expect(await scope.select(schema.invoiceDocuments)).toHaveLength(1);
    expect((await documentRow(scope, documentId))?.state).toBe("EXTRACTED");
  });
});

describe("infrastructure failure", () => {
  it("propagates for the workflow to retry, and libels nothing", async () => {
    // state-machines.md §3: an infrastructure failure is not a fact about the document.
    // Recording it there would make a retry look like a verdict.
    const { scope, store, documentId } = await seedDocument();
    const read: ReadInvoice = async () => {
      throw new Error("gateway has no credit");
    };

    await expect(
      understandDocument(scope, documentId, { store, extractPdfText: extractText, read }),
    ).rejects.toThrow("gateway has no credit");

    const row = await documentRow(scope, documentId);
    expect(row?.state).toBe("CLASSIFYING");
    expect(row?.classification).toBeNull();
    expect(await scope.select(schema.invoices)).toHaveLength(0);
  });
});

describe("a figure the model did not read off the document", () => {
  it("is dropped, and takes the document to UNREADABLE", async () => {
    // decision 0010, as corrected: the model is in the value path here, so the characters
    // it reports have to be on the page. A total nobody can find is the failure the anchor
    // exists to prevent, and nothing is persisted rather than a plausible wrong number.
    const { scope, store, documentId } = await seedDocument();

    const outcome = await understandDocument(
      scope,
      documentId,
      depsReading(reading({ total: { text: "9,99,999.00" } }), store),
    );

    expect(outcome.state).toBe("UNREADABLE");
    expect(outcome.invoiceId).toBeNull();
    expect(await scope.select(schema.invoices)).toHaveLength(0);
    expect(await scope.select(schema.invoiceDocuments)).toHaveLength(0);
  });

  it("leaves the document stored and linkable, as every other outcome does", async () => {
    const { scope, store, documentId } = await seedDocument();

    await understandDocument(
      scope,
      documentId,
      depsReading(reading({ total: { text: "9,99,999.00" } }), store),
    );

    const row = await documentRow(scope, documentId);
    expect(await store.get(row!.storageRef)).not.toBeNull();
    expect(row?.classification).toBe("IS_INVOICE");
  });

  it("is not checked at all on a document with no text to check against", async () => {
    // The asymmetry is deliberate and is asserted so it cannot be quietly removed. A
    // photograph yields no ground truth, so the same reading that fails above succeeds
    // here -- which is the higher risk 0003 already accepts on the scanned path, not a bug.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode("photo")]);
    const { scope, store, documentId } = await seedDocument(jpeg);

    const outcome = await understandDocument(
      scope,
      documentId,
      depsReading(reading({ total: { text: "9,99,999.00" } }), store),
    );

    expect(outcome.state).toBe("EXTRACTED");
    const invoice = await scope.selectOne(
      schema.invoices,
      eq(schema.invoices.id, outcome.invoiceId!),
    );
    expect(invoice?.totalMinor).toBe(99_999_900n);
  });
});
