/**
 * The app's own settings for `pnpm check:dialogs` and
 * `pnpm check:shell-loading`: how to sign in, every dialog to open, and the
 * signed-in pages to hard-reload. The check scripts and
 * `browser-check-lib.ts` stay identical to the template's; only this file
 * changes per app.
 *
 * ws-model-proxy has no mock mode: run the app (a disposable local stack, for
 * example the built server on a throwaway database) and pass `--url`:
 *
 *   pnpm check:dialogs --url http://localhost:3000
 *   pnpm check:shell-loading --url http://localhost:3000
 *
 * The URL's origin must be the app's own (`BETTER_AUTH_URL`): the auth API
 * refuses another origin.
 *
 * Accounts: `WMP_CHECK_ADMIN_EMAIL` / `WMP_CHECK_ADMIN_PASSWORD` and
 * `WMP_CHECK_USER_EMAIL` / `WMP_CHECK_USER_PASSWORD` when set. Otherwise the
 * check signs up throwaway accounts (`check-admin@example.invalid`, then
 * `check-user@example.invalid`), the admin first: on a fresh database the
 * first account is the admin (in production mode only when it is
 * `ADMIN_EMAIL`, so start the stack with
 * `ADMIN_EMAIL=check-admin@example.invalid`). It creates a runtime, a pool and
 * a provider account to open the dialogs that need them, so it refuses to sign
 * in at all unless `WMP_CHECK_DISPOSABLE=1` says the target is a throwaway
 * stack, and refuses the throwaway accounts' fixed password anywhere but a
 * loopback address:
 *
 *   WMP_CHECK_DISPOSABLE=1 pnpm check:dialogs --url http://localhost:3000
 */
import type { CheckRun } from "./browser-check-lib.ts";

/**
 * A page whose content has loaded: its heading, with no skeleton left in
 * `<main>` (a layout's heading, as on a runtime or pool, renders before its
 * page does).
 */
const LOADED = 'main:not(:has([data-slot="skeleton"], [data-route-skeleton])) h1';

/** No mock mode here: `--url` is required. */
export const MOCK_SERVER = false;

export type Role = "anonymous" | "user" | "admin";

export interface SignInOptions {
  /** Mock-mode only (template API); unused here. */
  overrides?: Record<string, string>;
  /** Mock-mode only (template API); the checks throttle the network instead. */
  slow?: boolean;
}

type Account = { email: string; password: string; fromEnv: boolean };

function accountFor(
  role: "user" | "admin",
  env: Record<string, string | undefined> = process.env,
): Account {
  const prefix = `WMP_CHECK_${role.toUpperCase()}`;
  const email = env[`${prefix}_EMAIL`];
  const password = env[`${prefix}_PASSWORD`];
  if (email && password) return { email, password, fromEnv: true };
  // Fixed, so a re-run signs in again; only ever used on a disposable stack.
  return {
    email: `check-${role}@example.invalid`,
    password: `check-${role}-disposable-Aa1!x`,
    fromEnv: false,
  };
}

const ACCOUNTS = { admin: accountFor("admin"), user: accountFor("user") };

/** IDs of the records the check creates, so the dialogs that need them can be opened. */
const fixtures: { runtimeId?: string; poolId?: string; providerId?: string } = {};
let prepared = false;
let signedInAs: Role | undefined;

/**
 * Runs in the page: signs out, then in as `account` (signing up first when
 * the account is the check's own). Same-origin fetches, so the browser keeps
 * the session cookie. Resolves with "ok" or the failure.
 */
function signInScript(account: Account): string {
  return `(async () => {
    const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await post("/api/auth/sign-out", {}).catch(() => {});
    let response = await post("/api/auth/sign-in/email", { email: ${JSON.stringify(account.email)}, password: ${JSON.stringify(account.password)} });
    if (!response.ok && ${!account.fromEnv}) {
      response = await post("/api/auth/sign-up/email", { email: ${JSON.stringify(account.email)}, password: ${JSON.stringify(account.password)}, name: "Check ${account.email.split("@")[0]}" });
    }
    return response.ok ? "ok" : "sign-in failed: " + response.status + " " + (await response.text()).slice(0, 200);
  })()`;
}

/** Runs in the page: calls one oRPC procedure (the app's RPC protocol) and returns its JSON. */
function rpcScript(procedure: string, input: unknown): string {
  return `(async () => {
    const response = await fetch("/rpc/${procedure.replaceAll(".", "/")}", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "orpc" },
      body: JSON.stringify({ json: ${JSON.stringify(input)} }),
    });
    const body = await response.json().catch(() => ({}));
    return JSON.stringify(response.ok ? body.json : { error: response.status, body });
  })()`;
}

