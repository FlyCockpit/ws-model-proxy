// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
}));

import { CliAccessSummary } from "./cli-access-summary";

afterEach(cleanup);

describe("CliAccessSummary", () => {
  it("shows the grant, the machine's own setting and the stricter result per feature", () => {
    render(
      <CliAccessSummary
        device={{
          features: {
            terminal: {
              granted: true,
              deviceAllows: false,
              supported: true,
              live: true,
              available: false,
            },
            commands: {
              mode: "unsupervised",
              deviceMode: "supervised",
              supported: true,
              live: true,
              effectiveMode: "supervised",
              available: true,
            },
          },
          fileTools: { read: "off", write: "off" },
          mcpFileRead: false,
          reportedMcpFileRead: null,
        }}
      />,
    );
    const row = (name: string) =>
      within(screen.getByRole("rowheader", { name }).closest("tr") as HTMLElement)
        .getAllByRole("cell")
        .map((cell) => cell.textContent);
    expect(row("dashboard:clis.access.terminal")).toEqual([
      "dashboard:clis.access.on",
      "dashboard:clis.access.blocks",
      "dashboard:clis.access.unavailable",
    ]);
    expect(row("dashboard:clis.access.commands")).toEqual([
      "dashboard:clis.features.commandModes.unsupervised",
      "dashboard:clis.features.commandModes.supervised",
      "dashboard:clis.features.commandModes.supervised",
    ]);
    expect(row("dashboard:clis.access.fileRead")).toEqual([
      "dashboard:clis.access.off",
      "dashboard:clis.access.notReported",
      "dashboard:clis.access.off",
    ]);
  });
});
