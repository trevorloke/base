import "server-only";
import { revalidatePath, revalidateTag, unstable_cache } from "next/cache";

/**
 * Public pages read through this cache, so a visit costs no database query.
 * Entries live for an hour and are thrown away the moment an admin changes
 * the data they came from (see `invalidate`). Tag every cached loader with
 * the tags of the data it reads.
 */
export const TAGS = {
  settings: "settings",
  brand: "brand",
  pages: "pages",
  news: "news",
  events: "events",
  products: "products",
  tracker: "tracker",
  counters: "counters",
} as const;

export type Tag = (typeof TAGS)[keyof typeof TAGS];

export const CACHE_SECONDS = 3600;

/**
 * Wrap a loader. `key` must be unique per loader; the loader's arguments are
 * added to the cache key automatically. Loaders must not read cookies,
 * headers or `connection()`: take any request-specific value as an argument.
 */
export function cached<A extends unknown[], R>(key: string, tags: Tag[], fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return unstable_cache(fn, [key], { tags, revalidate: CACHE_SECONDS });
}

/** Call from a server action or route handler after writing data the public site shows. */
export function invalidate(...tags: Tag[]) {
  for (const tag of tags) revalidateTag(tag, { expire: 0 });
  // Static pages are regenerated on their next visit.
  revalidatePath("/", "layout");
}
