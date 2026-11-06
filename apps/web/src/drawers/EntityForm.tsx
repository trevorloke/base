import { useMemo, useState, type FormEvent } from "react";
import type { AliasSuggestions, Entity, EntityInput, EntityKind, EntityPatch, EntityRelation, Network } from "../types";
import { api, errorText } from "../api";
import { ChipsInput } from "../components/ChipsInput";
import { NetworkBadge } from "../components/NetworkBadge";
import { ENTITY_ROLE_SUGGESTIONS, NETWORKS, networkLabel, RELATION_HINT, RELATION_LABEL, RELATION_ORDER } from "../lib/format";
import { languageName } from "../lib/lang";
import { descendantsOf } from "../lib/tracker";

type Handles = Partial<Record<Network, string[]>>;

interface Draft {
  kind: EntityKind;
  name: string;
  role: string;
  parentId: string;
  relation: EntityRelation;
  aliases: string[];
  handles: Handles;
  context: string[];
  exclude: string[];
  wikipedia: string[];
  trackTrend: boolean;
  notes: string;
}

function draftOf(e: Entity | null, preset?: { parentId?: string; kind?: EntityKind }): Draft {
  return {
    kind: e?.kind ?? preset?.kind ?? "organization",
    name: e?.name ?? "",
    role: e?.role ?? "",
    parentId: e?.parentId ?? preset?.parentId ?? "",
    relation: e?.relation ?? "watch",
    aliases: e?.aliases ?? [],
    handles: e?.handles ?? {},
    context: e?.context ?? [],
    exclude: e?.exclude ?? [],
    wikipedia: e?.wikipedia ?? [],
    trackTrend: true,
    notes: e?.notes ?? "",
  };
}

const HANDLE_RE = /^@?[^\s@]+(@[^\s@]+)?$/;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Track a new name or change how one is matched. Kept to one column: what it is, then every way people write it.
 * The submit button lives in the drawer footer (`form="entity-form"`).
 */
