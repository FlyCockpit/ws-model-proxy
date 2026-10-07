/**
 * Storage of runtime request profiles (`runtime_request_profile`): one row per runtime launch.
 * Reads go through a short in-process cache (the request path reads one per attempt); this
 * process's own writes refresh it. Writes are best effort: a lost update only means a fix is
 * learned again on a later 400. Rows hold field names only, never request values.
 */
import {
  type AcceptedProfile,
  type CompatEndpoint,
  emptyLearnedProfile,
  type LearnedFix,
  type LearnedProfile,
  readAcceptedProfile,
  readLearnedProfile,
} from "@ws-model-proxy/api/lib/request-compat";
import prisma, { Prisma } from "@ws-model-proxy/db";
import { withLearnedFix, withLearnedHeader } from "./runtime-compat.js";

export type StoredRequestProfile = {
  accepted: AcceptedProfile | null;
  learned: LearnedProfile;
  engineFingerprint: string | null;
};

export type LaunchKey = { userId: string; runtimeId: string; launchHash: string };

const CACHE_TTL_MS = 15_000;
const CACHE_MAX_ENTRIES = 2_048;
const cache = new Map<string, { at: number; profile: StoredRequestProfile }>();

function cacheKey(key: Pick<LaunchKey, "runtimeId" | "launchHash">): string {
  return `${key.runtimeId}:${key.launchHash}`;
}

function remember(key: LaunchKey, profile: StoredRequestProfile) {
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value ?? "");
  cache.set(cacheKey(key), { at: Date.now(), profile });
}

const EMPTY: StoredRequestProfile = {
  accepted: null,
  learned: emptyLearnedProfile(),
  engineFingerprint: null,
};

/** Forgets cached profiles (tests; a relearn in another process expires on its own). */
export function clearRequestProfileCache(): void {
  cache.clear();
}

/** The profile of one launch (empty when none was learned). Never throws. */
export async function loadRequestProfile(key: LaunchKey): Promise<StoredRequestProfile> {
  const hit = cache.get(cacheKey(key));
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.profile;
  try {
    const row = await prisma.runtimeRequestProfile.findFirst({
      where: { runtimeId: key.runtimeId, launchHash: key.launchHash, userId: key.userId },
      select: { accepted: true, learned: true, engineFingerprint: true },
    });
    const profile = row
      ? {
          accepted: readAcceptedProfile(row.accepted),
          learned: readLearnedProfile(row.learned),
          engineFingerprint: row.engineFingerprint,
        }
      : EMPTY;
    remember(key, profile);
    return profile;
  } catch {
    return hit?.profile ?? EMPTY;
  }
}

async function writeLearned(
  key: LaunchKey,
  next: (learned: LearnedProfile) => LearnedProfile | null,
): Promise<void> {
  for (let tries = 0; tries < 2; tries += 1) {
    const row = await prisma.runtimeRequestProfile.findFirst({
      where: { runtimeId: key.runtimeId, launchHash: key.launchHash, userId: key.userId },
      select: { id: true, learned: true, updatedAt: true, accepted: true, engineFingerprint: true },
    });
    const learned = next(readLearnedProfile(row?.learned));
    if (!learned) return;
    try {
      if (row) {
        const updated = await prisma.runtimeRequestProfile.updateMany({
          where: { id: row.id, updatedAt: row.updatedAt },
          data: { learned: learned as Prisma.InputJsonValue },
        });
        if (updated.count === 0) continue;
      } else {
        await prisma.runtimeRequestProfile.create({
          data: {
            userId: key.userId,
            runtimeId: key.runtimeId,
            launchHash: key.launchHash,
            learned: learned as Prisma.InputJsonValue,
          },
        });
      }
      remember(key, {
        accepted: readAcceptedProfile(row?.accepted),
        learned,
        engineFingerprint: row?.engineFingerprint ?? null,
      });
      return;
    } catch {
      // A concurrent create of the same launch: read it again and merge.
    }
  }
}

/** Records a fix learned from the engine's 400 for one endpoint. */
export function recordLearnedFix(
  key: LaunchKey,
  endpoint: CompatEndpoint,
  fix: LearnedFix,
): Promise<void> {
  return writeLearned(key, (learned) => withLearnedFix(learned, endpoint, fix)).catch(
    () => undefined,
  );
}

/** Records a client header the engine rejected. */
export function recordLearnedHeader(key: LaunchKey, name: string): Promise<void> {
  return writeLearned(key, (learned) => withLearnedHeader(learned, name)).catch(() => undefined);
}

/**
 * Stores what the engine's description says it accepts. Another fingerprint than the stored one
 * means another engine version answered: what was learned before is dropped.
 */
export async function saveDescribedProfile(
  key: LaunchKey,
  described: { accepted: AcceptedProfile; engineFingerprint: string },
  now = new Date(),
): Promise<void> {
  const row = await prisma.runtimeRequestProfile.findFirst({
    where: { runtimeId: key.runtimeId, launchHash: key.launchHash, userId: key.userId },
    select: { id: true, engineFingerprint: true, learned: true },
  });
  const sameEngine = row?.engineFingerprint === described.engineFingerprint;
  const learned = sameEngine ? readLearnedProfile(row?.learned) : emptyLearnedProfile();
  const data = {
    source: "OPENAPI" as const,
    engineFingerprint: described.engineFingerprint,
    accepted: described.accepted as Prisma.InputJsonValue,
    learned: learned as Prisma.InputJsonValue,
    probedAt: now,
  };
  if (row) await prisma.runtimeRequestProfile.update({ where: { id: row.id }, data });
  else
    await prisma.runtimeRequestProfile.create({
      data: { userId: key.userId, runtimeId: key.runtimeId, launchHash: key.launchHash, ...data },
    });
  remember(key, {
    accepted: described.accepted,
    learned,
    engineFingerprint: described.engineFingerprint,
  });
}

/**
 * Notes that the engine has no readable description, so it is not asked again until it
 * restarts. When it had one before, another engine answers now: everything is forgotten.
 */
export async function markProbedWithoutDescription(key: LaunchKey, now = new Date()) {
  const row = await prisma.runtimeRequestProfile.findFirst({
    where: { runtimeId: key.runtimeId, launchHash: key.launchHash, userId: key.userId },
    select: { id: true, engineFingerprint: true },
  });
  if (!row) {
    await prisma.runtimeRequestProfile
      .create({ data: { ...key, probedAt: now } })
      .catch(() => undefined);
    return;
  }
  const changedEngine = row.engineFingerprint !== null;
  await prisma.runtimeRequestProfile.update({
    where: { id: row.id },
    data: {
      probedAt: now,
      ...(changedEngine
        ? {
            source: "LEARNED" as const,
            engineFingerprint: null,
            accepted: Prisma.DbNull,
            learned: emptyLearnedProfile() as Prisma.InputJsonValue,
          }
        : {}),
    },
  });
  if (changedEngine) cache.delete(cacheKey(key));
}
