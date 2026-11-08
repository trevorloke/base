import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { InviteInfo, Session } from "../types";
import { api, errorText, isApiError, reasonOf, sentence, setApiKey, USE_FIXTURES } from "../api";
import { roleLabel } from "../lib/format";
import { formatDateTime } from "../lib/time";
import { browserTz } from "../lib/tz";
import { signInWithBaseHref, useSuite } from "../lib/suite";
import { useBrand } from "../lib/brand";
import { BrandMark } from "../components/BrandMark";

export type AuthScreen = "signin" | "signup" | "forgot" | "reset" | "invite" | "key";

const MIN_PASSWORD = 10;

/** Takes `?invite=` / `?reset=` / `?forgot=` out of the address bar once they have been read. */
export function stripAuthParams(): void {
  const url = new URL(window.location.href);
  let changed = false;
  for (const k of ["invite", "reset", "forgot"]) {
    if (url.searchParams.has(k)) {
      url.searchParams.delete(k);
      changed = true;
    }
  }
  if (changed) window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

/** Login, signup and accept-invite answer 401/403/429 with sentences meant for the person; use them. */
function authError(e: unknown, fallback401: string): string {
  if (isApiError(e)) {
    if (e.status === 401) return e.message && !e.code.startsWith("http_") ? sentence(e.message) : fallback401;
    if (e.status === 429) return errorText(e);
    const reason = reasonOf(e);
    if (reason) return reason;
  }
  return errorText(e);
}

/**
 * Everything before the room: sign in, first-run create account, forgot/reset password, accept an invite, and a
 * quiet way in with an API key for developers.
 */
export function AuthGate({
  initial,
  inviteToken,
  resetToken,
  session,
  signupAllowed,
  message,
  theme,
  onToggleTheme,
  onSession,
  onApiKey,
}: {
  initial: AuthScreen;
  inviteToken: string | null;
  resetToken: string | null;
  /** Already signed in (only while accepting an invite). */
  session: Session | null;
  /** null: the server didn't say; the link shows and a refusal explains itself. */
  signupAllowed: boolean | null;
  message: string | null;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onSession: (s: Session) => void;
  onApiKey: (key: string) => void;
}) {
  const [screen, setScreen] = useState<AuthScreen>(initial);
  const [email, setEmail] = useState("");
  const [notice, setNotice] = useState<string | null>(message);
  // An invite someone opened while signed out: signing in first, then joining.
  const [pendingInvite, setPendingInvite] = useState<string | null>(null);

  const go = (s: AuthScreen, note: string | null = null) => {
    setNotice(note);
    setScreen(s);
  };

  const finishSignIn = async (s: Session) => {
    if (pendingInvite) {
      try {
        const joined = await api.acceptInvite({ token: pendingInvite });
        stripAuthParams();
        onSession(joined);
        return;
      } catch {
        // Signed in anyway; the room opens and the invite can be retried from its link.
      }
    }
    stripAuthParams();
    onSession(s);
  };

  let card: ReactNode;
  switch (screen) {
    case "signup":
      card = <SignupCard initialEmail={email} onDone={(s) => void finishSignIn(s)} onSignIn={() => go("signin")} />;
      break;
    case "forgot":
      card = (
        <ForgotCard
          initialEmail={email}
          onBack={(note) => {
            stripAuthParams();
            go("signin", note);
          }}
        />
      );
      break;
    case "reset":
      card = (
        <ResetCard
          token={resetToken ?? ""}
          onDone={() => {
            stripAuthParams();
            go("signin", "Password changed. Sign in with the new one.");
          }}
          onForgot={() => {
            stripAuthParams();
            go("forgot");
          }}
        />
      );
      break;
    case "invite":
      card = (
        <InviteCard
          token={inviteToken ?? ""}
          session={session}
          onJoined={(s) => {
            stripAuthParams();
            onSession(s);
          }}
          onSignInFirst={(invitedEmail) => {
            setPendingInvite(inviteToken);
            setEmail(invitedEmail);
            go("signin", "Sign in, and you'll join the workspace right after.");
          }}
          onSkip={() => {
            stripAuthParams();
            if (session) onSession(session);
            else go("signin");
          }}
          onForgot={() => {
            stripAuthParams();
            go("forgot");
          }}
        />
      );
      break;
    case "key":
      card = <KeyCard onConnected={onApiKey} onBack={() => go("signin")} initialError={notice} />;
      break;
    default:
      card = (
        <SignInCard
          email={email}
          onEmail={setEmail}
          notice={notice}
          signupAllowed={signupAllowed}
          onDone={(s) => void finishSignIn(s)}
          onForgot={() => go("forgot")}
          onSignup={() => go("signup")}
          onKey={() => go("key")}
        />
      );
  }

  return (
    <main className="gate">
      {card}
      <button type="button" className="btn btn-ghost gate-theme" onClick={onToggleTheme}>
        {theme === "dark" ? "Light" : "Dark"}
      </button>
    </main>
  );
}

/** The workspace's logo and name over the sign-in form (the server knows the brand before anyone signs in). */
function GateBrand() {
  const brand = useBrand();
  return (
    <div className="gate-brand">
      <BrandMark />
      {brand.name ? <span className="gate-brand-name">{brand.name}</span> : <span className="base-wordmark">base</span>}
      <span className="gate-app">air</span>
    </div>
  );
}

function Notice({ text, tone = "ok" }: { text: string | null; tone?: "ok" | "bad" }) {
  if (!text) return null;
  return (
    <div className={tone === "bad" ? "card-error" : "gate-notice"} role={tone === "bad" ? "alert" : "status"}>
      {text}
    </div>
  );
}

function SignInCard({
  email,
  onEmail,
  notice,
  signupAllowed,
  onDone,
  onForgot,
  onSignup,
  onKey,
}: {
  email: string;
  onEmail: (v: string) => void;
  notice: string | null;
  signupAllowed: boolean | null;
  onDone: (s: Session) => void;
  onForgot: () => void;
  onSignup: () => void;
  onKey: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suite = useSuite();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await api.login(email.trim(), password));
    } catch (err) {
      setError(authError(err, "That email and password don't match."));
      setBusy(false);
    }
  }

  return (
    <form className="gate-card" onSubmit={(e) => void submit(e)}>
      <GateBrand />
      <h1>Sign in</h1>
      <Notice text={notice} />
      {suite.signInWithBase ? (
        <>
          <a className="btn btn-base" href={signInWithBaseHref("/")}>
            <span className="base-mark" aria-hidden="true">
              base
            </span>
            Sign in with base
          </a>
          <div className="gate-or" role="separator">
            <span>or with email and password</span>
          </div>
        </>
      ) : null}
      <label className="field">
        <span>Email</span>
        <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => onEmail(e.target.value)} autoFocus={!email && !suite.signInWithBase} />
      </label>
      <div className="field">
        <span className="field-row">
          <label htmlFor="signin-password">Password</label>
          <button type="button" className="linkish gate-link" onClick={onForgot}>
            Forgot password?
          </button>
        </span>
        <input id="signin-password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={!!email} />
      </div>
      <Notice text={error} tone="bad" />
      <button className="btn btn-primary" type="submit" disabled={busy || !email.trim() || !password}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      <div className="gate-foot">
        {signupAllowed !== false ? (
          <span className="muted small">
            New here?{" "}
            <button type="button" className="linkish gate-link" onClick={onSignup}>
              Create an account
            </button>
          </span>
        ) : (
          <span className="muted small">New here? Ask a workspace owner for an invite.</span>
        )}
        <button type="button" className="linkish gate-quiet" onClick={onKey}>
          Use an API key instead
        </button>
      </div>
      {USE_FIXTURES ? <p className="muted small gate-sample">Sample data: any email works. The password “wrong” shows a failed sign-in.</p> : null}
    </form>
  );
}

