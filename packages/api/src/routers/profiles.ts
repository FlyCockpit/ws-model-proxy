import { profileProcedures } from "../profiles/procedures";

/** Lane B: profiles (`src/profiles/`). */
export const profilesRouter = {
  list: profileProcedures.list,
  get: profileProcedures.get,
  save: profileProcedures.save,
  delete: profileProcedures.delete,
  apply: profileProcedures.apply,
};
