import { stub } from "../contract-procedure";
import { profilesContract as c } from "../contracts/profiles";

/** S0c: bound to the contract with NOT_IMPLEMENTED handlers; implemented in lane A5. */
export const profilesRouter = {
  list: stub(c.list),
  get: stub(c.get),
  save: stub(c.save),
  delete: stub(c.delete),
  apply: stub(c.apply),
};
