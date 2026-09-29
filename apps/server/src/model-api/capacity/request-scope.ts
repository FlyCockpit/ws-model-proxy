import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";
import { CapacityLeaseLostError } from "./lease-loss.js";

/** The part of `CapacityLeaseOwner` a scope needs (kept structural to avoid an import cycle). */
export type ScopedCapacityLeaseOwner = {
  readonly released: boolean;
  release(reason?: unknown): Promise<boolean>;
};

/**
 * Structural release guard (F2-CAP-6). Every `CapacityLeaseOwner` created while
 * a scope is active registers itself here. The scope closes when the request
 * is over: the handler threw, returned a bodyless response, or the returned
 * body reached EOF, errored, or was cancelled. Owners still alive at that point
 * were forgotten by their route: the scope logs that and releases them, so a
 * missing `release()` or response hand-off can no longer keep a slot
 * heartbeating until process shutdown.
 *
 * Legitimate owners are always released first: the response wrapper
 * (`holdCapacityLeaseForResponse`) releases before it exposes EOF and marks the
 * owner released before it surfaces an error, so the scope only ever sees
 * released owners on correct paths.
 *
 * The scope deliberately does not close on request abort: owners already take
 * the request signal as their parent and release as a client cancellation. A
 * scope release is a server-side lease loss, and must not win that race.
 */
export class CapacityRequestScope {
  readonly #owners = new Set<ScopedCapacityLeaseOwner>();
  #closing: Promise<void> | undefined;

  get closed(): boolean {
    return this.#closing !== undefined;
  }

  register(owner: ScopedCapacityLeaseOwner): void {
    if (this.#closing) {
      // Created by a continuation that outlived its request: never let it run.
      console.warn("[capacity] lease owner created after its request scope closed; releasing");
      void owner.release(new CapacityLeaseLostError("request_scope_closed"));
      return;
    }
    this.#owners.add(owner);
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    const leaked = [...this.#owners].filter((owner) => !owner.released);
    this.#owners.clear();
    if (leaked.length > 0)
      console.warn("[capacity] lease owner outlived its request scope; releasing", {
        owners: leaked.length,
      });
    this.#closing = Promise.all(
      leaked.map((owner) => owner.release(new CapacityLeaseLostError("request_scope_closed"))),
    ).then(() => undefined);
    return this.#closing;
  }
}

const capacityRequestScopes = new AsyncLocalStorage<CapacityRequestScope>();

export function currentCapacityRequestScope(): CapacityRequestScope | undefined {
  return capacityRequestScopes.getStore();
}

/** Close `scope` once `response` is fully delivered, errored, or cancelled. */
export function bindResponseToCapacityScope(
  response: Response,
  scope: CapacityRequestScope,
): Response {
  if (!response.body) {
    void scope.close();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        await scope.close();
        controller.error(error);
        return;
      }
      if (chunk.done) {
        await scope.close();
        controller.close();
        return;
      }
      controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await scope.close();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Run a non-HTTP caller (for example an MCP diagnostic) inside a scope closed on return. */
export async function withCapacityRequestScope<T>(work: () => Promise<T>): Promise<T> {
  const scope = new CapacityRequestScope();
  try {
    return await capacityRequestScopes.run(scope, work);
  } finally {
    await scope.close();
  }
}

/** Hono middleware form of `withCapacityRequestScope`. */
export const capacityRequestScopeMiddleware: MiddlewareHandler = async (c, next) => {
  const scope = new CapacityRequestScope();
  try {
    await capacityRequestScopes.run(scope, next);
  } catch (error) {
    await scope.close();
    throw error;
  }
  c.res = bindResponseToCapacityScope(c.res, scope);
};
