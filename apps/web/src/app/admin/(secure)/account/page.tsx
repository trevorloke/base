import Link from "next/link";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { adminUsers } from "@/lib/db/schema";
import { MFA_REQUIRED_ROLES, mustEnrol } from "@/lib/mfa-policy";
import { qrSvgPath } from "@/lib/qr";
import { parseSessionCookie, PASSWORD_MIN_LENGTH, requireAdmin, ROLE_LABELS, SESSION_COOKIE } from "@/lib/server/admin-auth";
import { enrolmentUri, twoFactorStatus } from "@/lib/server/mfa";
import { getSettings } from "@/lib/server/settings";
import { describeUserAgent, listSessions } from "@/lib/server/staff";
import { groupSecret } from "@/lib/server/totp";
import {
  changePasswordAction,
  confirmTwoFactorAction,
  disableTwoFactorAction,
  regenerateCodesAction,
  renameAction,
  signOutEverywhereAction,
  startTwoFactorAction,
} from "./actions";
import { PasswordForm, RenameForm, SignOutEverywhereForm } from "./AccountForms";
import { TwoFactorCard } from "./TwoFactorCard";
import "../people/people.css";
import { clientProfile } from "@/seeds/client";

const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "short", day: "numeric" });
const WHEN = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * The signed-in admin's own name, password, two-factor sign-in and sessions.
 * Any role. An owner or administrator who hasn't set up two-factor sign-in
 * is sent here by every other admin page, and sees only that until it's on.
 */
export default async function AccountPage() {
  const user = await requireAdmin(undefined, { enrolling: true });
  const db = getDb();
  const [account, sessions, currentId, twoFactor, { org }] = await Promise.all([
    db.query.adminUsers.findFirst({ where: eq(adminUsers.id, user.id), columns: { passwordHash: true } }),
    listSessions(db, user.id),
    cookies().then((jar) => parseSessionCookie(jar.get(SESSION_COOKIE)?.value)?.id ?? null),
    twoFactorStatus(db, user.id),
    getSettings(),
  ]);
  const enrolFirst = mustEnrol(user.role, twoFactor.enabled);
  const setup = twoFactor.pendingSecret
    ? { ...qrSvgPath(enrolmentUri(twoFactor.pendingSecret, user.email, org.name || clientProfile.orgName)), secret: twoFactor.pendingSecret, grouped: groupSecret(twoFactor.pendingSecret) }
    : null;
  const twoFactorCard = (
    <section className="profile-card" aria-labelledby="twofactor-title">
      <h2 id="twofactor-title">Two-factor sign-in</h2>
      {twoFactor.secretUnreadable && twoFactor.enabled && (
        <p role="alert" className="alert">
          The site&apos;s session secret has changed, so your authenticator app&apos;s codes no longer match. Sign in with a recovery code, turn two-factor sign-in off with one, and set it up again.
        </p>
      )}
      <TwoFactorCard
        status={twoFactor.enabled ? "on" : setup ? "pending" : "off"}
        required={MFA_REQUIRED_ROLES.includes(user.role)}
        enabledOn={twoFactor.enabledAt ? DAY.format(twoFactor.enabledAt) : null}
        recoveryCodesLeft={twoFactor.recoveryCodesLeft}
        setup={setup ? { path: setup.d, size: setup.size, secret: setup.secret, grouped: setup.grouped } : null}
        actions={{ start: startTwoFactorAction, confirm: confirmTwoFactorAction, regenerate: regenerateCodesAction, disable: disableTwoFactorAction }}
      />
    </section>
  );

  if (enrolFirst) {
    // Only the set-up is open until it's done; the layout explains why.
    return (
      <>
        <div className="crm-head">
          <h1 className="h3">My account</h1>
          <p className="small">
            {user.email} · {ROLE_LABELS[user.role]}
          </p>
        </div>
        <div style={{ maxWidth: 640 }}>{twoFactorCard}</div>
      </>
    );
  }

  return (
    <>
      <div className="crm-head">
        <h1 className="h3">My account</h1>
        <p className="small">
          {user.email} · {ROLE_LABELS[user.role]}
        </p>
        <nav className="crm-sub" aria-label="Related">
          <Link href="/admin">Dashboard</Link>
        </nav>
      </div>

      <div className="profile-grid">
        <div className="stack" style={{ gap: 24 }}>
          <section className="profile-card" aria-labelledby="name-title">
            <h2 id="name-title">Name</h2>
            <RenameForm action={renameAction} name={user.name} />
          </section>
          <section className="profile-card" aria-labelledby="password-title">
            <h2 id="password-title">Password</h2>
            <PasswordForm action={changePasswordAction} passwordSet={Boolean(account?.passwordHash)} minLength={PASSWORD_MIN_LENGTH} />
          </section>
          {twoFactorCard}
        </div>

        <div className="stack" style={{ gap: 24 }}>
          <section className="profile-card" aria-labelledby="sessions-title">
            <h2 id="sessions-title">Where you&apos;re signed in</h2>
            <ul className="notes">
              {sessions.map((s) => (
                <li key={s.id} className="note">
                  <span className="note__meta">
                    {s.id === currentId ? "This device · " : ""}
                    signed in {WHEN.format(s.createdAt)} · last seen {WHEN.format(s.lastSeenAt)}
                  </span>
                  {describeUserAgent(s.userAgent)}
                  {s.ip ? ` · ${s.ip}` : ""}
                </li>
              ))}
            </ul>
            <SignOutEverywhereForm action={signOutEverywhereAction} />
          </section>
        </div>
      </div>
    </>
  );
}
