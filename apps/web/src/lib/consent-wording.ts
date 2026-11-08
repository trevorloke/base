// The exact wording shown next to consent tick boxes. Pure, importable from
// client components; the consent ledger stores the version people saw.
import { clientProfile } from "@/seeds/client";
export const CONSENT_WORDING = {
  updates: `Yes, ${clientProfile.orgName} can email me news and ways to help. I can unsubscribe at any time.`,
  sms: `Yes, ${clientProfile.orgName} can text me about events and volunteering. Reply STOP at any time. Message and data rates may apply.`,
  newsletter: `Send me the ${clientProfile.orgName} newsletter. I can unsubscribe at any time.`,
} as const;

export type ConsentWordingKey = keyof typeof CONSENT_WORDING;
