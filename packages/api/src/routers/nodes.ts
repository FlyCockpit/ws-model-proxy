import { credentialProcedures, enrollmentProcedures } from "../nodes/enrollment";
import { fileProcedures } from "../nodes/files";
import { nodeProcedures as n } from "../nodes/procedures";
import { secretProcedures } from "../nodes/secrets";
import { nodeOperatorRouters } from "./node-operator";

/**
 * Lane B implements the node definition, trust, fabrics, enrollment and activity
 * (`src/nodes/`); lane D terminals, queued commands and commands (`./node-operator.ts`); the
 * node file tools are `src/nodes/files.ts`.
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
  files: fileProcedures,
};
