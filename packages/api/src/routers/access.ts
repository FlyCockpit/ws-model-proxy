import { stub } from "../contract-procedure";
import { accessContract as c } from "../contracts/access";

/** S0c: bound to the contract with NOT_IMPLEMENTED handlers; implemented in lane B2. */
export const accessRouter = {
  apiKeys: {
    list: stub(c.apiKeys.list),
    create: stub(c.apiKeys.create),
    revoke: stub(c.apiKeys.revoke),
  },
  agentTokens: {
    list: stub(c.agentTokens.list),
    create: stub(c.agentTokens.create),
    revoke: stub(c.agentTokens.revoke),
  },
  oauthGrants: {
    list: stub(c.oauthGrants.list),
    revoke: stub(c.oauthGrants.revoke),
  },
  shares: {
    list: stub(c.shares.list),
    create: stub(c.shares.create),
    update: stub(c.shares.update),
    delete: stub(c.shares.delete),
    setOwnKey: stub(c.shares.setOwnKey),
  },
  invites: {
    resend: stub(c.invites.resend),
    revoke: stub(c.invites.revoke),
  },
  contributing: {
    pools: stub(c.contributing.pools),
  },
};
