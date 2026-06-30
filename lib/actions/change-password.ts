"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { AuthProvider, Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { changePasswordSchema } from "@/lib/validations";

export type ChangePasswordState = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
  success?: boolean;
} | null;

export async function changePasswordAction(
  _prevState: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const session = await auth();

  if (!session?.user || session.user.role !== Role.ADMIN) {
    return { error: "Unauthorized." };
  }

  const parsed = changePasswordSchema.safeParse({
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]> };
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { passwordHash: true, authProvider: true },
  });

  if (!user || user.authProvider !== AuthProvider.CREDENTIALS) {
    return { error: "Password change is only available for admin credential accounts." };
  }

  if (!user.passwordHash) {
    return { error: "No password set on this account. Contact IT support." };
  }

  const isCurrentValid = await bcrypt.compare(parsed.data.currentPassword, user.passwordHash);
  if (!isCurrentValid) {
    return { fieldErrors: { currentPassword: ["Current password is incorrect."] } };
  }

  const newHash = await bcrypt.hash(parsed.data.newPassword, 12);

  await prisma.user.update({
    where: { id: session.user.id },
    data: { passwordHash: newHash, mustChangePassword: false },
  });

  return { success: true };
}
