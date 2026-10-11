/**
 * The Welcome stepper's steps, in order. The keys match `activity.overview.summary`'s
 * `onboarding.steps`, so the Overview checklist and Welcome agree on what is done.
 */
export const WELCOME_STEPS = ["node", "runtime", "pool", "agent", "apiKey"] as const;
export type WelcomeStep = (typeof WELCOME_STEPS)[number];
export type WelcomeProgress = Record<WelcomeStep, boolean>;

/** `?step=` of the Welcome page; anything else means "pick for me". */
export function parseWelcomeStep(value: unknown): WelcomeStep | undefined {
  return WELCOME_STEPS.find((step) => step === value);
}

/** The first step not done yet (the last step once everything is). */
export function firstOpenStep(progress: WelcomeProgress): WelcomeStep {
  return WELCOME_STEPS.find((step) => !progress[step]) ?? "apiKey";
}

/** The step after `step`, or null after the last one. */
export function nextStep(step: WelcomeStep): WelcomeStep | null {
  return WELCOME_STEPS[WELCOME_STEPS.indexOf(step) + 1] ?? null;
}

/** The step before `step`, or null on the first one. */
export function previousStep(step: WelcomeStep): WelcomeStep | null {
  const index = WELCOME_STEPS.indexOf(step);
  return index > 0 ? (WELCOME_STEPS[index - 1] ?? null) : null;
}

/** Session-storage flag: Welcome was offered in this tab, so the Overview stops sending people there. */
export const WELCOME_OFFERED_FLAG = "wsmp:welcome-offered";

/**
 * A first sign-in: getting started is not finished or dismissed, nothing is set up yet, and this
 * tab has not been sent to Welcome already.
 */
export function shouldOfferWelcome(
  onboarding: { done: boolean; steps: WelcomeProgress },
  alreadyOffered: boolean,
): boolean {
  if (alreadyOffered || onboarding.done) return false;
  return WELCOME_STEPS.every((step) => !onboarding.steps[step]);
}
