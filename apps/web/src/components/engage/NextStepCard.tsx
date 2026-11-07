import Link from "next/link";
import { useId } from "react";
import { EMPTY_STATE, nextStep, SHARE_TEXT, THANKS, type Completed, type NextStep as Step } from "@/lib/engagement";
import { ShareSheet } from "./ShareSheet";
import "./engage.css";

/**
 * The card itself: a thank-you line, one ask, and the share sheet. No data
 * access, so it renders on the server or inside client forms alike.
 */
export function NextStepCard({
  step,
  thanks,
  heading = "Your next step",
  shareUrl,
  shareText = SHARE_TEXT,
  as: Heading = "h2",
}: {
  step: Step;
  thanks?: string;
  heading?: string;
  shareUrl?: string | null;
  shareText?: string;
  as?: "h2" | "h3";
}) {
  const id = useId();
  return (
    <section className="next-step" aria-labelledby={`${id}-title`} data-rung={step.rung}>
      {thanks && <p className="next-step__thanks">{thanks}</p>}
      <p className="next-step__eyebrow">{heading}</p>
      <Heading id={`${id}-title`} className="next-step__title">
        {step.title}
      </Heading>
      <p className="next-step__body">{step.body}</p>
      <div className="next-step__actions">
        <Link href={step.cta.href} className="btn btn--accent btn--lg">
          {step.cta.label}
        </Link>
        {step.secondary && (
          <Link href={step.secondary.href} className="next-step__secondary">
            {step.secondary.label}
          </Link>
        )}
      </div>
      {shareUrl && (
        <div className="next-step__share">
          <ShareSheet url={shareUrl} text={shareText} label="Tell a neighbour" />
        </div>
      )}
    </section>
  );
}

/**
 * The next step when nothing is known about the person (a form's success
 * card, where the email was only just typed): the first rung after what
 * they just did, and the plain site link to share. Safe in client components.
 *
 *   <GenericNextStep completed="petition" as="h3" />
 */
export function GenericNextStep({ completed, heading, shareUrl, as }: { completed: Completed; heading?: string; shareUrl?: string; as?: "h2" | "h3" }) {
  const url = shareUrl ?? process.env.NEXT_PUBLIC_SITE_URL ?? "https://imaginesurrey.ca";
  return <NextStepCard step={nextStep(EMPTY_STATE, completed)} thanks={THANKS[completed]} heading={heading} shareUrl={url} as={as} />;
}
