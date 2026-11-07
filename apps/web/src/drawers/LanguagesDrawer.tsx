import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { LanguageSettings, LanguagesInfo, Role, Stream } from "../types";
import { api, errorText } from "../api";
import { Drawer } from "../components/Drawer";
import { PanelState } from "../components/PanelState";
import { useToast } from "../components/Toast";
import { plural } from "../lib/format";
import { COMMON_LANGUAGES, LANG_CODE_RE, languageName, primaryLanguage, sameLanguage } from "../lib/lang";
import { ErrorNote } from "../components/ErrorNote";

const OTHER = "__other";
const MAX_DAILY = 100_000;
/** The server expands at most this many languages at once. */
const MAX_EXPAND = 12;

/**
 * The team's language, automatic translation, the languages the feed has seen, and each stream's keywords in
 * other languages.
 */
export function LanguagesDrawer({
  myRole,
  streams,
  onInfo,
  onStream,
  onClose,
}: {
  myRole: Role | null;
  streams: Stream[];
  /** Fresh languages info (after loading or saving), so the feed follows the team's language. */
  onInfo: (info: LanguagesInfo) => void;
  /** A stream whose keywords were just expanded. */
  onStream: (stream: Stream) => void;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<LanguagesInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .languages()
      .then((i) => {
        setInfo(i);
        onInfo(i);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, [onInfo]);
  useEffect(load, [load]);

  const saved = (settings: LanguageSettings) => {
    if (!info) return;
    const next = { ...info, settings };
    setInfo(next);
    onInfo(next);
  };

  const home = info?.settings.home ?? "en";
  const total = info ? info.seen.reduce((n, s) => n + s.n, 0) : 0;

  return (
    <Drawer
      title="Languages"
      subtitle={info ? <span className="muted">{`Team language: ${languageName(home)}`}</span> : null}
      onClose={onClose}
    >
      <PanelState error={error} loading={!info && !error} onRetry={load} />
      {info ? (
        <>
          {!info.translationAvailable ? (
            <section className="dsec">
              <p className="lang-off" role="note">
                Translation needs a model configured on the server (<code className="links-inline-code">ANTHROPIC_API_KEY</code>). Language detection and filtering still
                work.
              </p>
            </section>
          ) : null}

          <SettingsSection settings={info.settings} isOwner={myRole === "owner"} onSaved={saved} />

          <section className="dsec">
            <h3 className="section-h">Seen in the last 30 days</h3>
            {info.seen.length ? (
              <ul className="lang-seen">
                {info.seen.map((s) => (
                  <li key={s.lang ?? "unknown"} className="lang-seen-row">
                    <span className="lang-seen-name">
                      {languageName(s.lang)}
                      {s.lang ? <span className="muted mono small"> {s.lang}</span> : null}
                      {s.lang && sameLanguage(s.lang, home) ? <span className="muted small"> · the team's language</span> : null}
                    </span>
                    <span className="lang-seen-bar" aria-hidden="true">
                      <span style={{ width: `${total ? Math.max(2, Math.round((s.n / total) * 100)) : 0}%` }} />
                    </span>
                    <span className="mono lang-seen-n">{s.n.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Nothing in the feed yet.</p>
            )}
          </section>

          <section className="dsec">
            <h3 className="section-h">Streams in other languages</h3>
            <p className="small lang-lede">
              A stream finds its keywords as written, plus the terms below. Expanding asks the model how people write the keywords in each language.
            </p>
            {streams.length ? (
              <div className="lang-streams">
                {streams.map((s) => (
                  <StreamLanguages
                    key={s.id}
                    stream={s}
                    home={home}
                    seen={info.seen}
                    canChange={!!myRole && myRole !== "viewer"}
                    available={info.translationAvailable}
                    onStream={onStream}
                  />
                ))}
              </div>
            ) : (
              <p className="muted">No streams yet.</p>
            )}
            <p className="muted small links-note">
              Terms can't be edited here yet. Expanding a language again replaces its terms. A stream's language filter is set when the stream is created.
            </p>
          </section>
        </>
      ) : null}
    </Drawer>
  );
}

// --- Settings -----------------------------------------------------------------

type Draft = { choice: string; code: string; autoTranslate: boolean; dailyLimit: string };

function draftOf(s: LanguageSettings): Draft {
  const common = COMMON_LANGUAGES.includes(s.home);
  return { choice: common ? s.home : OTHER, code: common ? "" : s.home, autoTranslate: s.autoTranslate, dailyLimit: String(s.dailyLimit) };
}

function homeOf(d: Draft): string {
  return d.choice === OTHER ? d.code.trim() : d.choice;
}

function SettingsSection({ settings, isOwner, onSaved }: { settings: LanguageSettings; isOwner: boolean; onSaved: (s: LanguageSettings) => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => draftOf(settings));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(draftOf(settings)), [settings]);

  const home = homeOf(draft);
  const limit = Number(draft.dailyLimit);
  const codeOk = LANG_CODE_RE.test(home);
  const limitOk = draft.dailyLimit.trim() !== "" && Number.isInteger(limit) && limit >= 0 && limit <= MAX_DAILY;
  const dirty = home !== settings.home || draft.autoTranslate !== settings.autoTranslate || limit !== settings.dailyLimit;

  if (!isOwner) {
    return (
      <section className="dsec">
        <h3 className="section-h">Settings</h3>
        <dl className="kv">
          <div className="kv-row">
            <dt>Team language</dt>
            <dd>
              {languageName(settings.home)} <span className="muted mono small">{settings.home}</span>
            </dd>
          </div>
          <div className="kv-row">
            <dt>Translate new messages automatically</dt>
            <dd>{settings.autoTranslate ? "On" : "Off"}</dd>
          </div>
          <div className="kv-row">
            <dt>Most automatic translations a day</dt>
            <dd className="mono">{settings.dailyLimit.toLocaleString()}</dd>
          </div>
        </dl>
        <p className="muted small links-note">Only an owner can change these.</p>
      </section>
    );
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!codeOk || !limitOk || !dirty) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.updateLanguageSettings({ home, autoTranslate: draft.autoTranslate, dailyLimit: limit });
      onSaved(next);
      toast("Language settings saved");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const set = (p: Partial<Draft>) => setDraft({ ...draft, ...p });
  return (
    <section className="dsec">
      <h3 className="section-h">Settings</h3>
      <form className="links-settings lang-settings" onSubmit={(e) => void save(e)}>
        <div className="lang-home">
          <label className="field">
            <span>Team language</span>
            <select className="select" value={draft.choice} onChange={(e) => set({ choice: e.target.value })}>
              {COMMON_LANGUAGES.map((c) => (
                <option key={c} value={c}>
                  {languageName(c)}
                </option>
              ))}
              <option value={OTHER}>Other…</option>
            </select>
          </label>
          {draft.choice === OTHER ? (
            <label className="field lang-code">
              <span>Language code</span>
              <input
                className="input mono"
                placeholder="pt-BR"
                spellCheck={false}
                autoComplete="off"
                maxLength={20}
                value={draft.code}
                aria-invalid={!!draft.code.trim() && !codeOk}
                onChange={(e) => set({ code: e.target.value })}
              />
            </label>
          ) : null}
        </div>
        <p className="muted small lang-hint">
          {draft.choice === OTHER && draft.code.trim() && !codeOk
            ? "Use a language code such as en, ja or pt-BR."
            : draft.choice === OTHER && codeOk
              ? `${languageName(home)}. Messages are translated into this language.`
              : "Messages are translated into this language."}
        </p>
        <label className="check">
          <input type="checkbox" checked={draft.autoTranslate} onChange={(e) => set({ autoTranslate: e.target.checked })} />
          <span>
            Translate new messages automatically <span className="muted small">· when off, only when someone presses Translate</span>
          </span>
        </label>
        <label className="field lang-limit">
          <span>Most automatic translations a day</span>
          <input
            className="input mono"
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_DAILY}
            step={1}
            value={draft.dailyLimit}
            aria-invalid={!limitOk}
            onChange={(e) => set({ dailyLimit: e.target.value })}
          />
        </label>
        {!limitOk ? <p className="small field-warn">Use a whole number from 0 to {MAX_DAILY.toLocaleString()}.</p> : null}
        {error ? (
          <div className="card-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="dsec-act">
          <button type="submit" className="btn btn-primary" disabled={busy || !dirty || !codeOk || !limitOk}>
            {busy ? "Saving…" : "Save"}
          </button>
          {dirty && !busy ? (
            <button type="button" className="btn btn-ghost" onClick={() => setDraft(draftOf(settings))}>
              Undo changes
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

// --- Streams ------------------------------------------------------------------

function StreamLanguages({
  stream,
  home,
  seen,
  canChange,
  available,
  onStream,
}: {
  stream: Stream;
  home: string;
  seen: LanguagesInfo["seen"];
  canChange: boolean;
  available: boolean;
  onStream: (s: Stream) => void;
}) {
  const filter = stream.query.languages ?? [];
  const translations = Object.entries(stream.query.translations ?? {}).filter(([, terms]) => terms.length);
  const hasKeywords = stream.query.keywords.length > 0;

  // Languages worth offering: what the feed has seen first, then common ones; never the team's own language.
  const candidates = useMemo(() => {
    const out: string[] = [];
    for (const c of [...filter, ...seen.map((s) => s.lang).filter((l): l is string => !!l), ...COMMON_LANGUAGES]) {
      const p = primaryLanguage(c);
      if (!sameLanguage(p, home) && !out.includes(p)) out.push(p);
    }
    return out.slice(0, 16);
  }, [filter, seen, home]);
  const suggested = useMemo(() => {
    const fromSeen = seen.map((s) => s.lang).filter((l): l is string => !!l && !sameLanguage(l, home)).map(primaryLanguage);
    return [...new Set(filter.length ? filter.map(primaryLanguage).filter((l) => !sameLanguage(l, home)) : fromSeen)].slice(0, MAX_EXPAND);
  }, [filter, seen, home]);

  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>(suggested);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const toggle = (l: string) => setPicked((p) => (p.includes(l) ? p.filter((x) => x !== l) : p.length >= MAX_EXPAND ? p : [...p, l]));

  async function expand() {
    if (!picked.length || busy) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const next = await api.expandStream(stream.id, picked);
      onStream(next);
      const got = picked.filter((l) => (next.query.translations?.[l] ?? []).length);
      setDone(got.length ? `Added terms in ${got.map((l) => languageName(l)).join(", ")}.` : "The model found no terms for those languages.");
      setOpen(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lang-stream">
      <div className="lang-stream-head">
        <span className="strong">{stream.name}</span>
        <span className="muted small lang-stream-langs">{filter.length ? `Only ${filter.map((l) => languageName(l)).join(", ")}` : "All languages"}</span>
      </div>
      <div className="lang-terms">
        <span className="muted small lang-terms-label">Keywords</span>
        {hasKeywords ? (
          stream.query.keywords.map((k) => (
            <span key={k} className="tag">
              {k}
            </span>
          ))
        ) : (
          <span className="muted small">None</span>
        )}
      </div>
      {translations.map(([lang, terms]) => (
        <div key={lang} className="lang-terms">
          <span className="muted small lang-terms-label">{languageName(lang)}</span>
          {terms.map((t) => (
            <span key={t} className="tag" lang={lang}>
              {t}
            </span>
          ))}
        </div>
      ))}
      {done ? (
        <p className="small lang-done" role="status">
          {done}
        </p>
      ) : null}
      {canChange && hasKeywords ? (
        open ? (
          <div className="lang-expand" role="group" aria-label={`Expand ${stream.name} to languages`}>
            <p className="small">Languages to add</p>
            <div className="lang-pick">
              {candidates.map((l) => {
                const on = picked.includes(l);
                return (
                  <button key={l} type="button" className={`chip${on ? " chip-on" : ""}`} aria-pressed={on} onClick={() => toggle(l)}>
                    {languageName(l)}
                  </button>
                );
              })}
            </div>
            {!available ? <p className="muted small">Needs a model configured on the server.</p> : null}
            <div className="dsec-act">
              <button type="button" className="btn btn-primary btn-small" disabled={busy || !picked.length} onClick={() => void expand()}>
                {busy ? "Expanding…" : picked.length ? `Expand to ${plural(picked.length, "language")}` : "Pick a language"}
              </button>
              <button type="button" className="btn btn-ghost btn-small" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="lang-stream-act">
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                setPicked(suggested);
                setError(null);
                setDone(null);
                setOpen(true);
              }}
            >
              Expand keywords to languages
            </button>
          </div>
        )
      ) : null}
      {error ? <ErrorNote text={error} /> : null}
    </div>
  );
}
