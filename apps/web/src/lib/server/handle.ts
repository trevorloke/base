import "server-only";
import { error } from "./api";
import { UserFacingError } from "./payments";
import { clientProfile } from "@/seeds/client";

/** Turn thrown errors into JSON responses; log anything unexpected. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UserFacingError) return error(err.message, 422, err.fields);
    console.error(err);
    return error(`Something went wrong on our end. Please try again, or email ${clientProfile.email}.`, 500);
  }
}
