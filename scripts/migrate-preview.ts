/**
 * Migrate the Preview database before a Preview build.
 *
 * Runs as the first half of `npm run build`, so it runs everywhere a build does: Vercel
 * Production, Vercel Preview, CI's `verify` job, a laptop. It does something only on a
 * Vercel Preview build. Production is migrated by CI's `migrate` job and nowhere else
 * (.github/workflows/README.md); this script must never become a second way in.
 *
 * The host check is an allowlist, not a denylist. Preview once resolved to the production
 * database without anyone noticing (docs/decisions/0013), so a Preview build refuses to
 * migrate anything but the one host it was told is the Preview database.
 */

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

type Env = Record<string, string | undefined>;

export type Decision =
  | { action: "skip"; reason: string }
  | { action: "fail"; reason: string }
  | { action: "migrate"; url: string; host: string };

export function decide(env: Env): Decision {
  if (env.VERCEL_ENV !== "preview") {
    return {
      action: "skip",
      reason: `not a Vercel Preview build (VERCEL_ENV=${env.VERCEL_ENV ?? "unset"})`,
    };
  }

  const url = env.DATABASE_URL_UNPOOLED;
  const expected = env.PREVIEW_DATABASE_HOST;
  if (!url) return { action: "fail", reason: "DATABASE_URL_UNPOOLED is not set for Preview" };
  if (!expected) return { action: "fail", reason: "PREVIEW_DATABASE_HOST is not set for Preview" };

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { action: "fail", reason: "DATABASE_URL_UNPOOLED is not a valid URL" };
  }
  if (host !== expected) {
    return {
      action: "fail",
      reason: `DATABASE_URL_UNPOOLED points at ${host}, not the Preview database ${expected}`,
    };
  }

  return { action: "migrate", url, host };
}

function main() {
  const decision = decide(process.env);
  switch (decision.action) {
    case "skip":
      console.log(`migrate-preview: skipped, ${decision.reason}`);
      return;
    case "fail":
      console.error(`migrate-preview: refusing to build, ${decision.reason}`);
      process.exit(1);
    case "migrate":
      console.log(`migrate-preview: applying migrations to ${decision.host}`);
      // Unpooled: Neon's pooler is not reliable for DDL. drizzle.config.ts reads DATABASE_URL,
      // so the direct URL is handed over under that name for this one command.
      execFileSync("npx", ["drizzle-kit", "migrate"], {
        stdio: "inherit",
        env: { ...process.env, DATABASE_URL: decision.url },
      });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
