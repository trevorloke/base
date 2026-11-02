import { createContext, useContext } from "react";
import type { Account, Stream, Topic } from "../types";

/** What every panel needs to turn ids into names, and to open detail over the room. */
export interface RoomRefs {
  accountsById: Map<string, Account>;
  streamsById: Map<string, Stream>;
  topicsById: Map<string, Topic>;
  openPost: (id: string) => void;
  openTopic: (id: string) => void;
}

const RoomContext = createContext<RoomRefs>({
  accountsById: new Map(),
  streamsById: new Map(),
  topicsById: new Map(),
  openPost: () => {},
  openTopic: () => {},
});

export const RoomProvider = RoomContext.Provider;

export function useRoom(): RoomRefs {
  return useContext(RoomContext);
}
