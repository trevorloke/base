import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { InviteCreated, Member, Role } from "../types";
import { api, errorText } from "../api";
import { Drawer } from "../components/Drawer";
import { PanelState } from "../components/PanelState";
import { Pill } from "../components/Pill";
import { useToast } from "../components/Toast";
import { plural, ROLE_HINT, ROLE_LABEL } from "../lib/format";
import { formatDateTime } from "../lib/time";

const ROLES: Role[] = ["owner", "approver", "editor", "viewer"];

/** Who is in this workspace and what each may do. Owners change roles, remove people and invite. */
export function TeamDrawer({ workspaceName, myRole, myUserId, onClose }: { workspaceName: string; myRole: Role | null; myUserId: string | null; onClose: () => void }) {
  const toast = useToast();
  const isOwner = myRole === "owner";
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .members()
      .then(setMembers)
      .catch((e: unknown) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);

  async function changeRole(m: Member, role: Role) {
    if (role === m.role) return;
    setSaving(m.id);
    setRowError(null);
    try {
      const updated = await api.setMemberRole(m.id, role);
      setMembers((list) => list?.map((x) => (x.id === m.id ? { ...x, ...(updated ?? {}), role } : x)) ?? null);
      toast(`${m.name || m.email} is now ${role === "viewer" ? "a" : "an"} ${ROLE_LABEL[role].toLowerCase()}`);
    } catch (e) {
      // The server's own words: "cannot demote the last owner" and friends.
      setRowError({ id: m.id, text: errorText(e) });
    } finally {
      setSaving(null);
    }
  }

  async function remove(m: Member) {
    setSaving(m.id);
    setRowError(null);
    try {
      await api.removeMember(m.id);
      setConfirming(null);
      setMembers((list) => list?.filter((x) => x.id !== m.id) ?? null);
      toast(`Removed ${m.name || m.email}`);
    } catch (e) {
      setRowError({ id: m.id, text: errorText(e) });
    } finally {
      setSaving(null);
    }
  }

  return (
    <Drawer title="Team" subtitle={<span className="muted">{members ? `${workspaceName} · ${plural(members.length, "person", "people")}` : workspaceName}</span>} onClose={onClose}>
      <PanelState error={error} loading={!members && !error} onRetry={load} />
      {members ? (
        <section className="dsec">
          <h3 className="section-h">People</h3>
          <ul className="acct-list">
            {members.map((m) => {
              const me = m.userId === myUserId;
              return (
                <li key={m.id} className="acct-row team-row">
                  <div className="acct-main">
                    <div className="acct-id">
                      <span className="strong">{m.name || m.email}</span>
                      {me ? <span className="tag">You</span> : null}
                    </div>
                    <div className="acct-meta muted small">
                      <span>{m.email}</span>
                    </div>
                    {rowError?.id === m.id ? (
                      <div className="card-error" role="alert">
                        {rowError.text}
                      </div>
                    ) : null}
                  </div>
                  {confirming === m.id ? (
                    <div className="acct-confirm" role="group" aria-label={`Remove ${m.name || m.email}?`}>
                      <span>{me ? "Leave this workspace?" : `Remove ${m.name.split(" ")[0] || m.email}?`}</span>
                      <button type="button" className="btn btn-small btn-danger" disabled={saving === m.id} onClick={() => void remove(m)}>
                        {saving === m.id ? "…" : "Yes"}
                      </button>
                      <span className="sep" aria-hidden="true">
                        ·
                      </span>
                      <button type="button" className="btn btn-small btn-ghost" onClick={() => setConfirming(null)}>
                        No
                      </button>
                    </div>
                  ) : (
                    <div className="acct-actions">
                      {isOwner ? (
                        <select
                          className="select select-small"
                          value={m.role}
                          disabled={saving === m.id}
                          aria-label={`Role for ${m.name || m.email}`}
                          onChange={(e) => void changeRole(m, e.target.value as Role)}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Pill tone={m.role === "owner" ? "accent" : "neutral"}>{ROLE_LABEL[m.role] ?? m.role}</Pill>
                      )}
                      {isOwner ? (
                        <button type="button" className="btn btn-small btn-ghost" onClick={() => setConfirming(m.id)}>
                          Remove
                        </button>
                      ) : null}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {isOwner ? (
        <InviteForm />
      ) : members ? (
        <section className="dsec">
          <p className="muted small">Only an owner can invite people or change roles.</p>
        </section>
      ) : null}

      <section className="dsec">
        <h3 className="section-h">Roles</h3>
        <dl className="kv role-kv">
          {ROLES.map((r) => (
            <div key={r} className="kv-row">
              <dt>{ROLE_LABEL[r]}</dt>
              <dd className="muted">{ROLE_HINT[r]}</dd>
            </div>
          ))}
        </dl>
      </section>
    </Drawer>
  );
}

function InviteForm() {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<(InviteCreated & { email: string }) | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await api.invite(email.trim(), role);
      setSent({ ...res, email: email.trim() });
      setEmail("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!sent) return;
    try {
      await navigator.clipboard.writeText(sent.inviteUrl);
      setCopied(true);
    } catch {
      // Clipboard blocked: select the text so a manual copy is one keystroke away.
      const el = document.getElementById("invite-link") as HTMLInputElement | null;
      el?.select();
    }
  }

  return (
    <section className="dsec">
      <h3 className="section-h">Invite someone</h3>
      <form className="invite-form" onSubmit={(e) => void submit(e)}>
        <label className="field invite-email">
          <span>Email</span>
          <input className="input" type="email" autoComplete="off" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>Role</span>
          <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-primary invite-send" disabled={busy || !email.trim()}>
          {busy ? "Inviting…" : "Invite"}
        </button>
      </form>
      {error ? (
        <div className="card-error" role="alert">
          {error}
        </div>
      ) : null}
      {sent ? (
        <div className="invite-result">
          <div className="invite-result-head">
            <span>
              Invite for <span className="strong">{sent.email}</span>
            </span>
            {sent.emailed ? <Pill tone="good">Emailed</Pill> : <span className="muted small">Send them this link</span>}
          </div>
          <div className="invite-link-row">
            <input id="invite-link" className="input mono" readOnly value={sent.inviteUrl} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" />
            <button type="button" className="btn" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
          <p className="muted small">Works once, until {formatDateTime(sent.expiresAt)}.</p>
        </div>
      ) : null}
    </section>
  );
}
