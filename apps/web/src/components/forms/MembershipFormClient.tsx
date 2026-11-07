"use client";

import Link from "next/link";
import { useState } from "react";
import { site } from "@/content/site";
import {
  isYouthMember,
  membershipAmountProblem,
  membershipMinimumFor,
  membershipSuggestions,
  YOUTH_MAX_AGE,
  YOUTH_MIN_AGE,
  type MembershipMinimums,
} from "@/lib/contributions";
import { formatCents } from "@/lib/money";
import { ageOn, CAMPUSES, MIN_MEMBER_AGE, NEIGHBOURHOODS, neighbourhoodForPostalCode, OUTSIDE_SURREY } from "@/lib/neighbourhoods";
import { membershipSchema } from "@/lib/validation";
import { Alert, Checkbox, ConsentCheckbox, ErrorSummary, Honeypot, LiveRegion, PostalCodeField, SelectField, SubmitButton, SuccessCard, TextField, TrackingFields } from "./Field";
import { HumanCheck } from "./HumanCheck";
import { parseMembershipAmount } from "./amount";
import { readForm, useApiForm } from "./useApiForm";

const LANGUAGES: [string, string?, string?][] = [
  ["English"],
  ["Punjabi", "ਪੰਜਾਬੀ", "pa"],
  ["Hindi", "हिन्दी", "hi"],
  ["Urdu", "اردو", "ur"],
  ["Mandarin", "普通话", "zh"],
  ["Cantonese", "廣東話", "yue"],
  ["Filipino"],
  ["Korean", "한국어", "ko"],
  ["Vietnamese", "Tiếng Việt", "vi"],
  ["Arabic", "العربية", "ar"],
  ["Farsi", "فارسی", "fa"],
  ["Gujarati", "ગુજરાતી", "gu"],
  ["Spanish", "Español", "es"],
  ["French", "Français", "fr"],
  ["Other", "Another language"],
];
const MAX_LANGUAGES = 6;

const ISSUES = ["Safer streets", "Faster commutes", "Smarter investments", "Lower costs", "Stronger services", "Homes I can afford"];

type Result = { status: "checkout"; url: string } | { status: "received" } | { status: "active" } | { status: "already_member"; expiresAt: string };

const OTHER_ID = "m-amount-other";

/**
 * The membership application. Sends membershipSchema: the existing fields
 * plus languages (up to 6), updatesConsent, smsConsent, source, ref, locale,
 * and the amount chosen. `consent` is the application itself; email and text
 * consent are the two unticked boxes.
 *
 * Membership is by donation: suggested amounts start at the minimum that
 * applies (the youth minimum once the birthdate says 14 to 30), and the
 * minimum is what is selected until the person picks something else.
 */
