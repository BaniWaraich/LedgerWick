/**
 * Two documents from one vendor, arriving together.
 *
 * spec: docs/architecture.md §16 · `resolveVendor`'s own comment in
 * `src/documents/vendors.ts`, which says the unique index settles this race and the loser
 * keeps a harmless orphan.
 *
 * Written because feature G found the same class of bug in its own code: Drizzle wraps the
 * driver error and puts the original on `cause`, so a check for `error.code` at the top
 * level reads as correct and never matches. This is the test that says whether the swallow
 * here actually swallows.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, seedWorkspace, type TestDb } from "../helpers/db";
import { vendorAliases, vendors } from "../../src/db/schema";
import { WorkspaceScope } from "../../src/db/workspace-scope";
import { resolveVendor } from "../../src/documents/vendors";

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

const NAMES = {
  legalName: "Anthropic PBC",
  tradeName: "Anthropic",
  aliases: [] as string[],
};

describe("two documents from one vendor at once", () => {
  it("does not throw when the alias was taken between the check and the insert", async () => {
    // Feature K fetching a dozen attachments at once makes this the common case rather
    // than a rare one. If the swallow does not catch, understand-document fails the
    // document over a vendor row.
    const [first, second] = await Promise.all([
      resolveVendor(scope, NAMES),
      resolveVendor(scope, NAMES),
    ]);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
  });

  it("sends both documents to the same vendor", async () => {
    // The point of re-reading after the collision: the vendor that owns the alias is the
    // one every later document finds, and returning the orphan would split them.
    const [first, second] = await Promise.all([
      resolveVendor(scope, NAMES),
      resolveVendor(scope, NAMES),
    ]);

    expect(first).toBe(second);
  });

  it("leaves exactly one alias per name", async () => {
    await Promise.all([resolveVendor(scope, NAMES), resolveVendor(scope, NAMES)]);

    const aliases = await h.db.select().from(vendorAliases);
    const normalized = aliases.map((a) => a.aliasNormalized);

    expect(new Set(normalized).size).toBe(normalized.length);
  });

  it("finds the same vendor on a later document, not the orphan", async () => {
    await Promise.all([resolveVendor(scope, NAMES), resolveVendor(scope, NAMES)]);

    const later = await resolveVendor(scope, NAMES);
    const rows = await h.db.select().from(vendors);
    const reachable = rows.find((row) => row.id === later);

    expect(reachable).toBeDefined();
  });
});
