/**
 * What the review screen shows about retrieval, and what deciding there does to it.
 *
 * spec: docs/workflows/invoice-match-review.md §4, §5, §7 · connect-gmail.md §9
 * decision: docs/decisions/0016-retrieval-proposes-settle-decides.md
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { invoiceRequirements } from "../../src/db/schema";
import type { FakeMessage } from "../gmail/fake-gmail";
import { paper, Pipeline, reading, type Paper } from "./pipeline";
import { world, type World } from "./world";

vi.mock("server-only", () => ({}));

const { reviewContext } = await import("../../src/review/context");
const { confirmCandidate, linkExistingDocument, rejectAllCandidates } =
  await import("../../src/review/resolve");
const { blockedByMailbox } = await import("../../src/report/report");
const { markNeedsReauth } = await import("../../src/gmail/connections");

let w: World;

beforeEach(async () => {
  w = await world();
});

afterEach(async () => {
  await w.h.close();
});

function mail(id: string, papers: Paper[], over: Partial<FakeMessage> = {}): FakeMessage {
  return {
    id,
    from: "Receipts <receipts@anthropic.com>",
    subject: `Your Anthropic receipt ${id}`,
    receivedAt: "2026-04-15T08:30:00Z",
    attachments: papers.map((p) => ({ filename: `Receipt-${p.key}.pdf`, bytes: p.bytes })),
    ...over,
  };
}

async function requirement() {
  return w.requirement(await w.transaction());
}

async function stateOf(id: string) {
  const [row] = await w.h.db
    .select()
    .from(invoiceRequirements)
    .where(eq(invoiceRequirements.id, id));
  return row;
}

describe("what the system did", () => {
  it("names each mailbox, the window, and whether it could be searched", async () => {
    // §4: "we looked in three mailboxes across two weeks" or "we never got to look".
    const receipt = paper("A1");
    await w.connect("r-a", "accounts@business.in");
    const b = await w.connect("r-b", "founder@gmail.com");
    await markNeedsReauth(w.scope, b);
    w.gmail.mailbox("r-a", [mail("m1", [receipt])]);
    const id = await requirement();
    await new Pipeline(w).know(receipt).run(id);

    const context = await reviewContext(w.scope, id);

    expect(context?.whatWeDid.searchedMailboxes).toEqual([
      {
        email: "accounts@business.in",
        windowStart: "2026-04-07",
        windowEnd: "2026-04-21",
        outcome: "COMPLETED",
      },
      {
        email: "founder@gmail.com",
        windowStart: "2026-04-07",
        windowEnd: "2026-04-21",
        outcome: "NEEDS_REAUTH",
      },
    ]);
  });
});

describe("a retrieved candidate", () => {
  it("carries the email it came in and why that email was read", async () => {
    // §5: "From: receipts@anthropic.com · Attachment: Receipt-INV-92831.pdf".
    const seat = paper("S", reading({ invoiceNumber: "2231-9912" }));
    const usage = paper("U", reading({ invoiceNumber: "2231-9913" }));
    await w.connect("r-a", "accounts@business.in");
    w.gmail.mailbox("r-a", [mail("m1", [seat]), mail("m2", [usage])]);
    const id = await requirement();
    await new Pipeline(w).know(seat, usage).run(id);

    const context = await reviewContext(w.scope, id);

    expect(context?.candidates).toHaveLength(2);
    const [first] = context?.candidates ?? [];
    expect(first.source).toBe("GMAIL");
    expect(first.mail).toMatchObject({
      from: "Receipts <receipts@anthropic.com>",
      mailbox: "accounts@business.in",
    });
    expect(first.mail?.evidence).toContain(
      "Sent from receipts@anthropic.com, the vendor's own address",
    );
    // The document's own case is there too, as matching wrote it.
    expect(first.evidence).toContain("Amount matches exactly");
  });

  it("that nobody could read is still offered, and choosing it links the document", async () => {
    const scan = paper("X", "UNREADABLE");
    await w.connect("r-a");
    w.gmail.mailbox("r-a", [mail("m1", [scan])]);
    const id = await requirement();
    await new Pipeline(w).know(scan).run(id);

    const context = await reviewContext(w.scope, id);
    const [candidate] = context?.candidates ?? [];
    expect(candidate).toMatchObject({
      invoiceId: null,
      evidence: ["We couldn't read the details from this document"],
    });

    expect(await linkExistingDocument(w.scope, id, candidate.documentId)).toEqual({
      resolved: true,
    });
    expect(await stateOf(id)).toMatchObject({
      state: "RESOLVED",
      resolutionMethod: "USER_CONFIRMED",
      resolvedDocumentId: candidate.documentId,
    });
  });

  it("confirmed by the user resolves as the user's decision, not the system's", async () => {
    const receipt = paper("A1", reading({ total: { text: "23.60" } }));
    await w.connect("r-a");
    w.gmail.mailbox("r-a", [mail("m1", [receipt])]);
    const id = await requirement();
    await new Pipeline(w).know(receipt).run(id);
    const [candidate] = (await reviewContext(w.scope, id))?.candidates ?? [];

    await confirmCandidate(w.scope, id, candidate.invoiceId as string);

    expect(await stateOf(id)).toMatchObject({
      state: "RESOLVED",
      resolutionMethod: "USER_CONFIRMED",
    });
  });
});

describe("rejecting what retrieval found", () => {
  it("covers unreadable documents too, so a later run does not offer them again", async () => {
    // §7: rejected candidates are recorded so a later run does not present them again.
    const scan = paper("X", "UNREADABLE");
    await w.connect("r-a");
    w.gmail.mailbox("r-a", [mail("m1", [scan])]);
    const id = await requirement();
    const p = new Pipeline(w).know(scan);
    await p.run(id);

    await rejectAllCandidates(w.scope, id);
    await p.run(id);

    expect((await stateOf(id)).state).toBe("NOT_FOUND");
    const context = await reviewContext(w.scope, id);
    expect(context?.candidates).toEqual([]);
    expect(context?.whatWeDid.rejectedPreviously).toBe(1);
  });
});

describe("the reconnect prompt", () => {
  it("says how many invoices wait on each mailbox", async () => {
    // connect-gmail §9: "7 invoices are waiting on this."
    const a = await w.connect("r-a");
    await markNeedsReauth(w.scope, a);
    const p = new Pipeline(w);
    await p.run(await requirement());
    await p.run(await requirement());

    expect(await blockedByMailbox(w.scope)).toEqual(new Map([[a, 2]]));
  });
});
