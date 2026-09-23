// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangedCliTrust, CliTrust } from "@/lib/terminal-cli-identity";
import type { ListedCli } from "@/lib/terminal-protocol";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { TerminalCliIdentities } from "./terminal-cli-identities";

afterEach(() => cleanup());

function cli(cliDeviceId: string, terminalViewers: boolean): ListedCli {
  return {
    cliDeviceId,
    slug: cliDeviceId,
    publicKey: "pk",
    terminalViewers,
    identityPublicKey: terminalViewers ? "ik" : null,
    identitySignature: terminalViewers ? "sig" : null,
  };
}

function renderList(clis: ListedCli[], trust: Record<string, CliTrust>, applied = true) {
  const onTrustNewKey = vi.fn(async (_cliDeviceId: string, _expected: ChangedCliTrust) => applied);
  const view = render(
    <TerminalCliIdentities
      clis={clis}
      trust={trust}
      labelFor={(id) => `label-${id}`}
      onTrustNewKey={onTrustNewKey}
    />,
  );
  const rerender = (next: Record<string, CliTrust>) =>
    view.rerender(
      <TerminalCliIdentities
        clis={clis}
        trust={next}
        labelFor={(id) => `label-${id}`}
        onTrustNewKey={onTrustNewKey}
      />,
    );
  return { onTrustNewKey, rerender };
}

const shownChange: ChangedCliTrust = {
  status: "changed",
  pinnedFingerprint: "AAAA AAAA",
  fingerprint: "BBBB BBBB",
  identityPublicKey: "ik",
};

async function openAndConfirm(
  user: ReturnType<typeof userEvent.setup>,
  beforeConfirm?: () => void,
) {
  await user.click(screen.getByRole("button", { name: "dashboard:terminals.identity.trustNew" }));
  const dialog = await screen.findByRole("alertdialog");
  beforeConfirm?.();
  const confirm = within(dialog).getByRole("button", {
    name: "dashboard:terminals.identity.trustNew",
  });
  return { dialog, confirm };
}

describe("TerminalCliIdentities", () => {
  it("shows the fingerprint of a trusted CLI and the unverified notice for a 2.4 CLI", () => {
    renderList([cli("new", true), cli("old", false)], {
      new: {
        status: "trusted",
        fingerprint: "EHI6 GLCX HTTU Q3DC VR2L P6WK K5PF OMMO",
        terminalPublicKey: "pk",
        firstUse: false,
      },
      old: { status: "unverified" },
    });
    expect(screen.getByText("EHI6 GLCX HTTU Q3DC VR2L P6WK K5PF OMMO")).toBeTruthy();
    expect(screen.getByText("label-old")).toBeTruthy();
    expect(screen.getByText("dashboard:terminals.identity.unverified")).toBeTruthy();
  });

  it("shows both fingerprints and trusts the new key only after confirmation", async () => {
    const user = userEvent.setup();
    const { onTrustNewKey } = renderList([cli("desk", true)], {
      desk: {
        status: "changed",
        pinnedFingerprint: "AAAA AAAA",
        fingerprint: "BBBB BBBB",
        identityPublicKey: "ik",
      },
    });
    expect(screen.getByText("dashboard:terminals.identity.changed")).toBeTruthy();
    expect(screen.getByText("AAAA AAAA")).toBeTruthy();
    expect(screen.getByText("BBBB BBBB")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "dashboard:terminals.identity.trustNew" }));
    expect(onTrustNewKey).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("dashboard:terminals.identity.trustDescription");
    const confirm = screen
      .getAllByRole("button", { name: "dashboard:terminals.identity.trustNew" })
      .find((button) => dialog.contains(button));
    if (!confirm) throw new Error("no confirm button");
    await user.click(confirm);
    await waitFor(() => expect(onTrustNewKey).toHaveBeenCalledWith("desk", shownChange));
  });

  it("shows the pinned and new fingerprints inside the dialog", async () => {
    const user = userEvent.setup();
    renderList([cli("desk", true)], { desk: shownChange });
    const { dialog } = await openAndConfirm(user);
    expect(within(dialog).getByText("AAAA AAAA")).toBeTruthy();
    expect(within(dialog).getByText("BBBB BBBB")).toBeTruthy();
    expect(within(dialog).getByText("dashboard:terminals.identity.pinned")).toBeTruthy();
    expect(within(dialog).getByText("dashboard:terminals.identity.new")).toBeTruthy();
  });

  it("confirms the snapshot it showed, not a key that arrived while it was open", async () => {
    const user = userEvent.setup();
    const { onTrustNewKey, rerender } = renderList(
      [cli("desk", true)],
      { desk: shownChange },
      false,
    );
    const swapped: ChangedCliTrust = {
      ...shownChange,
      fingerprint: "CCCC CCCC",
      identityPublicKey: "ik-2",
    };
    const { dialog, confirm } = await openAndConfirm(user, () => rerender({ desk: swapped }));
    // The dialog keeps showing what the user is confirming.
    expect(within(dialog).getByText("BBBB BBBB")).toBeTruthy();
    expect(within(dialog).queryByText("CCCC CCCC")).toBeNull();
    await user.click(confirm);
    await waitFor(() => expect(onTrustNewKey).toHaveBeenCalledWith("desk", shownChange));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("dashboard:terminals.identity.keyChangedAgain"),
    );
  });

  it("blocks an invalid 2.5 CLI with a notice and no trust action", () => {
    renderList([cli("bad", true)], { bad: { status: "invalid" } });
    expect(screen.getByText("dashboard:terminals.identity.invalid")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
