// Turns a settings section's zod schema into a plain description the admin
// form can render, and converts values between the form's state and the JSON
// the schema parses. Pure, so the round trip is unit tested.
import type { z } from "zod";
import { humanize } from "./fields";

export type FieldSpec =
  | { kind: "text"; max?: number; multiline: boolean; format?: "email"; optional: boolean }
  | { kind: "number"; integer: boolean; min?: number; max?: number; optional: boolean }
  | { kind: "boolean"; optional: boolean }
  | { kind: "enum"; options: string[]; optional: boolean }
  | { kind: "image"; optional: boolean }
  | { kind: "list"; item: FieldSpec; min?: number; max?: number; optional: boolean }
  | { kind: "group"; fields: GroupField[]; optional: boolean }
  | { kind: "unknown"; optional: boolean };

export type GroupField = { key: string; label: string; description?: string; spec: FieldSpec };

export type ImageValue = { url: string; alt: string };

/** Text fields longer than this get a textarea. */
export const TEXTAREA_FROM = 120;

type Check = { check?: string; maximum?: number; minimum?: number; format?: string; inclusive?: boolean };
type Def = {
  type: string;
  innerType?: z.ZodType;
  element?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  entries?: Record<string, string>;
  checks?: { _zod?: { def?: Check }; def?: Check }[];
};

function defOf(schema: z.ZodType): Def {
  return schema.def as unknown as Def;
}

function checksOf(def: Def): Check[] {
  return (def.checks ?? []).map((c) => c._zod?.def ?? c.def ?? {});
}

/** Strip default/optional/nullable wrappers; remember whether the value may be left out. */
function unwrap(schema: z.ZodType): { inner: z.ZodType; optional: boolean } {
  let current = schema;
  let optional = false;
  for (let i = 0; i < 10; i++) {
    const def = defOf(current);
    if ((def.type === "default" || def.type === "optional" || def.type === "nullable" || def.type === "nonoptional" || def.type === "catch" || def.type === "readonly") && def.innerType) {
      if (def.type === "optional" || def.type === "nullable") optional = true;
      current = def.innerType;
      continue;
    }
    break;
  }
  return { inner: current, optional };
}

function describeInner(schema: z.ZodType, optional: boolean): FieldSpec {
  const def = defOf(schema);
  const checks = checksOf(def);
  switch (def.type) {
    case "string": {
      const max = checks.find((c) => c.check === "max_length")?.maximum;
      const format = checks.some((c) => c.check === "string_format" && c.format === "email") || (def as { format?: string }).format === "email" ? "email" : undefined;
      return { kind: "text", max, multiline: max !== undefined && max > TEXTAREA_FROM, format, optional };
    }
    case "number": {
      const integer = checks.some((c) => c.check === "number_format" && /int/.test(c.format ?? ""));
      const min = checks.find((c) => c.check === "greater_than")?.minimum;
      const max = checks.find((c) => c.check === "less_than")?.maximum;
      return { kind: "number", integer, min, max, optional };
    }
    case "boolean":
      return { kind: "boolean", optional };
    case "enum":
      return { kind: "enum", options: Object.values(def.entries ?? {}).map(String), optional };
    case "array": {
      const item = def.element ? describeSchema(def.element) : ({ kind: "unknown", optional: false } as FieldSpec);
      const min = checks.find((c) => c.check === "min_length")?.minimum;
      const max = checks.find((c) => c.check === "max_length")?.maximum;
      return { kind: "list", item, min, max, optional };
    }
    case "object": {
      const shape = def.shape ?? {};
      const keys = Object.keys(shape);
      if (keys.length === 2 && keys.includes("url") && keys.includes("alt")) return { kind: "image", optional };
      return {
        kind: "group",
        optional,
        fields: keys.map((key) => ({ key, label: humanize(key), description: (shape[key] as { description?: string }).description, spec: describeSchema(shape[key]) })),
      };
    }
    default:
      return { kind: "unknown", optional };
  }
}

/** The form description for a schema (usually a section's z.object). */
export function describeSchema(schema: z.ZodType): FieldSpec {
  const { inner, optional } = unwrap(schema);
  return describeInner(inner, optional);
}

