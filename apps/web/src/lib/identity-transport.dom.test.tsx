// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => {
  const transport = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", transport);
  return transport;
});
vi.mock("@ws-model-proxy/env/web", () => ({ env: { VITE_SERVER_URL: "https://app.test" } }));
vi.mock("@ws-model-proxy/ui/lib/toast", () => ({ toast: { error: vi.fn() } }));

import { toast } from "@ws-model-proxy/ui/lib/toast";
import { createAppMutationCache } from "@/utils/mutation-error-toast";
import { orpc } from "@/utils/orpc";
import {
  admitRouteIdentity,
  observeDocumentIdentity,
  onDocumentReplaced,
  replaceDocument,
  resetDocumentIdentityForTests,
  sealQueryClient,
} from "./document-identity";

const reload = vi.fn();
const formError = vi.fn();
let client: QueryClient;
let stop: () => void;
beforeEach(async () => {
  resetDocumentIdentityForTests(() => undefined);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { reload, pathname: "/en-US/settings" },
  });
  document.documentElement.style.removeProperty("display");
  reload.mockClear();
  formError.mockClear();
  vi.mocked(toast.error).mockClear();
  fetchMock.mockReset();
  await admitRouteIdentity({ status: "resolved", session: { user: { id: "a" } } });
  client = new QueryClient({ mutationCache: createAppMutationCache((key) => key) });
  stop = onDocumentReplaced(() => sealQueryClient(client));
});
afterEach(() => {
  cleanup();
  stop();
  client.clear();
  document.documentElement.style.removeProperty("display");
});
function Form() {
  const [error, setError] = useState("");
  const mutation = useMutation({
    ...orpc.settings.update.mutationOptions(),
    onError: (error) => {
      formError(error);
      setError("form failure");
    },
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate({ operationalAlerts: true });
      }}
    >
      <button type="submit">Save</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
describe("mounted document cookie switch", () => {
  it("409 replaces before any mutation toast or inline form error", async () => {
    fetchMock.mockResolvedValue(Response.json({ code: "IDENTITY_CHANGED" }, { status: 409 }));
    client.setQueryData(["private"], "A data");
    render(
      <QueryClientProvider client={client}>
        <Form />
      </QueryClientProvider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce(), { timeout: 5000 });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Expected-User")).toBe("a");
    await waitFor(() => expect(reload).toHaveBeenCalledOnce(), { timeout: 5000 });
    expect(client.getQueryData(["private"])).toBeUndefined();
    expect(toast.error).not.toHaveBeenCalled();
    expect(formError).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.documentElement.style.display).toBe("none");
  });
  it("a late mounted mutation cannot put A data back in the sealed cache", async () => {
    let finish!: (value: string) => void;
    function LateForm() {
      const mutation = useMutation({
        mutationFn: () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
        onSuccess: (value) => client.setQueryData(["private"], value),
      });
      return (
        <button type="button" onClick={() => mutation.mutate()}>
          Write
        </button>
      );
    }
    render(
      <QueryClientProvider client={client}>
        <LateForm />
      </QueryClientProvider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Write" }));
    });
    expect(observeDocumentIdentity("b")).toBe(true);
    replaceDocument();
    await act(async () => {
      finish("A late data");
    });
    expect(reload).toHaveBeenCalledOnce();
    expect(client.getQueryData(["private"])).toBeUndefined();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
