/**
 * Where Inngest invokes this application's workflows.
 *
 * Inngest calls back into the app over HTTP, so background work runs in the same process,
 * with the same database and the same modules as a request — the difference is only what
 * triggered it. There is no session here; a workflow gets its workspace from the event
 * and re-checks it (`src/auth/background.ts`).
 *
 * Request authenticity is Inngest's signing key, verified by `serve`. The route is public
 * in the routing sense and must stay out of `src/proxy.ts`'s matcher: a redirect to
 * /login in front of it would break every workflow.
 */

import { serve } from "inngest/next";

import { inngest } from "../../../inngest/client";
import { functions } from "../../../inngest/functions";

export const { GET, POST, PUT } = serve({ client: inngest, functions });
