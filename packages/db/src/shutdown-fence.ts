/**
 * Shared DB client shutdown fence (Part G pass 2, G1 — extends the Part F
 * pass-5 auth-only fence to the ONE shared Prisma client; pass 3 adds the
 * per-request abort fence, transaction-callback fencing, and the durable
 * cleanup permit).
 *
 * WHY THIS EXISTS: three classes of un-cancellable continuation can outlive
 * their authority:
 *
 * 1. the installed `requireMcpAuth` verifier chain (Part F/F8) — it DROPS
 *    the abort signal and performs DB work through better-auth's internal
 *    adapter (DPoP replay reservations);
 * 2. tool dispatch continuations after SHUTDOWN (Part G/G1) — a procedure
 *    call or diagnostic core whose first await is parked when the gate
 *    closes can resume afterwards and START the next direct Prisma
 *    operation even though the admission permit already released;
 * 3. tool dispatch continuations after a plain CLIENT ABORT (no shutdown) —
 *    the global fence is NOT armed for client aborts, yet the tool wrapper
 *    has already settled the MCP response (`REQUEST_ABORTED`); a resumed
 *    procedure continuation must not START new database work either.
 *
 * THE FENCE is enforcement at the one seam this repository owns: the SHARED
 * Prisma client exported by `@ws-model-proxy/db`. Every consumer of that
 * client — better-auth's prisma adapter (packages/auth), the oRPC
 * procedures the MCP tools invoke, the /mcp admission lookups, and the
 * diagnostic cores — goes through this wrapper. While no fence applies (the
 * entire normal lifetime of the process for HTTP traffic) the wrapper is
 * behaviorally transparent. Two fences exist:
 *
 * - GLOBAL shutdown fence (`armDbShutdownFence`): once the MCP shutdown
 *   gate closes, any NEW database operation initiated by ANY continuation
 *   rejects with {@link DbShutdownFenceError}.
 * - PER-REQUEST abort fence (`runWithDbAbortFence`): an AsyncLocalStorage
 *   context carries the request's OWNED admission signal; operations
 *   initiated inside that context reject with
 *   {@link DbRequestAbortFenceError} once the signal aborts. ALS propagates
 *   through the await tree, so resumed procedure continuations and
 *   transaction callbacks of ONE MCP tool call all see it. Normal HTTP
 *   traffic runs OUTSIDE the ALS context — zero behavior change.
 *
 * CANCELLATION BOUNDARY (documented invariant): an operation that already
 * STARTED may complete (atomic semantics — identical to an aborted HTTP
 * request whose single in-flight query finishes); NO NEW operation may
 * START once the applicable fence is active. Interactive `$transaction`
 * callbacks receive a FENCED transaction client (covering transactions
 * opened before shutdown whose callback resumes afterwards); the array form
 * is inherently covered because every element operation was built through
 * this same shared proxy.
 *
 * `$`-prefixed client methods other than `$transaction` split in two
 * (pass 4, G1): DATA operations (`$queryRaw`, `$queryRawUnsafe`,
 * `$executeRaw`, `$executeRawUnsafe`, and any other `$`-prefixed method)
 * are fenced through the same check as delegate operations — on the shared
 * client AND on wrapped transaction clients — because production
 * procedures issue consecutive raw statements (the two-lock advisory
 * pattern) and a resumed continuation must not START the next one any more
 * than it may start a delegate write. Client-valued `$` properties (the
 * installed client's `$parent` = the ORIGINAL unfenced client) are wrapped
 * in the SAME fence proxy (pass 5, G1) — weakly cached per underlying
 * object so identity is stable and `$parent`-of-`$parent` chains stay
 * fenced. `$`-method RESULTS that are the underlying client itself are
 * likewise returned WRAPPED (pass 9, G1): installed Prisma's `$on`
 * registers the listener and returns the client for chaining, so an
 * unwrapped result would be a complete fence bypass through the normal
 * typed API; the wrapping is a strict identity check (result === the
 * underlying client this proxy wraps) — any other return value passes
 * through verbatim, so `$on` chaining stays fenced without prohibiting
 * anything. The one client-DERIVING `$` method, `$extends`, is PROHIBITED
 * outright (pass 7, user-decision terminal policy): the derived shapes it
 * can produce (thenable derived clients, callback extensions capturing
 * the raw client, model-extension continuations bound to the raw
 * delegate) cannot be closed by proxy wrapping, so any `$extends` call on
 * ANY fenced surface throws DbFenceUnsupportedOperationError regardless
 * of fence state — extensions must be built into @ws-model-proxy/db at
 * construction, where the fence can be applied deliberately.
 * Only `$disconnect` (the graceful-shutdown sequence owns the real
 * teardown) and `_`-prefixed internals pass through UNWRAPPED — the fence
 * owns DATA operations only.
 *
 * SCOPE AND ACCEPTED RESIDUAL (user decision, 2026-09-17 — Part G pass 8):
 * this fence is a SHUTDOWN-LIFECYCLE CORRECTNESS mechanism for ACCIDENTAL
 * or DETACHED request continuations, not a security boundary against
 * hostile in-process code. The enumerated surface it covers: model
 * delegates (calls checked; object-valued properties such as the delegate
 * `$parent` wrapped), `$`-prefixed client methods (data operations fenced;
 * results that are the underlying client itself — `$on` chaining — are
 * returned wrapped), client `$parent` (wrapped), interactive `$transaction`
 * callbacks (wrapped), and `$extends` (prohibited). LANGUAGE-REFLECTION escapes are
 * ACCEPTED RESIDUAL, out of the fence's threat model: `valueOf()` /
 * custom-inspection returns on delegates, Prisma's symbol-keyed internals,
 * prototype walks, and fluent-query builder continuations (a PrismaPromise
 * built before abort and awaited after). Rationale: no production code in
 * this repository uses any of these paths; MCP tool inputs cannot reach
 * them; and deliberate in-process code can always construct its own
 * unfenced PrismaClient, so no proxy enumeration can be complete against
 * it. Re-evaluate this residual if a production reflection consumer ever
 * appears or at the next Prisma major-version bump (ledger L26).
 *
 * DURABLE CLEANUP PERMIT (`runWithDbShutdownPermit`): gate closure arms the
 * global fence BEFORE aborting outstanding requests by design (no stray
 * continuation may slip a new operation between the flip and the abort).
 * Abort-triggered cleanup — capacity lease release, waiter terminalization
 * — is DURABLE INTENT that MUST still execute during teardown. The permit
 * exempts ONLY the wrapped function's operations from BOTH fences (the
 * cleanup runs after abort BY DESIGN); everything else stays fenced.
 *
 * Log policy (Part D, ctor-only): a fenced rejection emits ONE static
 * sanitized line — never the operation's arguments, model data, or any
 * error message from upstream code.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Dedicated rejection error: upstream catch paths turn it into failed
 * verification / failed procedures / 500 responses (the client is gone or
 * the process is shutting down). */
