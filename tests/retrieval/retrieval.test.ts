/**
 * Retrieval from end to end: a requirement goes in, a settled requirement comes out.
 *
 * spec: docs/workflows/retrieve-invoices.md §11–§20 · docs/state-machines.md §2
 * decision: docs/decisions/0016-retrieval-proposes-settle-decides.md
 *
 * Driven through the same domain functions the two Inngest functions call, in the order
 * they call them, against a real database, a scripted Gmail and a scripted model. The
 * scripted model means these measure the pipeline and the policy, never model quality.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import {
  candidateEmailDocuments,
  candidateEmails,
  invoiceMatchCandidates,
  invoiceRequirements,
  invoices,
  mailboxSearches,
  supportingDocuments,
} from "../../src/db/schema";
import { json } from "../gmail/fake-google";
import { contentRequests, type FakeMessage } from "../gmail/fake-gmail";
import { addWorkspace, world, type World } from "./world";
import { paper, Pipeline, reading, unsure, type Paper } from "./pipeline";

vi.mock("server-only", () => ({}));

const { GmailApiError } = await import("../../src/gmail/mail");
const { markNeedsReauth } = await import("../../src/gmail/connections");
const { rejectAllCandidates } = await import("../../src/review/resolve");

let w: World;

beforeEach(async () => {
  w = await world();
});

afterEach(async () => {
  await w.h.close();
});

/** A message from the vendor carrying these papers. */
function mail(id: string, papers: Paper[], over: Partial<FakeMessage> = {}): FakeMessage {
  return {
    id,
    from: '"Anthropic, PBC" <invoice+statements@mail.anthropic.com>',
    subject: `Your receipt from Anthropic, PBC #${id}`,
    receivedAt: "2026-04-14T08:30:00Z",
    rfc822MessageId: `<${id}@mail.anthropic.com>`,
    attachments: papers.map((p) => ({ filename: `Receipt-${p.key}.pdf`, bytes: p.bytes })),
    ...over,
  };
}

async function requirement(over: Parameters<World["requirement"]>[1] = {}) {
  const transactionId = await w.transaction();
  return { transactionId, id: await w.requirement(transactionId, over) };
}

async function row(id: string) {
  const [r] = await w.h.db.select().from(invoiceRequirements).where(eq(invoiceRequirements.id, id));
  return r;
}

async function counts() {
  const [documents, joins, emails, searches, invoiceRows] = await Promise.all([
    w.h.db.select().from(supportingDocuments),
    w.h.db.select().from(candidateEmailDocuments),
    w.h.db.select().from(candidateEmails),
    w.h.db.select().from(mailboxSearches),
    w.h.db.select().from(invoices),
  ]);
  return {
    documents: documents.length,
    joins: joins.length,
    emails: emails.length,
    searches: searches.length,
    invoices: invoiceRows.length,
  };
}

describe("a strong match", () => {
  it("is retrieved, understood, and linked automatically", async () => {
    // spec: retrieve-invoices §12 — no separate confirmation for an obviously correct document.
    const receipt = paper("A1");
    await w.connect("r-a");
    w.gmail.mailbox("r-a", [mail("m1", [receipt])]);
    const p = new Pipeline(w).know(receipt);
    const { id, transactionId } = await requirement();

    const { settled } = await p.run(id);

    expect(settled).toMatchObject({
      kind: "SETTLED",
      resolved: true,
      settlement: { kind: "AUTO" },
    });
    const r = await row(id);
    expect(r).toMatchObject({ state: "RESOLVED", resolutionMethod: "AUTO_RETRIEVED" });

    const [invoice] = await w.h.db.select().from(invoices);
    expect(invoice.canonicalTransactionId).toBe(transactionId);

    const [document] = await w.h.db.select().from(supportingDocuments);
    expect(r.resolvedDocumentId).toBe(document.id);
    expect(document).toMatchObject({
      source: "GMAIL",
      state: "EXTRACTED",
      filename: "Receipt-A1.pdf",
    });
    // spec: retrieve-invoices §11 — traceable to the account, the email and the attachment.
    expect(document.sourceMetadata).toMatchObject({
      gmailMessageId: "m1",
      rfc822MessageId: "<m1@mail.anthropic.com>",
      filename: "Receipt-A1.pdf",
    });
    expect(await w.h.db.select().from(candidateEmailDocuments)).toHaveLength(1);
  });

  it("goes through the same understanding every upload does, and is never published for it", async () => {
    // spec: retrieve-invoices §11.1 — neither entry path skips classification and extraction.
    const receipt = paper("A1");
    await w.connect("r-a");
    w.gmail.mailbox("r-a", [mail("m1", [receipt])]);
    const p = new Pipeline(w).know(receipt);

    await p.run((await requirement()).id);

    expect(p.reads).toBe(1);
  });

  it("downloads only what search selected", async () => {
    // spec: connect-gmail §5 — full content only for a message already selected.
    const receipt = paper("A1");
    const noise: FakeMessage = {
      id: "m-news",
      from: "news@somewhere.io",
      subject: "What we shipped in April",
      receivedAt: "2026-04-15T10:00:00Z",
      attachments: [{ filename: "april.pdf", bytes: paper("N").bytes }],
    };
    await w.connect("r-a");
    w.gmail.mailbox("r-a", [mail("m1", [receipt]), noise]);

    await new Pipeline(w).know(receipt).run((await requirement()).id);

    const contents = contentRequests(w.gmail.gmailRequests());
    expect(contents.length).toBeGreaterThan(0);
    expect(contents.every((url) => url.pathname.includes("/messages/m1"))).toBe(true);
  });
});

