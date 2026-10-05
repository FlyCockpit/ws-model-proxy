/**
 * `Endpoint.failureReasonCode` for a managed endpoint whose reported identity
 * the relay refused. Registration sets and clears it; a passing health check
 * never republishes an endpoint that carries it.
 */
export const MANAGED_IDENTITY_REFUSED = "managed_identity_refused";