function SignupCard({ initialEmail, onDone, onSignIn }: { initialEmail: string; onDone: (s: Session) => void; onSignIn: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const short = password.length > 0 && password.length < MIN_PASSWORD;
  const ready = name.trim() && email.trim() && password.length >= MIN_PASSWORD && workspaceName.trim();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await api.signup({ name: name.trim(), email: email.trim(), password, workspaceName: workspaceName.trim(), timezone: browserTz() }));
    } catch (err) {
      if (isApiError(err) && err.status === 403) setError("This server isn't taking new sign-ups. Ask a workspace owner to invite you.");
      else if (isApiError(err) && err.status === 409) setError("There's already an account with that email. Sign in instead.");
      else setError(authError(err, "Couldn't create the account."));
      setBusy(false);
    }
  }

  return (
    <form className="gate-card" onSubmit={(e) => void submit(e)}>
      <GateBrand />
      <h1>Create your account</h1>
      <p className="muted">You'll be the owner of a new workspace. Invite your team once you're in.</p>
      <label className="field">
        <span>Your name</span>
        <input className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="field">
        <span>Email</span>
        <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="field">
        <span>Password</span>
        <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <span className={`small ${short ? "field-warn" : "muted"}`}>At least {MIN_PASSWORD} characters</span>
      </label>
      <label className="field">
        <span>Workspace name</span>
        <input className="input" placeholder="Your brand or client" value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} />
      </label>
      <Notice text={error} tone="bad" />
      <button className="btn btn-primary" type="submit" disabled={busy || !ready}>
        {busy ? "Creating…" : "Create account"}
      </button>
      <div className="gate-foot">
        <span className="muted small">
          Have an account?{" "}
          <button type="button" className="linkish gate-link" onClick={onSignIn}>
            Sign in
          </button>
        </span>
      </div>
    </form>
  );
}

