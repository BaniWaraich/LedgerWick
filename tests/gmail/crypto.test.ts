/**
 * Refresh tokens are encrypted before they are stored.
 *
 * spec: docs/workflows/connect-gmail.md §6
 */

import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { GmailTokenDecryptError, GmailTokenKeyError, decryptToken, encryptToken, readTokenKey } =
  await import("../../src/gmail/crypto");

const key = randomBytes(32);
const binding = { workspaceId: "11111111-1111-1111-1111-111111111111", googleSubject: "1001" };
const token = "1//0gRefreshTokenThatGrantsReadAccessToAMailbox";

describe("a stored refresh token", () => {
  it("decrypts to the token that was encrypted", () => {
    expect(decryptToken(encryptToken(token, binding, key), binding, key)).toBe(token);
  });

  it("does not contain the token", () => {
    const stored = encryptToken(token, binding, key);

    expect(stored).not.toContain(token);
    expect(stored).not.toContain(Buffer.from(token).toString("base64url"));
  });

  it("differs every time, even for the same token", () => {
    expect(encryptToken(token, binding, key)).not.toBe(encryptToken(token, binding, key));
  });

  it("does not decrypt once altered", () => {
    const [version, iv, ciphertext, tag] = encryptToken(token, binding, key).split(":");
    const flipped = Buffer.from(ciphertext, "base64url");
    flipped[0] ^= 1;
    const altered = [version, iv, flipped.toString("base64url"), tag].join(":");

    expect(() => decryptToken(altered, binding, key)).toThrow(GmailTokenDecryptError);
  });

  it("does not decrypt under another key", () => {
    const stored = encryptToken(token, binding, key);

    expect(() => decryptToken(stored, binding, randomBytes(32))).toThrow(GmailTokenDecryptError);
  });

  it("does not decrypt for another workspace's connection", () => {
    // Copying a ciphertext from one workspace's row into another's must not hand the
    // second workspace the first one's mailbox.
    const stored = encryptToken(token, binding, key);
    const elsewhere = { ...binding, workspaceId: "22222222-2222-2222-2222-222222222222" };

    expect(() => decryptToken(stored, elsewhere, key)).toThrow(GmailTokenDecryptError);
  });

  it("does not decrypt for another google account", () => {
    const stored = encryptToken(token, binding, key);

    expect(() => decryptToken(stored, { ...binding, googleSubject: "1002" }, key)).toThrow(
      GmailTokenDecryptError,
    );
  });

  it("refuses something that was never one", () => {
    expect(() => decryptToken(token, binding, key)).toThrow(GmailTokenDecryptError);
  });
});

describe("the token key", () => {
  it("is read from GMAIL_TOKEN_KEY", () => {
    const encoded = key.toString("base64");

    expect(readTokenKey({ GMAIL_TOKEN_KEY: encoded }).equals(key)).toBe(true);
  });

  it("is refused when missing", () => {
    expect(() => readTokenKey({})).toThrow(GmailTokenKeyError);
    expect(() => readTokenKey({ GMAIL_TOKEN_KEY: "  " })).toThrow(GmailTokenKeyError);
  });

  it("is refused when it is not 32 bytes", () => {
    expect(() => readTokenKey({ GMAIL_TOKEN_KEY: randomBytes(16).toString("base64") })).toThrow(
      /16 bytes/,
    );
  });

  it("is refused when it is not base64", () => {
    expect(() => readTokenKey({ GMAIL_TOKEN_KEY: "not a key!" })).toThrow(GmailTokenKeyError);
  });

  it("never appears in the error that refuses it", () => {
    const wrong = randomBytes(24).toString("base64");

    expect(() => readTokenKey({ GMAIL_TOKEN_KEY: wrong })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(wrong) }),
    );
  });

  it("is not needed to import the module", async () => {
    // A build, or a page that never touches mail, must not need the key.
    vi.resetModules();
    const saved = process.env.GMAIL_TOKEN_KEY;
    delete process.env.GMAIL_TOKEN_KEY;
    try {
      await expect(import("../../src/gmail/crypto")).resolves.toBeDefined();
    } finally {
      if (saved !== undefined) process.env.GMAIL_TOKEN_KEY = saved;
    }
  });
});
