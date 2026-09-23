/**
 * The adapter that binds the invoice prompt to the one model call this system makes.
 *
 * A one-liner on purpose, and separated from the logic for the reason
 * `src/requirements/classifier.ts` and `src/statements/column-mapper.ts` are: this file is
 * `server-only` and reaches a provider, so keeping it apart is what lets `understand.ts`
 * and its tests be imported without a key, a network, or a gateway balance.
 */

import "server-only";

import { inferStructure } from "../ai/model";
import { invoiceReadingSchema, readInvoicePrompt } from "../ai/prompts/read-invoice.v1";
import type { ReadInvoice } from "./contracts";

export const readInvoice: ReadInvoice = (content) =>
  inferStructure({ prompt: readInvoicePrompt, schema: invoiceReadingSchema, content });
