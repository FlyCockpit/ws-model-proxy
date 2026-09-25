// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { toast } from "@ws-model-proxy/ui/components/sileo";
import type { DeletionEntity } from "./friendly-error";
import { createAppMutationCache } from "./mutation-error-toast";

function DeleteButton({ error, entity }: { error: unknown; entity?: DeletionEntity }) {
  const remove = useMutation({
    mutationFn: async () => {
      throw error;
    },
    meta: { errorFallbackKey: "test:deleteFailed", deletionEntity: entity },
  });
  return (
    <button type="button" onClick={() => remove.mutate()}>
      delete
    </button>
  );
}

function renderDelete(error: unknown, entity?: DeletionEntity) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
    mutationCache: createAppMutationCache((key) => `t(${key})`),
  });
  render(
    <QueryClientProvider client={client}>
      <DeleteButton error={error} entity={entity} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "delete" }));
}

function conflict(reason?: string) {
  return {
    status: 409,
    code: "CONFLICT",
    message: "raw server message",
    ...(reason ? { data: { reason } } : {}),
  };
}

afterEach(() => {
  cleanup();
  vi.mocked(toast.error).mockClear();
});

describe("app mutation error toast for deletes", () => {
  const cases: Array<[string, DeletionEntity, string]> = [
    ["retained_history", "user", "errors:deletionConflict.retainedHistory.user"],
    ["retained_history", "cliDevice", "errors:deletionConflict.retainedHistory.cliDevice"],
    ["retained_history", "endpoint", "errors:deletionConflict.retainedHistory.endpoint"],
    [
      "retained_history",
      "discoveredModel",
      "errors:deletionConflict.retainedHistory.discoveredModel",
    ],
    ["retained_history", "pool", "errors:deletionConflict.retainedHistory.pool"],
    ["retained_history", "poolMember", "errors:deletionConflict.retainedHistory.poolMember"],
    ["retained_history", "capacity", "errors:deletionConflict.retainedHistory.capacity"],
    ["delete_pending", "pool", "errors:deletionConflict.deletePending"],
    ["delete_contended", "endpoint", "errors:deletionConflict.deleteContended"],
    ["still_attached", "capacity", "errors:deletionConflict.stillAttached"],
    ["not_stale", "cliDevice", "errors:deletionConflict.notStale"],
    ["deletion_in_progress", "user", "errors:deletionConflict.deletionInProgress"],
  ];

  for (const [reason, entity, key] of cases) {
    it(`shows the ${reason} copy for a ${entity} delete`, async () => {
      renderDelete(conflict(reason), entity);
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(`t(${key})`));
      expect(toast.error).toHaveBeenCalledTimes(1);
    });
  }

  it("keeps the generic conflict copy for a CONFLICT without a known reason", async () => {
    renderDelete(conflict(), "pool");
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("That conflicts with an existing record."),
    );
  });

  it("keeps the generic conflict copy for a mutation that is not a delete", async () => {
    renderDelete(conflict("retained_history"));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("That conflicts with an existing record."),
    );
  });

  it("uses the context fallback for other failures", async () => {
    renderDelete({ status: 500, code: "INTERNAL_SERVER_ERROR" }, "pool");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("t(test:deleteFailed)"));
  });
});
