import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { clockIn } from "../lib/tz";

const FALLBACK = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

let zonesCache: string[] | null = null;
/** Every IANA zone this browser knows (plus UTC, which some engines leave out). */
export function allTimezones(): string[] {
  if (zonesCache) return zonesCache;
  let list: string[] = [];
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    list = intl.supportedValuesOf ? intl.supportedValuesOf("timeZone") : [];
  } catch {
    list = [];
  }
  if (!list.length) list = FALLBACK;
  zonesCache = list.includes("UTC") ? list : ["UTC", ...list];
  return zonesCache;
}

const MAX_SHOWN = 60;
const norm = (s: string) => s.toLowerCase().replace(/[_/]+/g, " ");

/**
 * A searchable list of IANA timezones: type part of a city or region ("tokyo", "america new"), arrow to one, Enter
 * to pick. Each match shows its local time now.
 */
export function TimezonePicker({
  value,
  onChange,
  label,
  disabled,
  now,
}: {
  value: string;
  onChange: (tz: string) => void;
  label: string;
  disabled?: boolean;
  now: number;
}) {
  const id = useId();
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const open = query !== null;

  const zones = useMemo(() => {
    const all = allTimezones();
    return all.includes(value) ? all : [value, ...all];
  }, [value]);
  const matches = useMemo(() => {
    if (query === null) return [];
    const words = norm(query).split(/\s+/).filter(Boolean);
    const hits = words.length ? zones.filter((z) => words.every((w) => norm(z).includes(w))) : zones;
    return hits.slice(0, MAX_SHOWN);
  }, [zones, query]);

  const pick = (tz: string) => {
    onChange(tz);
    setQuery(null);
  };

  const move = (to: number) => {
    const n = Math.max(0, Math.min(matches.length - 1, to));
    setActive(n);
    list.current?.querySelector<HTMLElement>(`[data-i="${n}"]`)?.scrollIntoView({ block: "nearest" });
  };

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setQuery("");
      else move(active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(active - 1);
    } else if (e.key === "Enter") {
      if (open && matches[active]) {
        e.preventDefault();
        pick(matches[active]!);
      }
    } else if (e.key === "Escape" && open) {
      // Close the list, not the drawer around it.
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      setQuery(null);
    }
  }

  const listId = `${id}-list`;
  return (
    <div className="tzp">
      <input
        className="input tzp-input"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? `${id}-${active}` : undefined}
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
        value={open ? query : value.replace(/_/g, " ")}
        placeholder="Search: city or region"
        onFocus={(e) => {
          setQuery("");
          setActive(Math.max(0, zones.indexOf(value)));
          e.currentTarget.select();
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => window.setTimeout(() => setQuery(null), 120)}
      />
      {open ? (
        <ul id={listId} ref={list} className="tzp-list" role="listbox" aria-label={label}>
          {matches.length ? (
            matches.map((z, i) => (
              <li
                key={z}
                id={`${id}-${i}`}
                data-i={i}
                role="option"
                aria-selected={z === value}
                className={`tzp-opt${i === active ? " tzp-active" : ""}${z === value ? " tzp-on" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(z);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span className="tzp-name">{z.replace(/_/g, " ")}</span>
                <span className="mono muted small">{safeClock(now, z)}</span>
              </li>
            ))
          ) : (
            <li className="tzp-empty muted small">No timezone matches “{query}”.</li>
          )}
        </ul>
      ) : null}
    </div>
  );
}

function safeClock(ms: number, tz: string): string {
  try {
    return clockIn(ms, tz);
  } catch {
    return "";
  }
}
