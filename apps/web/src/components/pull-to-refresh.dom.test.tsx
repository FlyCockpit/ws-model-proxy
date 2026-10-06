// @vitest-environment jsdom
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createPortal } from "react-dom";
import { afterEach, expect, it, vi } from "vitest";
import PullToRefresh from "./pull-to-refresh";

afterEach(cleanup);

function touch(identifier = 1, clientY = 0) {
  return { identifier, clientY };
}

function start(target: Element, identifier = 1) {
  fireEvent.touchStart(target, {
    touches: [touch(identifier)],
    changedTouches: [touch(identifier)],
  });
}

function move(target: Element, clientY = 200, identifier = 1) {
  fireEvent.touchMove(target, {
    touches: [touch(identifier, clientY)],
    changedTouches: [touch(identifier, clientY)],
  });
}

function end(target: Element, identifier = 1) {
  fireEvent.touchEnd(target, { touches: [], changedTouches: [touch(identifier, 200)] });
}

function cancel(target: Element, identifier = 1) {
  fireEvent.touchCancel(target, { touches: [], changedTouches: [touch(identifier, 200)] });
}

function pull(target: Element) {
  start(target);
  move(target);
  end(target);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function mount(refresh = vi.fn(async (): Promise<void> => undefined)) {
  const internalHost = document.createElement("div");
  const view = render(
    <PullToRefresh onRefresh={refresh}>
      <div data-testid="page">
        <svg>
          <path data-testid="svg-path" />
        </svg>
        <div data-testid="nested" style={{ overflowY: "auto", overflowX: "hidden" }}>
          <span data-testid="nested-child" />
        </div>
        <div
          ref={(node) => {
            node?.appendChild(internalHost);
          }}
        />
      </div>
      {createPortal(<span data-testid="internal-portal" />, internalHost)}
      {createPortal(
        <div>
          <span data-testid="overlay" />
        </div>,
        document.body,
      )}
    </PullToRefresh>,
  );
  return {
    ...view,
    refresh,
    page: view.getByTestId("page"),
    overlay: view.getByTestId("overlay"),
    indicator: view.container.firstElementChild?.firstElementChild as HTMLElement,
  };
}

it("ignores portaled overlay touch events while normal page gestures refresh", async () => {
  const view = mount();
  pull(view.overlay);
  expect(view.refresh).not.toHaveBeenCalled();
  pull(view.page);
  expect(view.refresh).toHaveBeenCalledTimes(1);
  await act(async () => {});
});

it.each(["overlay", "page"] as const)(
  "cancels a pull before a later %s gesture and permits a fresh pull",
  async (target) => {
    const view = mount();
    start(view.page);
    move(view.page);
    expect(view.indicator.style.height).toBe("100px");
    cancel(view.page);
    expect(view.indicator.style.height).toBe("0px");
    expect(view.refresh).not.toHaveBeenCalled();
    start(view[target]);
    if (target === "overlay") move(view.overlay);
    end(view[target]);
    expect(view.refresh).not.toHaveBeenCalled();
    pull(view.page);
    expect(view.refresh).toHaveBeenCalledTimes(1);
    await act(async () => {});
  },
);

it("rejects stale state on a new ineligible start and ignores external move/end events", async () => {
  const view = mount();
  start(view.page);
  move(view.page);
  move(view.overlay);
  end(view.overlay);
  expect(view.refresh).not.toHaveBeenCalled();
  start(view.overlay);
  end(view.page);
  expect(view.indicator.style.height).toBe("0px");
  expect(view.refresh).not.toHaveBeenCalled();
  pull(view.page);
  expect(view.refresh).toHaveBeenCalledTimes(1);
  await act(async () => {});
});

it("keeps pending feedback through unrelated page and portal gestures until settlement", async () => {
  const pending = deferred();
  const view = mount(vi.fn(() => pending.promise));
  pull(view.page);
  for (const target of [view.page, view.overlay]) {
    start(target);
    end(target);
    pull(target);
    cancel(target);
    expect(view.indicator.style.height).toBe("40px");
    expect(view.indicator.querySelector("svg")?.style.animation).toBe("spin 0.8s linear infinite");
    expect(view.refresh).toHaveBeenCalledTimes(1);
  }
  await act(async () => pending.resolve());
  expect(view.indicator.style.height).toBe("0px");
  expect(view.indicator.querySelector("svg")?.style.animation).toBe("none");
  pull(view.page);
  expect(view.refresh).toHaveBeenCalledTimes(2);
  await act(async () => {});
});

it("installs pending ownership before a synchronously reentrant callback", async () => {
  const pending = deferred();
  const refresh = vi.fn(() => {
    pull(view.page);
    return pending.promise;
  });
  const view = mount(refresh);
  pull(view.page);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(view.indicator.style.height).toBe("40px");
  await act(async () => pending.resolve());
});

it("accepts SVG, physically internal portals and nested scrollers at the top", async () => {
  const view = mount();
  for (const id of ["svg-path", "internal-portal", "nested-child"]) {
    pull(view.getByTestId(id));
    await act(async () => {});
  }
  expect(view.refresh).toHaveBeenCalledTimes(3);
});

it("rejects moved nested and outer scrollers, then permits re-entry at the top", async () => {
  const view = mount();
  const nested = view.getByTestId("nested");
  for (const scroller of [nested, view.container]) {
    scroller.style.overflowY = "auto";
    scroller.style.overflowX = "hidden";
    Object.defineProperties(scroller, {
      scrollHeight: { value: 500 },
      clientHeight: { value: 100 },
    });
    scroller.scrollTop = 30;
    pull(view.getByTestId("nested-child"));
    expect(view.refresh).not.toHaveBeenCalled();
    scroller.scrollTop = 0;
  }
  pull(view.getByTestId("nested-child"));
  expect(view.refresh).toHaveBeenCalledTimes(1);
  await act(async () => {});
});

it("clears short and upward pulls without preventing native events", () => {
  const view = mount();
  start(view.page);
  move(view.page, 100);
  end(view.page);
  expect(view.indicator.style.height).toBe("0px");
  start(view.page);
  move(view.page);
  expect(
    fireEvent.touchMove(view.page, {
      touches: [touch(1, -1)],
      changedTouches: [touch(1, -1)],
      cancelable: true,
    }),
  ).toBe(true);
  move(view.page);
  end(view.page);
  expect(view.refresh).not.toHaveBeenCalled();
  expect(view.indicator.style.height).toBe("0px");
});

it("requires the owned touch to end and rejects multi-touch without stale re-entry", async () => {
  const view = mount();
  start(view.page);
  move(view.page);
  end(view.page, 2);
  expect(view.refresh).not.toHaveBeenCalled();
  fireEvent.touchStart(view.page, {
    touches: [touch(1), touch(2)],
    changedTouches: [touch(2)],
  });
  end(view.page);
  expect(view.refresh).not.toHaveBeenCalled();
  expect(view.indicator.style.height).toBe("0px");
  start(view.page);
  move(view.page, 200, 2);
  end(view.page);
  expect(view.refresh).not.toHaveBeenCalled();
  fireEvent.touchStart(view.page, { touches: [], changedTouches: [] });
  pull(view.page);
  expect(view.refresh).toHaveBeenCalledTimes(1);
  await act(async () => {});
});

it.each(["move", "end"] as const)(
  "cancels multi-touch detected on %s even without a second start",
  (phase) => {
    const view = mount();
    start(view.page);
    move(view.page);
    if (phase === "move") {
      fireEvent.touchMove(view.page, {
        touches: [touch(1, 200), touch(2, 200)],
        changedTouches: [touch(2, 200)],
      });
    } else {
      fireEvent.touchEnd(view.page, {
        touches: [touch(2, 200)],
        changedTouches: [touch(1, 200)],
      });
    }
    end(view.page);
    expect(view.refresh).not.toHaveBeenCalled();
    expect(view.indicator.style.height).toBe("0px");
  },
);

it("ignores another touch's cancellation while the owned single pull remains active", async () => {
  const view = mount();
  start(view.page);
  move(view.page);
  cancel(view.overlay, 2);
  expect(view.indicator.style.height).toBe("100px");
  end(view.page);
  expect(view.refresh).toHaveBeenCalledTimes(1);
  await act(async () => {});
});

it("old completion after unmount cannot clear a new instance's pending indicator", async () => {
  const firstPending = deferred();
  const first = mount(vi.fn(() => firstPending.promise));
  pull(first.page);
  first.unmount();
  const secondPending = deferred();
  const second = mount(vi.fn(() => secondPending.promise));
  pull(second.page);
  await act(async () => firstPending.resolve());
  expect(second.indicator.style.height).toBe("40px");
  expect(second.refresh).toHaveBeenCalledTimes(1);
  await act(async () => secondPending.resolve());
  expect(second.indicator.style.height).toBe("0px");
});

it("settles the actual QueryClient callback on rejection while retaining its query error", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let reject!: (error: Error) => void;
  client.setQueryData(["pull-refresh"], "initial");
  const observer = new QueryObserver(client, {
    queryKey: ["pull-refresh"],
    queryFn: () =>
      new Promise<string>((_, fail) => {
        reject = fail;
      }),
    staleTime: Infinity,
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    const view = mount(
      vi.fn(async () => {
        await client.invalidateQueries();
      }),
    );
    pull(view.page);
    expect(view.indicator.style.height).toBe("40px");
    const failure = new Error("query transport rejection");
    await act(async () => reject(failure));
    expect(client.getQueryState(["pull-refresh"])?.error).toBe(failure);
    expect(view.indicator.style.height).toBe("0px");
    pull(view.page);
    expect(view.refresh).toHaveBeenCalledTimes(2);
    await act(async () => reject(failure));
  } finally {
    unsubscribe();
    client.clear();
  }
});
