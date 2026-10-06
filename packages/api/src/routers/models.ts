import { stub } from "../contract-procedure";
import { modelsContract as c } from "../contracts/models";

/** S0c: bound to the contract with NOT_IMPLEMENTED handlers; implemented in lane B1. */
export const modelsRouter = {
  list: stub(c.list),
  test: stub(c.test),
};
