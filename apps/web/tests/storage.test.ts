// Uploads on a host whose disk doesn't keep them (Vercel: read-only; Render:
// wiped on every deploy and restart) are refused with a message naming the
// Supabase variables, instead of disappearing later.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { localUploadProblem } = await import("@/lib/server/storage");

describe("local uploads", () => {
  it("are refused on Render and on Vercel without Supabase Storage, naming the variables", () => {
    const render = localUploadProblem("Render", false)!;
    expect(render).toMatch(/Render wipes/);
    expect(render).toMatch(/SUPABASE_URL/);
    expect(render).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(localUploadProblem("Vercel", false)).toMatch(/read-only/);
  });

  it("are fine on a machine that keeps its disk, or with Supabase Storage set", () => {
    expect(localUploadProblem(null, false)).toBeNull();
    expect(localUploadProblem("Render", true)).toBeNull();
    expect(localUploadProblem("Vercel", true)).toBeNull();
  });
});
