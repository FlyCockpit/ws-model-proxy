import { stub } from "../contract-procedure";
import { poolsContract as c } from "../contracts/pools";

/** S0c: bound to the contract with NOT_IMPLEMENTED handlers; implemented in lane B1. */
export const poolsRouter = {
  list: stub(c.list),
  get: stub(c.get),
  history: {
    list: stub(c.history.list),
  },
  create: stub(c.create),
  update: stub(c.update),
  delete: stub(c.delete),
  cloud: {
    setMode: stub(c.cloud.setMode),
    setPaidWarmProtection: stub(c.cloud.setPaidWarmProtection),
    setOwnKeyEquivalent: stub(c.cloud.setOwnKeyEquivalent),
  },
  routing: {
    setOwnHardwareOnly: stub(c.routing.setOwnHardwareOnly),
  },
  members: {
    addContributed: stub(c.members.addContributed),
    removeContributed: stub(c.members.removeContributed),
  },
  rules: {
    delete: stub(c.rules.delete),
  },
};
