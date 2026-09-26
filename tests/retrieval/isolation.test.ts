/**
 * One workspace's retrieval cannot reach another's mailboxes, requirements or findings.
 *
 * spec: docs/definition-of-done.md "When it touches workspace-scoped data" ·
 * docs/workflows/connect-gmail.md §4 — "searching one Workspace never reads another
 * Workspace's connection."
 *
 * Written as attacks, like the rest of the isolation suites: each test hands one workspace
 * the other's ids and expects nothing to happen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";

import { candidateEmails, mailboxSearches } from "../../src/db/schema";
import { workspaceScopedTables } from "../../src/db/workspace-scope";
import { addWorkspace, world, type World } from "./world";

vi.mock("server-only", () => ({}));

const { searchRequirement } = await import("../../src/retrieval/search");
const { requirementsToSearch } = await import("../../src/retrieval/eligible");

let victim: World;
let attacker: World;

const invoice = {
  id: "m-victim",
  from: "Receipts <receipts@anthropic.com>",
  subject: "Your Anthropic receipt",
  receivedAt: "2026-04-14T08:30:00Z",
};

beforeEach(async () => {
  victim = await world();
  attacker = await addWorkspace(victim.h, victim.gmail);
});

afterEach(async () => {
  await victim.h.close();
});

describe("retrieval across workspaces", () => {
  it("cannot search for another workspace's requirement", async () => {
    await victim.connect("r-victim");
    await attacker.connect("r-attacker");
    victim.gmail.mailbox("r-victim", [invoice]).mailbox("r-attacker", [invoice]);
    const theirs = await victim.requirement(await victim.transaction());

    const outcome = await searchRequirement(attacker.scope, theirs, attacker.deps());

    expect(outcome).toEqual({ kind: "SKIPPED" });
    expect(victim.gmail.requests).toHaveLength(0);
    expect(await victim.h.db.select().from(mailboxSearches)).toHaveLength(0);
  });

  it("never uses another workspace's mailbox, even for the same person", async () => {
    // The attacker workspace has no mailbox of its own. The victim's must not stand in.
    await victim.connect("r-victim");
    victim.gmail.mailbox("r-victim", [invoice]);
    const own = await attacker.requirement(await attacker.transaction());

    expect(await searchRequirement(attacker.scope, own, attacker.deps())).toEqual({
      kind: "NO_MAILBOX",
    });
    expect(victim.gmail.requests).toHaveLength(0);
    expect(await requirementsToSearch(attacker.scope)).toEqual([]);
  });

  it("searches each workspace's mailbox with that workspace's own credentials", async () => {
    // The same Google account connected to both workspaces is two connections with two
    // tokens (connect-gmail §4). Each search must use its own.
    await victim.connect("r-victim", "shared@gmail.com");
    await attacker.connect("r-attacker", "shared@gmail.com");
    victim.gmail.mailbox("r-victim", [invoice]).mailbox("r-attacker", []);
    const own = await attacker.requirement(await attacker.transaction());

    await searchRequirement(attacker.scope, own, attacker.deps());

    // Its own mailbox was searched and was empty; the victim's invoice was never seen.
    const [search] = await attacker.scope.select(mailboxSearches);
    expect(search).toMatchObject({ outcome: "COMPLETED", messagesFound: 0 });
    expect(await attacker.scope.select(candidateEmails)).toHaveLength(0);
  });

  it("cannot read what another workspace's search found", async () => {
    await victim.connect("r-victim");
    victim.gmail.mailbox("r-victim", [invoice]);
    await searchRequirement(
      victim.scope,
      await victim.requirement(await victim.transaction()),
      victim.deps(),
    );

    expect(await victim.scope.select(candidateEmails)).toHaveLength(1);
    expect(await victim.scope.select(mailboxSearches)).toHaveLength(1);
    expect(await attacker.scope.select(candidateEmails)).toHaveLength(0);
    expect(await attacker.scope.select(mailboxSearches)).toHaveLength(0);
  });

  it("covers both new tables in the scope object", () => {
    const names = workspaceScopedTables.map((t) => getTableName(t));
    expect(names).toContain("mailbox_searches");
    expect(names).toContain("candidate_emails");
  });
});
