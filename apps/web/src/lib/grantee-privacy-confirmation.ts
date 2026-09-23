import { GRANTEE_PRIVACY_CONFIRMATION_REQUIRED } from "@ws-model-proxy/api/lib/effective-provider-egress";

export type GranteePrivacyConfirm = {
  poolName: string;
  grantees: { email: string; name: string }[];
};

export function granteePrivacyConfirmationFromError(error: unknown): GranteePrivacyConfirm | null {
  if (!error || typeof error !== "object" || !("data" in error)) return null;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object" || !("reason" in data)) return null;
  if (data.reason !== GRANTEE_PRIVACY_CONFIRMATION_REQUIRED) return null;
  const poolName = "poolName" in data && typeof data.poolName === "string" ? data.poolName : "";
  if (!("grantees" in data) || !Array.isArray(data.grantees)) return null;
  const grantees = data.grantees.flatMap((item) => {
    if (!item || typeof item !== "object" || !("email" in item)) return [];
    const email = item.email;
    const name = "name" in item ? item.name : "";
    if (typeof email !== "string" || email.length === 0) return [];
    return [{ email, name: typeof name === "string" ? name : "" }];
  });
  if (grantees.length === 0) return null;
  return { poolName, grantees };
}
