/**
 * Google's token endpoint and the Gmail API, stood in for.
 *
 * `testing-strategy.md`: test the code around a third-party API, not the API. Unlike
 * `FakeGoogle`, which answers from a queue, this one routes by URL -- a search makes a token
 * call and then a list and a metadata read per message, and scripting that order by hand
 * would test the script rather than the code.
 *
 * Every request is recorded, so a test can assert what was never asked for: that the
 * search path made no full-format request, that a mailbox needing reauthorization was never
 * called.
 *
 * Gmail's query language is not reimplemented. A mailbox holds messages; a list call
 * returns those inside the query's `after:`/`before:` window, and each message says which
 * passes find it (`VENDOR`, `KEYWORD`, or both), which is what a test needs to control.
 */

import type { GmailClient } from "../../src/gmail/mail";
import type { GoogleOAuthClient } from "../../src/gmail/oauth";
import { CLIENT_ID, json } from "./fake-google";

export interface FakeMessage {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  /** When Gmail received it: `internalDate`. */
  readonly receivedAt: string;
  readonly to?: string;
  readonly rfc822MessageId?: string;
  /** Body text Google would include in a metadata response. Must never escape. */
  readonly snippet?: string;
  /** Which search passes find this message. Both, unless a test says otherwise. */
  readonly foundBy?: readonly ("VENDOR" | "KEYWORD")[];
  /** What a full-format read finds attached. */
  readonly attachments?: readonly FakeAttachment[];
  /** The message body, inline in a full-format read. Must never escape either. */
  readonly body?: string;
}

export interface FakeAttachment {
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly mimeType?: string;
}

export type Failure = Response | Error;

export class FakeGmail {
  readonly requests: URL[] = [];
  private readonly mailboxes = new Map<string, FakeMessage[]>();
  private readonly tokenFailures = new Map<string, Failure>();
  private readonly revoked = new Set<string>();
  private readonly failures: { match: (url: URL) => boolean; response: Failure; once: boolean }[] =
    [];

  /** A mailbox, reached with the access token minted from this refresh token. */
  mailbox(refreshToken: string, messages: FakeMessage[]): this {
    this.mailboxes.set(accessTokenFor(refreshToken), messages);
    return this;
  }

  /** Make the token endpoint refuse this refresh token. */
  failToken(refreshToken: string, response: Failure): this {
    this.tokenFailures.set(refreshToken, response);
    return this;
  }

  /**
   * The user revoked access after the token was minted: the token endpoint still answers,
   * and every Gmail call with the token it gave comes back 401.
   */
  revoke(refreshToken: string): this {
    this.revoked.add(accessTokenFor(refreshToken));
    return this;
  }

  /** Answer Gmail requests matching `match` with this, once or every time. */
  fail(match: (url: URL) => boolean, response: Failure, options: { once?: boolean } = {}): this {
    this.failures.push({ match, response, once: options.once ?? false });
    return this;
  }

  /** Requests made to the Gmail API, as opposed to the token endpoint. */
  gmailRequests(): URL[] {
    return this.requests.filter((url) => url.hostname === "gmail.googleapis.com");
  }

  get fetch(): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      this.requests.push(url);

      if (url.hostname === "oauth2.googleapis.com") return this.token(init);

      const failure = this.failures.find((f) => f.match(url));
      if (failure) {
        if (failure.once) this.failures.splice(this.failures.indexOf(failure), 1);
        if (failure.response instanceof Error) throw failure.response;
        return failure.response.clone();
      }

      const token = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
      if (this.revoked.has(token)) return json(401, { error: { code: 401 } });
      const messages = this.mailboxes.get(token);
      if (!messages) return json(401, { error: { code: 401 } });

      const path = url.pathname.replace("/gmail/v1/users/me/", "");
      if (path === "messages") return this.list(url, messages);

