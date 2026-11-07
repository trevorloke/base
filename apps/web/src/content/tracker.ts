// The promise tracker's fixed copy, for the client this site is built for
// (src/seeds/client.ts). Statuses and updates live in the database.
import * as neutral from "@/seeds/default/tracker";
import * as imagineSurrey from "@/seeds/imagine-surrey/tracker";
import { CLIENT_ID } from "@/seeds/client";

export type { KeyDate } from "@/seeds/imagine-surrey/tracker";

const copy = CLIENT_ID === "imagine-surrey" ? imagineSurrey : neutral;

export const { trackerIntro, trackerHighlights, scoringNote, keyDates, termStart, termEnd, sourcesNote, sourceGroups, methodology, followCopy, embedCopy, councilLetter, councilContactUrl } = copy;
