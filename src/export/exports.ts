/**
 * Asking for an export, and what became of it.
 *
 * spec: docs/workflows/missing-invoice-report.md §4, §9 · docs/architecture.md §12B, §13 ·
 * docs/state-machines.md §7
 * decision: docs/decisions/0017-reconciliation-export.md
 *
 * The half of the feature a request may touch. It records that an export was asked for and
 * hands the work to the background; it never reads the reconciliation and never builds a
 * file. That lives in `generate.ts`, which only the Inngest function imports
 * (`tests/export/request.test.ts` holds the line).
 */

import { and, eq } from "drizzle-orm";

import { reconciliationExports, reconciliationRuns } from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";
import { exportRequested } from "../inngest/client";

/** The MIME type an export is stored and served as. */
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type Export = typeof reconciliationExports.$inferSelect;

export type ExportRequestOutcome =
  | { readonly requested: true; readonly exportId: string }
  | { readonly requested: false; readonly reason: string };

/** How an event reaches the background. Injected, so a test can see exactly what was sent. */
export type SendEvent = (event: ReturnType<typeof exportRequested.create>) => Promise<unknown>;

/**
 * The origin links in the file will point at, or null if this is not one.
 *
 * Normalized through `URL`, so a path or a query on the way in cannot become part of every
 * link on the way out, and held to http(s).
 */
export function linkOrigin(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** What the user's browser saves the file as. */
function exportFilename(at: Date): string {
  return `ledgerwick-reconciliation-${at.toISOString().slice(0, 10)}.xlsx`;
}

/**
 * Record an export request and start building it.
 *
 * §4: the report -- and so its export -- is available once a Reconciliation Run exists.
 * Before one, there is no reconciliation to snapshot, and offering a file would suggest
 * there is.
 *
 * Every call is a new export. Nothing here looks for an earlier one to reuse: an earlier
 * file is a snapshot of an earlier moment, and handing it back would answer a different
 * question from the one asked.
 */
export async function requestExport(
  scope: WorkspaceScope,
  origin: string,
  send: SendEvent,
  now: Date = new Date(),
): Promise<ExportRequestOutcome> {
  const run = await scope.selectOne(reconciliationRuns);
  if (!run) {
    return { requested: false, reason: "Upload your statements first, then export." };
  }

  const [created] = await scope.insert(reconciliationExports, {
    requestedBy: scope.userId,
    state: "GENERATING",
    filename: exportFilename(now),
    requestedAt: now,
  });

  try {
    await send(
      exportRequested.create({
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        exportId: created.id,
        origin,
      }),
    );
  } catch (error) {
    // Nothing will ever build this one. Left GENERATING, the page would say "preparing"
    // forever -- the swallowed failure `docs/definition-of-done.md` forbids.
    await recordExportFailure(scope, created.id);
    throw error;
  }

  return { requested: true, exportId: created.id };
}

/**
 * The workflow gave up on this export.
 *
 * Only from `GENERATING`: an export that became `READY` on an attempt that raced this one
 * stays ready, because its file is complete. `FAILED` carries no file -- the table refuses
 * one -- so a failure can never be downloaded.
 */
export async function recordExportFailure(scope: WorkspaceScope, exportId: string): Promise<void> {
  await scope.update(
    reconciliationExports,
    { state: "FAILED", completedAt: new Date() },
    and(eq(reconciliationExports.id, exportId), eq(reconciliationExports.state, "GENERATING")),
  );
}

/**
 * The export the report offers: the most recently requested.
 *
 * Earlier ones remain downloadable by id; the report offers one, because one is what the
 * user is asking about.
 */
export async function latestExport(scope: WorkspaceScope): Promise<Export | null> {
  const exports = await scope.select(reconciliationExports);
  return exports.sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())[0] ?? null;
}
