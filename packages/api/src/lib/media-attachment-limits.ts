import {
  clampMediaAttachmentMaxBytes,
  MEDIA_ATTACHMENT_MAX_BYTES_DEFAULT,
  MEDIA_ATTACHMENT_MAX_BYTES_SETTING_KEY,
} from "@ws-model-proxy/config/media-policy";
import prisma from "@ws-model-proxy/db";

type AttachmentLimitPrisma = Pick<typeof prisma, "appSetting">;

/** Database policy only; media routes additionally cap this at their deployment limit. */
export async function getConfiguredMediaAttachmentMaxBytes(
  db: AttachmentLimitPrisma = prisma,
): Promise<number> {
  const setting = await db.appSetting.findUnique({
    where: { key: MEDIA_ATTACHMENT_MAX_BYTES_SETTING_KEY },
    select: { value: true },
  });
  if (!setting?.value) return MEDIA_ATTACHMENT_MAX_BYTES_DEFAULT;
  const parsed = Number(setting.value);
  return Number.isFinite(parsed)
    ? clampMediaAttachmentMaxBytes(parsed)
    : MEDIA_ATTACHMENT_MAX_BYTES_DEFAULT;
}

/** The database policy can narrow a deployment's immutable upload ceiling, never raise it. */
export function effectiveMediaAttachmentMaxBytes(
  deploymentMaxBytes: number,
  configuredMaxBytes: number,
): number {
  return resolveAttachmentLimit({ configuredBytes: configuredMaxBytes, deploymentMaxBytes });
}

/** Resolve the one attachment policy used by uploads and model requests. */
export function resolveAttachmentLimit({
  configuredBytes,
  deploymentMaxBytes,
  modelOrPoolMaxBytes,
}: {
  configuredBytes: number;
  deploymentMaxBytes?: number | null;
  modelOrPoolMaxBytes?: number | null;
}): number {
  return Math.min(
    clampMediaAttachmentMaxBytes(configuredBytes),
    deploymentMaxBytes && deploymentMaxBytes > 0 ? deploymentMaxBytes : Number.POSITIVE_INFINITY,
    modelOrPoolMaxBytes && modelOrPoolMaxBytes > 0 ? modelOrPoolMaxBytes : Number.POSITIVE_INFINITY,
  );
}
