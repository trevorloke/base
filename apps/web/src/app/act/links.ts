// Share links for a campaign page. Each channel's link carries its own
// ?source=share-<channel> tag so sign-ups can be credited to where the link
// was shared. Pure, shared by the page, the success card and tests.
import { shareLinks, withSource, type ShareLinks } from "@/lib/share";

export type ShareChannel = keyof ShareLinks;

export const SHARE_CHANNELS: { key: ShareChannel; label: string }[] = [
  { key: "whatsapp", label: "WhatsApp" },
  { key: "sms", label: "Text message" },
  { key: "facebook", label: "Facebook" },
  { key: "x", label: "X" },
  { key: "email", label: "Email" },
];

export function campaignShareLinks(input: { url: string; text: string; subject?: string }): ShareLinks {
  const out = {} as ShareLinks;
  for (const key of ["whatsapp", "sms", "x", "facebook", "email", "copy"] as ShareChannel[]) {
    const tagged = withSource(input.url, `share-${key}`);
    out[key] = shareLinks({ url: tagged, text: input.text, subject: input.subject })[key];
  }
  return out;
}

/** The three next asks after signing, each tagged with the campaign. */
export function nextAsks(slug: string): { href: string; label: string }[] {
  const source = `act-${slug}`;
  return [
    { href: withSource("/join", source), label: "Become a member" },
    { href: withSource("/donate", source), label: "Chip in" },
    { href: withSource("/volunteer", source), label: "Volunteer" },
  ];
}
