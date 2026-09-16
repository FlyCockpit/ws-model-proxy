/**
 * Auth DB shutdown fence (Part F pass 5, F8 reopened).
 *
 * WHY THIS EXISTS: the installed `requireMcpAuth` continuation chain is not
 * cancellable — `requestToResourceInput()` (better-auth core verify.mjs:60)
 * DROPS the abort signal, so after the route-level abort race answers 499
 * and the shutdown gate releases its permit, the UPSTREAM verifier
 * continuation can still be running — and it performs DATABASE work through
 * the auth instance's internal adapter (DPoP replay reservation:
 * `reserveVerificationValue()` awaits hashing then `adapter.create()`, and
 * its failure/conflict path calls `adapter.findOne()` — internal-adapter.mjs
 * :884-903). Renewal probes (R59/R60) recorded `jwks:start → gate:drained →
 * prisma:disconnect → replay-db:create` (and the conflict variant
 * `… → replay-db:findOne`) with outstanding === 0 and 499 already returned:
 * DB operations were STARTED after gate drain and the simulated Prisma
 * teardown.
 *
 * THE FENCE is enforcement at the one seam this repository owns: the Prisma
 * client handed to better-auth's prisma adapter (packages/auth/src/index.ts).
 * While the fence is INACTIVE (the entire normal lifetime of the process)
 * the wrapper is behaviorally transparent — every property access and call
 * passes through unchanged. Once the MCP shutdown gate closes
 * (apps/server/src/app.ts wires `armAuthDbShutdownFence` into the gate's
 * `onClosed`), any NEW database operation initiated by ANY continuation of
 * the auth instance — including the un-cancellable verifier continuations —
 * is rejected immediately with {@link AuthDbShutdownFenceError}. Upstream
 * catch paths turn that rejection into failed verification / 500s for
 * clients that are gone anyway; the alternative (letting a stray
 * continuation open NEW Prisma operations during/after `prisma.$disconnect`)
 * is exactly the defect the probes demonstrated.
 *
 * Consistency of normal Better Auth API traffic after gate close: the
 * graceful-shutdown sequence drains HTTP FIRST and terminates lingering
 * connections, so no NEW /api/auth requests exist by the time the gate
 * closes and the fence arms; the fence's rejection is the backstop for
 * exactly the demonstrated stray-continuation class, not a behavior change
 * for live traffic.
 *
 * Log policy (Part D, ctor-only): a fenced rejection emits ONE static
 * sanitized line — never the operation's arguments, model data, or any
 * error message from upstream code.
 */

/** Dedicated rejection error: upstream catch paths turn it into failed
 * verification / 500 responses (the client is gone or the process is
 * shutting down). */
export class AuthDbShutdownFenceError extends Error {
  constructor() {
    super("auth database shutdown fence is active");
    this.name = "AuthDbShutdownFenceError";
  }
}

/** Module-level fence state. Default: NEVER fenced (zero behavior change). */
let fenceArmed = false;

/** Arm the fence: every NEW adapter DB operation rejects. Idempotent. */
export function armAuthDbShutdownFence(): void {
  fenceArmed = true;
}

/**
 * Disarm the fence (test hygiene only — production arms once at shutdown and
 * the process exits; tests must reset the module state between cases).
 */
export function disarmAuthDbShutdownFence(): void {
  fenceArmed = false;
}

/** Whether the fence is currently armed. */
export function isAuthDbShutdownFenceArmed(): boolean {
  return fenceArmed;
}

/** One sanitized line per fenced rejection (static text only). */
function logFencedRejection(): void {
  console.error("[auth] shutdown fence rejected database operation (AuthDbShutdownFenceError)");
}

const modelProxies = new WeakMap<object, object>();

/**
 * Wrap one Prisma model delegate so every METHOD call on it is check-first
 * fenced. Delegates may be plain objects (generated Prisma clients) OR
 * callable function proxies (test doubles such as vitest-mock-extended's
 * mockDeep) — both surfaces are fenced (property-accessed methods AND
 * calling the delegate itself). Non-function property access passes
 * through untouched. The wrapped methods preserve arguments, `this`
 * binding, and return values verbatim while the fence is inactive.
 */
function fenceModelDelegate<TDelegate extends object>(delegate: TDelegate): TDelegate {
  const cached = modelProxies.get(delegate);
  if (cached !== undefined) return cached as TDelegate;
  const proxy = new Proxy(delegate, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const method = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        if (fenceArmed) {
          logFencedRejection();
          throw new AuthDbShutdownFenceError();
        }
        return method.apply(target, args);
      };
    },
    apply(target, thisArg, args) {
      if (fenceArmed) {
        logFencedRejection();
        throw new AuthDbShutdownFenceError();
      }
      const callable = target as (...invokeArgs: unknown[]) => unknown;
      return Reflect.apply(callable, thisArg, args as unknown[]);
    },
  });
  modelProxies.set(delegate, proxy);
  return proxy;
}

/**
 * Wrap the Prisma client handed to better-auth's prisma adapter.
 *
 * Coverage (every adapter operation the installed @better-auth/prisma-adapter
 * issues — prisma-adapter/dist/index.mjs): model delegates (`prisma.user`,
 * `prisma.verification`, … — the adapter calls `db[model].create/findFirst/
 * findMany/count/update/updateMany/delete/deleteMany`, and `findOne` maps to
 * `findFirst`), plus `prisma.$transaction` (the adapter's consumeOne /
 * incrementOne transactional fallbacks). `$`-prefixed client methods other
 * than `$transaction` (e.g. `$disconnect`) and `_`-prefixed internals
 * (e.g. `_runtimeDataModel`, read once at adapter construction) pass
 * through UNWRAPPED — the fence owns adapter DATA operations only.
 */
export function withAuthDbShutdownFence<TClient extends object>(prisma: TClient): TClient {
  return new Proxy(prisma, {
    get(target, property, receiver) {
      if (typeof property === "string" && property !== "$transaction") {
        if (property.startsWith("$") || property.startsWith("_")) {
          return Reflect.get(target, property, receiver);
        }
        const value = Reflect.get(target, property, target);
        if (value !== null && (typeof value === "object" || typeof value === "function")) {
          return fenceModelDelegate(value);
        }
        return value;
      }
      // `$transaction` itself is fenced: no NEW transaction may open after
      // gate close (its callback would receive the raw, unfenced client).
      if (property === "$transaction") {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        const transaction = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => {
          if (fenceArmed) {
            logFencedRejection();
            throw new AuthDbShutdownFenceError();
          }
          return transaction.apply(target, args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}