/** A blank value for a field, as the form holds it. */
export function emptyValue(spec: FieldSpec): unknown {
  switch (spec.kind) {
    case "text":
    case "enum":
      return "";
    case "number":
      return "";
    case "boolean":
      return false;
    case "image":
      return { url: "", alt: "" };
    case "list":
      return [];
    case "group":
      return Object.fromEntries(spec.fields.map((f) => [f.key, emptyValue(f.spec)]));
    default:
      return "";
  }
}

/** The stored (or default) JSON → the form's state: every key present, blanks filled in. */
export function toFormState(spec: FieldSpec, value: unknown): unknown {
  switch (spec.kind) {
    case "text":
    case "enum":
      return typeof value === "string" ? value : value == null ? "" : String(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : "";
    case "boolean":
      return value === true;
    case "image": {
      const v = (value ?? {}) as Partial<ImageValue>;
      return { url: typeof v.url === "string" ? v.url : "", alt: typeof v.alt === "string" ? v.alt : "" };
    }
    case "list":
      return Array.isArray(value) ? value.map((item) => toFormState(spec.item, item)) : [];
    case "group": {
      const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
      return Object.fromEntries(spec.fields.map((f) => [f.key, toFormState(f.spec, v[f.key])]));
    }
    default:
      return typeof value === "string" ? value : JSON.stringify(value ?? null);
  }
}

function isBlank(spec: FieldSpec, value: unknown): boolean {
  switch (spec.kind) {
    case "text":
    case "enum":
    case "number":
      return value === "" || value == null;
    case "boolean":
      return value !== true;
    case "image": {
      const v = (value ?? {}) as Partial<ImageValue>;
      return !v.url && !v.alt;
    }
    case "list":
      return !Array.isArray(value) || value.length === 0;
    case "group": {
      const v = (value ?? {}) as Record<string, unknown>;
      return spec.fields.every((f) => isBlank(f.spec, v[f.key]));
    }
    default:
      return value === "" || value == null;
  }
}

/** The form's state → the JSON the schema parses. Optional fields left blank are omitted. */
export function toJson(spec: FieldSpec, value: unknown): unknown {
  if (spec.optional && isBlank(spec, value)) return undefined;
  switch (spec.kind) {
    case "text":
    case "enum":
      return typeof value === "string" ? value : "";
    case "number": {
      if (value === "" || value == null) return undefined;
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? n : value;
    }
    case "boolean":
      return value === true;
    case "image": {
      const v = (value ?? {}) as Partial<ImageValue>;
      return { url: v.url ?? "", alt: v.alt ?? "" };
    }
    case "list":
      return Array.isArray(value) ? value.map((item) => toJson(spec.item, item)) : [];
    case "group": {
      const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const f of spec.fields) {
        const converted = toJson(f.spec, v[f.key]);
        if (converted !== undefined) out[f.key] = converted;
      }
      return out;
    }
    default:
      if (typeof value !== "string") return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
  }
}

/** Every kind of field the spec uses, so a test can check the renderer covers them. */
export function fieldKinds(spec: FieldSpec, into = new Set<string>()): Set<string> {
  into.add(spec.kind);
  if (spec.kind === "list") fieldKinds(spec.item, into);
  if (spec.kind === "group") for (const f of spec.fields) fieldKinds(f.spec, into);
  return into;
}

/** Immutable update of a nested value at a path of keys and indexes. */
export function setAtPath(root: unknown, path: (string | number)[], next: unknown): unknown {
  if (path.length === 0) return next;
  const [head, ...rest] = path;
  if (Array.isArray(root)) {
    const copy = root.slice();
    copy[Number(head)] = setAtPath(copy[Number(head)], rest, next);
    return copy;
  }
  const obj = { ...((root ?? {}) as Record<string, unknown>) };
  obj[String(head)] = setAtPath(obj[String(head)], rest, next);
  return obj;
}

export function getAtPath(root: unknown, path: (string | number)[]): unknown {
  let current = root;
  for (const key of path) {
    if (current == null) return undefined;
    current = (current as Record<string, unknown>)[String(key)];
  }
  return current;
}