export function MembershipFormClient({
  minimums,
  maxCents,
  amountTitle,
  amountNote,
}: {
  minimums: MembershipMinimums;
  /** The most anyone can give this year: the contribution limit. */
  maxCents: number;
  amountTitle: string;
  amountNote: string;
}) {
  const feeCents = minimums.standardCents;
  const { submit, pending, error, fields, summaryRef, fail, human } = useApiForm<Result>("/api/membership", { schema: membershipSchema });
  const [hood, setHood] = useState("");
  const [outsideSurrey, setOutsideSurrey] = useState(false);
  const [tooYoung, setTooYoung] = useState(false);
  const [notEligible, setNotEligible] = useState(false);
  const [student, setStudent] = useState(false);
  const [languages, setLanguages] = useState<string[]>([]);
  const [done, setDone] = useState<Result | null>(null);
  const [live, setLive] = useState("");
  const [youth, setYouth] = useState(false);
  // "min" follows the minimum that applies, so nothing above it is ever chosen for the person.
  const [pick, setPick] = useState<"min" | "other" | number>("min");
  const [otherText, setOtherText] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);
  const minCents = membershipMinimumFor(minimums, youth);
  const suggestions = membershipSuggestions(minCents);
  const amountRules = { minimums, youth, maxCents };
  const other = parseMembershipAmount(otherText, amountRules);
  const amountCents = pick === "min" ? minCents : pick === "other" ? other.cents : pick;
  const shownAmountError = (pick === "other" && other.error) || amountError || fields.amountCents || null;
  const blocked = tooYoung || (notEligible && feeCents > 0);

  if (done && done.status !== "checkout") {
    const title = done.status === "already_member" ? "You’re already a member" : "Welcome to Imagine Surrey";
    return (
      <>
        <LiveRegion message={live} />
        <SuccessCard title={title}>
          <p>
            {done.status === "already_member"
              ? `Your membership runs until ${new Date(done.expiresAt).toLocaleDateString("en-CA", { dateStyle: "long" })}. We’ve updated your details.`
              : "Thanks for joining. Watch your inbox for a note from us."}{" "}
            Two things make the biggest difference right now: <Link href="/donate?source=join">chip in</Link> if you can, and tell one neighbour about us.
          </p>
        </SuccessCard>
      </>
    );
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (blocked || pending) return;
    const body = readForm(e.currentTarget);
    if (feeCents > 0) {
      const problem =
        pick === "other" && other.error ? other.error : amountCents === null ? "Choose an amount, or type one in." : membershipAmountProblem(amountCents, minimums, youth, maxCents);
      setAmountError(problem);
      if (problem) {
        fail("Please check the highlighted fields.", { amountCents: problem });
        return;
      }
      body.amountCents = amountCents;
    }
    if (body.smsConsent === true && !String(body.phone ?? "").trim()) {
      fail("Please check the highlighted fields.", { phone: "Add a mobile number so we can text you, or untick the text box" });
      return;
    }
    const result = await submit(body);
    if (!result) return;
    if (result.status === "checkout") {
      window.location.assign(result.url);
      return;
    }
    setLive(result.status === "already_member" ? "You’re already a member. We’ve updated your details." : "Welcome to Imagine Surrey. Thanks for joining.");
    setDone(result);
  }

  const languagesFull = languages.length >= MAX_LANGUAGES;

  return (
    <>
      <LiveRegion message={live} />
      <form className="form-card" onSubmit={onSubmit} noValidate aria-busy={pending || undefined}>
        <Honeypot />
        <TrackingFields />
        <div className="form-row">
          <TextField id="m-first" name="firstName" label="First name" required autoComplete="given-name" error={fields.firstName} />
          <TextField id="m-last" name="lastName" label="Last name" required autoComplete="family-name" error={fields.lastName} />
        </div>
        <div className="form-row">
          <TextField id="m-email" name="email" type="email" label="Email" required autoComplete="email" error={fields.email} />
          <TextField id="m-phone" name="phone" type="tel" label="Mobile number (optional)" autoComplete="tel" error={fields.phone} />
        </div>
        <div className="form-row form-row--address">
          <TextField
            id="m-address"
            name="address"
            label="Street address"
            required
            autoComplete="street-address"
            placeholder="Start typing your address"
            inputClassName="input--search"
            error={fields.address}
          />
          <TextField
            id="m-city"
            name="city"
            label="City"
            required
            defaultValue="Surrey"
            autoComplete="address-level2"
            error={fields.city}
            onChange={(e) => {
              const city = e.target.value.trim().toLowerCase();
              const outside = city !== "" && city !== "surrey";
              setOutsideSurrey(outside);
              if (outside) setHood(OUTSIDE_SURREY);
              else if (hood === OUTSIDE_SURREY) setHood("");
            }}
          />
        </div>
        {outsideSurrey && (
          <Alert tone="note">
            <strong>You live outside Surrey.</strong> You’re welcome to join and help, but members who live outside Surrey don’t have voting rights at
            member meetings.
          </Alert>
        )}
        <div className="form-row">
          <PostalCodeField
            id="m-postal"
            required
            error={fields.postalCode}
            onValueChange={(value) => {
              const match = neighbourhoodForPostalCode(value);
              if (match) setHood(match);
            }}
          />
          <SelectField
            id="m-hood"
            name="neighbourhood"
            label="Neighbourhood"
            required
            value={hood}
            error={fields.neighbourhood}
            onChange={(e) => {
              setHood(e.target.value);
              setOutsideSurrey(e.target.value === OUTSIDE_SURREY);
            }}
          >
            <option value="">Choose one</option>
            {NEIGHBOURHOODS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            <option value={OUTSIDE_SURREY}>I live outside Surrey</option>
          </SelectField>
        </div>
        <p className="hint">Every member joins their neighbourhood committee automatically, so you’ll hear about meetings close to home.</p>

        <fieldset className="group">
          <legend>About you</legend>
          <TextField
            id="m-dob"
            name="birthdate"
            type="date"
            label="Date of birth"
            required
            autoComplete="bday"
            style={{ maxWidth: 260 }}
            error={fields.birthdate}
            onChange={(e) => {
              const age = ageOn(e.target.value, new Date());
              setTooYoung(age !== undefined && age < MIN_MEMBER_AGE);
              const nextYouth = isYouthMember(e.target.value, new Date());
              setYouth(nextYouth);
              // A suggested amount under the new minimum can't stay chosen.
              if (typeof pick === "number" && pick < membershipMinimumFor(minimums, nextYouth)) setPick("min");
              setAmountError(null);
            }}
          />
          {tooYoung && (
            <Alert>
              <strong>Members must be {MIN_MEMBER_AGE} or older.</strong> You can’t join yet, but you can still <a href="#newsletter">get the newsletter</a> and
              follow along.
            </Alert>
          )}
          <SelectField
            id="m-status"
            name="citizenshipStatus"
            label="Are you a Canadian citizen or permanent resident?"
            required
            defaultValue=""
            style={{ maxWidth: 360 }}
            error={fields.citizenshipStatus}
            onChange={(e) => setNotEligible(e.target.value === "Other")}
          >
            <option value="">Choose one</option>
            <option value="Citizen">Canadian citizen</option>
            <option value="Permanent resident">Permanent resident</option>
            <option value="Other">Something else</option>
          </SelectField>
          {notEligible && feeCents > 0 && (
            <Alert>
              <strong>We can’t take a membership fee from you.</strong> Under BC election law, only Canadian citizens and permanent residents who live in BC
              can make contributions, and membership fees count as contributions. You can still <a href="#newsletter">get the newsletter</a>, come to events,
              and volunteer.
            </Alert>
          )}
          <SelectField id="m-gender" name="gender" label="Gender (optional)" defaultValue="" style={{ maxWidth: 260 }} error={fields.gender}>
            <option value="">Prefer not to say</option>
            <option value="Male">Male</option>
            <option value="Female">Female</option>
            <option value="Other">Other</option>
          </SelectField>
          <fieldset className="group" aria-describedby="m-languages-hint">
            <legend className="field-label">Languages you speak</legend>
            <p className="field-hint" id="m-languages-hint">
              Choose up to {MAX_LANGUAGES}.{languagesFull ? ` You’ve chosen ${MAX_LANGUAGES}; untick one to change.` : ""}
            </p>
            <div className="lang-grid">
              {LANGUAGES.map(([value, native, lang], i) => {
                const checked = languages.includes(value);
                return (
                  <label key={value} className="check" htmlFor={`m-lang-${i}`}>
                    <input
                      type="checkbox"
                      id={`m-lang-${i}`}
                      name="languages"
                      value={value}
                      data-group="true"
                      checked={checked}
                      disabled={!checked && languagesFull}
                      onChange={(e) => setLanguages((l) => (e.target.checked ? [...l, value] : l.filter((x) => x !== value)))}
                    />
                    {value === "Other" ? (
                      <span>{native}</span>
                    ) : native ? (
                      <span>
                        {value} ·{" "}
                        <span lang={lang} dir="auto">
                          {native}
                        </span>
                      </span>
                    ) : (
                      <span>{value}</span>
                    )}
                  </label>
                );
              })}
            </div>
            {fields.languages && <p className="field-error">{fields.languages}</p>}
          </fieldset>
          <Checkbox id="m-student" name="student" onChange={(e) => setStudent(e.currentTarget.checked)} error={fields.student}>
            I’m a student and I’d like to join a campus club
          </Checkbox>
          {student && (
            <SelectField id="m-campus" name="campus" label="Which campus?" defaultValue="" error={fields.campus}>
              <option value="">Choose one</option>
              {CAMPUSES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </SelectField>
          )}
        </fieldset>

        <TextField id="m-issue" name="issue" label="What’s one thing that you imagine for Surrey?" list="m-issue-options" placeholder="Pick one or type your own" error={fields.issue} />
        <datalist id="m-issue-options">
          {ISSUES.map((i) => (
            <option key={i} value={i} />
          ))}
        </datalist>

        <fieldset className="group">
          <legend>I’m interested in</legend>
          <Checkbox id="m-volunteer" name="interestVolunteer" error={fields.interestVolunteer}>
            Volunteering
          </Checkbox>
          <Checkbox id="m-lawn-sign" name="interestLawnSign" error={fields.interestLawnSign}>
            A lawn sign, when the time comes
          </Checkbox>
        </fieldset>

        <fieldset className="group">
          <legend>Keep in touch</legend>
          <ConsentCheckbox id="m-updates" kind="updates" error={fields.updatesConsent} />
          <ConsentCheckbox id="m-sms" kind="sms" error={fields.smsConsent} />
        </fieldset>
        {feeCents > 0 && (
          <fieldset className="group" aria-describedby="m-amount-hint">
            <legend>{amountTitle}</legend>
            <p className="field-hint" id="m-amount-hint" style={{ margin: 0 }}>
              {amountNote} The minimum is {formatCents(minimums.standardCents)} a year
              {minimums.youthCents < minimums.standardCents ? `, or ${formatCents(minimums.youthCents)} if you’re ${YOUTH_MIN_AGE} to ${YOUTH_MAX_AGE}` : ""}.
              {youth && minimums.youthCents < minimums.standardCents ? " The youth minimum applies to you." : ""}
            </p>
            <div role="group" aria-label="Suggested amounts" className="amounts">
              {suggestions.map((cents) => (
                <button
                  key={cents}
                  type="button"
                  className="amount"
                  aria-pressed={pick === "other" ? false : pick === "min" ? cents === minCents : pick === cents}
                  onClick={() => {
                    setPick(cents === minCents ? "min" : cents);
                    setOtherText("");
                    setAmountError(null);
                  }}
                >
                  {formatCents(cents)}
                </button>
              ))}
            </div>
            <div className="field">
              <label htmlFor={OTHER_ID}>Other amount</label>
              <div className="custom-amount">
                <span aria-hidden="true">$</span>
                <input
                  id={OTHER_ID}
                  data-field="amountCents"
                  className="input"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder={`${minCents / 100} or more`}
                  value={otherText}
                  aria-invalid={shownAmountError ? true : undefined}
                  aria-describedby={shownAmountError ? `${OTHER_ID}-error` : undefined}
                  onChange={(e) => {
                    setOtherText(e.target.value);
                    setAmountError(null);
                    setPick(e.target.value.trim() === "" ? "min" : "other");
                  }}
                />
              </div>
              {shownAmountError && (
                <p className="field-error" id={`${OTHER_ID}-error`}>
                  {shownAmountError}
                </p>
              )}
            </div>
          </fieldset>
        )}
        <Checkbox id="m-consent" name="consent" required error={fields.consent}>
          I’m applying to become a member of Imagine Surrey. The details above are mine and accurate, and I’ve read the{" "}
          <a href={site.privacyUrl}>privacy policy</a>.
        </Checkbox>

        <HumanCheck control={human} error={fields.human} />
        <ErrorSummary ref={summaryRef} error={error} fields={fields} />
        <SubmitButton pending={pending} disabled={blocked} className="btn btn--red btn--lg btn--block">
          {feeCents > 0 && amountCents !== null && !(pick === "other" && other.error) ? `Join Imagine Surrey · ${formatCents(amountCents)} a year` : "Join Imagine Surrey"}
        </SubmitButton>
        <p className="small">
          {feeCents > 0 &&
            `You’ll pay securely with Stripe. Membership runs for a year, and you renew at whatever amount you choose. It counts as a contribution under BC election law (up to ${formatCents(maxCents)} a year in all) and isn’t tax deductible. `}
          Your details stay with Imagine Surrey.
        </p>
      </form>
    </>
  );
}
