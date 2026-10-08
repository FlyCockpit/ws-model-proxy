import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useSessionFlag } from "@/hooks/use-session-flag";
import {
  shouldOfferWelcome,
  WELCOME_OFFERED_FLAG,
  type WelcomeProgress,
} from "@/lib/welcome-steps";

/**
 * The Overview sends a first sign-in (nothing set up, getting started not dismissed) to Welcome,
 * once per tab. `onboarding` is undefined until the summary loads.
 */
export function useOfferWelcome(
  lang: string,
  onboarding: { done: boolean; steps: WelcomeProgress } | undefined,
) {
  const navigate = useNavigate();
  const [offered, setOffered] = useSessionFlag(WELCOME_OFFERED_FLAG);
  const offer = onboarding ? shouldOfferWelcome(onboarding, offered) : false;
  useEffect(() => {
    if (!offer) return;
    setOffered(true);
    void navigate({ to: "/$lang/welcome", params: { lang }, replace: true });
  }, [offer, lang, navigate, setOffered]);
}

/** Welcome marks itself offered, so leaving it for the Overview does not bounce back. */
export function useMarkWelcomeOffered() {
  const [offered, setOffered] = useSessionFlag(WELCOME_OFFERED_FLAG);
  useEffect(() => {
    if (!offered) setOffered(true);
  }, [offered, setOffered]);
}
