import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Role } from "@prisma/client";
import { ActivityDetailClient } from "./activity-detail-client";

export default async function ActivityDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  const isAdmin = session.user.role === Role.ADMIN;
  return <ActivityDetailClient id={id} isAdmin={isAdmin} />;
}
