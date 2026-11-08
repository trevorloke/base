// The clients Base Web knows how to start up as. BASE_WEB_CLIENT picks one;
// unset (or unknown) means "default", a clean, neutral site.
import { client as defaultClient } from "./default";
import { client as imagineSurrey } from "./imagine-surrey";
import type { ClientSeed } from "./types";

export type { ClientSeed } from "./types";

export const CLIENTS = { default: defaultClient, "imagine-surrey": imagineSurrey } as const satisfies Record<string, ClientSeed>;
export type ClientId = keyof typeof CLIENTS;

export function isClientId(value: unknown): value is ClientId {
  return typeof value === "string" && Object.hasOwn(CLIENTS, value);
}

/** The client for a BASE_WEB_CLIENT value. */
export function clientFor(value: string | undefined): ClientSeed {
  if (value && !isClientId(value)) console.error(`BASE_WEB_CLIENT="${value}" isn't a known client (${Object.keys(CLIENTS).join(", ")}); using "default".`);
  return CLIENTS[isClientId(value) ? value : "default"];
}
