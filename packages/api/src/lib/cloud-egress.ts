import { env } from "@ws-model-proxy/env/server";
import { providerCredentialKeyringConfigured } from "./provider-credential-crypto";

/** Cloud calls are possible at all: egress on and a credential keyring configured. */
export function cloudEgressEnabled(): boolean {
  return (
    env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED === true &&
    providerCredentialKeyringConfigured(env.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS)
  );
}
