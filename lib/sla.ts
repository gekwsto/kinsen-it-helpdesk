import { prisma } from "@/lib/prisma";

export async function isSlaEnabled(): Promise<boolean> {
  const settings = await prisma.slaSettings.findFirst();
  return settings?.isEnabled ?? false;
}
