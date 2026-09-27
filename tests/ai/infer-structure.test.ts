/**
 * How long one model call may take, and what a call that ran out of time means.
 *
 * spec: docs/workflows/identifying-invoices.md §11
 *
 * The first production reconciliation made calls of up to 186 seconds, with the SDK's
 * default retries on top, inside a function Vercel kills at 300. These tests pin the bound,
 * and pin that running out of it is an infrastructure failure the workflow retries, never
 * "the model could not answer", which would be recorded against the user's data.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));

const generateObject = vi.fn();
vi.mock("ai", async (original) => ({
  ...(await original<typeof import("ai")>()),
  generateObject: (options: unknown) => generateObject(options),
}));

const { inferStructure } = await import("../../src/ai/model");

const request = {
  prompt: { id: "test", version: 1, system: "Answer." },
  schema: z.object({ answer: z.string() }),
  content: [{ type: "text" as const, text: "question" }],
};

beforeEach(() => {
  generateObject.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("one model call", () => {
  it("is bounded in time and retried at most once inside the call", async () => {
    generateObject.mockResolvedValue({ object: { answer: "yes" }, usage: {} });

    await inferStructure(request);

    const [options] = generateObject.mock.calls[0];
    expect(options.maxRetries).toBe(1);
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("logs the tokens it used beside how long it took", async () => {
    generateObject.mockResolvedValue({
      object: { answer: "yes" },
      usage: { inputTokens: 1200, outputTokens: 340 },
    });

    await inferStructure(request);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/stage=model .*inputTokens=1200 outputTokens=340 outcome=ok/),
    );
  });

  it("throws when it runs out of time, so the step is retried", async () => {
    generateObject.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));

    await expect(inferStructure(request)).rejects.toThrow("timed out");
  });
});
