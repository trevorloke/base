import { useEffect, useState } from "react";

/** A clock that ticks every `everyMs`, so relative timestamps stay honest while the room is open. */
export function useNow(everyMs: number = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return now;
}
