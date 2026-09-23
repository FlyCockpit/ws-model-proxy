import { providerCredentialKeyringConfigured } from "@ws-model-proxy/api/lib/provider-credential-crypto";

const MISSING_PROVIDER_KEYRING_WARNING =
  "[server] WMP_PUBLIC_PROVIDER_EGRESS_ENABLED is true but WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS is missing.";

/**
 * One warning when public provider egress is on and the keyring is missing or
 * blank. The message names the variable and never includes the key.
 * Returns whether a warning was logged.
 */
export function warnMissingProviderCredentialKeyring(
  input: { egressEnabled: boolean; keyring: string | null | undefined },
  log: (message: string) => void = console.warn,
): boolean {
  if (!input.egressEnabled || providerCredentialKeyringConfigured(input.keyring)) return false;
  log(MISSING_PROVIDER_KEYRING_WARNING);
  return true;
}
