import prisma from "@ws-model-proxy/db";

export async function canUserChangePassword({
  userId,
  forceSso,
}: {
  userId: string;
  forceSso: boolean;
}): Promise<boolean> {
  if (forceSso) return false;

  const credentialAccount = await prisma.account.findFirst({
    where: {
      userId,
      providerId: "credential",
      password: { not: null },
    },
    select: { id: true },
  });

  return Boolean(credentialAccount);
}
