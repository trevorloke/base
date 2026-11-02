import { randomUUID } from "node:crypto";

/** Prefixed ids: readable in logs, unambiguous in the ledger. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}
