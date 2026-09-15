import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { ActivityEditClient } from "./activity-edit-client";

export default async function EditActivityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  return <ActivityEditClient id={id} />;
}
