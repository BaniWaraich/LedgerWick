/**
 * Build one requested Excel export.
 *
 * A thin shell, like `match-invoice.ts`: it turns an event into a scope and calls
 * `generateExport`. What the file says is decided in `src/export/`, where it is tested
 * without Inngest.
 *
 * spec: docs/architecture.md §12B · docs/state-machines.md §7
 * decision: docs/decisions/0017-reconciliation-export.md
 */

import { openWorkspaceForJob } from "../../auth/background";
import { recordExportFailure } from "../../export/exports";
import { generateExport } from "../../export/generate";
import { getDocumentStore } from "../../storage/blob-store";
import { exportRequested, inngest } from "../client";

export const generateExportFunction = inngest.createFunction(
  {
    id: "generate-export",
    /*
     * Retries are for the transient half of `architecture.md §15` -- a cold database, the
     * store briefly unavailable. Generation makes no model call, so nothing here fails for
     * a reason a retry cannot fix except a bug, and a bug is what `onFailure` is for.
     *
     * Safe to retry because `generateExport` builds only an export still GENERATING.
     */
    retries: 3,
    triggers: [exportRequested],
    /*
     * Every retry is spent. Without this the export would sit in GENERATING and the page
     * would say "preparing" forever. FAILED holds no file -- the table refuses one -- so
     * the user is told honestly and can ask again, which is a new snapshot.
     */
    onFailure: async ({ event }) => {
      const { workspaceId, userId, exportId } = event.data.event.data;
      const scope = await openWorkspaceForJob(userId, workspaceId);

      await recordExportFailure(scope, exportId);
    },
  },
  async ({ event, step }) =>
    // One step, so the snapshot's bytes never have to cross a step boundary.
    step.run("generate", async () => {
      const { workspaceId, userId, exportId, origin } = event.data;
      const scope = await openWorkspaceForJob(userId, workspaceId);

      return generateExport(scope, getDocumentStore(), exportId, origin);
    }),
);
