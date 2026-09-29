// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { toast } from "@ws-model-proxy/ui/components/sileo";
import { createAppQueryCache } from "./query-error-toast";

function Failure({ meta }: { meta?: { skipGlobalErrorToast?: boolean } }) {
  useQuery({
    queryKey: ["probe", meta],
    queryFn: async () => {
      throw { status: 409, code: "CONFLICT", message: "raw server message", data: { reason: "x" } };
    },
    retry: false,
    meta,
  });
  return null;
}

function renderProbe(meta?: { skipGlobalErrorToast?: boolean }, invalidate = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    queryCache: createAppQueryCache((key) => `t(${key})`, invalidate),
  });
  render(
    <QueryClientProvider client={client}>
      <Failure meta={meta} />
    </QueryClientProvider>,
  );
  return { client, invalidate };
}

afterEach(() => {
  cleanup();
  vi.mocked(toast.error).mockClear();
});

describe("app query error toast", () => {
  it("toasts a query failure that does not opt out", async () => {
    renderProbe();
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
  });

  it("suppresses the toast when the query sets skipGlobalErrorToast", async () => {
    renderProbe({ skipGlobalErrorToast: true });
    // Give the query time to settle and fail.
    await waitFor(() => expect(toast.error).not.toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("offers a retry action that invalidates the failing query", async () => {
    const { invalidate } = renderProbe();
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    const [, options] = vi.mocked(toast.error).mock.calls[0] as unknown as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(options.action.label).toBe("t(common:actions.retry)");

    options.action.onClick();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate.mock.calls[0]?.[0]).toMatchObject({ queryKey: ["probe", undefined] });
  });
});
