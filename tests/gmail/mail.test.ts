/**
 * Reading a mailbox: what the Gmail module asks for, and what it lets out.
 *
 * spec: docs/workflows/connect-gmail.md §5, §8 · docs/workflows/retrieve-invoices.md §18
 */

import { describe, expect, it, vi } from "vitest";

import { json } from "./fake-google";
import { accessTokenFor, FakeGmail } from "./fake-gmail";

vi.mock("server-only", () => ({}));

const { GmailApiError, attachmentsOf, downloadAttachment, messageMetadata, searchMessages } =
  await import("../../src/gmail/mail");

const TOKEN = accessTokenFor("r1");

const message = {
  id: "m1",
  from: '"Anthropic, PBC" <invoice+statements@mail.anthropic.com>',
  subject: "Your receipt from Anthropic, PBC #2231-9912",
  receivedAt: "2026-04-14T08:30:00Z",
  rfc822MessageId: "<abc@mail.anthropic.com>",
  snippet: "Receipt #2231-9912 Amount paid $20.00 — card ending 4242",
};

function mailbox() {
  return new FakeGmail().mailbox("r1", [message]);
}

/** Every key anywhere in a value, however deep. */
function keysOf(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
}

describe("searching", () => {
  it("asks for message ids and nothing else", async () => {
    const fake = mailbox();

    const result = await searchMessages(fake.gmail, TOKEN, "has:attachment", 10);

    expect(result).toEqual({ messageIds: ["m1"], truncated: false });
    const [request] = fake.gmailRequests();
    expect(request.pathname).toBe("/gmail/v1/users/me/messages");
    expect(request.searchParams.get("format")).toBeNull();
  });

  it("says when Google had more than it was asked for", async () => {
    const fake = new FakeGmail().mailbox("r1", [
      message,
      { ...message, id: "m2" },
      { ...message, id: "m3" },
    ]);

    const result = await searchMessages(fake.gmail, TOKEN, "has:attachment", 2);

    expect(result.truncated).toBe(true);
    expect(result.messageIds).toHaveLength(2);
  });

  it("treats an empty mailbox as an answer, not an error", async () => {
    const fake = new FakeGmail().mailbox("r1", []);

    await expect(searchMessages(fake.gmail, TOKEN, "has:attachment", 10)).resolves.toEqual({
      messageIds: [],
      truncated: false,
    });
  });
});

describe("reading a message's headers", () => {
  it("requests metadata format, naming the headers it reads", async () => {
    const fake = mailbox();

    await messageMetadata(fake.gmail, TOKEN, "m1");

    const [request] = fake.gmailRequests();
    expect(request.searchParams.get("format")).toBe("metadata");
    expect(request.searchParams.getAll("metadataHeaders")).toEqual([
      "From",
      "To",
      "Subject",
      "Date",
      "Message-ID",
    ]);
  });

  it("returns the headers and when the message arrived", async () => {
    const metadata = await messageMetadata(mailbox().gmail, TOKEN, "m1");

    expect(metadata).toEqual({
      id: "m1",
      from: message.from,
      to: "owner@business.in",
      subject: message.subject,
      rfc822MessageId: "<abc@mail.anthropic.com>",
      receivedAt: new Date("2026-04-14T08:30:00Z"),
    });
  });

  it("lets no part of the body out, not even Google's snippet", async () => {
    // spec: connect-gmail §5 — "Message bodies are never persisted and never sent to an LLM."
    const metadata = await messageMetadata(mailbox().gmail, TOKEN, "m1");

    expect(keysOf(metadata)).not.toContain("snippet");
    expect(keysOf(metadata)).not.toContain("payload");
    expect(JSON.stringify(metadata)).not.toContain("card ending 4242");
  });
});

describe("failures", () => {
  const kindOf = async (response: Response | Error) => {
    const fake = mailbox().fail(() => true, response);
    try {
      await searchMessages(fake.gmail, TOKEN, "x", 10);
    } catch (error) {
      expect(error).toBeInstanceOf(GmailApiError);
      return (error as InstanceType<typeof GmailApiError>).kind;
    }
    throw new Error("expected a failure");
  };

  it("reads a 401 as the grant being gone", async () => {
    expect(await kindOf(json(401, { error: { code: 401 } }))).toBe("reauth");
  });

  it("reads a 403 for a missing permission as the grant being gone", async () => {
    const forbidden = json(403, {
      error: { code: 403, errors: [{ reason: "insufficientPermissions" }] },
    });
    expect(await kindOf(forbidden)).toBe("reauth");
  });

  it("reads a rate limit as transient, whether 429 or 403", async () => {
    // connect-gmail §8: rate limiting must never mark a connection broken.
    expect(await kindOf(json(429, {}))).toBe("transient");
    const limited = json(403, {
      error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }] },
    });
    expect(await kindOf(limited)).toBe("transient");
  });

  it("reads a 5xx and a dropped connection as transient", async () => {
    expect(await kindOf(json(503, {}))).toBe("transient");
    expect(await kindOf(new TypeError("fetch failed"))).toBe("transient");
  });

  it("reads a 404 as the message being gone", async () => {
    const fake = mailbox();
    await expect(messageMetadata(fake.gmail, TOKEN, "deleted")).rejects.toMatchObject({
      kind: "gone",
    });
  });

  it("never repeats what Google said", async () => {
    const leaky = json(400, { error: { message: "token access:r1 is malformed" } });
    const fake = mailbox().fail(() => true, leaky);

    const error = await searchMessages(fake.gmail, TOKEN, "x", 10).catch((e: Error) => e);

    expect((error as Error).message).toBe("Gmail API failed: config");
  });
});

describe("reading a selected message's attachments", () => {
  const pdf = new TextEncoder().encode("%PDF-1.7 Anthropic receipt 2231-9912 $20.00");
  const withAttachments = {
    ...message,
    body: "Hi Priya, card ending 4242 was charged $20.00 for Claude Pro.",
    attachments: [
      { filename: "Receipt-2231-9912.pdf", bytes: pdf },
      { filename: "logo.png", bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" },
    ],
  };

  it("lists the attachments and nothing of the body", async () => {
    // spec: connect-gmail §5 — full content is fetched only to reach an attachment, and
    // the body is never let out.
    const fake = new FakeGmail().mailbox("r1", [withAttachments]);

    const refs = await attachmentsOf(fake.gmail, TOKEN, "m1");

    expect(refs.map((r) => [r.filename, r.mimeType, r.size])).toEqual([
      ["Receipt-2231-9912.pdf", "application/pdf", pdf.length],
      ["logo.png", "image/png", 3],
    ]);
    expect(keysOf(refs)).not.toContain("data");
    expect(JSON.stringify(refs)).not.toContain("Y2FyZCBlbmRpbmcgNDI0Mg");
    expect(JSON.stringify(refs)).not.toContain("card ending 4242");
  });

  it("asks for the full format, the one place anything does", async () => {
    const fake = new FakeGmail().mailbox("r1", [withAttachments]);

    await attachmentsOf(fake.gmail, TOKEN, "m1");

    expect(fake.gmailRequests().map((u) => u.searchParams.get("format"))).toEqual(["full"]);
  });

  it("downloads an attachment's bytes exactly", async () => {
    const fake = new FakeGmail().mailbox("r1", [withAttachments]);
    const [ref] = await attachmentsOf(fake.gmail, TOKEN, "m1");

    const bytes = await downloadAttachment(fake.gmail, TOKEN, "m1", ref.attachmentId);

    expect(Buffer.from(bytes).equals(Buffer.from(pdf))).toBe(true);
  });
});
