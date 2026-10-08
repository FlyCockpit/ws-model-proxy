import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useSessionFlag } from "@/hooks/use-session-flag";
import {
  firstOpenStep,
  shouldOfferWelcome,
  WELCOME_OFFERED_FLAG,
  type WelcomeProgress,
  type WelcomeStep,
} from "@/lib/welcome-steps";

/**
 * The Overview sends a first sign-in (nothing set up, getting started not dismissed) to Welcome,
 * once per tab (blocked session storage counts as offered). `onboarding` is undefined until the
 * summary loads.
 */
export function useOfferWelcome(
  lang: string,
  onboarding: { done: boolean; steps: WelcomeProgress } | undefined,
) {
  const navigate = useNavigate();
  const [offered, setOffered] = useSessionFlag(WELCOME_OFFERED_FLAG, false, true);
  const offer = onboarding ? shouldOfferWelcome(onboarding, offered) : false;
  useEffect(() => {
    if (!offer) return;
    setOffered(true);
    void navigate({ to: "/$lang/welcome", params: { lang }, replace: true });
  }, [offer, lang, navigate, setOffered]);
}

/** Welcome marks itself offered, so leaving it for the Overview does not bounce back. */
export function useMarkWelcomeOffered() {
  const [offered, setOffered] = useSessionFlag(WELCOME_OFFERED_FLAG, false, true);
  useEffect(() => {
    if (!offered) setOffered(true);
  }, [offered, setOffered]);
}

/**
 * Welcome without `?step=` picks the first open step once and puts it in the URL (replacing the
 * entry), so the step never changes under the person when the progress refreshes.
 */
export function usePinWelcomeStep(
  lang: string,
  step: WelcomeStep | undefined,
  progress: WelcomeProgress | undefined,
) {
  const navigate = useNavigate();
  const pick = step === undefined && progress ? firstOpenStep(progress) : null;
  useEffect(() => {
    if (!pick) return;
    void navigate({
      to: "/$lang/welcome",
      params: { lang },
      search: { step: pick },
      replace: true,
    });
  }, [pick, lang, navigate]);
}
