/**
 * The database behind `isGoogleGrantHeldElsewhere`, for a request.
 *
 * Here rather than in `src/gmail` because only `src/db` and `src/auth` may reach the
 * unscoped client (`tests/auth/scope-is-unavoidable.test.ts`), and this question has to
 * look across workspaces. Widening that list for feature J would make the rule mean
 * nothing; one narrow function that returns a boolean does not.
 */

import "server-only";

import { getDb } from "../db/client";
import { isGoogleGrantHeldElsewhere } from "../db/google-grants";

export function googleGrantHeldElsewhere(
  googleSubject: string,
  exceptConnectionId: string,
): Promise<boolean> {
  return isGoogleGrantHeldElsewhere(getDb(), googleSubject, exceptConnectionId);
}
