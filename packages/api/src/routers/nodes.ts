import { stub } from "../contract-procedure";
import { nodesContract as c } from "../contracts/nodes";
import { credentialProcedures, enrollmentProcedures } from "../nodes/enrollment";
import { nodeProcedures as n } from "../nodes/procedures";

/**
 * Lane B implements the node definition, trust, fabrics, enrollment and activity
 * (`src/nodes/`); terminals, queued commands, commands and files are lane D's stubs.
 */
export const nodesRouter = {
  list: n.list,
  get: n.get,
  update: n.update,
  secrets: {
    set: stub(c.secrets.set),
    delete: stub(c.secrets.delete),
  },
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
  terminals: {
    openTicket: stub(c.terminals.openTicket),
  },
  queued: {
    list: stub(c.queued.list),
    enqueue: stub(c.queued.enqueue),
    run: stub(c.queued.run),
    dismiss: stub(c.queued.dismiss),
  },
  commands: {
    run: stub(c.commands.run),
    get: stub(c.commands.get),
  },
  files: {
    read: stub(c.files.read),
    write: stub(c.files.write),
    edit: stub(c.files.edit),
  },
};
