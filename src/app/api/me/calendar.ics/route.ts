import { getDb } from "@/lib/db";
import { icsCalendar } from "@/lib/ics";
import { error } from "@/lib/server/api";
import { getMember } from "@/lib/server/member-auth";
import { calendarEvents } from "@/lib/server/portal";

/** The supporter's upcoming shifts and events as a calendar file. */
export async function GET() {
  const person = await getMember();
  if (!person) return error("Sign in to download your calendar.", 401);
  const body = icsCalendar(await calendarEvents(getDb(), person.id), "Imagine Surrey: my shifts and events");
  return new Response(body, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'attachment; filename="imagine-surrey.ics"',
      "cache-control": "private, no-store",
    },
  });
}
