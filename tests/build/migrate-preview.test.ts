import { describe, expect, it } from "vitest";

import { decide } from "../../scripts/migrate-preview";

const PREVIEW_HOST = "ep-preview.c-4.ap-southeast-1.aws.neon.tech";
const PREVIEW = {
  VERCEL_ENV: "preview",
  DATABASE_URL_UNPOOLED: `postgresql://owner@${PREVIEW_HOST}/neondb?sslmode=require`,
  PREVIEW_DATABASE_HOST: PREVIEW_HOST,
};

describe("migrate-preview", () => {
  it("leaves production alone; CI migrates production", () => {
    expect(decide({ ...PREVIEW, VERCEL_ENV: "production" }).action).toBe("skip");
  });

  it("does nothing outside Vercel, in CI or on a laptop", () => {
    expect(decide({ ...PREVIEW, VERCEL_ENV: undefined }).action).toBe("skip");
  });

  it("migrates a Preview build pointed at the Preview database", () => {
    expect(decide(PREVIEW)).toEqual({
      action: "migrate",
      url: PREVIEW.DATABASE_URL_UNPOOLED,
      host: PREVIEW_HOST,
    });
  });

  it("refuses a Preview build pointed anywhere else", () => {
    const production = "postgresql://owner@ep-production.c-4.ap-southeast-1.aws.neon.tech/neondb";
    expect(decide({ ...PREVIEW, DATABASE_URL_UNPOOLED: production }).action).toBe("fail");
  });

  it("refuses the pooled host even for the Preview database", () => {
    const pooled = PREVIEW.DATABASE_URL_UNPOOLED.replace("ep-preview", "ep-preview-pooler");
    expect(decide({ ...PREVIEW, DATABASE_URL_UNPOOLED: pooled }).action).toBe("fail");
  });

  it("refuses when the Preview database is not configured", () => {
    expect(decide({ ...PREVIEW, DATABASE_URL_UNPOOLED: undefined }).action).toBe("fail");
    expect(decide({ ...PREVIEW, PREVIEW_DATABASE_HOST: undefined }).action).toBe("fail");
  });

  it("refuses a malformed URL rather than guessing its host", () => {
    expect(decide({ ...PREVIEW, DATABASE_URL_UNPOOLED: "not a url" }).action).toBe("fail");
  });
});
