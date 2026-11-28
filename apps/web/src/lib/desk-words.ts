import { OLD_AUDIT_ACTIONS, OLD_ENV, OLD_INBOUND_ENTITY, OLD_LEDGER_SOURCE, OLD_WORD } from "@/lib/old-names";

// How rows about base.win (the desk) read on screen. Rows written before the
// rename keep their older values (src/lib/old-names.ts): they are never
// rewritten, only shown with the same words as new ones, and every filter
// finds both.

/** The consent ledger's source for a withdrawal made in base.win. */
export const DESK_SOURCE = "base.win";
/** The audit log's entity for an answer to a call from base.win. */
export const DESK_ENTITY = "desk-consent";
/** Every ledger source a withdrawal made in base.win may carry: the new one, and the older one. */
export const LEDGER_SOURCES = [DESK_SOURCE, OLD_LEDGER_SOURCE];

export function ledgerSourceLabel(source: string): string;
export function ledgerSourceLabel(source: string | null): string | null;
export function ledgerSourceLabel(source: string | null): string | null {
  return source === OLD_LEDGER_SOURCE ? DESK_SOURCE : source;
}

const OLD_TO_NEW_ACTION = new Map<string, string>(OLD_AUDIT_ACTIONS.map((a) => [a, a.replace(OLD_WORD, "desk")]));

const ACTION_WORDS: Record<string, string> = {
  "consent.desk-withdraw": "A no from base.win (the desk), applied",
  "consent.desk-grant-ignored": "A yes from base.win (the desk), answered but not applied",
  "integrations.desk-test": "base.win (the desk): connection tested",
  "integrations.desk-send": "base.win (the desk): waiting rows sent",
  "integrations.desk-retry": "base.win (the desk): a row tried again",
  "integrations.desk-skip": "base.win (the desk): a row skipped",
};

/** An audit action under its new name (an older one maps to its new one). */
export function newAuditAction(action: string): string {
  return OLD_TO_NEW_ACTION.get(action) ?? action;
}

/** The words for an audit action; old and new read the same. Others show as they are. */
export function auditActionLabel(action: string): string {
  return ACTION_WORDS[newAuditAction(action)] ?? action;
}

/** Every stored action a filter for this one should find. */
export function sameAuditActions(action: string): string[] {
  const now = newAuditAction(action);
  const older = [...OLD_TO_NEW_ACTION].filter(([, n]) => n === now).map(([o]) => o);
  return [now, ...older];
}

export function auditEntityLabel(entity: string): string;
export function auditEntityLabel(entity: string | null): string | null;
export function auditEntityLabel(entity: string | null): string | null {
  return entity === OLD_INBOUND_ENTITY ? DESK_ENTITY : entity;
}

/** Every stored entity a filter for this one (or a part of it) should find. */
export function sameAuditEntities(entity: string): string[] {
  const e = entity.trim().toLowerCase();
  if (e === OLD_INBOUND_ENTITY || e === DESK_ENTITY) return [DESK_ENTITY, OLD_INBOUND_ENTITY];
  return e && DESK_ENTITY.includes(e) ? [entity, OLD_INBOUND_ENTITY] : [entity];
}

const OLD_WORD_ANYCASE = new RegExp(OLD_WORD, "gi");

/**
 * Text kept in a row before the rename (an outbox row's last error, a ledger
 * row's wording, an audit entry), as it reads now: the older setting names,
 * labels and word become the new ones. The row itself is never changed.
 */
export function deskWords(text: string): string;
export function deskWords(text: string | null): string | null;
export function deskWords(text: string | null): string | null {
  if (!text) return text;
  let out = text;
  for (const [old, now] of OLD_TO_NEW_ACTION) out = out.replaceAll(old, now);
  out = out.replaceAll(OLD_INBOUND_ENTITY, DESK_ENTITY);
  for (const [now, old] of Object.entries(OLD_ENV)) out = out.replaceAll(old, now);
  return out.replace(OLD_WORD_ANYCASE, DESK_SOURCE);
}
