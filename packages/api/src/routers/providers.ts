import { stub } from "../contract-procedure";
import { providersContract as c } from "../contracts/providers";

/** S0c: bound to the contract with NOT_IMPLEMENTED handlers; implemented in lane B3. */
export const providersRouter = {
  accounts: {
    list: stub(c.accounts.list),
    get: stub(c.accounts.get),
    create: stub(c.accounts.create),
    update: stub(c.accounts.update),
    delete: stub(c.accounts.delete),
    setEnabled: stub(c.accounts.setEnabled),
    setDataCollection: stub(c.accounts.setDataCollection),
  },
  credentials: {
    replace: stub(c.credentials.replace),
    revoke: stub(c.credentials.revoke),
    test: stub(c.credentials.test),
    reencrypt: stub(c.credentials.reencrypt),
  },
  models: {
    list: stub(c.models.list),
    create: stub(c.models.create),
    update: stub(c.models.update),
    delete: stub(c.models.delete),
  },
  pricing: {
    list: stub(c.pricing.list),
    create: stub(c.pricing.create),
    activate: stub(c.pricing.activate),
    retire: stub(c.pricing.retire),
    delete: stub(c.pricing.delete),
  },
  catalog: {
    search: stub(c.catalog.search),
  },
  usage: {
    list: stub(c.usage.list),
  },
  attempts: {
    list: stub(c.attempts.list),
  },
  spendCaps: {
    set: stub(c.spendCaps.set),
    clear: stub(c.spendCaps.clear),
  },
};
