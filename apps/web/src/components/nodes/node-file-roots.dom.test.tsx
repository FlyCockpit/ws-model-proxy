// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/x">{children}</a>,
}));
vi.mock("@/utils/orpc", () => ({ orpc: { nodes: { key: () => ["nodes"] } } }));

import { FileRootsCard } from "./node-info-cards";
import type { NodeDetail } from "./node-types";

afterEach(cleanup);

type Files = NonNullable<NodeDetail["features"]>["files"];

/** Only what the card reads. */
function node(files: Files | null) {
  const partial: Pick<NodeDetail, "id" | "features"> = {
    id: "node-1",
    features: files
      ? {
          terminals: { supported: true, max: 4, approvalRequired: false },
          operatorTerminals: true,
          files,
          runtimeHosts: [],
          mediaExpand: false,
          liveStt: false,
          secrets: [],
        }
      : null,
  };
  return partial as NodeDetail;
}

function wrap(children: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>);
}

describe("FileRootsCard", () => {
  it("lists configured roots with their source and the CLI command, read-only", () => {
    wrap(
      <FileRootsCard
        node={node({
          roots: ["/srv/models", "/home/me/data"],
          asRoot: false,
          source: "configured",
        })}
      />,
    );
    expect(screen.getByText("dashboard:nodes.fileRoots.source.configured")).toBeTruthy();
    expect(screen.getByText("/srv/models")).toBeTruthy();
    expect(screen.getByText("/home/me/data")).toBeTruthy();
    expect(screen.getByText("wsmp config set-file-roots ~/models")).toBeTruthy();
    // No way to change them here: no inputs, no save.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /save|set/i })).toBeNull();
  });

  it("shows the default home root and running as root", () => {
    wrap(<FileRootsCard node={node({ roots: ["/root"], asRoot: true, source: "default" })} />);
    expect(screen.getByText("dashboard:nodes.fileRoots.source.default")).toBeTruthy();
    expect(screen.getByText("dashboard:nodes.fileRoots.asRoot")).toBeTruthy();
    expect(screen.getByText("/root")).toBeTruthy();
  });

  it("says when file tools are off, roots are unusable, or nothing was reported", () => {
    wrap(<FileRootsCard node={node({ roots: null, asRoot: false, source: "disabled" })} />);
    expect(screen.getByText("dashboard:nodes.fileRoots.source.disabled")).toBeTruthy();
    expect(screen.queryByText("dashboard:nodes.fileRoots.unusable")).toBeNull();
    expect(screen.getByText("wsmp config set-file-tools on")).toBeTruthy();
    cleanup();
    wrap(<FileRootsCard node={node({ roots: null, asRoot: false, source: "configured" })} />);
    expect(screen.getByText("dashboard:nodes.fileRoots.unusable")).toBeTruthy();
    cleanup();
    wrap(<FileRootsCard node={node(null)} />);
    expect(screen.getByText("dashboard:nodes.fileRoots.unknown")).toBeTruthy();
  });
});
