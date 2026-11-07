import { describe, expect, it } from "vitest";
import { applyCompleted, CAMPAIGN_SLUGS, EMPTY_STATE, nextStep, RUNGS, THANKS, type Completed, type EngagementState } from "@/lib/engagement";

const all: EngagementState = { signedPledge: true, signedPetition: true, newsletterConfirmed: true, hasShift: true, memberActive: true, monthlyDonor: true, hasReferred: false };

describe("the ladder", () => {
  it("runs pledge → petition → newsletter → shift → member → monthly → recruit", () => {
    expect(RUNGS).toEqual(["pledge", "petition", "newsletter", "shift", "member", "monthly", "recruit"]);
  });

  it("starts a stranger on the pledge, linked to the campaign page with the next-step source", () => {
    const step = nextStep(EMPTY_STATE);
    expect(step.rung).toBe("pledge");
    expect(step.cta.href).toBe(`/act/${CAMPAIGN_SLUGS.pledge}?source=next-step`);
  });

  it("moves to the first rung not yet done", () => {
    expect(nextStep({ ...EMPTY_STATE, signedPledge: true }).rung).toBe("petition");
    expect(nextStep({ ...EMPTY_STATE, signedPledge: true, signedPetition: true }).rung).toBe("newsletter");
    expect(nextStep({ ...EMPTY_STATE, signedPledge: true, signedPetition: true, newsletterConfirmed: true }).rung).toBe("shift");
    expect(nextStep({ ...all, memberActive: false, monthlyDonor: false }).rung).toBe("member");
    expect(nextStep({ ...all, monthlyDonor: false }).rung).toBe("monthly");
  });

  it("skips rungs already climbed even when earlier ones are missing", () => {
    // A member who never signed the pledge is still asked for the pledge first: it is the easiest ask.
    expect(nextStep({ ...EMPTY_STATE, memberActive: true }).rung).toBe("pledge");
  });

  it("tops out at bringing a neighbour, and never reads as done", () => {
    expect(nextStep(all)).toMatchObject({ rung: "recruit", title: "Bring a neighbour" });
    expect(nextStep({ ...all, hasReferred: true })).toMatchObject({ rung: "recruit", title: "Bring another neighbour" });
  });

  it("never asks for what the person just did", () => {
    expect(nextStep(EMPTY_STATE, "pledge").rung).toBe("petition");
    expect(nextStep({ ...EMPTY_STATE, signedPledge: true }, "petition").rung).toBe("newsletter");
    // A pending double opt-in counts as done: asking again would nag.
    expect(nextStep({ ...EMPTY_STATE, signedPledge: true, signedPetition: true }, "newsletter").rung).toBe("shift");
    expect(nextStep({ ...all, memberActive: false, monthlyDonor: false }, "member").rung).toBe("monthly");
  });

  it("treats a one-off donation, an order or an RSVP as encouragement, not a rung", () => {
    for (const completed of ["donation", "order", "rsvp"] as Completed[]) {
      expect(nextStep(EMPTY_STATE, completed).rung).toBe("pledge");
    }
  });

  it("tags every call to action with ?source=next-step", () => {
    const states: EngagementState[] = [
      EMPTY_STATE,
      { ...EMPTY_STATE, signedPledge: true },
      { ...EMPTY_STATE, signedPledge: true, signedPetition: true },
      { ...EMPTY_STATE, signedPledge: true, signedPetition: true, newsletterConfirmed: true },
      { ...all, memberActive: false, monthlyDonor: false },
      { ...all, monthlyDonor: false },
      all,
    ];
    const seen = new Set<string>();
    for (const state of states) {
      const step = nextStep(state);
      seen.add(step.rung);
      expect(step.cta.href).toMatch(/[?&]source=next-step(#|$)/);
      if (step.secondary) expect(step.secondary.href).toMatch(/[?&]source=next-step/);
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.body.length).toBeGreaterThan(0);
    }
    expect([...seen].sort()).toEqual([...RUNGS].sort());
  });

  it("keeps the newsletter link's anchor after the query string", () => {
    const step = nextStep({ ...EMPTY_STATE, signedPledge: true, signedPetition: true });
    expect(step.cta.href).toBe("/?source=next-step#newsletter");
  });

  it("does not mutate the state it is given", () => {
    const state = { ...EMPTY_STATE };
    applyCompleted(state, "pledge");
    nextStep(state, "member");
    expect(state).toEqual(EMPTY_STATE);
  });

  it("has a thank-you line for every completed action", () => {
    for (const c of ["pledge", "petition", "newsletter", "rsvp", "shift", "member", "donation", "order"] as Completed[]) expect(THANKS[c]).toBeTruthy();
  });
});
