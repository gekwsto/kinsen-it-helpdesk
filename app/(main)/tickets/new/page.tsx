import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission, isAdmin } from "@/lib/permissions";
import { Role } from "@prisma/client";
import { CreateTicketForm } from "@/components/tickets/ticket-form";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ChevronRight, TicketPlus, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";

export default async function NewTicketPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const canCreate = await hasPermission(
    session.user.role,
    "ticket.create",
    session.user.customRoleId
  );

  if (!canCreate) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center gap-4">
        <ShieldOff className="h-12 w-12 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Cannot create tickets</h1>
        <p className="text-muted-foreground text-sm max-w-sm">
          You don&apos;t have permission to create support tickets. Contact your administrator to request access.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/my-tickets">View my tickets</Link>
        </Button>
      </div>
    );
  }

  const userIsAdmin = isAdmin(session.user.role);

  const [categories, priorities, departments, itAgents, projects, activities] =
    await Promise.all([
      prisma.ticketCategory.findMany({
        where: { isActive: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
      prisma.ticketPriority.findMany({
        where: { isActive: true },
        orderBy: { level: "desc" },
        select: { id: true, name: true, color: true, level: true },
      }),
      prisma.department.findMany({
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
      prisma.user.findMany({
        where: { role: { in: [Role.IT_AGENT, Role.ADMIN] }, isActive: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, image: true },
        take: 6,
      }),
      // Only load projects and activities for admin users (non-admins cannot link tickets)
      userIsAdmin
        ? prisma.project.findMany({
            orderBy: { title: "asc" },
            select: { id: true, title: true },
          })
        : Promise.resolve([]),
      userIsAdmin
        ? prisma.projectActivity.findMany({
            where: { isCompleted: false },
            orderBy: { title: "asc" },
            select: { id: true, title: true, projectId: true },
          })
        : Promise.resolve([]),
    ]);

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/tickets" className="hover:text-foreground transition-colors">
          Tickets
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground font-medium">New Ticket</span>
      </div>

      {/* Header */}
      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <TicketPlus className="h-6 w-6 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Create New Ticket</h1>
          <p className="text-muted-foreground mt-0.5">
            Submit a support request and our IT team will get back to you shortly.
          </p>
        </div>
      </div>

      <CreateTicketForm
        categories={categories}
        priorities={priorities}
        departments={departments}
        itAgents={itAgents}
        projects={projects}
        activities={activities}
      />
    </div>
  );
}