describe("more than one plausible document", () => {
  it("goes to review with each one's evidence, and links nothing", async () => {
    // spec: retrieve-invoices §13 — the user resolves the ambiguity.
    const seat = paper("S", reading({ invoiceNumber: "2231-9912" }));
    const usage = paper("U", reading({ invoiceNumber: "2231-9913" }));
    await w.connect("r-a");
    w.gmail.mailbox("r-a", [mail("m1", [seat]), mail("m2", [usage])]);
    const { id, transactionId } = await requirement();

    const { settled } = await new Pipeline(w).know(seat, usage).run(id);

    expect(settled).toMatchObject({
      settlement: { kind: "NEEDS_REVIEW", blockedBy: "one document supports this payment" },
    });
    expect((await row(id)).state).toBe("NEEDS_REVIEW");
    expect(
      (await w.h.db.select().from(invoices)).every((i) => i.canonicalTransactionId === null),
    ).toBe(true);
    // Both invoices' evidence for this payment is on file for the review screen.
    const proposed = await w.h.db
      .select()
      .from(invoiceMatchCandidates)
      .where(eq(invoiceMatchCandidates.canonicalTransactionId, transactionId));
    expect(proposed).toHaveLength(2);
  });

  it("goes to review when the model is not sure, even with one document", async () => {
    const receipt = paper("A1");
    await w.connect("r-a");
    w.gmail.mailbox("r-a", [mail("m1", [receipt])]);
    const { id } = await requirement();

    const { settled } = await new Pipeline(w, unsure).know(receipt).run(id);

    expect(settled).toMatchObject({
      settlement: { kind: "NEEDS_REVIEW", blockedBy: "matching chose this payment for it" },
    });
  });

  it("goes to review when the amount differs, rather than being linked or dropped", async () => {
    // spec: retrieve-invoices §8 — a different amount does not disqualify a document.
    const withTax = paper("T", reading({ total: { text: "23.60" } }));
    await w.connect("r-a");
    w.gmail.mailbox("r-a", [mail("m1", [withTax])]);
    const { id } = await requirement();

    await new Pipeline(w).know(withTax).run(id);

    expect((await row(id)).state).toBe("NEEDS_REVIEW");
  });

  it("puts a document nobody could read in front of the user", async () => {
    const scan = paper("X", "UNREADABLE");
    await w.connect("r-a");
    w.gmail.mailbox("r-a", [mail("m1", [scan])]);
    const { id } = await requirement();

    await new Pipeline(w).know(scan).run(id);

    expect((await row(id)).state).toBe("NEEDS_REVIEW");
  });
});