function ForgotCard({ initialEmail, onBack }: { initialEmail: string; onBack: (note: string | null) => void }) {
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether this server emails reset links at all (the signed-out session check says); null until known.
  const [mail, setMail] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.session().then(
      () => undefined,
      (e: unknown) => {
        const v = isApiError(e) && e.details && typeof e.details === "object" ? (e.details as { mail?: unknown }).mail : undefined;
        if (!cancelled && typeof v === "boolean") setMail(v);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.forgot(email.trim());
      setSent(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="gate-card" onSubmit={(e) => void submit(e)}>
      <GateBrand />
      <h1>Reset your password</h1>
      {mail === false ? (
        <>
          <p>This server doesn't send email yet, so a reset link can't be mailed to you.</p>
          <p className="muted small">
            Ask whoever runs base air for a one-time reset link. From a shell on the server: <code>node --import tsx src/admin.ts reset-link you@example.com</code>
          </p>
          <button type="button" className="btn btn-primary" onClick={() => onBack(null)}>
            Back to sign in
          </button>
        </>
      ) : sent ? (
        <>
          <p>If {email.trim()} has an account, a reset link is on its way. It works for one hour.</p>
          <p className="muted small">Nothing arrived? Check spam, or ask a workspace owner: this server may not send email.</p>
          <button type="button" className="btn btn-primary" onClick={() => onBack(null)}>
            Back to sign in
          </button>
        </>
      ) : (
        <>
          <p className="muted">We'll email you a link to choose a new one.</p>
          <label className="field">
            <span>Email</span>
            <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </label>
          <Notice text={error} tone="bad" />
          <button className="btn btn-primary" type="submit" disabled={busy || !email.trim()}>
            {busy ? "Sending…" : "Send reset link"}
          </button>
          <div className="gate-foot">
            <button type="button" className="linkish gate-link small" onClick={() => onBack(null)}>
              Back to sign in
            </button>
          </div>
        </>
      )}
    </form>
  );
}

function ResetCard({ token, onDone, onForgot }: { token: string; onDone: () => void; onForgot: () => void }) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const short = password.length > 0 && password.length < MIN_PASSWORD;
  const mismatch = again.length > 0 && again !== password;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < MIN_PASSWORD || password !== again) return;
    setBusy(true);
    setError(null);
    try {
      await api.reset(token, password);
      onDone();
    } catch (err) {
      setError(isApiError(err) && (err.status === 404 || err.status === 410) ? "This reset link has expired or was already used." : authError(err, "This reset link has expired."));
      setBusy(false);
    }
  }

  return (
    <form className="gate-card" onSubmit={(e) => void submit(e)}>
      <GateBrand />
      <h1>Choose a new password</h1>
      <label className="field">
        <span>New password</span>
        <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        <span className={`small ${short ? "field-warn" : "muted"}`}>At least {MIN_PASSWORD} characters</span>
      </label>
      <label className="field">
        <span>Type it again</span>
        <input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        {mismatch ? <span className="small field-warn">These don't match yet</span> : null}
      </label>
      <Notice text={error} tone="bad" />
      <button className="btn btn-primary" type="submit" disabled={busy || password.length < MIN_PASSWORD || password !== again}>
        {busy ? "Saving…" : "Save password"}
      </button>
      <div className="gate-foot">
        <button type="button" className="linkish gate-link small" onClick={onForgot}>
          Send a new link
        </button>
      </div>
    </form>
  );
}

