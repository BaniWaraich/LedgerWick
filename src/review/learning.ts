/**
 * What a confirmed match teaches about a vendor.
 *
 * spec: docs/workflows/invoice-match-review.md §9 · docs/architecture.md §11
 * invariant: docs/domain-model.md §10 invariant 18
 *
 * `§9`, row one: confirming a candidate whose vendor differs from the transaction
 * description learns "the alias, confirmed".
 *
 * ## Why this is safe, when §9 warns it might not be
 *
 * The same section warns: "One user confirming an Adobe receipt does not establish that
 * every `RAZORPAY*` transaction is Adobe."
 *
 * That danger is real for the raw narration and absent for the normalized one.
 * `normalizeVendorName` strips payment-processor prefixes from a closed list before it
 * does anything else, so `RAZORPAY*ADOBE` reduces to `adobe` and never to `razorpay`. The
 * alias written is the payee, which is exactly the thing the user confirmed. The machinery
 * that makes it safe is the machinery matching already relies on to find vendors at all.
 *
 * A description that reduces to nothing -- a narration that was a reference number and no
 * more -- teaches nothing, the same split `answer.ts` makes between recording and
 * learning.
 *
 * ## What it buys
 *
 * `decide.ts` requires vendor evidence of `RESOLVED` or `ALIAS` before an automatic link;
 * `NORMALIZED_CONTAINS` and `NONE` are deliberately not enough. A confirmed alias turns
 * the next payment bearing that description from `NONE` into a vendor the system knows, so
 * a match the user had to make by hand this month is one the system can make for them
 * next month. That is the loop closing.
 *
 * ## An alias already claimed by another vendor is left alone
 *
 * `vendor_aliases_identity_idx` is unique on (workspace, normalized alias), so one
 * description belongs to one vendor. If it already belongs to a different one, this writes
 * nothing: the user confirmed which document pays which payment, which is not the same as
 * saying two vendors are one. That is a merge, and `phase-1.md §3` defers the screen for
 * it deliberately.
 */

import { and, eq } from "drizzle-orm";

import { vendorAliases } from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";
import { normalizeVendorName } from "../documents/vendors";

/** Whether the confirmation taught us a name for this vendor. */
export interface AliasOutcome {
  readonly learned: boolean;
}

/**
 * Record that this bank description means this vendor, because the user said so.
 *
 * Idempotent: confirming the same pairing twice leaves one row, already confirmed.
 */
export async function confirmVendorAlias(
  scope: WorkspaceScope,
  vendorId: string | null,
  transactionDescription: string,
): Promise<AliasOutcome> {
  if (vendorId === null) return { learned: false };

  const key = normalizeVendorName(transactionDescription);
  if (key === "") return { learned: false };

  const [existing] = await scope.select(vendorAliases, eq(vendorAliases.aliasNormalized, key));

  if (existing) {
    // Claimed by someone else. Confirming a match is not a claim that two vendors are one.
    if (existing.vendorId !== vendorId) return { learned: false };

    // Already ours, and now confirmed rather than inferred. `architecture.md §11`: only a
    // user's confirmation makes a guess into Business Knowledge.
    if (existing.confirmed) return { learned: false };

    await scope.update(
      vendorAliases,
      { confirmed: true },
      and(eq(vendorAliases.id, existing.id), eq(vendorAliases.vendorId, vendorId)),
    );
    return { learned: true };
  }

  await scope.insert(vendorAliases, {
    vendorId,
    // What the bank actually printed, kept as it was printed. The normalized form is the
    // lookup key and is never shown to anyone.
    alias: transactionDescription,
    aliasNormalized: key,
    confirmed: true,
  });

  return { learned: true };
}
