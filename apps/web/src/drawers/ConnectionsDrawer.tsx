import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { Account, Connector, Network } from "../types";
import { api, errorText, isApiError, reasonOf } from "../api";
import { Drawer } from "../components/Drawer";
import { NetworkBadge } from "../components/NetworkBadge";
import { PanelState } from "../components/PanelState";
import { Pill, type PillTone } from "../components/Pill";
import { RelativeTime } from "../components/RelativeTime";
import { useToast } from "../components/Toast";
import { connectorFor, isSecretInput } from "../lib/connectors";
import { ACCOUNT_STATUS_LABEL, compact, NETWORKS, networkLabel, plural } from "../lib/format";

const STATUS_TONE: Record<Account["status"], PillTone> = {
  active: "good",
  reauth_required: "warn",
  disabled: "neutral",
};

/** What a person needs to know before connecting, in the network's own terms. */
const CONNECT_HINT: Partial<Record<Network, string>> = {
  x: "You'll sign in on X and come back here.",
  bluesky: "Create an app password in Bluesky: Settings → Privacy and security → App passwords.",
  threads: "You'll sign in with Instagram on Threads and come back here.",
  instagram: "Instagram connects through Facebook: one sign-in brings every professional Instagram account linked to your Pages.",
  facebook: "One sign-in connects every Facebook Page you manage, and the Instagram accounts linked to them.",
  linkedin: "Connects your profile and the company pages you administer.",
  tiktok: "You'll sign in on TikTok and come back here. Posting needs a TikTok business or creator account.",
  youtube: "You'll pick a Google account and the channel to post as.",
  pinterest: "You'll sign in on Pinterest and come back here.",
  mastodon: "Starsign registers itself on your server first, then you sign in there.",
  reddit: "You'll sign in on Reddit and come back here.",
  google_business: "You'll pick the Google account that manages your business profiles.",
  telegram: "Make your bot an admin of the channel, then paste its token from @BotFather.",
  discord: "In Discord: Server settings → Integrations → Webhooks → New webhook → Copy webhook URL.",
};

type Group = "connected" | "available" | "unset";

interface Tile {
  network: Network;
  connector: Connector | null;
  group: Group;
  accounts: Account[];
}

