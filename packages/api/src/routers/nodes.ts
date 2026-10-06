import { stub } from "../contract-procedure";
import { nodesContract as c } from "../contracts/nodes";
import { nodeOperatorRouters } from "./node-operator";

/** S0c: bound to the contract with NOT_IMPLEMENTED handlers; implemented in lane A1. */
export const nodesRouter = {
  list: stub(c.list),
  get: stub(c.get),
  update: stub(c.update),
  secrets: {
    set: stub(c.secrets.set),
    delete: stub(c.secrets.delete),
  },
  setHold: stub(c.setHold),
  setTemporary: stub(c.setTemporary),
  fabrics: {
    list: stub(c.fabrics.list),
    rename: stub(c.fabrics.rename),
    delete: stub(c.fabrics.delete),
  },
  rename: stub(c.rename),
  delete: stub(c.delete),
  lowerTrustPreview: stub(c.lowerTrustPreview),
  lowerTrust: stub(c.lowerTrust),
  enrollmentCodes: {
    list: stub(c.enrollmentCodes.list),
    create: stub(c.enrollmentCodes.create),
    revoke: stub(c.enrollmentCodes.revoke),
  },
  credentials: {
    list: stub(c.credentials.list),
    revoke: stub(c.credentials.revoke),
  },
  activity: {
    list: stub(c.activity.list),
  },
  // Lane D (node-operator.ts): browser terminals, queued commands, node commands.
  terminals: nodeOperatorRouters.terminals,
  queued: nodeOperatorRouters.queued,
  commands: nodeOperatorRouters.commands,
  files: {
    read: stub(c.files.read),
    write: stub(c.files.write),
    edit: stub(c.files.edit),
  },
};
