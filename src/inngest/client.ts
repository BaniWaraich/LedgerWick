/**
 * The event bus for durable background work.
 *
 * `docs/architecture.md §7` chose Inngest so that slow, multi-step, retryable work does
 * not run in a request and does not need the browser to stay open. §13 gives the shape
 * every feature follows: validate the action, persist initial state, send an event, let
 * the workflow persist the result, let the frontend read it back.
 *
 * Feature C is the first user of this module. Everything downstream — parsing, retrieval,
 * document understanding, the export — sends its events through the same client.
 */

import { eventType, Inngest } from "inngest";
import { z } from "zod";

/**
 * What every workspace-scoped event carries.
 *
 * The workflow needs to know which workspace, and on whose behalf. Both are captured from
 * the session by the request that sends the event, and both are re-checked by
 * `openWorkspaceForJob` before the workflow touches data — `src/auth/background.ts`
 * explains why the payload is a claim rather than proof.
 */
const workspaceEvent = z.object({
  workspaceId: z.uuid(),
  /** Auth.js user ids are provider-shaped strings, not uuids (see `src/db/schema.ts`). */
  userId: z.string().min(1),
});

/**
 * A statement's bytes are stored and its row exists. Identify it.
 *
 * Sent once per file in an upload batch, because `docs/workflows/upload-statement.md §11`
 * requires files in one batch to reach outcomes independently — one event per file is
 * what makes a failure in one unable to affect another.
 */
export const statementUploaded = eventType("statement/uploaded", {
  schema: workspaceEvent.extend({ statementId: z.uuid() }),
});

export const inngest = new Inngest({ id: "ledgerwick" });
