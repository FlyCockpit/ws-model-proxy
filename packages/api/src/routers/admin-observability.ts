import { stub } from "../contract-procedure";
import { adminObservabilityContract as c } from "../contracts/account";

/** S0c: bound to the contract with NOT_IMPLEMENTED handlers; implemented in lane W10. */
export const adminObservabilityRouter = {
  nodes: stub(c.nodes),
  runtimes: stub(c.runtimes),
  pools: stub(c.pools),
  relay: stub(c.relay),
};
