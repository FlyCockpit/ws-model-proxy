import prisma from "@ws-model-proxy/db";

const FORCE_TWO_FACTOR_CACHE_TTL_MS = 15_000;

type CachedPolicy = {
  value: boolean;
  expiresAt: number;
};

type PolicyLookup = {
  generation: number;
  promise: Promise<boolean>;
};

let generation = 0;
let cachedPolicy: CachedPolicy | undefined;
let activeLookup: PolicyLookup | undefined;

/**
 * Reads the global force-2FA policy with a short process-local cache.
 *
 * The admin settings mutation invalidates this cache immediately. The TTL is
 * still bounded so direct database changes and independently deployed server
 * processes converge without leaving security policy stale indefinitely.
 */
export async function isForceTwoFactorRequired(): Promise<boolean> {
  const now = Date.now();
  if (cachedPolicy && cachedPolicy.expiresAt > now) return cachedPolicy.value;
  if (activeLookup?.generation === generation) return activeLookup.promise;

  const lookupGeneration = generation;
  const promise = (async () => {
    const setting = await prisma.appSetting.findUnique({
      where: { key: "force2fa" },
      select: { value: true },
    });
    const value = setting?.value === "true";
    if (generation === lookupGeneration) {
      cachedPolicy = { value, expiresAt: Date.now() + FORCE_TWO_FACTOR_CACHE_TTL_MS };
    }
    return value;
  })();

  activeLookup = { generation: lookupGeneration, promise };
  try {
    return await promise;
  } finally {
    if (activeLookup?.promise === promise) activeLookup = undefined;
  }
}

/** Invalidates cached policy after a successful force-2FA setting update. */
export function invalidateForceTwoFactorPolicyCache(): void {
  generation += 1;
  cachedPolicy = undefined;
  activeLookup = undefined;
}