export function EntityForm({
  entity,
  all,
  preset,
  onSaved,
  onBusy,
}: {
  /** null: a new name. */
  entity: Entity | null;
  /** Every tracked name, for "Belongs to". */
  all: Entity[];
  preset?: { parentId?: string; kind?: EntityKind };
  onSaved: (e: Entity, created: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(entity, preset));
  const [errors, setErrors] = useState<{ name?: string; handle?: string; form?: string }>({});
  const [handleNet, setHandleNet] = useState<Network>("x");
  const [handleText, setHandleText] = useState("");
  const set = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  const selfAndBelow = useMemo(() => (entity ? descendantsOf(all, entity.id) : new Set<string>()), [all, entity]);
  const orgs = useMemo(
    () => all.filter((e) => e.kind === "organization" && !e.archivedAt && !selfAndBelow.has(e.id)).sort((a, b) => a.name.localeCompare(b.name)),
    [all, selfAndBelow],
  );
  const hasPeople = !!entity && all.some((e) => e.parentId === entity.id && !e.archivedAt);
  const parentGone = !!draft.parentId && !orgs.some((o) => o.id === draft.parentId);

  function addHandle() {
    const raw = handleText.trim();
    if (!raw) return;
    if (!HANDLE_RE.test(raw)) {
      setErrors((x) => ({ ...x, handle: "A handle has no spaces, like @northwindcoffee." }));
      return;
    }
    const h = raw.replace(/^@/, "");
    const list = draft.handles[handleNet] ?? [];
    if (list.some((x) => x.toLowerCase() === h.toLowerCase())) {
      setHandleText("");
      return;
    }
    if (list.length >= 20) {
      setErrors((x) => ({ ...x, handle: `At most 20 handles on ${networkLabel(handleNet)}.` }));
      return;
    }
    set({ handles: { ...draft.handles, [handleNet]: [...list, h] } });
    setHandleText("");
    setErrors((x) => ({ ...x, handle: undefined }));
  }

  function removeHandle(net: Network, h: string) {
    const list = (draft.handles[net] ?? []).filter((x) => x !== h);
    const next = { ...draft.handles };
    if (list.length) next[net] = list;
    else delete next[net];
    set({ handles: next });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const name = draft.name.trim();
    if (!name) {
      setErrors({ name: "Give it a name." });
      document.getElementById("ent-name")?.focus();
      return;
    }
    // A handle typed but not added yet still counts.
    let handles = draft.handles;
    const pending = handleText.trim();
    if (pending) {
      if (!HANDLE_RE.test(pending)) {
        setErrors({ handle: "A handle has no spaces, like @northwindcoffee." });
        return;
      }
      const h = pending.replace(/^@/, "");
      const list = handles[handleNet] ?? [];
      if (!list.some((x) => x.toLowerCase() === h.toLowerCase())) handles = { ...handles, [handleNet]: [...list, h] };
      setHandleText("");
      set({ handles });
    }
    setErrors({});
    onBusy(true);
    try {
      if (!entity) {
        const input: EntityInput = {
          kind: draft.kind,
          name,
          relation: draft.relation,
          aliases: draft.aliases,
          handles,
          context: draft.context,
          exclude: draft.exclude,
          wikipedia: draft.wikipedia,
          trackTrend: draft.trackTrend,
          ...(draft.role.trim() ? { role: draft.role.trim() } : {}),
          ...(draft.parentId ? { parentId: draft.parentId } : {}),
          ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
        };
        onSaved(await api.createEntity(input), true);
      } else {
        // Only what changed: a change to how it is matched makes the server rebuild its mentions.
        const before = draftOf(entity);
        const patch: EntityPatch = {};
        if (draft.kind !== before.kind) patch.kind = draft.kind;
        if (name !== before.name) patch.name = name;
        if (draft.role.trim() !== before.role) patch.role = draft.role.trim();
        if (draft.parentId !== before.parentId) patch.parentId = draft.parentId; // "" clears it
        if (draft.relation !== before.relation) patch.relation = draft.relation;
        if (!same(draft.aliases, before.aliases)) patch.aliases = draft.aliases;
        if (!same(handles, before.handles)) patch.handles = handles;
        if (!same(draft.context, before.context)) patch.context = draft.context;
        if (!same(draft.exclude, before.exclude)) patch.exclude = draft.exclude;
        if (!same(draft.wikipedia, before.wikipedia)) patch.wikipedia = draft.wikipedia;
        if (draft.notes.trim() !== before.notes) patch.notes = draft.notes.trim();
        onSaved(Object.keys(patch).length ? await api.updateEntity(entity.id, patch) : entity, false);
      }
    } catch (err) {
      setErrors({ form: errorText(err) });
    } finally {
      onBusy(false);
    }
  }

  const handleList = NETWORKS.flatMap((net) => (draft.handles[net] ?? []).map((h) => ({ net, h })));

  return (
    <form id="entity-form" className="ent-form" onSubmit={(e) => void submit(e)} noValidate>
      <section className="dsec ent-fields">
        <div className="field">
          <span className="field-label" id="ent-kind-label">
            What it is
          </span>
          <div className="seg seg-wide" role="radiogroup" aria-labelledby="ent-kind-label">
            {(["organization", "person"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={draft.kind === k}
                className="seg-btn"
                disabled={k === "person" && hasPeople}
                title={k === "person" && hasPeople ? "People belong to it, so it stays an organisation" : undefined}
                onClick={() => set({ kind: k })}
              >
                {k === "organization" ? "Organisation" : "Person"}
              </button>
            ))}
          </div>
          <span className="muted small">{draft.kind === "organization" ? "A party, a brand, a company." : "A candidate, a founder, a creator, someone's own brand."}</span>
        </div>

        <label className="field">
          <span className="field-label">Name</span>
          <input
            id="ent-name"
            className="input"
            value={draft.name}
            maxLength={200}
            placeholder={draft.kind === "organization" ? "Green Party, Blue Bottle" : "Ana Ruiz"}
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? "ent-name-error" : undefined}
            onChange={(e) => {
              set({ name: e.target.value });
              if (errors.name) setErrors((x) => ({ ...x, name: undefined }));
            }}
            autoFocus={!entity}
          />
          {errors.name ? (
            <span id="ent-name-error" className="field-error" role="alert">
              {errors.name}
            </span>
          ) : null}
        </label>

        <div className="ent-pair">
          <label className="field">
            <span className="field-label">Role</span>
            <input className="input" list="ent-roles" value={draft.role} maxLength={60} placeholder={draft.kind === "organization" ? "brand" : "founder"} onChange={(e) => set({ role: e.target.value })} />
            <datalist id="ent-roles">
              {ENTITY_ROLE_SUGGESTIONS.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </label>
          <label className="field">
            <span className="field-label">Relation</span>
            <select className="select" value={draft.relation} onChange={(e) => set({ relation: e.target.value as EntityRelation })}>
              {RELATION_ORDER.map((r) => (
                <option key={r} value={r}>
                  {RELATION_LABEL[r]}: {RELATION_HINT[r]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="field">
          <span className="field-label">Belongs to</span>
          <select className="select" value={draft.parentId} onChange={(e) => set({ parentId: e.target.value })}>
            <option value="">Nothing: it stands on its own</option>
            {parentGone ? <option value={draft.parentId}>An organisation that isn't tracked anymore</option> : null}
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <span className="muted small">Its numbers roll up into the organisation's.</span>
        </label>
      </section>

      <section className="dsec ent-fields">
        <h3 className="section-h">How people write it</h3>
        <ChipsInput
          id="ent-aliases"
          label="Aliases"
          what="alias"
          values={draft.aliases}
          onChange={(aliases) => set({ aliases })}
          max={60}
          placeholder="Greens, ノースウィンド, NW"
          help="Other spellings, scripts, nicknames and abbreviations. Press Enter after each."
        />
        {entity ? <AliasSuggester entity={entity} have={[draft.name, ...draft.aliases]} onAdd={(t) => set({ aliases: [...draft.aliases, t] })} /> : null}

        <div className="field">
          <span className="field-label" id="ent-handles-label">
            Its own accounts
          </span>
          <span className="muted small">Messages from these count as by them; an @mention of one counts as a mention.</span>
          {handleList.length ? (
            <ul className="chipsin ent-handles" aria-labelledby="ent-handles-label">
              {handleList.map(({ net, h }) => (
                <li key={`${net}:${h}`} className="chipsin-chip">
                  <NetworkBadge network={net} short />
                  <span className="chipsin-text">@{h}</span>
                  <button type="button" className="chipsin-x" aria-label={`Remove handle @${h} on ${networkLabel(net)}`} onClick={() => removeHandle(net, h)}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="ent-handle-add">
            <label className="sr-only" htmlFor="ent-handle-net">
              Network
            </label>
            <select id="ent-handle-net" className="select" value={handleNet} onChange={(e) => setHandleNet(e.target.value as Network)}>
              {NETWORKS.map((n) => (
                <option key={n} value={n}>
                  {networkLabel(n)}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="ent-handle">
              Handle on {networkLabel(handleNet)}
            </label>
            <input
              id="ent-handle"
              className="input"
              value={handleText}
              placeholder="@handle"
              maxLength={120}
              aria-invalid={!!errors.handle}
              aria-describedby={errors.handle ? "ent-handle-error" : undefined}
              onChange={(e) => {
                setHandleText(e.target.value);
                if (errors.handle) setErrors((x) => ({ ...x, handle: undefined }));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addHandle();
                }
              }}
            />
            <button type="button" className="btn" onClick={addHandle} disabled={!handleText.trim()}>
              Add
            </button>
          </div>
          {errors.handle ? (
            <span id="ent-handle-error" className="field-error" role="alert">
              {errors.handle}
            </span>
          ) : null}
        </div>

        <ChipsInput
          id="ent-context"
          label="Context words"
          what="context word"
          values={draft.context}
          onChange={(context) => set({ context })}
          max={40}
          placeholder="coffee, election"
          help="Only count the name when one of these words is nearby. Use for names that are also common words."
        />
        <ChipsInput
          id="ent-exclude"
          label="Exclude words"
          what="exclude word"
          values={draft.exclude}
          onChange={(exclude) => set({ exclude })}
          max={40}
          placeholder="Northwind Traders"
          help="Never count a match when one of these appears, e.g. a namesake."
        />
        <ChipsInput
          id="ent-wiki"
          label="Wikipedia articles"
          what="Wikipedia article"
          values={draft.wikipedia}
          onChange={(wikipedia) => set({ wikipedia })}
          max={10}
          maxLength={200}
          placeholder="Blue_Bottle_Coffee"
          help="Article titles as in the address. Their page views feed the momentum forecast."
        />
      </section>

      <section className="dsec ent-fields">
        {!entity ? (
          <label className="check">
            <input type="checkbox" checked={draft.trackTrend} onChange={(e) => set({ trackTrend: e.target.checked })} />
            <span>
              Track on the radar <span className="muted small">· forecasts its momentum next to your topics</span>
            </span>
          </label>
        ) : null}
        <label className="field">
          <span className="field-label">Notes</span>
          <textarea className="textarea" rows={3} maxLength={4000} value={draft.notes} placeholder="For the team: who they are, what to watch for" onChange={(e) => set({ notes: e.target.value })} />
        </label>
        {!entity ? <p className="muted small">Starsign looks back over the last 90 days when you save.</p> : null}
        {errors.form ? (
          <div className="card-error" role="alert">
            {errors.form}
          </div>
        ) : null}
      </section>
    </form>
  );
}

/** Asks the model how the name is written in the languages the feed sees. Suggestions only: added ones save with the form. */
function AliasSuggester({ entity, have, onAdd }: { entity: Entity; have: string[]; onAdd: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AliasSuggestions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const taken = new Set(have.map((x) => x.normalize("NFKC").toLowerCase()));
  const ambiguous = new Set((result?.ambiguous ?? []).map((x) => x.normalize("NFKC").toLowerCase()));
  const suggested = new Set((result?.aliases ?? []).map((a) => a.text.normalize("NFKC").toLowerCase()));
  const otherAmbiguous = (result?.ambiguous ?? []).filter((x) => !suggested.has(x.normalize("NFKC").toLowerCase()));

  async function ask() {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.suggestAliases(entity.id));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ent-suggest">
      <button type="button" className="btn btn-small" disabled={busy} onClick={() => void ask()}>
        {busy ? "Asking…" : result ? "Suggest again" : "Suggest names in other languages"}
      </button>
      {error ? (
        <div className="card-error" role="alert">
          {error}
        </div>
      ) : null}
      {result ? (
        <div className="ent-suggest-out" role="status">
          {result.aliases.length ? (
            <>
              <p className="muted small">
                For {result.languages.map((l) => languageName(l)).join(", ")}. Added ones are saved with the form.
              </p>
              <ul className="ent-suggest-list">
                {result.aliases.map((a) => {
                  const added = taken.has(a.text.normalize("NFKC").toLowerCase());
                  const vague = ambiguous.has(a.text.normalize("NFKC").toLowerCase());
                  return (
                    <li key={`${a.lang}:${a.text}`} className="ent-suggest-item">
                      <div className="ent-suggest-head">
                        <span className="strong" lang={a.lang}>
                          {a.text}
                        </span>
                        <span className="tag">{languageName(a.lang)}</span>
                        {vague ? <span className="pill pill-warn">Also a common word</span> : null}
                        {added ? (
                          <span className="muted small ent-suggest-added">Added</span>
                        ) : (
                          <button type="button" className="btn btn-small ent-suggest-add" aria-label={`Add alias ${a.text}`} onClick={() => onAdd(a.text)}>
                            Add
                          </button>
                        )}
                      </div>
                      <span className="muted small">{a.why}</span>
                      {vague ? <span className="small field-warn">If you add it, add context words too, so only posts about {entity.name} count.</span> : null}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <p className="muted small">No new names to suggest for {result.languages.map((l) => languageName(l)).join(", ")}.</p>
          )}
          {otherAmbiguous.length ? (
            <p className="small field-warn">
              {otherAmbiguous.join(", ")} can mean something else. Context words keep the count to posts about {entity.name}.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
