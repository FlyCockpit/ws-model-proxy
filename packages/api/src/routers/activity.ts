import { stub } from "../contract-procedure";
import { activityContract as c } from "../contracts/activity";

/** S0c: bound to the contract with NOT_IMPLEMENTED handlers; implemented in lane B5. */
export const activityRouter = {
  metrics: {
    query: stub(c.metrics.query),
  },
  requests: {
    list: stub(c.requests.list),
    delete: stub(c.requests.delete),
  },
  overview: {
    summary: stub(c.overview.summary),
  },
  needsYou: {
    list: stub(c.needsYou.list),
  },
};
