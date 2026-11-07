import { describe, expect, it } from "vitest";
import { adminPreviewAllowed } from "@/lib/preview-mode";

const local = { ADMIN_PREVIEW_MODE: "1", DATABASE_URL: "postgres://u:p@localhost:5432/imagine_surrey" };

describe("admin preview mode", () => {
  it("is on only when asked for, with a database on this machine", () => {
    expect(adminPreviewAllowed(local)).toBe(true);
    expect(adminPreviewAllowed({ ...local, DATABASE_URL: "postgres://u:p@127.0.0.1/x" })).toBe(true);
    expect(adminPreviewAllowed({ ...local, ADMIN_PREVIEW_MODE: undefined })).toBe(false);
    expect(adminPreviewAllowed({ ...local, ADMIN_PREVIEW_MODE: "true" })).toBe(false);
  });
  it("never switches on against a remote database", () => {
    expect(adminPreviewAllowed({ ...local, DATABASE_URL: "postgres://u:p@aws-0-ca-central-1.pooler.supabase.com:6543/postgres" })).toBe(false);
    expect(adminPreviewAllowed({ ...local, DATABASE_URL: "postgres://u:p@localhost.evil.example/x" })).toBe(false);
    expect(adminPreviewAllowed({ ...local, DATABASE_URL: undefined })).toBe(false);
  });
  it("never switches on on a hosted deploy, even with a local database", () => {
    expect(adminPreviewAllowed({ ...local, VERCEL_ENV: "production" })).toBe(false);
    expect(adminPreviewAllowed({ ...local, VERCEL: "1" })).toBe(false);
    expect(adminPreviewAllowed({ ...local, RENDER: "true" })).toBe(false);
  });
});
