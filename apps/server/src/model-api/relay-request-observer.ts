import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Lets an in-process caller learn the id of the `RelayRequest` row its request created
 * (`models.test` reads back what served it). The model API routes report every row they
 * create; only a caller that runs inside `observeRelayRequests` hears about it.
 */
const observers = new AsyncLocalStorage<(relayRequestId: string) => void>();

export function observeRelayRequests<T>(
  onCreated: (relayRequestId: string) => void,
  work: () => Promise<T>,
): Promise<T> {
  return observers.run(onCreated, work);
}

export function reportRelayRequestCreated(relayRequestId: string): void {
  observers.getStore()?.(relayRequestId);
}