export class DbShutdownFenceError extends Error {
  constructor() {
    super("database shutdown fence is active");
    this.name = "DbShutdownFenceError";
  }
}

/**
 * Per-request abort rejection (DbShutdownFenceError family): the calling
 * request's OWNED admission signal aborted — no NEW operation may start for
 * that request's continuations. Distinct `name`/message so upstream logs
 * (constructor-name-only) can distinguish client aborts from shutdown.
 */
export class DbRequestAbortFenceError extends DbShutdownFenceError {
  constructor() {
    super();
    this.message = "request abort fence is active";
    this.name = "DbRequestAbortFenceError";
  }
}

/**
 * Prohibited-operation error (pass 7, user-decision terminal policy):
 * client extensions are NOT supported through the fenced shared client.
 * `$extends` can hand consumers derived shapes the proxy boundary cannot
 * close (thenable derived clients, callback extensions capturing the raw
 * client, model-extension continuations bound to the raw delegate), so the
 * operation is prohibited outright — fence armed or not. Prisma client
 * extensions, if ever needed, must be built into `@ws-model-proxy/db` at
 * client construction, where the fence can be applied deliberately.
 */
export class DbFenceUnsupportedOperationError extends Error {
  constructor() {
    super(
      "client extensions ($extends) are not supported on the fenced shared client: build extensions into @ws-model-proxy/db at client construction",
    );
    this.name = "DbFenceUnsupportedOperationError";
  }
}

/** Module-level fence state. Default: NEVER fenced (zero behavior change). */
let fenceArmed = false;

/** Arm the fence: every NEW client DB operation rejects. Idempotent. */
export function armDbShutdownFence(): void {
  fenceArmed = true;
}

/**
 * Disarm the fence (test hygiene only — production arms once at shutdown
 * and the process exits; tests must reset the module state between cases).
 */
export function disarmDbShutdownFence(): void {
  fenceArmed = false;
}

/** Whether the fence is currently armed. */
export function isDbShutdownFenceArmed(): boolean {
  return fenceArmed;
}

/** Per-request fence context carried through the await tree via ALS. */
interface DbFenceContext {
  /** The owning request's admission signal (per-request abort fence). */
  signal?: AbortSignal;
  /** Durable-cleanup permit: exempt from BOTH fences inside the scope. */
  permit?: boolean;
}

