import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  redirect,
  useRouteContext,
} from "@tanstack/react-router";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  online: true,
  sessionError: null as { status: number } | null,
  anonymous: false,
  account: {
    user: { id: "A", name: "Alice Private", email: "alice@private.test", role: "admin" },
  },
  transport: vi.fn(),
  checkSession: vi.fn(),
  refetch: vi.fn(),
  invalidate: vi.fn(async () => undefined),
  reconnect: { retry: undefined as (() => void) | undefined, offline: false },
}));
vi.mock("@ws-model-proxy/ui/components/button", () => ({
  Button: (props: import("react").ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("@/lib/auth-client", () => ({
  checkDocumentSession: () => fixture.checkSession(),
  authClient: {
    useSession: () => ({
      data: fixture.sessionError || fixture.anonymous ? null : fixture.account,
      error: fixture.sessionError,
      isPending: false,
      isRefetching: false,
      refetch: fixture.refetch,
    }),
    $store: { atoms: { session: { get: () => undefined } } },
  },
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: {}, isPending: false }) }));
vi.mock("@/utils/orpc", () => ({ orpc: { app: { config: { queryOptions: () => ({}) } } } }));
vi.mock("./main-nav", () => ({ MainNav: () => null }));
vi.mock("@ws-model-proxy/ui/lib/toast", () => ({ toast: { error: vi.fn() } }));
vi.mock("./app-name-link", () => ({ AppNameLink: () => <span>App</span> }));
vi.mock("./language-switcher", () => ({ LanguageSwitcher: () => null }));
vi.mock("./mode-toggle", () => ({ ModeToggle: () => null }));
vi.mock("@ws-model-proxy/ui/components/dropdown-menu", () => {
  const Part = ({ children }: { children?: import("react").ReactNode }) => <div>{children}</div>;
  return {
    DropdownMenu: Part,
    DropdownMenuGroup: Part,
    DropdownMenuLabel: Part,
    DropdownMenuContent: ({ children }: { children?: import("react").ReactNode }) => (
      <div role="menu">{children}</div>
    ),
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuItem: ({ children }: { children?: import("react").ReactNode }) => (
      <button role="menuitem">{children}</button>
    ),
    DropdownMenuTrigger: ({
      render,
      children,
    }: {
      render: import("react").ReactElement;
      children?: import("react").ReactNode;
    }) => (
      <>
        {render}
        {children}
      </>
    ),
  };
});
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/use-network-status", () => ({ useNetworkStatus: () => fixture.online }));
vi.mock("@/hooks/use-route-import-failure", () => ({ useRouteImportFailure: () => {} }));
vi.mock("@/hooks/use-retry-on-reconnect", () => ({
  useRetryOnReconnect: (retry: () => void, offline: boolean) => {
    fixture.reconnect = { retry, offline };
  },
}));
vi.mock("@/utils/friendly-error", () => ({ friendly: () => "friendly copy" }));
vi.mock("../utils/friendly-error", () => ({ friendly: () => "friendly copy" }));

import { resetAuthSessionMemoryForTests } from "@/hooks/use-auth-session";
import {
  admitRouteIdentity,
  confirmOutsideAppIdentity,
  identityVerificationGeneration,
  isDocumentIdentityUnverified,
  resetDocumentIdentityForTests,
} from "@/lib/document-identity";
import {
  recordSessionRetryAfter,
  resetSessionRetryForTests,
  waitForSessionCooldown,
} from "@/lib/session-retry";
import Header from "./header";
import UserMenu from "./user-menu";

const { default: ErrorState } = await import("./error-state");

// Minimal in-memory DOM, as in reset-password.test.tsx; React and the router are real.
class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  constructor(
    readonly ownerDocument: FakeDocument | null,
    readonly nodeType: number,
    readonly nodeName: string,
  ) {}
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes.at(-1) ?? null;
  }
  get parentElement(): FakeNode | null {
    return this.parentNode?.nodeType === 1 ? this.parentNode : null;
  }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes;
    return siblings ? (siblings[siblings.indexOf(this) + 1] ?? null) : null;
  }
  get previousSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes;
    return siblings ? (siblings[siblings.indexOf(this) - 1] ?? null) : null;
  }
  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(text: string) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (text) this.appendChild(new FakeText(this.ownerDocument, text));
  }
  appendChild<T extends FakeNode>(child: T): T {
    return this.insertBefore(child, null);
  }
  insertBefore<T extends FakeNode>(child: T, ref: FakeNode | null): T {
    child.parentNode?.removeChild(child);
    const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(at, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild<T extends FakeNode>(child: T): T {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }
  contains(other: FakeNode | null): boolean {
    for (let node = other; node; node = node.parentNode) if (node === this) return true;
    return false;
  }
  getRootNode(): FakeNode {
    let node: FakeNode = this;
    while (node.parentNode) node = node.parentNode;
    return node;
  }
  addEventListener(
    _type: string,
    _callback: EventListenerOrEventListenerObject | null,
    _options?: boolean | AddEventListenerOptions,
  ) {}
  removeEventListener(
    _type: string,
    _callback: EventListenerOrEventListenerObject | null,
    _options?: boolean | EventListenerOptions,
  ) {}
}

class FakeText extends FakeNode {
  constructor(
    doc: FakeDocument | null,
    public nodeValue: string,
    nodeType = 3,
  ) {
    super(doc, nodeType, nodeType === 3 ? "#text" : "#comment");
  }
  get data() {
    return this.nodeValue;
  }
  override get textContent() {
    return this.nodeValue;
  }
  override set textContent(text: string) {
    this.nodeValue = text;
  }
}

class FakeElement extends FakeNode {
  readonly attributes = new Map<string, string>();
  readonly style = { setProperty() {}, removeProperty() {} };
  /** React DOM writes `value`, `type`, `checked` as properties. */
  [property: string]: unknown;
  constructor(
    doc: FakeDocument,
    readonly localName: string,
    readonly namespaceURI: string,
  ) {
    super(doc, 1, localName.toUpperCase());
  }
  get tagName() {
    return this.nodeName;
  }
  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
  }
  setAttributeNS(_namespace: string, name: string, value: unknown) {
    this.setAttribute(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  removeAttributeNS(_namespace: string, name: string) {
    this.removeAttribute(name);
  }
  focus() {}
  blur() {}
}

class FakeDocument extends FakeNode {
  readonly documentElement: FakeElement;
  readonly head: FakeElement;
  readonly body: FakeElement;
  readonly activeElement = null;
  defaultView: unknown = null;
  constructor() {
    super(null, 9, "#document");
    this.documentElement = this.appendChild(this.createElement("html"));
    this.head = this.documentElement.appendChild(this.createElement("head"));
    this.body = this.documentElement.appendChild(this.createElement("body"));
  }
  createElement(tag: string) {
    return new FakeElement(this, tag.toLowerCase(), "http://www.w3.org/1999/xhtml");
  }
  createElementNS(namespace: string, tag: string) {
    return new FakeElement(this, tag, namespace);
  }
  createTextNode(text: string) {
    return new FakeText(this, text);
  }
  createComment(text: string) {
    return new FakeText(this, text, 8);
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
}

function allElements(node: FakeNode): FakeElement[] {
  return [...(node instanceof FakeElement ? [node] : []), ...node.childNodes.flatMap(allElements)];
}
function findElement(node: FakeNode, predicate: (node: FakeElement) => boolean) {
  return allElements(node).find(predicate);
}
function button(node: FakeNode, text: string): FakeElement | undefined {
  if (node instanceof FakeElement && node.localName === "button" && node.textContent === text)
    return node;
  for (const child of node.childNodes) {
    const found = button(child, text);
    if (found) return found;
  }
}
function click(node: FakeElement | undefined) {
  if (!node) throw new Error("Missing retry control");
  const propsKey = Object.keys(node).find((key) => key.startsWith("__reactProps"));
  const props = propsKey ? (node[propsKey] as { onClick: () => void }) : undefined;
  if (!props) throw new Error("Missing mounted React button props");
  props.onClick();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const mountedCase = { renderError: () => false, parentError: false, commits: [] as string[] };
function PrivateFixture() {
  const context = useRouteContext({ strict: false });
  const owner = "owner" in context && typeof context.owner === "string" ? context.owner : "missing";
  useLayoutEffect(() => {
    mountedCase.commits.push(owner);
  });
  if (!mountedCase.parentError && mountedCase.renderError()) throw new Error("render failed");
  return <p>{owner} private email</p>;
}

describe("mounted guarded route recovery", () => {
  let root: Root;
  let container: FakeElement;
  let commits: string[];
  const reload = vi.fn();
  let peer: { onmessage: ((event: MessageEvent) => void) | null; postMessage: () => void };
  beforeEach(() => {
    commits = [];
    fixture.sessionError = null;
    fixture.anonymous = false;
    fixture.refetch.mockReset().mockImplementation(async () => {
      await waitForSessionCooldown();
      fixture.transport();
    });
    fixture.transport.mockReset();
    fixture.checkSession.mockReset().mockResolvedValue(undefined);
    resetAuthSessionMemoryForTests();
    resetSessionRetryForTests();
    reload.mockReset();
    peer = { onmessage: null, postMessage() {} };
    resetDocumentIdentityForTests(() => peer);
    const doc = new FakeDocument();
    const classes = {
      Node: FakeNode,
      Element: FakeElement,
      HTMLElement: FakeElement,
      HTMLIFrameElement: class {},
    };
    const events = new EventTarget();
    const win = {
      ...classes,
      document: doc,
      location: { reload, pathname: "/private" },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
      scrollTo() {},
    };
    doc.addEventListener = events.addEventListener.bind(events);
    doc.removeEventListener = events.removeEventListener.bind(events);
    doc.defaultView = win;
    vi.stubGlobal("window", win);
    vi.stubGlobal("self", win);
    vi.stubGlobal("scrollTo", () => {});
    vi.stubGlobal("document", doc);
    for (const [name, value] of Object.entries(classes)) vi.stubGlobal(name, value);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = doc.body.appendChild(doc.createElement("div"));
    root = createRoot(container as unknown as Element);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    act(() => root.unmount());
    resetSessionRetryForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  async function mount(
    probe: () => Promise<string | null>,
    renderError: () => boolean = () => false,
    parentError = false,
    withHeader = false,
    publicError: () => boolean = () => false,
  ) {
    mountedCase.renderError = renderError;
    mountedCase.parentError = parentError;
    mountedCase.commits = commits;
    const rootRoute = createRootRoute({
      component: () => (
        <>
          {withHeader && <Header />}
          <Outlet />
        </>
      ),
    });
    const guard = createRoute({
      getParentRoute: () => rootRoute,
      id: "_auth",
      beforeLoad: async () => {
        const owner = await probe();
        await admitRouteIdentity({
          status: "resolved",
          session: owner ? { user: { id: owner } } : null,
        });
        if (owner === null) throw redirect({ href: "/login" });
        return { owner };
      },
      component: () => {
        guard.useSearch();
        if (parentError && renderError()) throw new Error("parent render failed");
        return <Outlet />;
      },
    });
    const page = createRoute({
      getParentRoute: () => guard,
      path: "/private",
      component: PrivateFixture,
    });
    const login = createRoute({
      getParentRoute: () => rootRoute,
      path: "/login",
      component: () => <p>login form</p>,
    });
    const publicPage = createRoute({
      getParentRoute: () => rootRoute,
      path: "/public",
      component: () => {
        if (publicError()) throw new Error("public render failed");
        return <p>unguarded public page</p>;
      },
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([guard.addChildren([page]), login, publicPage]),
      history: createMemoryHistory({ initialEntries: ["/private"] }),
      defaultErrorComponent: ErrorState,
      defaultPendingComponent: () => <p>guard pending</p>,
      defaultPendingMs: 0,
      defaultPendingMinMs: 0,
      isServer: false,
      origin: "http://localhost",
    });
    await act(async () => {
      await router.load();
      root.render(<RouterProvider router={router} />);
    });
    return router;
  }
  it.each(["A", "B"])(
    "masks the mounted root Header and open account menu before a delayed cookie guard retry to %s",
    async (nextOwner) => {
      let broken = false;
      const probe = vi.fn<() => Promise<string | null>>().mockResolvedValue("A");
      const router = await mount(probe, () => broken, false, true);
      const header = findElement(container, (node) => node.hasAttribute("data-app-header"));
      expect(header?.textContent).toContain("Alice Private");
      expect(
        findElement(header!, (node) => node.getAttribute("title") === "Alice Private"),
      ).toBeDefined();
      await import("./user-menu-content");
      await act(async () => click(button(header!, "Alice Private")));
      expect(findElement(header!, (node) => node.getAttribute("role") === "menu")).toBeDefined();
      expect(header?.textContent).toContain("alice@private.test");
      broken = true;
      await act(async () => {
        await router.navigate({ href: "/private?broken=true" });
      });
      broken = false;
      const next = deferred<string | null>();
      probe.mockReturnValueOnce(next.promise);
      // Cookie changed without a peer announcement. Only ErrorState recovery
      // knows a new guard must decide; the root header is outside its subtree.
      await act(async () => click(button(container, "common:actions.tryAgain")));
      expect(probe).toHaveBeenCalledTimes(3);
      expect(header?.textContent).not.toContain("Alice Private");
      expect(header?.textContent).not.toContain("alice@private.test");
      expect(header?.textContent).not.toContain("items.admin");
      expect(header?.textContent).not.toContain("items.settings");
      expect(header?.textContent).not.toContain("userMenu.signOut");
      expect(
        findElement(header!, (node) => node.getAttribute("title") === "Alice Private"),
      ).toBeUndefined();
      expect(findElement(header!, (node) => node.localName === "img")).toBeUndefined();
      expect(
        findElement(header!, (node) =>
          ["menu", "menuitem"].includes(node.getAttribute("role") ?? ""),
        ),
      ).toBeUndefined();
      expect(container.textContent).not.toContain("A private email");
      expect(reload).not.toHaveBeenCalled();
      await act(async () => next.resolve(nextOwner));
      expect(reload).toHaveBeenCalledTimes(nextOwner === "B" ? 1 : 0);
      if (nextOwner === "A") {
        expect(header?.textContent).toContain("Alice Private");
        expect(container.textContent).toContain("A private email");
        expect(isDocumentIdentityUnverified()).toBe(false);
      } else expect(container.textContent).not.toContain("A private email");
    },
  );

  it("recovers an anonymous public route without a guard, a stuck root identity mask or a session probe", async () => {
    fixture.anonymous = true;
    let broken = true;
    const rootRoute = createRootRoute({
      component: () => (
        <>
          <Header />
          <Outlet />
        </>
      ),
    });
    const publicRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/public",
      component: () => {
        if (broken) throw new Error("public page failed");
        return <p>public page recovered</p>;
      },
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([publicRoute]),
      history: createMemoryHistory({ initialEntries: ["/public"] }),
      defaultErrorComponent: ErrorState,
      defaultPendingMs: 0,
      defaultPendingMinMs: 0,
      isServer: false,
      origin: "http://localhost",
    });
    await act(async () => {
      await router.load();
      root.render(<RouterProvider router={router} />);
    });
    expect(button(container, "common:actions.tryAgain")).toBeDefined();
    broken = false;
    await act(async () => click(button(container, "common:actions.tryAgain")));
    expect(container.textContent).toContain("public page recovered");
    expect(isDocumentIdentityUnverified()).toBe(false);
    const header = findElement(container, (node) => node.hasAttribute("data-app-header"));
    expect(header?.textContent).toContain("userMenu.signIn");
    expect(fixture.refetch).not.toHaveBeenCalled();
    expect(fixture.checkSession).not.toHaveBeenCalled();
    expect(fixture.transport).not.toHaveBeenCalled();
  });

  it.each(["A", "B"])(
    "retained A on an unguarded public error retries a fresh identity answering %s",
    async (answer) => {
      let broken = false;
      const probe = vi.fn<() => Promise<string | null>>().mockResolvedValue("A");
      const router = await mount(
        probe,
        () => false,
        false,
        true,
        () => broken,
      );
      broken = true;
      await act(async () => {
        await router.navigate({ href: "/public" });
      });
      expect(button(container, "common:actions.tryAgain")).toBeDefined();
      const next = deferred<void>();
      fixture.checkSession.mockImplementationOnce(async () => {
        const since = identityVerificationGeneration();
        fixture.transport();
        await next.promise;
        confirmOutsideAppIdentity(answer, since);
      });
      broken = false;
      await act(async () => click(button(container, "common:actions.tryAgain")));
      expect(probe).toHaveBeenCalledTimes(1); // public recovery has no guard
      expect(fixture.checkSession).toHaveBeenCalledTimes(1);
      expect(fixture.transport).toHaveBeenCalledTimes(1);
      expect(isDocumentIdentityUnverified()).toBe(true);
      const header = findElement(container, (node) => node.hasAttribute("data-app-header"));
      expect(header?.textContent).not.toContain("Alice Private");
      expect(header?.textContent).not.toContain("userMenu.signOut");
      expect(container.textContent).toContain("unguarded public page");
      expect(container.textContent).not.toContain("A private email");
      await act(async () => next.resolve());
      expect(reload).toHaveBeenCalledTimes(answer === "B" ? 1 : 0);
      if (answer === "A") {
        expect(isDocumentIdentityUnverified()).toBe(false);
        expect(header?.textContent).toContain("Alice Private");
      } else expect(header?.textContent).not.toContain("Alice Private");
    },
  );

  it.each(["visible", "hidden", "offline"])(
    "manual account Retry gives immediate busy feedback and one deadline-bound request when %s",
    async (availability) => {
      vi.useFakeTimers();
      Object.assign(document, { visibilityState: "visible" });
      vi.stubGlobal("navigator", { onLine: true });
      fixture.sessionError = { status: 429 };
      recordSessionRetryAfter(
        new Response(null, { status: 429, headers: { "Retry-After": "30" } }),
      );
      const rootRoute = createRootRoute({
        component: () => (
          <>
            <UserMenu />
            <UserMenu />
          </>
        ),
      });
      const router = createRouter({
        routeTree: rootRoute,
        isServer: false,
        origin: "http://localhost",
        history: createMemoryHistory({ initialEntries: ["/"] }),
      });
      await act(async () => {
        await router.load();
        root.render(<RouterProvider router={router} />);
      });
      const retries = allElements(container).filter(
        (node) => node.getAttribute("aria-label") === "userMenu.accountUnavailable",
      );
      expect(retries).toHaveLength(2);
      await act(async () => {
        for (const retry of retries) click(retry);
      });
      for (const retry of retries) {
        expect(retry.hasAttribute("disabled")).toBe(true);
        expect(retry.getAttribute("aria-busy")).toBe("true");
        expect(retry.textContent).toContain("userMenu.retryQueued");
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(29_999);
      });
      expect(fixture.transport).not.toHaveBeenCalled();
      if (availability === "hidden") Object.assign(document, { visibilityState: "hidden" });
      if (availability === "offline") vi.stubGlobal("navigator", { onLine: false });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      if (availability !== "visible") {
        expect(fixture.transport).not.toHaveBeenCalled();
        Object.assign(document, { visibilityState: "visible" });
        vi.stubGlobal("navigator", { onLine: true });
        await act(async () => {
          window.dispatchEvent(new Event("online"));
        });
      }
      expect(fixture.transport).toHaveBeenCalledTimes(1);
      expect(fixture.refetch).toHaveBeenCalledTimes(1);
    },
  );

  it("reruns a failed beforeLoad, keeps recovery pending, and allows another retry after failure", async () => {
    const probe = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValue(new Error("Route session unavailable"));
    await mount(probe);
    expect(container.textContent).toContain("common:somethingWentWrong");
    const next = deferred<string | null>();
    probe.mockReturnValueOnce(next.promise);
    await act(async () => click(button(container, "common:actions.tryAgain")));
    expect(probe).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("private email");
    await act(async () => next.resolve("A"));
    expect(container.textContent).toContain("A private email");
  });
  it("keeps a repeated guard failure retryable, then follows the anonymous redirect", async () => {
    const probe = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValue(new Error("Route session unavailable"));
    const router = await mount(probe);
    await act(async () => click(button(container, "common:actions.tryAgain")));
    expect(probe).toHaveBeenCalledTimes(2);
    expect(button(container, "common:actions.tryAgain")).toBeDefined();
    probe.mockResolvedValue(null);
    await act(async () => click(button(container, "common:actions.tryAgain")));
    expect(router.state.location.pathname).toBe("/login");
    expect(container.textContent).toContain("login form");
  });
  it.each([false, true])(
    "never recommits old private context while revalidating a %s parent render error",
    async (parentError) => {
      let broken = false;
      const probe = vi.fn<() => Promise<string | null>>().mockResolvedValue("A");
      const router = await mount(probe, () => broken, parentError);
      expect(container.textContent).toContain("A private email");
      broken = true;
      // An ordinary route transition can trigger a component error after the
      // guard succeeded. The fallback owns recovery from this point.
      await act(async () => {
        await router.navigate({ href: "/private?broken=true" });
      });
      expect(button(container, "common:actions.tryAgain")).toBeDefined();
      broken = false;
      peer.onmessage?.({ data: { kind: "identity", id: "B" } } as MessageEvent);
      commits.length = 0;
      const next = deferred<string | null>();
      probe.mockReturnValueOnce(next.promise);
      await act(async () => click(button(container, "common:actions.tryAgain")));
      expect(container.textContent).not.toContain("A private email");
      expect(commits).toEqual([]);
      await act(async () => next.resolve("B"));
      expect(commits).not.toContain("A");
      expect(reload).toHaveBeenCalledTimes(1);
      expect(container.textContent).not.toContain("private email");
    },
  );
});