/** Every network this room knows, where each stands on this server, and the accounts already connected. */
export function ConnectionsDrawer({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [followers, setFollowers] = useState<Record<string, number>>({});
  const [open, setOpen] = useState<{ network: Network; prefill?: Record<string, string>; reconnect?: boolean } | null>(null);
  const [unset, setUnset] = useState<Set<string>>(() => new Set()); // connectors the server said 503 for
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
  const [reconnecting, setReconnecting] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    void Promise.allSettled([api.accounts(), api.connectors()]).then(([a, c]) => {
      if (a.status === "fulfilled") setAccounts(a.value);
      else setError(errorText(a.reason));
      setConnectors(c.status === "fulfilled" ? c.value : []);
    });
  }, []);
  useEffect(load, [load]);

  // Follower counts arrive one by one; a network without account metrics just shows none.
  useEffect(() => {
    if (!accounts) return;
    let cancelled = false;
    for (const a of accounts) {
      if (a.status === "disabled" || followers[a.id] !== undefined) continue;
      api
        .accountMetrics(a.id)
        .then((m) => {
          const n = m.latest.followers_total;
          if (!cancelled && typeof n === "number") setFollowers((f) => ({ ...f, [a.id]: n }));
        })
        .catch(() => {
          // no number is fine
        });
    }
    return () => {
      cancelled = true;
    };
    // followers is read, not depended on: each account is asked once per load.
  }, [accounts]);

  const tiles = useMemo<Tile[]>(() => {
    if (!accounts || !connectors) return [];
    return NETWORKS.map((network) => {
      const connector = connectorFor(connectors, network);
      const mine = accounts.filter((a) => a.network === network);
      const settable = !!connector && connector.configured && !unset.has(connector.name);
      const group: Group = mine.length ? "connected" : settable ? "available" : "unset";
      return { network, connector, group, accounts: mine };
    });
  }, [accounts, connectors, unset]);

  const connectedAccounts = useMemo(
    () => (accounts ?? []).slice().sort((a, b) => NETWORKS.indexOf(a.network) - NETWORKS.indexOf(b.network) || a.handle.localeCompare(b.handle)),
    [accounts],
  );

  const afterConnect = (list: Account[], network: Network) => {
    const first = list[0];
    toast(list.length === 1 && first ? `Connected @${first.handle} on ${networkLabel(network)}` : `Connected ${plural(list.length, "account")} on ${networkLabel(network)}`);
    setOpen(null);
    load();
    onChanged();
  };

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

  /** Restart the flow that connected this account: OAuth goes straight out; typed credentials open the form. */
  async function reconnect(a: Account) {
    const all = connectors ?? [];
    const c = all.find((k) => k.name === a.connector) ?? connectorFor(all, a.network);
    if (!c) {
      setRowError({ id: a.id, text: `${networkLabel(a.network)} isn't set up on this server anymore.` });
      return;
    }
    if (c.connect !== "oauth" || (c.inputs?.length ?? 0) > 0) {
      const server = a.handle.includes("@") ? a.handle.split("@").pop() : undefined;
      const prefill: Record<string, string> = {};
      for (const f of c.inputs ?? []) {
        if (f.key === "identifier") prefill[f.key] = a.handle;
        else if (/instance|server/i.test(f.key) && server) prefill[f.key] = server;
      }
      setOpen({ network: a.network, prefill, reconnect: true });
      return;
    }
    setReconnecting(a.id);
    setRowError(null);
    try {
      const { authorizeUrl } = await api.connectStart(c.name, { network: a.network });
      window.location.assign(authorizeUrl);
    } catch (e) {
      setRowError({ id: a.id, text: isApiError(e) && e.status === 503 ? `${networkLabel(a.network)} isn't set up on this server right now.` : (reasonOf(e) ?? errorText(e)) });
      setReconnecting(null);
    }
  }

  const byGroup = (g: Group) => tiles.filter((t) => t.group === g);
  const activeCount = (accounts ?? []).filter((a) => a.status === "active").length;
  const connectedNets = byGroup("connected").length;

  const renderGrid = (group: Group) => {
    const list = byGroup(group);
    const openTile = open ? list.find((t) => t.network === open.network) : undefined;
    return (
      <>
        <div className="net-grid" role="list">
          {list.map((t) => (
            <NetTile key={t.network} tile={t} open={open?.network === t.network} onToggle={() => setOpen(open?.network === t.network ? null : { network: t.network })} />
          ))}
        </div>
        {openTile && openTile.connector && group !== "unset" ? (
          <ConnectPanel
            key={`${openTile.network}:${open?.reconnect ? "re" : "new"}`}
            network={openTile.network}
            connector={openTile.connector}
            prefill={open?.prefill}
            again={openTile.accounts.length > 0 && !open?.reconnect}
            onClose={() => setOpen(null)}
            onUnset={() => {
              setUnset((s) => new Set([...s, openTile.connector!.name]));
              setOpen(null);
            }}
            onConnected={(list) => afterConnect(list, openTile.network)}
          />
        ) : null}
        {openTile && group === "unset" ? (
          <p className="net-unset-note muted small">
            {networkLabel(openTile.network)} needs its app keys added to this server before anyone can connect it. Ask whoever runs Starsign.
          </p>
        ) : null}
      </>
    );
  };

  return (
    <Drawer
      title="Connections"
      subtitle={accounts ? <span className="muted mono">{`${plural(activeCount, "connected account")} · ${plural(connectedNets, "network")}`}</span> : null}
      onClose={onClose}
    >
      <PanelState error={error} loading={(!accounts || !connectors) && !error} onRetry={load} />
      {accounts && connectors ? (
        <>
          <section className="dsec">
            <h3 className="section-h">Connected</h3>
            {byGroup("connected").length ? renderGrid("connected") : <p className="muted">Nothing connected yet. Pick a network below.</p>}
            {connectedAccounts.length ? (
              <ul className="acct-list conn-accounts">
                {connectedAccounts.map((a) => (
                  <li key={a.id} className="acct-row">
                    <div className="acct-main">
                      <div className="acct-id">
                        <NetworkBadge network={a.network} />
                        <span className="strong">@{a.handle}</span>
                        <Pill tone={STATUS_TONE[a.status]}>{ACCOUNT_STATUS_LABEL[a.status]}</Pill>
                      </div>
                      <div className="acct-meta muted small">
                        {a.displayName && a.displayName !== a.handle ? <span>{a.displayName}</span> : null}
                        {followers[a.id] !== undefined ? (
                          <span>
                            <span className="mono acct-followers">{compact(followers[a.id])}</span> followers
                          </span>
                        ) : null}
                        {a.status === "disabled" ? null : a.lastIngestAt ? (
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
                      <div className="acct-actions">
                        {a.status === "reauth_required" ? (
                          <button type="button" className="btn btn-small" disabled={reconnecting === a.id} onClick={() => void reconnect(a)}>
                            {reconnecting === a.id ? `Opening ${networkLabel(a.network)}…` : "Reconnect"}
                          </button>
                        ) : null}
                        <button type="button" className="btn btn-small btn-ghost" onClick={() => setConfirming(a.id)}>
                          {a.status === "disabled" ? "Remove" : "Disconnect"}
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          {byGroup("available").length ? (
            <section className="dsec">
              <h3 className="section-h">Available</h3>
              {renderGrid("available")}
            </section>
          ) : null}

          {byGroup("unset").length ? (
            <section className="dsec">
              <h3 className="section-h">Not set up on this server</h3>
              {renderGrid("unset")}
            </section>
          ) : null}
        </>
      ) : null}
    </Drawer>
  );
}

function NetTile({ tile, open, onToggle }: { tile: Tile; open: boolean; onToggle: () => void }) {
  const label = networkLabel(tile.network);
  const needs = tile.accounts.some((a) => a.status === "reauth_required");
  const active = tile.accounts.filter((a) => a.status === "active").length;
  const meta =
    tile.group === "connected"
      ? needs
        ? "Needs reconnecting"
        : active
          ? plural(active, "account")
          : "Disconnected"
      : tile.group === "available"
        ? "Connect"
        : "Not set up";
  return (
    <button
      type="button"
      role="listitem"
      className={`net-tile net-tile-${tile.group}${open ? " net-tile-open" : ""}`}
      data-network={tile.network}
      aria-expanded={open}
      onClick={onToggle}
      title={tile.group === "connected" ? `Connect another ${label} account` : undefined}
    >
      <NetworkBadge network={tile.network} short />
      <span className="net-tile-name">{label}</span>
      <span className={`net-tile-meta${needs ? " net-tile-warn" : ""}`}>{meta}</span>
    </button>
  );
}

/**
 * How one network connects. OAuth: an optional inputs form (e.g. the Mastodon server), then off to the network.
 * Everything else (app password, bot token, webhook URL): the connector's inputs, sent to the server to verify.
 */
function ConnectPanel({
  network,
  connector,
  prefill,
  again,
  onClose,
  onUnset,
  onConnected,
}: {
  network: Network;
  connector: Connector;
  prefill?: Record<string, string>;
  again: boolean;
  onClose: () => void;
  onUnset: () => void;
  onConnected: (accounts: Account[]) => void;
}) {
  const label = networkLabel(network);
  const inputs = connector.inputs ?? [];
  const oauth = connector.connect === "oauth";
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(inputs.map((f) => [f.key, prefill?.[f.key] ?? ""])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing = inputs.some((f) => !(values[f.key] ?? "").trim());

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (missing || busy) return;
    setBusy(true);
    setError(null);
    const clean = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]));
    try {
      if (oauth) {
        const { authorizeUrl } = await api.connectStart(connector.name, { network, ...(inputs.length ? { inputs: clean } : {}) });
        window.location.assign(authorizeUrl);
        return; // the page is leaving; keep the button busy
      }
      const list = await api.connectCredentials(connector.name, { network, inputs: clean });
      onConnected(Array.isArray(list) ? list : []);
    } catch (err) {
      if (isApiError(err) && err.status === 503) {
        onUnset();
        return;
      }
      setError(reasonOf(err) ?? errorText(err));
    }
    setBusy(false);
  }

  const action = oauth ? (inputs.length ? `Continue to ${label}` : `Connect ${label}`) : `Connect ${label}`;

  return (
    <form className="connect-form conn-panel" onSubmit={(e) => void submit(e)} data-network={network}>
      <div className="connect-head">
        <NetworkBadge network={network} />
        <span className="strong">{again ? `Another ${label} account` : `Connect ${label}`}</span>
        <button type="button" className="btn btn-ghost btn-small conn-panel-close" onClick={onClose}>
          Close
        </button>
      </div>
      {CONNECT_HINT[network] ? <p className="muted small">{CONNECT_HINT[network]}</p> : null}
      {inputs.length ? (
        <div className={`connect-fields${inputs.length === 1 ? " connect-fields-one" : ""}`}>
          {inputs.map((f, i) => {
            const secret = isSecretInput(f.key);
            return (
              <label key={f.key} className="field">
                <span>{f.label}</span>
                <input
                  className={`input${secret ? " mono" : ""}`}
                  type={secret && !/webhook/i.test(f.key) ? "password" : /url|webhook/i.test(f.key) ? "url" : "text"}
                  autoComplete={f.key === "identifier" ? "username" : "off"}
                  spellCheck={false}
                  placeholder={f.placeholder}
                  value={values[f.key] ?? ""}
                  autoFocus={i === 0}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                />
              </label>
            );
          })}
        </div>
      ) : null}
      {error ? (
        <div className="card-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="compose-actions">
        <button type="submit" className="btn btn-primary" disabled={busy || missing}>
          {busy ? (oauth ? `Opening ${label}…` : "Connecting…") : action}
        </button>
      </div>
    </form>
  );
}
