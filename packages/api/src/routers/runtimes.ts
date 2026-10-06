import { stub } from "../contract-procedure";
import { runtimesContract as c } from "../contracts/runtimes";

/** S0c: bound to the contract with NOT_IMPLEMENTED handlers; implemented in lane A2 to A5. */
export const runtimesRouter = {
  list: stub(c.list),
  get: stub(c.get),
  versions: {
    list: stub(c.versions.list),
    get: stub(c.versions.get),
  },
  presets: {
    list: stub(c.presets.list),
  },
  create: stub(c.create),
  update: stub(c.update),
  delete: stub(c.delete),
  start: stub(c.start),
  stop: stub(c.stop),
  steps: {
    attach: stub(c.steps.attach),
    reopen: stub(c.steps.reopen),
    cancel: stub(c.steps.cancel),
  },
  instances: {
    forget: stub(c.instances.forget),
  },
  models: {
    setCapabilities: stub(c.models.setCapabilities),
  },
  detected: {
    add: stub(c.detected.add),
  },
  shares: {
    list: stub(c.shares.list),
    create: stub(c.shares.create),
    delete: stub(c.shares.delete),
  },
  fork: stub(c.fork),
};
