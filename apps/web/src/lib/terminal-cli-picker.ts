import { cliDeviceMatchesSearch } from "@ws-model-proxy/config/cli-device-name";

import {
  featureReasonKey,
  type TerminalFeature,
  terminalOpenBlockReason,
} from "@/lib/cli-device-features";
import type { CliTrust } from "@/lib/terminal-cli-identity";

/** One CLI in the new-terminal picker. */
export type CliPickerOption = {
  id: string;
  /** The server-computed display name, else the slug, else the id. */
  name: string;
  slug: string | null;
  reportedHostname: string | null;
  /** Why the CLI cannot open a terminal, as a translation key. */
  blockKey: string | null;
  /** True when the block is an identity problem (shown as destructive). */
  blockIsIdentity: boolean;
};

/**
 * A picker option. A feature block (not granted, offline, ...) wins over an
 * identity block, since fixing the identity would not make the CLI usable.
 */
export function cliPickerOption(input: {
  id: string;
  displayName: string | null;
  slug: string | null;
  reportedHostname: string | null;
  terminal: TerminalFeature;
  trust: CliTrust["status"] | undefined;
}): CliPickerOption {
  const block = terminalOpenBlockReason(input.terminal);
  const identityBlock =
    input.trust === "changed"
      ? "dashboard:terminals.rejection.identity_changed"
      : input.trust === "invalid"
        ? "dashboard:terminals.rejection.identity_invalid"
        : null;
  return {
    id: input.id,
    name: input.displayName ?? input.slug ?? input.id,
    slug: input.slug,
    reportedHostname: input.reportedHostname,
    blockKey: block ? featureReasonKey(block) : identityBlock,
    blockIsIdentity: !block && identityBlock !== null,
  };
}

/** The options matching a search, using the same matcher as the dashboard. */
export function filterCliPickerOptions(
  options: readonly CliPickerOption[],
  query: string,
): CliPickerOption[] {
  return options.filter((option) =>
    cliDeviceMatchesSearch(
      { displayName: option.name, reportedHostname: option.reportedHostname, slug: option.slug },
      query,
    ),
  );
}
