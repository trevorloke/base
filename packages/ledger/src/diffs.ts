import { approvalDiffs, type Db } from "@meridian/db";
import type { Actor } from "@meridian/schema";
import { newId } from "./ids.ts";

/** Records what a human changed in a draft. Every row is a labeled example of "closer to our voice". */
export class ApprovalDiffs {
  constructor(private readonly db: Db) {}

  async record(params: {
    workspaceId: string;
    postId: string;
    variantId: string | null;
    beforeText: string;
    afterText: string;
    draftedBy: Actor;
    editedBy: Actor;
  }): Promise<string | null> {
    if (params.beforeText === params.afterText) return null;
    const id = newId("diff");
    await this.db.insert(approvalDiffs).values({ id, ...params });
    return id;
  }
}
