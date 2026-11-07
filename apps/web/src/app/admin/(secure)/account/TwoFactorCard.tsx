"use client";

import { useActionState, useState } from "react";
import { fieldError, Notice } from "@/components/admin/Notice";
import { SubmitButton } from "@/components/admin/SubmitButton";
import { TextField } from "@/components/forms/Field";
import type { TwoFactorState } from "./actions";

type Action = (state: TwoFactorState, form: FormData) => Promise<TwoFactorState>;

export type TwoFactorCardProps = {
  status: "off" | "pending" | "on";
  required: boolean;
  enabledOn: string | null;
  recoveryCodesLeft: number;
  /** While setting up: the QR code (an SVG path) and the key to type in. */
  setup: { path: string; size: number; secret: string; grouped: string } | null;
  actions: { start: Action; confirm: Action; regenerate: Action; disable: Action };
};

/**
 * Set up, check and turn off two-factor sign-in. Every action's state lives
 * here, at one place in the tree, so the recovery codes stay on screen after
 * the server re-renders the page around them.
 */
export function TwoFactorCard(p: TwoFactorCardProps) {
  const [startState, start] = useActionState(p.actions.start, null);
  const [confirmState, confirm] = useActionState(p.actions.confirm, null);
  const [regenState, regenerate] = useActionState(p.actions.regenerate, null);
  const [disableState, disable] = useActionState(p.actions.disable, null);
  const shown = regenState?.ok && regenState.codes ? regenState : confirmState?.ok && confirmState.codes ? confirmState : null;

  if (shown?.ok && shown.codes) return <RecoveryCodes codes={shown.codes} message={shown.message} continueTo={p.required ? "/admin" : "/admin/account"} />;

  if (p.status === "on") {
    return (
      <div className="stack" style={{ gap: 16 }}>
        <Notice state={disableState} />
        <p style={{ margin: 0 }}>
          <span className="badge badge--navy">On</span> Sign-in asks for a code from your authenticator app{p.enabledOn ? ` (since ${p.enabledOn})` : ""}. You have{" "}
          <strong>{p.recoveryCodesLeft}</strong> unused recovery code{p.recoveryCodesLeft === 1 ? "" : "s"}.
        </p>
        <form action={regenerate} className="stack" style={{ gap: 12 }}>
          <Notice state={regenState} />
          <TextField id="regen-code" name="code" label="Code from your app" required autoComplete="one-time-code" inputMode="numeric" maxLength={40} error={fieldError(regenState, "code")} />
          <div>
            <SubmitButton className="btn btn--outline btn--compact" pendingText="Making new codes…">
              New recovery codes
            </SubmitButton>
          </div>
        </form>
        <form action={disable} className="stack" style={{ gap: 12 }}>
          <TextField
            id="disable-code"
            name="code"
            label="Code from your app, or a recovery code"
            required
            autoComplete="one-time-code"
            maxLength={40}
            error={fieldError(disableState, "code")}
            hint={p.required ? "Owners and administrators must use two-factor sign-in, so you'll be asked to set it up again straight away (for example, on a new phone)." : undefined}
          />
          <div>
            <SubmitButton className="btn btn--red btn--compact" pendingText="Turning off…" confirm="Turn off two-factor sign-in? Your password alone will open your account.">
              Turn off two-factor sign-in
            </SubmitButton>
          </div>
        </form>
      </div>
    );
  }

  if (p.status === "pending" && p.setup) {
    return (
      <div className="stack" style={{ gap: 16 }}>
        <Notice state={startState} />
        <ol className="stack" style={{ gap: 14, margin: 0, paddingLeft: 20 }}>
          <li>
            Open an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, 1Password, Authy…) and scan this code.
            <svg
              role="img"
              aria-label="QR code for setting up your authenticator app"
              viewBox={`0 0 ${p.setup.size} ${p.setup.size}`}
              width={200}
              height={200}
              shapeRendering="crispEdges"
              style={{ display: "block", margin: "12px 0", background: "#fff", maxWidth: "100%", height: "auto" }}
            >
              <path d={p.setup.path} fill="#000" />
            </svg>
          </li>
          <li>
            Can&apos;t scan it? Add an account by hand with this setup key (time-based):
            <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginTop: 8 }}>
              <code id="totp-secret" data-secret={p.setup.secret} style={{ fontSize: 17, letterSpacing: 1, wordBreak: "break-all" }}>
                {p.setup.grouped}
              </code>
              <CopyButton text={p.setup.secret} />
            </span>
          </li>
          <li>Type the 6-digit code the app shows.</li>
        </ol>
        <form action={confirm} className="stack" style={{ gap: 12 }}>
          <Notice state={confirmState} />
          <TextField id="confirm-code" name="code" label="Code from your app" required autoComplete="one-time-code" inputMode="numeric" maxLength={40} error={fieldError(confirmState, "code")} />
          <div>
            <SubmitButton pendingText="Checking…">Turn on two-factor sign-in</SubmitButton>
          </div>
        </form>
        <form action={start}>
          <SubmitButton className="btn btn--outline btn--compact" pendingText="Starting over…" confirm="Start over with a new key? The one on this page stops working.">
            Start over with a new key
          </SubmitButton>
        </form>
      </div>
    );
  }

  return (
    <form action={start} className="stack" style={{ gap: 12 }}>
      <Notice state={disableState} />
      <Notice state={startState} />
      <p style={{ margin: 0 }}>
        Two-factor sign-in asks for a code from an app on your phone after your password or email link, so a stolen password alone can&apos;t open the admin.
        {p.required ? " Owners and administrators must use it." : " It's optional for your role, and recommended."}
      </p>
      <div>
        <SubmitButton pendingText="Starting…">Set up two-factor sign-in</SubmitButton>
      </div>
    </form>
  );
}

function RecoveryCodes({ codes, message, continueTo }: { codes: string[]; message?: string; continueTo: string }) {
  return (
    <div className="stack" style={{ gap: 14 }} role="status" aria-live="polite">
      {message && <p style={{ margin: 0, fontWeight: 700, color: "var(--navy)" }}>{message}</p>}
      <p style={{ margin: 0 }}>
        Save these recovery codes somewhere safe, like a password manager or printed paper. Each one signs you in once if you lose your phone. <strong>They are shown only now.</strong>
      </p>
      <ul id="recovery-codes" style={{ columns: 2, margin: 0, paddingLeft: 20, fontFamily: "ui-monospace, monospace", fontSize: 16 }}>
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <CopyButton text={codes.join("\n")} label="Copy the codes" />
        {/* A full page load, so the admin re-checks the account. */}
        <a className="btn btn--navy btn--compact" href={continueTo}>
          I&apos;ve saved them
        </a>
      </div>
    </div>
  );
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn--outline btn--compact"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </button>
  );
}