describe("nothing suitable", () => {
  it("is NOT_FOUND when the only document found is not an invoice", async () => {
    // Settled 2026-09-26 (retrieve-invoices §11.1): recorded, not offered.
    const notice = paper("TOS", "NOT_AN_INVOICE");
    await w.connect("r-a");
    w.gmail.mailbox("r-a", [mail("m1", [notice])]);
    const { id } = await requirement();

    await new Pipeline(w).know(notice).run(id);

    expect((await row(id)).state).toBe("NOT_FOUND");
    expect((await w.h.db.select().from(supportingDocuments))[0].state).toBe("NOT_AN_INVOICE");
  });

  it("is NOT_FOUND when the vendor's invoice is for a different month", async () => {
    const march = paper("M", reading({ invoiceDate: { text: "14/03/2026" } }));
    await w.connect("r-a");
    w.gmail.mailbox("r-a", [mail("m1", [march])]);
    const { id } = await requirement();

    await new Pipeline(w).know(march).run(id);

    expect((await row(id)).state).toBe("NOT_FOUND");
  });

  it("is NOT_FOUND when the selected message carried no PDF at all", async () => {
    const fake = new TextEncoder().encode("<html>not a pdf</html>");
    await w.connect("r-a");
    w.gmail.mailbox("r-a", [
      mail("m1", [], { attachments: [{ filename: "invoice.pdf", bytes: fake }] }),
    ]);
    const { id } = await requirement();

    const { fetched } = await new Pipeline(w).run(id);

    expect(fetched).toEqual({ next: "NOT_FOUND" });
    expect((await w.h.db.select().from(candidateEmails))[0].fetchOutcome).toBe("NO_ATTACHMENT");
    expect(await w.h.db.select().from(supportingDocuments)).toHaveLength(0);
  });

  it("skips a message deleted between being found and being fetched", async () => {
    await w.connect("r-a");
    w.gmail
      .mailbox("r-a", [mail("m1", [paper("A1")])])
      .fail((url) => url.searchParams.get("format") === "full", json(404, {}));
    const { id } = await requirement();

    await new Pipeline(w).run(id);

    expect((await w.h.db.select().from(candidateEmails))[0].fetchOutcome).toBe("MESSAGE_GONE");
    expect((await row(id)).state).toBe("NOT_FOUND");
  });
});

describe("a mailbox that cannot be read", () => {
  it("blocks a requirement nothing else was found for", async () => {
    // spec: retrieve-invoices §17 — BLOCKED, not NOT_FOUND.
    const a = await w.connect("r-a");
    await markNeedsReauth(w.scope, a);
    const { id } = await requirement();

    await new Pipeline(w).run(id);

    expect((await row(id)).state).toBe("BLOCKED");
    expect(w.gmail.requests).toHaveLength(0);
  });

  it("holds back an otherwise certain link while another mailbox went unsearched", async () => {
    const receipt = paper("A1");
    const a = await w.connect("r-a");
    await w.connect("r-b");
    await markNeedsReauth(w.scope, a);
    w.gmail.mailbox("r-b", [mail("m1", [receipt])]);
    const { id } = await requirement();

    const { settled } = await new Pipeline(w).know(receipt).run(id);

    expect(settled).toMatchObject({
      settlement: { kind: "NEEDS_REVIEW", blockedBy: "every mailbox was searched" },
    });
  });

  it("is found out while fetching, and counts as unsearched", async () => {
    const receipt = paper("A1");
    await w.connect("r-a");
    w.gmail
      .mailbox("r-a", [mail("m1", [receipt])])
      .fail((url) => url.searchParams.get("format") === "full", json(401, {}));
    const { id } = await requirement();

    await new Pipeline(w).know(receipt).run(id);

    expect((await row(id)).state).toBe("BLOCKED");
    expect((await w.h.db.select().from(mailboxSearches))[0].outcome).toBe("NEEDS_REAUTH");
  });
});

describe("two mailboxes", () => {
  it("searches both, keeps both provenances, and stores one document", async () => {
    const receipt = paper("A1");
    await w.connect("r-a", "accounts@business.in");
    await w.connect("r-b", "founder@gmail.com");
    const shared = mail("m1", [receipt]);
    w.gmail.mailbox("r-a", [shared]).mailbox("r-b", [{ ...shared, id: "m1-in-b" }]);
    const { id } = await requirement();

    await new Pipeline(w).know(receipt).run(id);

    expect(await counts()).toMatchObject({
      documents: 1,
      joins: 2,
      emails: 2,
      searches: 2,
      invoices: 1,
    });
    // One document reached twice is one document, not two competing ones.
    expect(await row(id)).toMatchObject({ state: "RESOLVED", resolutionMethod: "AUTO_RETRIEVED" });
    // And only one of the two mailboxes was asked for it.
    const downloads = w.gmail.gmailRequests().filter((u) => u.pathname.includes("/attachments/"));
    expect(downloads).toHaveLength(1);
  });
});

