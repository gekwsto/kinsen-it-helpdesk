import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { hasPermission } from "@/lib/permissions";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate } from "@/lib/utils";

interface SearchParams {
  departmentId?: string;
  minRating?: string;
}

/**
 * Administration -> Feedback — REVIEW ONLY. Renders every submitted
 * ProjectFeedback row; never offers create/edit/delete for any of them
 * (see prisma/schema.prisma's ProjectFeedback model — the data is
 * immutable by design, and this page never pretends otherwise).
 *
 * Gated on its OWN dedicated permission (projectFeedback.view), never bare
 * admin.access and never a hardcoded role === "ADMIN" check — see
 * components/layout/sidebar.tsx's matching nav-visibility gate
 * (navFlags.canViewProjectFeedback) for why this one deliberately departs
 * from most other Administration entries' roles:["ADMIN"] pattern. Hiding
 * this page is UX only; this server-side check is the actual authority.
 */
export default async function ProjectFeedbackAdminPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const allowed = await hasPermission(session.user.role, "projectFeedback.view", session.user.customRoleId);
  if (!allowed) redirect("/dashboard");

  const { departmentId, minRating } = await searchParams;
  const minRatingNum = minRating ? Number(minRating) : undefined;

  const [feedbacks, departments] = await Promise.all([
    prisma.projectFeedback.findMany({
      where: {
        ...(departmentId ? { project: { departmentId } } : {}),
        ...(minRatingNum && Number.isInteger(minRatingNum) ? { satisfactionScore: { gte: minRatingNum } } : {}),
      },
      orderBy: { createdAt: "desc" },
      include: {
        project: { select: { id: true, title: true, department: { select: { id: true, name: true } } } },
        projectRequest: { select: { id: true, title: true } },
        submittedByUser: { select: { id: true, name: true, email: true } },
      },
    }),
    prisma.department.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Project Feedback</h1>
        <p className="text-muted-foreground mt-1">
          Feedback submitted by the original requester on delivered, request-origin Projects. Read-only.
        </p>
      </div>

      {/* Plain GET form — no client JS needed for a simple review filter;
          same "query params drive the list" convention as every other
          filterable list page in this app, just without a client-side
          Select component since nothing here needs live re-fetching. */}
      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label htmlFor="departmentId" className="text-xs font-medium text-muted-foreground">
            Department
          </label>
          <select
            id="departmentId"
            name="departmentId"
            defaultValue={departmentId ?? ""}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor="minRating" className="text-xs font-medium text-muted-foreground">
            Minimum Satisfaction
          </label>
          <select
            id="minRating"
            name="minRating"
            defaultValue={minRating ?? ""}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">Any</option>
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}+
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="h-9 rounded-md border px-4 text-sm font-medium hover:bg-muted">
          Filter
        </button>
        {(departmentId || minRating) && (
          <Link href="/admin/project-feedback" className="text-sm text-muted-foreground hover:underline">
            Clear filters
          </Link>
        )}
      </form>

      <Card>
        <CardContent className="p-0">
          {feedbacks.length === 0 ? (
            <p className="text-sm text-muted-foreground p-6">No Project Feedback has been submitted yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Project</TableHead>
                  <TableHead>Project Request</TableHead>
                  <TableHead>Requester</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Satisfaction</TableHead>
                  <TableHead>Comments</TableHead>
                  <TableHead>Submitted At</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {feedbacks.map((fb) => (
                  <TableRow key={fb.id}>
                    <TableCell>
                      <Link href={`/projects/${fb.project.id}`} className="text-primary hover:underline">
                        {fb.project.title}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link href={`/project-requests/${fb.projectRequest.id}`} className="text-primary hover:underline">
                        {fb.projectRequest.title}
                      </Link>
                    </TableCell>
                    <TableCell>{fb.submittedByUser.name ?? fb.submittedByUser.email}</TableCell>
                    <TableCell>{fb.project.department?.name ?? "—"}</TableCell>
                    <TableCell className="font-medium">{fb.satisfactionScore} / 10</TableCell>
                    <TableCell className="max-w-xs truncate" title={fb.comments ?? undefined}>
                      {fb.comments ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{formatDate(fb.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
