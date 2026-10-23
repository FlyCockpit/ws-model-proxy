// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, Suspense, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** A page taking the whole viewport (the maximized terminal) hides the frame's chrome. */

const page = vi.hoisted(() => ({ mounts: 0 }));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  // The page: counts its mounts, so a remount (an xterm losing its screen) would show. A stable
  // ref callback runs once per mounted element.
  const countMount = (element: HTMLDivElement | null) => {
    if (element) page.mounts += 1;
  };
  function Page() {
    return <div ref={countMount} data-testid="page" />;
  }
  return {
    ...actual,
    Outlet: Page,
    Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
}));

vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state: { session: { user: { id: "owner", role: "user" } } } }),
}));

vi.mock("@/hooks/use-needs-you-count", () => ({ useNeedsYouCount: () => 0 }));

import { useHideAppChrome } from "@/hooks/use-hide-app-chrome";
import { useAppChrome } from "@/stores/app-chrome";

import { AppFrame } from "./app-frame";

function mount() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <AppFrame lang="en-US" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  act(() => useAppChrome.setState({ hidden: false }));
  page.mounts = 0;
});

describe("AppFrame with the chrome hidden", () => {
  it("hides the sidebar and page padding, and shows them again, without remounting the page", () => {
    mount();
    const sidebar = document.querySelector('[data-app-nav="sidebar"]');
    const frame = document.querySelector('[data-testid="page"]')?.parentElement;
    if (!sidebar || !frame) throw new Error("no frame");
    expect(sidebar.classList.contains("md:flex")).toBe(true);
    expect(frame.className).toContain("max-w-6xl");

    act(() => useAppChrome.getState().setHidden(true));
    expect(sidebar.classList.contains("md:flex")).toBe(false);
    expect(frame.className).not.toContain("max-w-6xl");
    expect(frame.className).toContain("[--app-page-pad-y:0px]");

    act(() => useAppChrome.getState().setHidden(false));
    expect(sidebar.classList.contains("md:flex")).toBe(true);
    expect(page.mounts).toBe(1);
  });
});

describe("useHideAppChrome", () => {
  it("hides the chrome while active and shows it again when inactive or unmounted", () => {
    const { rerender, unmount } = renderHook(({ active }) => useHideAppChrome(active), {
      initialProps: { active: false },
    });
    expect(useAppChrome.getState().hidden).toBe(false);
    rerender({ active: true });
    expect(useAppChrome.getState().hidden).toBe(true);
    rerender({ active: false });
    expect(useAppChrome.getState().hidden).toBe(false);
    rerender({ active: true });
    unmount();
    expect(useAppChrome.getState().hidden).toBe(false);
  });

  it("shows the chrome while a Suspense fallback hides the page, and hides it again after", async () => {
    // A pending navigation: the page stays mounted but hidden behind the fallback.
    let resolve = () => {};
    let pending: Promise<void> | null = null;
    function Pending() {
      if (pending) throw pending;
      return null;
    }
    function Maximized() {
      useHideAppChrome(true);
      return null;
    }
    let setLoading = (_loading: boolean) => {};
    function Harness() {
      const [loading, set] = useState(false);
      setLoading = set;
      return (
        <Suspense fallback={<p>loading</p>}>
          <Maximized />
          {loading ? <Pending /> : null}
        </Suspense>
      );
    }
    render(<Harness />);
    expect(useAppChrome.getState().hidden).toBe(true);

    pending = new Promise<void>((done) => {
      resolve = done;
    });
    act(() => setLoading(true));
    expect(useAppChrome.getState().hidden).toBe(false);

    // The navigation completes: the page shows again and takes the viewport back.
    pending = null;
    await act(async () => resolve());
    await waitFor(() => expect(useAppChrome.getState().hidden).toBe(true));

    // Cancelled instead: leaving the pending state shows the page as well.
    act(() => setLoading(false));
    pending = new Promise<void>(() => {});
    act(() => setLoading(true));
    expect(useAppChrome.getState().hidden).toBe(false);
    pending = null;
    act(() => setLoading(false));
    await waitFor(() => expect(useAppChrome.getState().hidden).toBe(true));
  });
});
