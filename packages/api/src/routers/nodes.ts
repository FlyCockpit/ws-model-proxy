import { stub } from "../contract-procedure";
import { nodesContract as c } from "../contracts/nodes";
import { credentialProcedures, enrollmentProcedures } from "../nodes/enrollment";
import { nodeProcedures as n } from "../nodes/procedures";
import { secretProcedures } from "../nodes/secrets";
import { nodeOperatorRouters } from "./node-operator";

/**
 * Lane B implements the node definition, trust, fabrics, enrollment and activity
 * (`src/nodes/`); lane D terminals, queued commands and commands (`./node-operator.ts`).
 * Files are still stubs.
 */
export const nodesRouter = {
  list: n.list,
  get: n.get,
  update: n.update,
  secrets: secretProcedures,
  setHold: n.setHold,
  setTemporary: n.setTemporary,
  fabrics: n.fabrics,
  rename: n.rename,
  delete: n.delete,
  lowerTrustPreview: n.lowerTrustPreview,
  lowerTrust: n.lowerTrust,
  enrollmentCodes: enrollmentProcedures,
  credentials: credentialProcedures,
  activity: n.activity,
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
