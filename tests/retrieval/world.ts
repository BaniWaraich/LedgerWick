/**
 * A workspace with payments, requirements and mailboxes, for retrieval tests.
 *
 * Connections are made through `recordGrant`, the way a real consent makes them, so their
 * refresh tokens are encrypted exactly as they would be and a search has to decrypt one to
 * reach the fake mailbox.
 */

import { randomBytes } from "node:crypto";

import { createTestDb, seedBankAccount, seedWorkspace, type TestDb } from "../helpers/db";
import {
  canonicalTransactions,
  invoiceRequirements,
  type requirementStateEnum,
} from "../../src/db/schema";
import { WorkspaceScope } from "../../src/db/workspace-scope";
import { recordGrant } from "../../src/gmail/connections";
import { FakeGmail } from "../gmail/fake-gmail";

export const TOKEN_KEY = randomBytes(32);

let seq = 0;

export interface World {
  readonly h: TestDb;
  readonly scope: WorkspaceScope;
  readonly gmail: FakeGmail;
  /** Connect a mailbox; returns its connection id. The refresh token names its fake mailbox. */
  connect(refreshToken: string, email?: string): Promise<string>;
  transaction(overrides?: Partial<typeof canonicalTransactions.$inferInsert>): Promise<string>;
  requirement(
    transactionId: string,
    overrides?: Partial<typeof invoiceRequirements.$inferInsert> & {
      state?: (typeof requirementStateEnum.enumValues)[number];
    },
  ): Promise<string>;
  /** Everything a search needs, pointed at the fake. */
  deps(): {
    oauth: FakeGmail["oauth"];
    gmail: FakeGmail["gmail"];
    tokenKey: Buffer;
    now: () => Date;
  };
}

/** A second workspace in the same database. */
export async function addWorkspace(h: TestDb, gmail: FakeGmail): Promise<World> {
  const { workspace, user } = await seedWorkspace(h.db);
  const bankAccountId = (await seedBankAccount(h.db, workspace.id)).id;
  const scope = new WorkspaceScope(h.db, workspace.id, user.id);

  return {
    h,
    scope,
    gmail,
    async connect(refreshToken, email) {
      seq += 1;
      const { connection } = await recordGrant(
        scope,
        {
          googleSubject: `sub-${refreshToken}-${seq}`,
          email: email ?? `${refreshToken}@business.in`,
          grantedScopes: "openid email https://www.googleapis.com/auth/gmail.readonly",
          refreshToken,
        },
        { key: TOKEN_KEY },
      );
      return connection.id;
    },
    async transaction(overrides = {}) {
      seq += 1;
      const [row] = await h.db
        .insert(canonicalTransactions)
        .values({
          workspaceId: workspace.id,
          bankAccountId,
          valueDate: "2026-04-14",
          amountMinor: 2000n,
          direction: "DEBIT",
          currency: "USD",
          description: "CARD 4242 ANTHROPIC SAN FRANCISCO",
          descriptionNormalized: "card 4242 anthropic san francisco",
          occurrenceIndex: seq,
          ...overrides,
        })
        .returning();
      return row.id;
    },
    async requirement(transactionId, overrides = {}) {
      const [row] = await h.db
        .insert(invoiceRequirements)
        .values({
          workspaceId: workspace.id,
          canonicalTransactionId: transactionId,
          state: "IDENTIFIED",
          vendorGuess: "Anthropic",
          ...overrides,
        })
        .returning();
      return row.id;
    },
    deps() {
      return {
        oauth: gmail.oauth,
        gmail: gmail.gmail,
        tokenKey: TOKEN_KEY,
        now: () => new Date("2026-04-25T09:00:00Z"),
      };
    },
  };
}

export async function world(): Promise<World> {
  const h = await createTestDb();
  return addWorkspace(h, new FakeGmail());
}
