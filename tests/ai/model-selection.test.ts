/**
 * Which model gets called.
 *
 * spec: docs/architecture.md §21.2
 *
 * The provider choice is deferred to evaluation, so it is configuration rather than code
 * — which makes the way that configuration is read part of the contract.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { modelId } = await import("../../src/ai/model");

const original = process.env.AI_MODEL;

afterEach(() => {
  if (original === undefined) delete process.env.AI_MODEL;
  else process.env.AI_MODEL = original;
});

describe("the configured model", () => {
  it("uses the override when one is set", () => {
    process.env.AI_MODEL = "anthropic/claude-haiku-4.5";
    expect(modelId()).toBe("anthropic/claude-haiku-4.5");
  });

  it("falls back to the default when the variable is absent", () => {
    delete process.env.AI_MODEL;
    expect(modelId()).toBe("anthropic/claude-sonnet-5");
  });

  it("falls back when the variable is present but empty", () => {
    // .env.example ships `AI_MODEL=` and a pulled .env.local carries it as "", which `??`
    // treats as a real value. That sent an empty model id to the gateway and failed every
    // call with an error that blamed the gateway rather than the blank line.
    process.env.AI_MODEL = "";
    expect(modelId()).toBe("anthropic/claude-sonnet-5");
  });

  it("falls back when the variable is only whitespace", () => {
    process.env.AI_MODEL = "   ";
    expect(modelId()).toBe("anthropic/claude-sonnet-5");
  });
});
