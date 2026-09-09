/**
 * Auth.js request handlers: sign-in, callback, sign-out, session.
 *
 * The whole route surface is Auth.js's. Nothing application-specific belongs here — the
 * session is read on the server through `auth()`, never by fetching this endpoint.
 */

import { handlers } from "../../../../auth/config";

export const { GET, POST } = handlers;
