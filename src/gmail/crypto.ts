/**
 * Encrypting a Gmail refresh token before it is stored.
 *
 * spec: docs/workflows/connect-gmail.md §6 — "Tokens are encrypted at rest and never stored
 * in plaintext."
 *
 * AES-256-GCM from `node:crypto`: authenticated, so a ciphertext that has been altered or
 * moved fails to decrypt rather than decrypting to something else, and no dependency is
 * needed to get it.
 *
 * Each ciphertext is bound to the connection it was written for — its workspace and Google
 * account — as additional authenticated data. Someone able to write the database could
 * otherwise copy workspace A's token into workspace B's row and have B read A's mail; with
 * the binding, the copy does not decrypt.
 *
 * The key is `GMAIL_TOKEN_KEY`, 32 random bytes in base64. It is read when a token is
 * encrypted or decrypted and not when this module is imported, so a build — or a page that
 * never touches mail — does not need it.
 */

import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * A refresh token as it is stored: encrypted, never the token itself.
 *
 * A brand, so a column write that is handed a plaintext string is a compile error.
 * `encryptToken` is the only thing that mints one; `tests/gmail/boundary.test.ts` bans the
 * cast that would forge it.
 */
export type EncryptedToken = string & { readonly __encryptedToken: unique symbol };

/** Which connection a ciphertext belongs to. Part of what it is authenticated against. */
export type TokenBinding = { workspaceId: string; googleSubject: string };

/**
 * The key is missing or malformed.
 *
 * The message says what is wrong with the key and never contains it. A misconfigured key
 * is an operator's problem and must fail loudly, not quietly write something nobody can
 * read back.
 */
export class GmailTokenKeyError extends Error {
  constructor(reason: string) {
    super(`GMAIL_TOKEN_KEY ${reason}. Set it to 32 random bytes, base64-encoded.`);
    this.name = "GmailTokenKeyError";
  }
}

/** A stored token that does not decrypt: altered, moved, or written under another key. */
export class GmailTokenDecryptError extends Error {
  constructor() {
    super("A stored Gmail token could not be decrypted");
    this.name = "GmailTokenDecryptError";
  }
}

/** The version prefix. A future key rotation writes `v2:` beside it; nothing reads one yet. */
const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * The encryption key, from the environment, validated.
 *
 * `env` is a parameter so the validation can be tested without mutating `process.env`.
 */
export function readTokenKey(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env.GMAIL_TOKEN_KEY?.trim();
  if (!raw) throw new GmailTokenKeyError("is not set");

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new GmailTokenKeyError("is not base64");

  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new GmailTokenKeyError(`decodes to ${key.length} bytes, not ${KEY_BYTES}`);
  }

  return key;
}

function associatedData(binding: TokenBinding): Buffer {
  return Buffer.from(`gmail-connection:${binding.workspaceId}:${binding.googleSubject}`, "utf8");
}

export function encryptToken(
  plaintext: string,
  binding: TokenBinding,
  key: Buffer = readTokenKey(),
): EncryptedToken {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(associatedData(binding));

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const encoded = [VERSION, iv, ciphertext, tag]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(":");

  // The one cast that mints an EncryptedToken, in the one function that encrypts.
  return encoded as EncryptedToken;
}

export function decryptToken(
  stored: string,
  binding: TokenBinding,
  key: Buffer = readTokenKey(),
): string {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new GmailTokenDecryptError();

  const [, iv, ciphertext, tag] = parts.map((part) => Buffer.from(part, "base64url"));
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new GmailTokenDecryptError();

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(associatedData(binding));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // Node's own message is safe, but a single error type keeps every caller from having
    // to tell "wrong key" from "tampered" -- to the caller they are the same fact.
    throw new GmailTokenDecryptError();
  }
}
