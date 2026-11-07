import { createContext, useContext } from "react";
import type { Account, ComposePrefill, Connector, Stream, Topic } from "../types";
import type { SettingsSectionId } from "./policy";
import { browserTz } from "./tz";

/** What every panel needs to turn ids into names, and to open detail over the room. */
export interface RoomRefs {
  accountsById: Map<string, Account>;
  /** GET /v1/connectors: what each network can do here (post kinds, reply, moderate). */
  connectors: Connector[];
  streamsById: Map<string, Stream>;
  topicsById: Map<string, Topic>;
  /** The workspace's policy timezone: schedules and the calendar read in it. */
  timezone: string;
  openPost: (id: string) => void;
  openTopic: (id: string) => void;
  openCompose: (prefill?: ComposePrefill) => void;
  /** Team members' names by user id, so posts say "Nora" rather than "usr_…". */
  people: ReadonlyMap<string, string>;
  /** The Connections drawer: where an empty room's next step usually is. */
  openAccounts: () => void;
  /** The Settings drawer, at one section: where red lines, autonomy, timezone and the brand profile change. */
  openSettings: (section?: SettingsSectionId) => void;
}

const RoomContext = createContext<RoomRefs>({
  accountsById: new Map(),
  connectors: [],
  streamsById: new Map(),
  topicsById: new Map(),
  timezone: browserTz(),
  openPost: () => {},
  openTopic: () => {},
  openCompose: () => {},
  openAccounts: () => {},
  openSettings: () => {},
  people: new Map(),
});

export const RoomProvider = RoomContext.Provider;

export function useRoom(): RoomRefs {
  return useContext(RoomContext);
}
