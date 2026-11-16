// Typing in a search asks once it settles, not on every key: the value
// as it was `ms` after the last change.
import { useEffect, useState } from 'react';

export function useSettled(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export default useSettled;