      const [, rawId, attachmentsSegment, attachmentId] = path.split("/");
      const message = messages.find((m) => m.id === decodeURIComponent(rawId ?? ""));
      if (!message) return json(404, { error: { code: 404 } });
      if (attachmentsSegment === "attachments") {
        return this.attachment(message, decodeURIComponent(attachmentId ?? ""));
      }
      return this.get(url, message);
    }) as typeof fetch;
  }

  get oauth(): GoogleOAuthClient {
    return { clientId: CLIENT_ID, clientSecret: "test-client-secret", fetch: this.fetch };
  }

  get gmail(): GmailClient {
    return { fetch: this.fetch };
  }

  private token(init?: RequestInit): Response {
    const form = new URLSearchParams(String(init?.body ?? ""));
    const refresh = form.get("refresh_token") ?? "";
    const failure = this.tokenFailures.get(refresh);
    if (failure instanceof Error) throw failure;
    if (failure) return failure.clone();
    return json(200, { access_token: accessTokenFor(refresh), expires_in: 3599 });
  }

  private list(url: URL, messages: FakeMessage[]): Response {
    const query = url.searchParams.get("q") ?? "";
    const max = Number(url.searchParams.get("maxResults") ?? "100");
    const after = Number(/after:(\d+)/.exec(query)?.[1] ?? "0") * 1000;
    const before = Number(/before:(\d+)/.exec(query)?.[1] ?? `${Number.MAX_SAFE_INTEGER}`) * 1000;
    const pass = /\(invoice OR/.test(query) ? "KEYWORD" : "VENDOR";

    const found = messages.filter((m) => {
      const at = Date.parse(m.receivedAt);
      return at >= after && at < before && (m.foundBy ?? ["VENDOR", "KEYWORD"]).includes(pass);
    });

    return json(200, {
      messages: found.slice(0, max).map((m) => ({ id: m.id, threadId: `t-${m.id}` })),
      ...(found.length > max ? { nextPageToken: "more" } : {}),
      resultSizeEstimate: found.length,
    });
  }

  /** A full-format read: the part tree, with the body inline as Gmail sends small parts. */
  private full(message: FakeMessage, headers: { name: string; value: string }[]): Response {
    const text = Buffer.from(message.body ?? "Hello, your invoice is attached.").toString(
      "base64url",
    );
    return json(200, {
      id: message.id,
      snippet: "Hello, your invoice is attached.",
      payload: {
        partId: "",
        mimeType: "multipart/mixed",
        filename: "",
        headers,
        body: { size: 0 },
        parts: [
          {
            partId: "0",
            mimeType: "multipart/alternative",
            filename: "",
            body: { size: 0 },
            parts: [
              {
                partId: "0.0",
                mimeType: "text/plain",
                filename: "",
                body: { size: 40, data: text },
              },
              {
                partId: "0.1",
                mimeType: "text/html",
                filename: "",
                body: { size: 60, data: text },
              },
            ],
          },
          ...(message.attachments ?? []).map((attachment, index) => ({
            partId: String(index + 1),
            mimeType: attachment.mimeType ?? "application/pdf",
            filename: attachment.filename,
            body: {
              // Fresh on every read, as Gmail's are: never a stable identity.
              attachmentId: `att-${message.id}-${index}-${(this.reads += 1)}`,
              size: attachment.bytes.length,
            },
          })),
        ],
      },
    });
  }

  private reads = 0;

  private attachment(message: FakeMessage, attachmentId: string): Response {
    const index = Number(/^att-[^]*?-(\d+)-\d+$/.exec(attachmentId)?.[1] ?? "-1");
    const attachment = message.attachments?.[index];
    if (!attachment) return json(404, { error: { code: 404 } });
    return json(200, {
      size: attachment.bytes.length,
      data: Buffer.from(attachment.bytes).toString("base64url"),
    });
  }

  private get(url: URL, message: FakeMessage): Response {
    const headers = [
      { name: "From", value: message.from },
      { name: "To", value: message.to ?? "owner@business.in" },
      { name: "Subject", value: message.subject },
      { name: "Date", value: new Date(message.receivedAt).toUTCString() },
      ...(message.rfc822MessageId ? [{ name: "Message-ID", value: message.rfc822MessageId }] : []),
    ];

    const format = url.searchParams.get("format");
    if (format === "full") return this.full(message, headers);
    if (format !== "metadata") return json(400, { error: { code: 400 } });

    return json(200, {
      id: message.id,
      threadId: `t-${message.id}`,
      labelIds: ["INBOX"],
      snippet: message.snippet ?? "Dear customer, please find attached",
      internalDate: String(Date.parse(message.receivedAt)),
      payload: { mimeType: "multipart/mixed", headers },
    });
  }
}

/** Requests for a message's full contents or its attachments: everything past metadata. */
export function contentRequests(requests: URL[]): URL[] {
  return requests.filter(
    (url) => url.searchParams.get("format") === "full" || url.pathname.includes("/attachments/"),
  );
}

export function accessTokenFor(refreshToken: string): string {
  return `access:${refreshToken}`;
}