async function rpc<T>({ browser }: CheckRun, procedure: string, input: unknown): Promise<T> {
  const result = await browser.evalJson<T & { error?: number }>(rpcScript(procedure, input));
  if (result && typeof result === "object" && "error" in result && result.error)
    throw new Error(`${procedure}: ${JSON.stringify(result).slice(0, 300)}`);
  return result;
}

type WithId = { id?: string; runtime?: { id: string }; pool?: { id: string } };
const idOf = (value: WithId) => value.id ?? value.runtime?.id ?? value.pool?.id;

/** Creates, once per run, the records some dialogs need: a runtime, a pool, a provider account. */
async function prepareFixtures(run: CheckRun): Promise<void> {
  if (prepared) return;
  prepared = true;
  const stamp = String(process.pid);
  const presets = await rpc<{ presets: Array<{ id: string; kind: string; spec: unknown }> }>(
    run,
    "runtimes.presets.list",
    {},
  );
  const vllm = presets.presets.find((preset) => preset.id === "vllm");
  if (vllm)
    fixtures.runtimeId = idOf(
      await rpc<WithId>(run, "runtimes.create", {
        slug: `check-${stamp}`,
        name: `Check ${stamp}`,
        kind: vllm.kind,
        preset: vllm.id,
        spec: vllm.spec,
      }),
    );
  fixtures.poolId = idOf(
    await rpc<WithId>(run, "pools.create", {
      slug: `check-${stamp}`,
      name: `Check ${stamp}`,
      type: "LLM",
    }),
  );
  fixtures.providerId = idOf(
    await rpc<WithId>(run, "providers.accounts.create", {
      providerType: "generic",
      label: `Check ${stamp}`,
      baseUrl: "https://provider.example.invalid/v1",
      authType: "BEARER",
      secret: "check-not-a-real-key",
      allowDataCollection: false,
    }),
  );
}

/**
 * Leaves the browser signed in as `role`. The admin account is created first,
 * so on a fresh database it is the first one (the admin). The admin's
 * records (runtime, pool, provider account) are created on its first sign-in.
 */
/**
 * Refuses a target that was not declared disposable (the check writes records there), and the
 * throwaway accounts' fixed, published password on anything but this machine.
 */
export function assertDisposableTarget(
  base: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (env.WMP_CHECK_DISPOSABLE !== "1")
    throw new Error(
      "refusing to sign in: these checks create records. Point --url at a throwaway stack and set WMP_CHECK_DISPOSABLE=1.",
    );
  const host = new URL(base).hostname;
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  const ownAccounts = !accountFor("admin", env).fromEnv || !accountFor("user", env).fromEnv;
  if (!loopback && ownAccounts)
    throw new Error(
      `refusing the throwaway accounts on ${host}: set WMP_CHECK_ADMIN_EMAIL/PASSWORD and WMP_CHECK_USER_EMAIL/PASSWORD for a stack that is not on this machine.`,
    );
}

export async function signIn(run: CheckRun, role: Role, _options: SignInOptions = {}) {
  const { base, browser } = run;
  assertDisposableTarget(base);
  await browser.run(["open", `${base}/en-US/login`]);
  // One sign-in per role and run: the session lasts across the cases, and the auth endpoints
  // are rate-limited.
  if (role === signedInAs) return;
  signedInAs = role;
  if (role === "anonymous") {
    await browser.run(["eval", "--stdin"], signInScript({ ...ACCOUNTS.user, fromEnv: true }));
    await browser.run(["cookies", "clear"]);
    return;
  }
  if (!prepared) {
    const admin = await browser.run(["eval", "--stdin"], signInScript(ACCOUNTS.admin));
    if (!admin.includes("ok")) throw new Error(`admin ${admin}`);
    await prepareFixtures(run);
  }
  const result = await browser.run(["eval", "--stdin"], signInScript(ACCOUNTS[role]));
  if (!result.includes("ok")) throw new Error(`${role} ${result}`);
}

export type DialogStep =
  /** Click the first element matching a CSS selector. */
  | { click: string }
  /** Click the button, link or menu item whose trimmed text is exactly this. */
  | { clickText: string };

export interface DialogCase {
  /** Unique; shown in failures and used by `--only`. */
  name: string;
  /** Path with the locale, opened after signing in as `role`. */
  path: string;
  role: Role;
  overrides?: Record<string, string>;
  /** Wait for this selector before the steps. */
  ready: string;
  /** Steps that open the dialog. */
  steps: DialogStep[];
}