describe("running it again", () => {
  it("resumes after a failure mid-download without duplicating anything", async () => {
    const one = paper("A1");
    const two = paper("A2", reading({ invoiceNumber: "2231-9913" }));
    await w.connect("r-a");
    w.gmail
      .mailbox("r-a", [mail("m1", [one]), mail("m2", [two])])
      .fail((url) => url.pathname.includes("/messages/m2/attachments/"), json(503, {}), {
        once: true,
      });
    const p = new Pipeline(w).know(one, two);
    const { id } = await requirement();

    await p.searchAndFetch(id).catch((error: unknown) => {
      expect(error).toBeInstanceOf(GmailApiError);
    });
    // Inngest retries the fetch step alone; the search's result is replayed, not re-run.
    const { fetchForRequirement } = await import("../../src/retrieval/fetch");
    await fetchForRequirement(w.scope, id, p.fetchDeps());
    await p.assessAndSettle(id);

    expect(await counts()).toMatchObject({ documents: 2, joins: 2, emails: 2, invoices: 2 });
  });

  it("assessing twice creates no second invoice and no second candidate set", async () => {
    const receipt = paper("A1", reading());
    const other = paper("A2", reading({ invoiceNumber: "2231-9913" }));
    await w.connect("r-a");
    w.gmail.mailbox("r-a", [mail("m1", [receipt]), mail("m2", [other])]);
    const p = new Pipeline(w).know(receipt, other);
    const { id } = await requirement();

    await p.searchAndFetch(id);
    const { documentsFor } = await import("../../src/retrieval/fetch");
    const { assessDocument } = await import("../../src/retrieval/assess");
    for (const documentId of await documentsFor(w.scope, id)) {
      await assessDocument(w.scope, documentId, p.deps());
      await assessDocument(w.scope, documentId, p.deps());
    }

    expect((await counts()).invoices).toBe(2);
    expect(await w.h.db.select().from(invoiceMatchCandidates)).toHaveLength(2);
  });

  it("searches again after NOT_FOUND, reusing what it already downloaded", async () => {
    const receipt = paper("A1");
    await w.connect("r-a");
    w.gmail.mailbox("r-a", [mail("m1", [receipt])]);
    const p = new Pipeline(w, unsure).know(receipt);
    const { id } = await requirement();
    await p.run(id);
    await rejectAllCandidates(w.scope, id);
    expect((await row(id)).state).toBe("NOT_FOUND");
    const before = await counts();
    const downloadsBefore = contentRequests(w.gmail.gmailRequests()).length;

    await p.run(id);

    // Nothing downloaded again, nothing stored again, and the rejected document not offered.
    expect(contentRequests(w.gmail.gmailRequests())).toHaveLength(downloadsBefore);
    expect(await counts()).toEqual(before);
    expect((await row(id)).state).toBe("NOT_FOUND");
  });

  it("finds an invoice that arrived after the last search", async () => {
    await w.connect("r-a");
    w.gmail.mailbox("r-a", []);
    const p = new Pipeline(w);
    const { id } = await requirement();
    await p.run(id);
    expect((await row(id)).state).toBe("NOT_FOUND");

    const late = paper("L");
    w.gmail.mailbox("r-a", [mail("m-late", [late], { receivedAt: "2026-04-20T09:00:00Z" })]);
    p.know(late);
    await p.run(id);

    expect((await row(id)).state).toBe("RESOLVED");
  });

  it("leaves a requirement the user resolved meanwhile exactly as they left it", async () => {
    const receipt = paper("A1");
    await w.connect("r-a");
    w.gmail.mailbox("r-a", [mail("m1", [receipt])]);
    const p = new Pipeline(w).know(receipt);
    const { id } = await requirement();
    await p.searchAndFetch(id);

    await w.h.db
      .update(invoiceRequirements)
      .set({ state: "RESOLVED", resolutionMethod: "NOT_REQUIRED" })
      .where(eq(invoiceRequirements.id, id));
    const settled = await p.assessAndSettle(id);

    expect(settled).toEqual({ kind: "SKIPPED" });
    expect(await row(id)).toMatchObject({ state: "RESOLVED", resolutionMethod: "NOT_REQUIRED" });
  });
});

describe("across workspaces", () => {
  it("cannot fetch, assess or settle another workspace's requirement", async () => {
    const receipt = paper("A1");
    await w.connect("r-a");
    w.gmail.mailbox("r-a", [mail("m1", [receipt])]);
    const p = new Pipeline(w).know(receipt);
    const { id } = await requirement();
    await p.searchAndFetch(id);
    const [document] = await w.h.db.select().from(supportingDocuments);

    const attacker = await addWorkspace(w.h, w.gmail);
    const theirs = new Pipeline(attacker).know(receipt);
    const { fetchForRequirement } = await import("../../src/retrieval/fetch");
    const { assessDocument, settleRetrieval } = await import("../../src/retrieval/assess");

    expect(await fetchForRequirement(attacker.scope, id, theirs.fetchDeps())).toEqual({
      next: "NONE",
    });
    expect(await assessDocument(attacker.scope, document.id, theirs.deps())).toMatchObject({
      state: "GONE",
    });
    expect(await settleRetrieval(attacker.scope, id, [])).toEqual({ kind: "SKIPPED" });
    expect((await row(id)).state).toBe("EVALUATING");
    expect(theirs.reads).toBe(0);
  });
});
