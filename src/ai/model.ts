/**
 * The one place this system asks a model a question.
 *
 * `docs/architecture.md §2.3` draws the line this module exists to hold: AI provides
 * inference, not authority. Nothing a model says becomes state without passing a schema
 * first, so every call here returns a validated value or a reason — never a raw string,
 * and never a throw that a workflow has to remember to catch.
 *
 * The model is named by a plain `"provider/model"` string through Vercel AI Gateway rather
 * than by a provider SDK, because `§21.2` defers the provider choice to evaluation. Keeping
 * it a string is what keeps that choice cheap: changing it is configuration, not a
 * refactor.
 */

import "server-only";

import { generateObject, NoObjectGeneratedError } from "ai";
import type { ZodType } from "zod";

/**
 * A versioned prompt.
 *
 * The definition of done requires prompts to live in files rather than inline strings, so
 * that a change to one is a diff someone can review and an eval can be attributed to a
 * version.
 */
export interface PromptDefinition {
  /** Stable across versions; identifies what the prompt is for. */
  readonly id: string;
  readonly version: number;
  readonly system: string;
}

/** What the model is given: extracted text, or the document itself. */
export type InferenceContent =
  { type: "text"; text: string } | { type: "file"; data: Uint8Array; mediaType: string };

/**
 * A validated answer, or a reason there isn't one.
 *
 * A result type rather than an exception because every caller is a background workflow
 * that has to distinguish "the model could not answer" — an outcome, recorded as state —
 * from "the infrastructure broke" — a retry. An exception blurs the two.
 */
export type Inference<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * The model this system uses until evaluation says otherwise.
 *
 * `§21.2` lists what that evaluation has to measure. Until it has run, this is an explicit
 * placeholder rather than a decision, and the environment can override it without a deploy.
 */
const DEFAULT_MODEL = "anthropic/claude-sonnet-5";

/**
 * The model to call.
 *
 * `??` is wrong here and was: `.env.example` ships `AI_MODEL=` and a pulled `.env.local`
 * carries it as an empty string, which is *set* as far as `??` is concerned. That sent an
 * empty model id to the gateway and failed every call with an error that pointed at the
 * gateway rather than at the blank line in the env file. An unset variable and a variable
 * set to nothing mean the same thing to a reader, so they mean the same thing here.
 */
export function modelId(): string {
  return process.env.AI_MODEL?.trim() || DEFAULT_MODEL;
}

/** Ask the model for one structured answer. */
export async function inferStructure<T>(request: {
  prompt: PromptDefinition;
  schema: ZodType<T>;
  content: InferenceContent[];
}): Promise<Inference<T>> {
  try {
    const { object } = await generateObject({
      model: modelId(),
      schema: request.schema,
      system: request.prompt.system,
      messages: [{ role: "user", content: request.content }],
    });

    return { ok: true, value: object };
  } catch (error) {
    // The definition of done requires recoverable and non-recoverable failures to be
    // distinguished, and this is where the two are told apart.
    //
    // The model answered and the answer was unusable — a refusal, or output that would
    // not fit the schema. That is a fact about this document, it will not improve on a
    // retry, and the caller records it as state.
    if (NoObjectGeneratedError.isInstance(error)) {
      return { ok: false, reason: error.message };
    }

    // The model never answered: no credit card on the gateway, an expired key, a rate
    // limit, a timeout, a provider outage. That is a fact about our infrastructure and
    // says nothing about the document, so it must NOT come back as "we could not read
    // this" — that would permanently fail a perfectly good statement because billing
    // lapsed. Rethrowing lets the workflow retry and surfaces it as a failed run.
    throw error;
  }
}