function InviteCard({
  token,
  session,
  onJoined,
  onSignInFirst,
  onSkip,
  onForgot,
}: {
  token: string;
  session: Session | null;
  onJoined: (s: Session) => void;
  onSignInFirst: (email: string) => void;
  onSkip: () => void;
  onForgot: () => void;
}) {
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .inviteInfo(token)
      .then((i) => {
        if (!cancelled) setInfo(i);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setGone(isApiError(e) && e.status === 404 ? "This invite has expired or was already used. Ask whoever sent it for a new one." : errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const signedIn = session !== null;
  const existing = info?.userExists === true;
  const ready = signedIn || (existing ? password.length > 0 : name.trim() && password.length >= MIN_PASSWORD);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const input = signedIn ? { token } : existing ? { token, password } : { token, name: name.trim(), password };
      onJoined(await api.acceptInvite(input));
    } catch (err) {
      if (isApiError(err) && err.status === 409) setError("There's already an account for this email. Sign in, and you'll join right after.");
      else setError(authError(err, existing ? "That password doesn't match the account for this email." : "Couldn't join with that. Try again."));
      setBusy(false);
    }
  }

  if (gone) {
    return (
      <div className="gate-card">
        <GateBrand />
        <h1>Invite not found</h1>
        <p className="muted">{gone}</p>
        <button type="button" className="btn btn-primary" onClick={onSkip}>
          {signedIn ? "Go to base air" : "Sign in"}
        </button>
      </div>
    );
  }
  if (!info) {
    return (
      <div className="gate-card">
        <GateBrand />
        <p className="muted">Opening the invite…</p>
      </div>
    );
  }

  const role = roleLabel(info.role).toLowerCase();
  return (
    <form className="gate-card" onSubmit={(e) => void submit(e)}>
      <GateBrand />
      <h1>Join {info.workspaceName}</h1>
      <p>
        You're invited as {role === "owner" || role === "approver" || role === "editor" ? "an" : "a"} <span className="strong">{role}</span>.
      </p>
      <dl className="kv gate-kv">
        <div className="kv-row">
          <dt>Email</dt>
          <dd>{info.email}</dd>
        </div>
        <div className="kv-row">
          <dt>Expires</dt>
          <dd>{formatDateTime(info.expiresAt)}</dd>
        </div>
      </dl>
      {signedIn ? (
        <p className="muted small">You're signed in as {session.user.email}.</p>
      ) : existing ? (
        <>
          <p className="muted small">This email already has a base air account. Enter its password to join.</p>
          <div className="field">
            <span className="field-row">
              <label htmlFor="invite-password">Password</label>
              <button type="button" className="linkish gate-link" onClick={onForgot}>
                Forgot password?
              </button>
            </span>
            <input id="invite-password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </div>
        </>
      ) : (
        <>
          <p className="muted small">New to base air? Add your name and a password.</p>
          <label className="field">
            <span>Your name</span>
            <input className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <label className="field">
            <span>Password</span>
            <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <span className={`small ${password.length > 0 && password.length < MIN_PASSWORD ? "field-warn" : "muted"}`}>At least {MIN_PASSWORD} characters</span>
          </label>
        </>
      )}
      <Notice text={error} tone="bad" />
      <button className="btn btn-primary" type="submit" disabled={busy || !ready}>
        {busy ? "Joining…" : `Join ${info.workspaceName}`}
      </button>
      <div className="gate-foot">
        {signedIn ? (
          <button type="button" className="linkish gate-link small" onClick={onSkip}>
            Not now
          </button>
        ) : info.userExists === undefined ? (
          <span className="muted small">
            Already have an account?{" "}
            <button type="button" className="linkish gate-link" onClick={() => onSignInFirst(info.email)}>
              Sign in
            </button>
          </span>
        ) : null}
      </div>
    </form>
  );
}

/** Developers: paste a workspace API key. It stays in this browser. */
function KeyCard({ onConnected, onBack, initialError }: { onConnected: (key: string) => void; onBack: () => void; initialError: string | null }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const k = value.trim();
    if (!k) return;
    setBusy(true);
    setError(null);
    setApiKey(k); // the client reads the key from storage
    try {
      await api.me();
      onConnected(k);
    } catch (err) {
      setApiKey(null);
      setError(isApiError(err) && err.status === 401 ? "That key didn't work." : errorText(err));
      setBusy(false);
    }
  }

  return (
    <form className="gate-card" onSubmit={(e) => void submit(e)}>
      <GateBrand />
      <h1>Use an API key</h1>
      <p className="muted">For developers and agents. Paste a workspace API key; it stays in this browser.</p>
      <label className="field">
        <span>API key</span>
        <input
          className="input mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="air_…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
      </label>
      <Notice text={error} tone="bad" />
      <button className="btn btn-primary" type="submit" disabled={busy || !value.trim()}>
        {busy ? "Checking…" : "Connect"}
      </button>
      <div className="gate-foot">
        <span className="hint muted small">
          No key yet? Run <code className="mono">pnpm seed</code> to mint a dev key.
        </span>
        <button type="button" className="linkish gate-link small" onClick={onBack}>
          Sign in with email
        </button>
      </div>
    </form>
  );
}