const dbFenceContext = new AsyncLocalStorage<DbFenceContext>();

/**
 * Run `fn` with the per-request abort fence installed for `signal`. Every
 * database operation initiated by `fn` (or by ANY continuation, awaited
 * callback, or transaction body it spawns — ALS propagates through the
 * await tree) rejects with {@link DbRequestAbortFenceError} once the
 * signal aborts. In-flight operations may complete (atomic semantics); NEW
 * operations may not start. Callers outside this context are unaffected.
 */
export function runWithDbAbortFence<T>(signal: AbortSignal | undefined, fn: () => T): T {
  const parent = dbFenceContext.getStore();
  if (signal === undefined && parent === undefined) return fn();
  return dbFenceContext.run({ ...parent, signal }, fn);
}

/**
 * Run `fn` as DURABLE CLEANUP: its database operations are exempt from the
 * global shutdown fence AND from any enclosing per-request abort fence.
 * Scope this to the cleanup write paths ONLY (capacity lease release,
 * attempt terminalization): releasing durable state during teardown is
 * exactly the intent that must complete; NEW work stays fenced.
 */
export function runWithDbShutdownPermit<T>(fn: () => T): T {
  const parent = dbFenceContext.getStore();
  return dbFenceContext.run({ ...parent, signal: undefined, permit: true }, fn);
}

/** One sanitized line per fenced rejection (static text only). */
function logFencedRejection(errorName: string): void {
  console.error(`[db] fence rejected database operation (${errorName})`);
}

/**
 * The one fence decision every data operation passes through. Order:
 * durable-cleanup permit wins (teardown cleanup must complete), then the
 * global shutdown fence, then the per-request abort fence.
 */
function assertOperationAllowed(): void {
  const context = dbFenceContext.getStore();
  if (context?.permit === true) return;
  if (fenceArmed) {
    logFencedRejection("DbShutdownFenceError");
    throw new DbShutdownFenceError();
  }
  if (context?.signal?.aborted) {
    logFencedRejection("DbRequestAbortFenceError");
    throw new DbRequestAbortFenceError();
  }
}

const modelProxies = new WeakMap<object, object>();

/**
 * Client-valued `$` properties (pass 5, G1): the installed Prisma client
 * exposes `$parent` — the ORIGINAL unfenced client (and its `$parent` in
 * turn). Returning such values unwrapped would hand callers a complete
 * bypass of the shared fence. They are wrapped in the SAME fence proxy and
 * cached per underlying object so identity is stable across accesses and
 * `$parent.$parent...` chains stay fenced. (The pass-6 `$extends`-result
 * wrapping that reused this cache was removed in pass 7 — `$extends` is
 * prohibited outright.) Like every other branch, the wrapper is
 * behaviorally transparent while no fence applies.
 */
const fencedClientProxies = new WeakMap<object, object>();

function fenceClientProxy(client: object): object {
  const cached = fencedClientProxies.get(client);
  if (cached !== undefined) return cached;
  const fenced = withDbShutdownFence(client);
  fencedClientProxies.set(client, fenced);
  return fenced;
}

/**
 * Wrap one Prisma model delegate so every METHOD call on it is check-first
 * fenced. Delegates may be plain objects (generated Prisma clients) OR
 * callable function proxies (test doubles such as vitest-mock-extended's
 * mockDeep) — both surfaces are fenced (property-accessed methods AND
 * calling the delegate itself). Non-function property access splits like
 * the client's own `$` surface (pass 8, G1): OBJECT-valued properties —
 * installed Prisma puts `$parent` on EVERY model delegate, pointing at
 * its underlying client (the transaction client for delegates reached
 * inside an interactive transaction callback) — are wrapped in the SAME
 * weakly-cached fence proxy used for client-level `$parent`, so
 * `delegate.$parent`, `getExtensionContext(delegate).$parent`
 * (getExtensionContext returns its receiver unchanged), and
 * `$parent`-of-`$parent` chains all resolve to fenced objects with
 * stable identity per underlying object; primitives and other non-object
 * values pass through untouched. The wrapping is lazy (single property
 * read; no delegate enumeration). The wrapped methods preserve
 * arguments, `this` binding, and return values verbatim while no fence
 * applies.
 */
