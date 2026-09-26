/**
 * Searching a requirement's mailboxes, against a real database and a scripted Gmail.
 *
 * spec: docs/workflows/retrieve-invoices.md §5–§9, §16–§18 · docs/workflows/connect-gmail.md §5,
 * §7, §8 · docs/state-machines.md §2
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import {
  candidateEmails,
  gmailConnections,
  invoiceRequirements,
  mailboxSearches,
  vendorAliases,
  vendors,
} from "../../src/db/schema";
import { json } from "../gmail/fake-google";
import type { FakeMessage } from "../gmail/fake-gmail";
import { world, type World } from "./world";

vi.mock("server-only", () => ({}));

const { searchRequirement } = await import("../../src/retrieval/search");
const { markNeedsReauth, disconnectConnection } = await import("../../src/gmail/connections");
const { GmailApiError } = await import("../../src/gmail/mail");

let w: World;

beforeEach(async () => {
  w = await world();
});

afterEach(async () => {
  await w.h.close();
});

const receipt: FakeMessage = {
  id: "m-receipt",
  from: '"Anthropic, PBC" <invoice+statements@mail.anthropic.com>',
  subject: "Your receipt from Anthropic, PBC #2231-9912",
  receivedAt: "2026-04-14T08:30:00Z",
  rfc822MessageId: "<receipt-2231@mail.anthropic.com>",
};

const newsletter: FakeMessage = {
  id: "m-news",
  from: "Product Updates <news@somewhere.io>",
  subject: "What we shipped in April",
  receivedAt: "2026-04-16T10:00:00Z",
  foundBy: ["KEYWORD"],
};

async function requirement(overrides: Parameters<World["requirement"]>[1] = {}) {
  return w.requirement(await w.transaction(), overrides);
}

async function stateOf(id: string) {
  const [row] = await w.h.db
    .select()
    .from(invoiceRequirements)
    .where(eq(invoiceRequirements.id, id));
  return row.state;
}

const searches = () => w.h.db.select().from(mailboxSearches);
const candidates = () => w.h.db.select().from(candidateEmails);

describe("a search", () => {
  it("records where it looked, and what it found, for every connected mailbox", async () => {
    const a = await w.connect("r-a", "accounts@business.in");
    const b = await w.connect("r-b", "founder@gmail.com");
    w.gmail.mailbox("r-a", [receipt]).mailbox("r-b", []);
    const id = await requirement();

    await searchRequirement(w.scope, id, w.deps());

    const rows = await searches();
    expect(rows.map((r) => [r.gmailConnectionId, r.outcome, r.messagesFound]).sort()).toEqual(
      [
        [a, "COMPLETED", 1],
        [b, "COMPLETED", 0],
      ].sort(),
    );
    expect(rows[0]).toMatchObject({ windowStart: "2026-04-07", windowEnd: "2026-04-21" });

    const [candidate] = await candidates();
    expect(candidate).toMatchObject({
      gmailConnectionId: a,
      gmailMessageId: "m-receipt",
      rfc822MessageId: "<receipt-2231@mail.anthropic.com>",
      fromHeader: receipt.from,
      subject: receipt.subject,
      foundBy: "VENDOR",
      selected: true,
      fetchOutcome: null,
    });
  });

  it("asks Gmail for ids and headers, and never for a message's contents", async () => {
    // spec: connect-gmail §5 — "A test asserts that the search path issues no full-format
    // request."
    await w.connect("r-a");
    w.gmail.mailbox("r-a", [receipt, newsletter, { ...receipt, id: "m-2", foundBy: ["KEYWORD"] }]);

    await searchRequirement(w.scope, await requirement(), w.deps());

    const requests = w.gmail.gmailRequests();
    expect(requests.length).toBeGreaterThan(0);
    for (const url of requests) {
      const listing = url.pathname.endsWith("/users/me/messages");
      expect(listing || url.searchParams.get("format") === "metadata").toBe(true);
      expect(url.searchParams.get("format")).not.toBe("full");
      expect(url.searchParams.get("format")).not.toBe("raw");
      expect(url.pathname).not.toContain("/attachments");
    }
  });

  it("stores no part of a message's body", async () => {
    await w.connect("r-a");
    w.gmail.mailbox("r-a", [{ ...receipt, snippet: "Amount paid $20.00 card ending 4242" }]);

    await searchRequirement(w.scope, await requirement(), w.deps());

    expect(JSON.stringify(await candidates())).not.toContain("card ending 4242");
  });

  it("looks only inside the window around the payment", async () => {
    await w.connect("r-a");
    w.gmail.mailbox("r-a", [
      { ...receipt, id: "early", receivedAt: "2026-04-06T23:00:00Z" },
      { ...receipt, id: "first", receivedAt: "2026-04-07T00:30:00Z" },
      { ...receipt, id: "last", receivedAt: "2026-04-21T23:30:00Z" },
      { ...receipt, id: "late", receivedAt: "2026-04-22T00:30:00Z" },
    ]);

    await searchRequirement(w.scope, await requirement(), w.deps());

    expect((await candidates()).map((c) => c.gmailMessageId).sort()).toEqual(["first", "last"]);
  });

  it("widens the vendor pass with every name a known vendor goes by", async () => {
    // spec: retrieve-invoices §6.1 — inferred aliases may widen a search.
    const [vendor] = await w.h.db
      .insert(vendors)
      .values({ workspaceId: w.scope.workspaceId, name: "Anthropic", legalName: "Anthropic, PBC" })
      .returning();
    await w.h.db.insert(vendorAliases).values([
      {
        workspaceId: w.scope.workspaceId,
        vendorId: vendor.id,
        alias: "claudeai",
        aliasNormalized: "claudeai",
      },
    ]);
    await w.connect("r-a");
    w.gmail.mailbox("r-a", []);
    const id = await w.requirement(
      await w.transaction({
        description: "CLAUDE.AI SUBSCRIPTION",
        descriptionNormalized: "claudeai subscription",
      }),
      { vendorGuess: null },
    );

    await searchRequirement(w.scope, id, w.deps());

    const vendorPass = w.gmail
      .gmailRequests()
      .map((u) => u.searchParams.get("q") ?? "")
      .find((q) => q.includes("from:"));
    expect(vendorPass).toContain('"Anthropic, PBC"');
    expect(vendorPass).toContain("from:claudeai");
  });

  it("marks the connection as used when it searched it", async () => {
    const a = await w.connect("r-a");
    w.gmail.mailbox("r-a", []);

    await searchRequirement(w.scope, await requirement(), w.deps());

    const [row] = await w.h.db.select().from(gmailConnections).where(eq(gmailConnections.id, a));
    expect(row.lastUsedAt).toEqual(new Date("2026-04-25T09:00:00Z"));
  });
});

describe("what a search comes to", () => {
  it("stays SEARCHING with the messages worth downloading selected", async () => {
    await w.connect("r-a");
    w.gmail.mailbox("r-a", [receipt, newsletter]);
    const id = await requirement();

    const outcome = await searchRequirement(w.scope, id, w.deps());

    expect(outcome).toMatchObject({ kind: "SEARCHED", next: "FETCH", selected: 1 });
    expect(await stateOf(id)).toBe("SEARCHING");
    const byId = Object.fromEntries(
      (await candidates()).map((c) => [c.gmailMessageId, c.selected]),
    );
    expect(byId).toEqual({ "m-receipt": true, "m-news": false });
  });

  it("is NOT_FOUND when every mailbox was searched and nothing was worth downloading", async () => {
    // spec: retrieve-invoices §16 — a valid business outcome, not a failure.
    await w.connect("r-a");
    w.gmail.mailbox("r-a", [newsletter]);
    const id = await requirement();

    await searchRequirement(w.scope, id, w.deps());

    expect(await stateOf(id)).toBe("NOT_FOUND");
    // The weak candidate is kept, so the user can see something was looked at.
    expect(await candidates()).toHaveLength(1);
  });

  it("leaves the requirement waiting when the workspace has no mailbox", async () => {
    const id = await requirement();

    expect(await searchRequirement(w.scope, id, w.deps())).toEqual({ kind: "NO_MAILBOX" });
    expect(await stateOf(id)).toBe("IDENTIFIED");
    expect(w.gmail.requests).toHaveLength(0);
  });

  it("never searches a mailbox the user disconnected", async () => {
    const a = await w.connect("r-a");
    await disconnectConnection(w.scope, a, {
      client: w.gmail.oauth,
      grantHeldElsewhere: async () => true,
      key: Buffer.alloc(32),
    });
    const id = await requirement();

    expect(await searchRequirement(w.scope, id, w.deps())).toEqual({ kind: "NO_MAILBOX" });
    expect(w.gmail.gmailRequests()).toHaveLength(0);
  });

  it("does not touch a requirement already resolved or waiting on the user", async () => {
    await w.connect("r-a");
    w.gmail.mailbox("r-a", [receipt]);
    const review = await requirement({ state: "NEEDS_REVIEW" });
    const resolved = await requirement({ state: "RESOLVED", resolutionMethod: "USER_LINKED" });

    expect(await searchRequirement(w.scope, review, w.deps())).toEqual({ kind: "SKIPPED" });
    expect(await searchRequirement(w.scope, resolved, w.deps())).toEqual({ kind: "SKIPPED" });
    expect(w.gmail.gmailRequests()).toHaveLength(0);
  });

  it("searches again for a requirement an earlier run did not find", async () => {
    await w.connect("r-a");
    w.gmail.mailbox("r-a", [receipt]);
    const id = await requirement({ state: "NOT_FOUND" });

    const outcome = await searchRequirement(w.scope, id, w.deps());

    expect(outcome).toMatchObject({ next: "FETCH" });
  });
});

describe("a mailbox that needs reconnecting", () => {
  it("is not called at all, and blocks a requirement nothing else was found for", async () => {
    // spec: connect-gmail §7 — retrieval must not repeatedly attempt an account in NEEDS_REAUTH.
    const a = await w.connect("r-a");
    await markNeedsReauth(w.scope, a);
    const id = await requirement();

    await searchRequirement(w.scope, id, w.deps());

    expect(w.gmail.requests).toHaveLength(0);
    expect(await stateOf(id)).toBe("BLOCKED");
    const [row] = await searches();
    expect(row).toMatchObject({ gmailConnectionId: a, outcome: "NEEDS_REAUTH" });
  });

  it("is found out when Google refuses the refresh token", async () => {
    const a = await w.connect("r-a");
    w.gmail.failToken("r-a", json(400, { error: "invalid_grant" }));
    const id = await requirement();

    await searchRequirement(w.scope, id, w.deps());

    expect(await stateOf(id)).toBe("BLOCKED");
    const [connection] = await w.h.db
      .select()
      .from(gmailConnections)
      .where(eq(gmailConnections.id, a));
    expect(connection.state).toBe("NEEDS_REAUTH");
  });

  it("is found out mid-search, without stopping the other mailbox", async () => {
    const a = await w.connect("r-a");
    const b = await w.connect("r-b");
    w.gmail.mailbox("r-a", [receipt]).mailbox("r-b", [receipt]).revoke("r-a");
    const id = await requirement();

    const outcome = await searchRequirement(w.scope, id, w.deps());

    const byConnection = Object.fromEntries(
      (await searches()).map((s) => [s.gmailConnectionId, s.outcome]),
    );
    expect(byConnection).toEqual({ [a]: "NEEDS_REAUTH", [b]: "COMPLETED" });
    const [connection] = await w.h.db
      .select()
      .from(gmailConnections)
      .where(eq(gmailConnections.id, a));
    expect(connection.state).toBe("NEEDS_REAUTH");
    // The healthy mailbox found something, so there is still something to download.
    expect(outcome).toMatchObject({ next: "FETCH" });
    expect((await candidates()).map((c) => c.gmailConnectionId)).toEqual([b]);
  });
});

describe("a transient failure", () => {
  it("is recorded against the mailbox and thrown for the workflow to retry", async () => {
    // spec: retrieve-invoices §18 — recoverable failures are retried, and never read as
    // "not found"; connect-gmail §8 — they never mark a connection broken.
    const a = await w.connect("r-a");
    w.gmail
      .mailbox("r-a", [receipt])
      .fail((url) => url.pathname.endsWith("/messages"), json(503, {}));
    const id = await requirement();

    await expect(searchRequirement(w.scope, id, w.deps())).rejects.toBeInstanceOf(GmailApiError);

    expect(await stateOf(id)).toBe("SEARCHING");
    expect((await searches())[0]).toMatchObject({ gmailConnectionId: a, outcome: "FAILED" });
    const [connection] = await w.h.db.select().from(gmailConnections);
    expect(connection.state).toBe("CONNECTED");
  });

  it("leaves nothing behind that a successful retry does not replace", async () => {
    await w.connect("r-a");
    w.gmail
      .mailbox("r-a", [receipt, newsletter])
      .fail((url) => url.pathname.endsWith("/m-news"), json(503, {}), { once: true });
    const id = await requirement();

    await expect(searchRequirement(w.scope, id, w.deps())).rejects.toThrow();
    await searchRequirement(w.scope, id, w.deps());

    expect(await searches()).toHaveLength(1);
    expect((await searches())[0].outcome).toBe("COMPLETED");
    expect(await candidates()).toHaveLength(2);
  });
});

describe("running it again", () => {
  it("produces the same rows, not more of them", async () => {
    await w.connect("r-a");
    await w.connect("r-b");
    w.gmail.mailbox("r-a", [receipt, newsletter]).mailbox("r-b", [receipt]);
    const id = await requirement({ state: "NOT_FOUND" });

    await searchRequirement(w.scope, id, w.deps());
    const first = { searches: (await searches()).length, candidates: (await candidates()).length };
    await w.h.db
      .update(invoiceRequirements)
      .set({ state: "NOT_FOUND" })
      .where(eq(invoiceRequirements.id, id));
    await searchRequirement(w.scope, id, w.deps());

    expect({
      searches: (await searches()).length,
      candidates: (await candidates()).length,
    }).toEqual(first);
    expect(first).toEqual({ searches: 2, candidates: 3 });
  });

  it("keeps both copies of mail that reached two mailboxes, and selects both", async () => {
    await w.connect("r-a");
    await w.connect("r-b");
    w.gmail.mailbox("r-a", [receipt]).mailbox("r-b", [{ ...receipt, id: "other-gmail-id" }]);

    await searchRequirement(w.scope, await requirement(), w.deps());

    const rows = await candidates();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.selected)).toBe(true);
    expect(new Set(rows.map((row) => row.rfc822MessageId)).size).toBe(1);
  });

  it("forgets what a since-disconnected mailbox contributed", async () => {
    const a = await w.connect("r-a");
    await w.connect("r-b");
    w.gmail.mailbox("r-a", [receipt]).mailbox("r-b", []);
    const id = await requirement();
    await searchRequirement(w.scope, id, w.deps());

    await disconnectConnection(w.scope, a, {
      client: w.gmail.oauth,
      grantHeldElsewhere: async () => true,
      key: Buffer.alloc(32),
    });
    await w.h.db
      .update(invoiceRequirements)
      .set({ state: "NOT_FOUND" })
      .where(eq(invoiceRequirements.id, id));
    await searchRequirement(w.scope, id, w.deps());

    expect((await searches()).map((s) => s.gmailConnectionId)).not.toContain(a);
    expect(await candidates()).toHaveLength(0);
  });
});
