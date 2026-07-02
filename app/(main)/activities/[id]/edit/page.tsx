import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Role } from "@prisma/client";
import { ActivityEditClient } from "./activity-edit-client";

export default async function EditActivityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  const isAdmin = session.user.role === Role.ADMIN;
  return <ActivityEditClient id={id} isAdmin={isAdmin} />;
}