function fenceModelDelegate<TDelegate extends object>(delegate: TDelegate): TDelegate {
  const cached = modelProxies.get(delegate);
  if (cached !== undefined) return cached as TDelegate;
  const proxy = new Proxy(delegate, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        // Object-valued delegate properties (pass 8, G1): installed
        // Prisma exposes `$parent` on EVERY model delegate — the
        // underlying (unfenced) client. Returning it unwrapped would hand
        // callers a complete bypass of both fences AND the `$extends`
        // prohibition. Wrap it in the SAME weakly-cached fence proxy used
        // for client-level `$parent`: chains, extension-context
        // receivers, and tx-client delegate parents all stay fenced, with
        // stable identity per underlying object. Primitives and other
        // non-object values pass through untouched.
        if (value !== null && typeof value === "object") return fenceClientProxy(value);
        return value;
      }
      const method = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        assertOperationAllowed();
        return method.apply(target, args);
      };
    },
    apply(target, thisArg, args) {
      assertOperationAllowed();
      const callable = target as (...invokeArgs: unknown[]) => unknown;
      return Reflect.apply(callable, thisArg, args as unknown[]);
    },
  });
  modelProxies.set(delegate, proxy);
  return proxy;
}

/**
 * Wrap a Prisma client so every model-delegate data operation and every
 * `$transaction` is check-first fenced (see the module docblock for the
 * shutdown rationale and the passthrough surface).
 */
export function withDbShutdownFence<TClient extends object>(prisma: TClient): TClient {
  return new Proxy(prisma, {
    get(target, property, receiver) {
      if (typeof property === "string" && property !== "$transaction") {
        if (property.startsWith("_")) {
          return Reflect.get(target, property, receiver);
        }
        if (property.startsWith("$")) {
          // `$disconnect` is the ONE `$` passthrough: teardown itself.
          if (property === "$disconnect") return Reflect.get(target, property, receiver);
          // Every other `$`-prefixed FUNCTION is a DATA operation (raw SQL,
          // `$connect`, `$on`, ...): fenced identically to delegate
          // methods, on the shared client and inside transaction callbacks
          // alike.
          const value = Reflect.get(target, property, target);
          if (typeof value === "function") {
            const method = value as (...args: unknown[]) => unknown;
            // `$extends` is PROHIBITED on the fenced client (pass 7,
            // user-decision terminal policy): the derived shapes it can
            // produce (thenable derived clients, callback extensions
            // capturing the raw client, model-extension continuations
            // bound to the raw delegate) cannot be closed by proxy
            // wrapping — see R73/R74. The operation is rejected outright,
            // regardless of fence state, WITHOUT ever calling the
            // underlying `$extends`. Prisma supports chaining `$extends`
            // on an already-extended client; on THIS client the call is
            // prohibited by policy — see
            // {@link DbFenceUnsupportedOperationError}.
            if (property === "$extends") {
              return (..._args: unknown[]) => {
                throw new DbFenceUnsupportedOperationError();
              };
            }
            return (...args: unknown[]) => {
              assertOperationAllowed();
              const result = method.apply(target, args);
              // Identity-checked result wrapping (pass 9, G1): a `$`
              // method may return the UNDERLYING client itself for
              // chaining — installed Prisma's `$on` does exactly that.
              // Returning it verbatim would hand callers the raw,
              // unfenced client (bypassing both fences AND the
              // `$extends` prohibition) through the normal typed API —
              // R80. Identity comparison ONLY: anything that is not
              // literally the same underlying client instance (result
              // objects, promises, query builders) returns verbatim; no
              // client-like heuristics, no thenable handling. `$extends`
              // never reaches here (its branch throws above).
              if (result === target) return fenceClientProxy(target);
              return result;
            };
          }
          // Non-function `$` values split once more (pass 5, G1): a
          // CLIENT-valued property (`$parent` = the original unfenced
          // client on the installed Prisma build) is wrapped in the same
          // fence proxy — weakly cached so identity is stable per access
          // path and chained `$parent`s cannot escape. Primitives pass
          // through untouched.
          if (value !== null && typeof value === "object") return fenceClientProxy(value);
          return value;
        }
        const value = Reflect.get(target, property, target);
        if (value !== null && (typeof value === "object" || typeof value === "function")) {
          return fenceModelDelegate(value);
        }
        return value;
      }
      // `$transaction` itself is fenced: no NEW transaction may open once a
      // fence applies, and an INTERACTIVE transaction's callback receives a
      // FENCED transaction client (a transaction opened before shutdown
      // whose callback resumes afterwards cannot START further operations).
      // The array form needs no wrapping here: every element operation was
      // already built through this same shared proxy.
      if (property === "$transaction") {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        const transaction = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => {
          assertOperationAllowed();
          const [callback, ...rest] = args;
          if (typeof callback === "function") {
            const interactive = callback as (txClient: object) => unknown;
            return transaction.apply(target, [
              (txClient: object) => interactive(withDbShutdownFence(txClient)),
              ...rest,
            ]);
          }
          return transaction.apply(target, args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}