/**
 * A dialog on a page under a record the check creates: its path is read when
 * the dialog is opened, after `signIn` has created the record.
 */
function onRecord(
  name: string,
  kind: keyof typeof fixtures,
  path: (id: string) => string,
  clickText: string,
): DialogCase {
  return {
    name,
    get path() {
      return path(fixtures[kind] ?? "not-created-yet");
    },
    role: "admin",
    ready: LOADED,
    steps: [{ clickText }],
  };
}

/**
 * Every dialog the app ships that a fresh stack can open, confirmations
 * included. A dialog that cannot fit moves to a page or a wide side sheet and
 * leaves this list; there is no exemption field.
 *
 * Not listed, because a fresh stack without a connected node or a second
 * person cannot open them (the e2e run covers them on the test deploy):
 * node dialogs (Rename node, Delete node, Lower trust, Hold, Update this
 * node / Update all, Rename fabric, Remove a secret), Replace node, Terminal
 * paste and End session (a node session), Fork (a definition shared by
 * someone else), Share settings / Remove share / Leave (a share between two
 * accounts), Apply profile (a profile with nodes), Mark stopped (a running
 * instance), Reveal invite / temporary password and the one-time key and
 * command reveals (shown after a create, inside the dialog measured here).
 * Create agent token and Edit access are side sheets, not dialogs.
 */
export const DIALOGS: DialogCase[] = [
  {
    name: "Add provider account",
    path: "/en-US/providers",
    role: "admin",
    ready: LOADED,
    steps: [{ clickText: "Add account" }],
  },
  {
    name: "New pool",
    path: "/en-US/pools",
    role: "admin",
    ready: LOADED,
    steps: [{ clickText: "New pool" }],
  },
  {
    name: "Add node",
    path: "/en-US/nodes",
    role: "admin",
    ready: LOADED,
    steps: [{ clickText: "Add node" }],
  },
  {
    name: "Share a pool or runtime",
    path: "/en-US/access/shares",
    role: "admin",
    ready: LOADED,
    steps: [{ clickText: "Share" }],
  },
  {
    name: "New API key",
    path: "/en-US/access/api-keys",
    role: "admin",
    ready: LOADED,
    steps: [{ clickText: "Create API key" }],
  },
  {
    name: "New profile",
    path: "/en-US/profiles",
    role: "admin",
    ready: LOADED,
    steps: [{ clickText: "New profile" }],
  },
  {
    name: "Invite user",
    path: "/en-US/admin/users",
    role: "admin",
    ready: LOADED,
    steps: [{ clickText: "Invite user" }],
  },
  onRecord("Start runtime", "runtimeId", (id) => `/en-US/runtimes/${id}`, "Start"),
  onRecord("Delete runtime", "runtimeId", (id) => `/en-US/runtimes/${id}`, "Delete runtime"),
  onRecord("Pool name and description", "poolId", (id) => `/en-US/pools/${id}`, "Edit"),
  onRecord("Change pool slug", "poolId", (id) => `/en-US/pools/${id}/advanced`, "Change slug"),
  onRecord("Delete pool", "poolId", (id) => `/en-US/pools/${id}/advanced`, "Delete pool"),
  onRecord("Revoke provider key", "providerId", (id) => `/en-US/providers/${id}`, "Revoke key"),
  onRecord(
    "Delete provider account",
    "providerId",
    (id) => `/en-US/providers/${id}`,
    "Delete account",
  ),
];

export interface ShellPage {
  name: string;
  path: string;
  role: Role;
  /**
   * A selector that exists only once the page's real content has loaded, not
   * in any skeleton (a row's action button, say; a card or a list item also
   * exists in the skeleton).
   */
  ready: string;
}

/** Signed-in pages `check:shell-loading` hard-reloads (pick two or more different shapes). */
export const SHELL_PAGES: ShellPage[] = [
  { name: "nodes", path: "/en-US/nodes", role: "admin", ready: LOADED },
  { name: "runtimes", path: "/en-US/runtimes", role: "admin", ready: LOADED },
  { name: "pools", path: "/en-US/pools", role: "admin", ready: LOADED },
  { name: "providers", path: "/en-US/providers", role: "admin", ready: LOADED },
  { name: "agents", path: "/en-US/access/agents", role: "admin", ready: LOADED },
  { name: "new runtime", path: "/en-US/runtimes/new", role: "admin", ready: LOADED },
  { name: "admin users", path: "/en-US/admin/users", role: "admin", ready: LOADED },
];
