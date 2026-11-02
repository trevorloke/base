import { useEffect, useState, type FormEvent } from "react";
import type { Account, Connector, Network } from "../types";
import { api, errorText, isApiError } from "../api";
import { Drawer } from "../components/Drawer";
import { NetworkBadge } from "../components/NetworkBadge";
import { PanelState } from "../components/PanelState";
import { Pill, type PillTone } from "../components/Pill";
import { RelativeTime } from "../components/RelativeTime";
import { useToast } from "../components/Toast";
import { ACCOUNT_STATUS_LABEL, plural } from "../lib/format";

const STATUS_TONE: Record<Account["status"], PillTone> = {
  active: "good",
  reauth_required: "warn",
  disabled: "neutral",
};

/** The accounts Starsign posts as and listens on, and the ways this deployment can connect more. */
export function AccountsDrawer({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);

  const load = () => {
    setError(null);
    void Promise.allSettled([api.accounts(), api.connectors()]).then(([a, c]) => {
      if (a.status === "fulfilled") setAccounts(a.value);
      else setError(errorText(a.reason));
      if (c.status === "fulfilled") setConnectors(c.value);
      else setConnectors([]);
    });
  };
  useEffect(load, []);

  async function disconnect(a: Account) {
    setRemoving(a.id);
    setRowError(null);
    try {
      await api.deleteAccount(a.id);
      setConfirming(null);
      toast(`Disconnected @${a.handle}`);
      load();
      onChanged();
    } catch (e) {
      setRowError({ id: a.id, text: errorText(e) });
    } finally {
      setRemoving(null);
    }
  }

  // Bluesky connects by app password and X by OAuth; any other way to connect is not built here yet.
  const all = connectors ?? [];
  const passwordNets: Network[] = [...new Set(all.filter((c) => c.connect === "app_password" && c.configured).flatMap((c) => c.networks))].filter((n) => n === "bluesky");
  const xConnector = all.find((c) => c.connect === "oauth" && c.networks.includes("x")) ?? null;
  const soon = [...new Set(all.filter((c) => c.connect !== "none").flatMap((c) => c.networks))].filter(
    (n) => !passwordNets.includes(n) && !(n === "x" && xConnector),
  );

  return (
    <Drawer
      title="Accounts"
      subtitle={accounts ? <span className="muted mono">{plural(accounts.filter((a) => a.status === "active").length, "connected account")}</span> : null}
      onClose={onClose}
    >
      <PanelState error={error} loading={!accounts && !error} onRetry={load} />
      {accounts ? (
        <section className="dsec">
          <h3 className="section-h">Connected</h3>
          {accounts.length === 0 ? <p className="muted">Nothing connected yet.</p> : null}
          <ul className="acct-list">
            {accounts.map((a) => (
              <li key={a.id} className="acct-row">
                <div className="acct-main">
                  <div className="acct-id">
                    <NetworkBadge network={a.network} />
                    <span className="strong">@{a.handle}</span>
                    <Pill tone={STATUS_TONE[a.status]}>{ACCOUNT_STATUS_LABEL[a.status]}</Pill>
                  </div>
                  <div className="acct-meta muted small">
                    {a.displayName ? <span>{a.displayName}</span> : null}
                    {a.lastIngestAt ? (
                      <span>
                        pulled <RelativeTime iso={a.lastIngestAt} />
                      </span>
                    ) : (
                      <span>not pulled yet</span>
                    )}
                  </div>
                  {rowError?.id === a.id ? (
                    <div className="card-error" role="alert">
                      {rowError.text}
                    </div>
                  ) : null}
                </div>
                {confirming === a.id ? (
                  <div className="acct-confirm" role="group" aria-label={`Disconnect @${a.handle}?`}>
                    <span>Disconnect @{a.handle}?</span>
                    <button type="button" className="btn btn-small btn-danger" disabled={removing === a.id} onClick={() => void disconnect(a)}>
                      {removing === a.id ? "…" : "Yes"}
                    </button>
                    <span className="sep" aria-hidden="true">
                      ·
                    </span>
                    <button type="button" className="btn btn-small btn-ghost" onClick={() => setConfirming(null)}>
                      No
                    </button>
                  </div>
                ) : (
                  <button type="button" className="btn btn-small btn-ghost" onClick={() => setConfirming(a.id)}>
                    Disconnect
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {connectors ? (
        <section className="dsec">
          <h3 className="section-h">Connect an account</h3>
          {passwordNets.map((n) => (
            <AppPasswordForm
              key={n}
              network={n}
              onConnected={(acc) => {
                toast(`Connected @${acc.handle}`);
                load();
                onChanged();
              }}
            />
          ))}
          {xConnector ? <XConnect configured={xConnector.configured} /> : null}
          {soon.length ? (
            <div className="soon">
              {soon.map((n) => (
                <NetworkBadge key={n} network={n} />
              ))}
              <span className="muted small">Coming soon</span>
            </div>
          ) : null}
          {!passwordNets.length && !xConnector && !soon.length ? <p className="muted">This deployment can't connect accounts from here yet.</p> : null}
        </section>
      ) : null}
    </Drawer>
  );
}

/** X connects by OAuth: the server hands back X's consent page, and X sends the person back to the room. */
function XConnect({ configured }: { configured: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unset, setUnset] = useState(!configured);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const { authorizeUrl } = await api.connectXStart();
      window.location.href = authorizeUrl;
    } catch (e) {
      if (isApiError(e) && e.status === 503) setUnset(true);
      else setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <div className="connect-row">
      <NetworkBadge network="x" />
      {unset ? (
        <span className="muted small">Not set up on this server</span>
      ) : (
        <>
          <button type="button" className="btn" disabled={busy} onClick={() => void start()}>
            {busy ? "Opening X…" : "Connect X"}
          </button>
          <span className="muted small">You'll sign in on X and come back here.</span>
        </>
      )}
      {error ? (
        <div className="card-error connect-row-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function AppPasswordForm({ network, onConnected }: { network: Network; onConnected: (a: Account) => void }) {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!identifier.trim() || !password.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // Only Bluesky connects by app password today; the endpoint is per network.
      const acc = await api.connectBluesky({ identifier: identifier.trim().replace(/^@/, ""), appPassword: password.trim() });
      setIdentifier("");
      setPassword("");
      onConnected(acc);
    } catch (err) {
      const reason = isApiError(err) && err.details && typeof err.details === "object" ? (err.details as { reason?: unknown }).reason : null;
      setError(typeof reason === "string" && reason ? reason : errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="connect-form" onSubmit={(e) => void submit(e)}>
      <div className="connect-head">
        <NetworkBadge network={network} />
        <span className="muted small">Create an app password in Bluesky: Settings → Privacy and security → App passwords</span>
      </div>
      <div className="connect-fields">
        <label className="field">
          <span>Handle</span>
          <input
            className="input"
            autoComplete="username"
            spellCheck={false}
            placeholder="yourbrand.bsky.social"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
          />
        </label>
        <label className="field">
          <span>App password</span>
          <input
            className="input mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="xxxx-xxxx-xxxx-xxxx"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
      </div>
      {error ? (
        <div className="card-error" role="alert">
          {error}
        </div>
      ) : null}
      <div>
        <button type="submit" className="btn btn-primary" disabled={busy || !identifier.trim() || !password.trim()}>
          {busy ? "Connecting…" : "Connect Bluesky"}
        </button>
      </div>
    </form>
  );
}
