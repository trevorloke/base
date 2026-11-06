import { createContext, useContext } from "react";
import type { Account, ComposePrefill, Connector, Stream, Topic } from "../types";
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
});

export const RoomProvider = RoomContext.Provider;

export function useRoom(): RoomRefs {
  return useContext(RoomContext);
}
