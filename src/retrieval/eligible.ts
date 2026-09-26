/**
 * Which requirements a retrieval request should search for.
 *
 * spec: docs/state-machines.md §2, "Transitions made by retrieval" · docs/workflows/connect-gmail.md §3, §9
 *
 * Every requirement in a state a search may start from, that nothing has resolved -- and
 * none at all when the workspace has no mailbox to search. `NOT_FOUND` is included on
 * purpose: invoices arrive late, and each new run looks again (settled 2026-09-26).
 * Documents the user rejected are never offered again, which the settle step enforces.
 */

import { and, inArray, isNull } from "drizzle-orm";

import { invoiceRequirements } from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";
import { listConnections } from "../gmail/connections";
import { SEARCHABLE_STATES } from "./requirement-state";

export async function requirementsToSearch(scope: WorkspaceScope): Promise<string[]> {
  const connections = await listConnections(scope);
  if (!connections.some((connection) => connection.state !== "DISCONNECTED")) return [];

  const rows = await scope.select(
    invoiceRequirements,
    and(
      inArray(invoiceRequirements.state, [...SEARCHABLE_STATES]),
      isNull(invoiceRequirements.resolutionMethod),
    ),
  );

  // Oldest first, so a large backlog is worked through in the order it arose.
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((row) => row.id);
}
