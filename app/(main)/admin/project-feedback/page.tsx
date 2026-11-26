import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { hasPermission } from "@/lib/permissions";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { getProjectFeedbackTrackingOverview, type ProjectFeedbackTrackingStatus } from "@/lib/services/project-feedback-service";

const TRACKING_STATUS: Record<ProjectFeedbackTrackingStatus, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  COMPLETE: { label: "Complete", variant: "default" },
  IN_PROGRESS: { label: "In progress", variant: "secondary" },
  NO_ELIGIBLE_RECIPIENTS: { label: "No eligible active recipients", variant: "destructive" },
  NOT_TRACKED: { label: "Not tracked (historical)", variant: "outline" },
};

interface SearchParams {
  departmentId?: string;
  minRating?: string;
}

/**
 * Administration -> Feedback — REVIEW ONLY. Renders every submitted
 * ProjectFeedback row; never offers create/edit/delete for any of them —
 * editing a row is a privilege reserved for the Project's own primary
 * Owner (Project.ownerId), exclusively through the dedicated
 * /projects/[id]/feedback page (see
 * lib/services/project-feedback-service.ts's upsertProjectFeedback). The
 * "Submitted By" column shows whoever actually submitted a given row —
 * for a pre-existing legacy row that may still be the OLD requester, even
 * though the currently-authorized submitter going forward is the Owner
 * (see this feature's own legacy-provenance-preservation rule).
 *
 * Shows the FIVE individual 1-5 ratings (never a single collapsed
 * average) plus Requirements Delivered — the five-rating replacement of
 * the old single 1-10 satisfactionScore (see prisma/schema.prisma's
 * ProjectFeedback model doc comment). A pre-existing LEGACY row (submitted
 * before the replacement) has all five ratings null — rendered as "—" in
 * each rating column, with its own historical score shown in the Legacy
 * Score column instead, never fabricated into the new five-rating shape.
 *
 * Feedback Tracking (top table): one row per request-origin Project with
 * Required / Submitted / Pending recipients and the overall status, all
 * computed by computeProjectFeedbackTracking from the PERSISTED obligations
 * (ProjectFeedbackRequest) — inactive requested users are listed but never
 * required/blocking; Projects never processed by tracking are "Not tracked
 * (historical)", decided by Project.feedbackRequestedAt, never by the
 * absence of rows.
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

  const [tracking, feedbacks, departments] = await Promise.all([
    getProjectFeedbackTrackingOverview({ departmentId }),
    prisma.projectFeedback.findMany({
      where: {
        ...(departmentId ? { project: { departmentId } } : {}),
        // Filters on overallRating — the closest equivalent to the old
        // satisfactionScore's own "overall satisfaction" meaning. A
        // legacy row (overallRating null) never matches a minimum-rating
        // filter — it has no rating on the new 1-5 scale to compare.
        ...(minRatingNum && Number.isInteger(minRatingNum) ? { overallRating: { gte: minRatingNum } } : {}),
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
          Feedback requested from each Project's recipients on delivered, request-origin Projects. Read-only.
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
            Minimum Overall Rating
          </label>
          <select
            id="minRating"
            name="minRating"
            defaultValue={minRating ?? ""}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">Any</option>
            {[1, 2, 3, 4, 5].map((n) => (
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

      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Feedback Tracking</h2>
        <Card>
          <CardContent className="p-0">
            {tracking.length === 0 ? (
              <p className="text-sm text-muted-foreground p-6">No completed request-origin Projects yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table data-testid="feedback-tracking-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Project</TableHead>
                      <TableHead>Department</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Submitted / Required</TableHead>
                      <TableHead>Required Recipients</TableHead>
                      <TableHead>Submitted</TableHead>
                      <TableHead>Pending</TableHead>
                      <TableHead>Requested</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tracking.map(({ project, tracking: t, users, allSubmittedUserIds, otherSubmissionUserIds }) => {
                      const name = (id: string) => users[id]?.name ?? users[id]?.email ?? "—";
                      const list = (ids: string[]) => (ids.length ? ids.map(name).join(", ") : <span className="text-muted-foreground">—</span>);
                      const meta = TRACKING_STATUS[t.status];
                      return (
                        <TableRow key={project.id} data-project-id={project.id}>
                          <TableCell>
                            <Link href={`/projects/${project.id}`} className="text-primary hover:underline">
                              {project.title}
                            </Link>
                            {project.status !== "COMPLETED" && <div className="text-xs text-muted-foreground">Project reopened ({project.status})</div>}
                          </TableCell>
                          <TableCell>{project.department?.name ?? "—"}</TableCell>
                          <TableCell>
                            <Badge variant={meta.variant} className="whitespace-nowrap" data-testid="tracking-status">{meta.label}</Badge>
                          </TableCell>
                          <TableCell className="font-medium" data-testid="tracking-counts">
                            {t.status === "NOT_TRACKED" ? "—" : `${t.submitted.length} / ${t.required.length}`}
                          </TableCell>
                          <TableCell data-testid="tracking-required">
                            {list(t.required)}
                            {t.inactiveRequested.length > 0 && (
                              <div className="text-xs text-muted-foreground">Inactive (not required): {t.inactiveRequested.map((u) => `${name(u)}${allSubmittedUserIds.includes(u) ? " (submitted)" : ""}`).join(", ")}</div>
                            )}
                          </TableCell>
                          <TableCell data-testid="tracking-submitted">
                            {list(t.submitted)}
                            {otherSubmissionUserIds.length > 0 && (
                              <div className="text-xs text-muted-foreground">
                                {t.status === "NOT_TRACKED" ? "Historical submissions" : "Other submissions"}: {otherSubmissionUserIds.map(name).join(", ")}
                              </div>
                            )}
                          </TableCell>
                          <TableCell data-testid="tracking-pending">{list(t.pending)}</TableCell>
                          <TableCell className="whitespace-nowrap">{project.feedbackRequestedAt ? formatDate(project.feedbackRequestedAt) : "—"}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <h2 className="text-lg font-semibold">Submitted Feedback</h2>
      <Card>
        <CardContent className="p-0">
          {feedbacks.length === 0 ? (
            <p className="text-sm text-muted-foreground p-6">No Project Feedback has been submitted yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Project</TableHead>
                    <TableHead>Submitted By</TableHead>
                    <TableHead>Department</TableHead>
                    <TableHead>Delivery</TableHead>
                    <TableHead>Communication</TableHead>
                    <TableHead>Functionality</TableHead>
                    <TableHead>Ease of Use</TableHead>
                    <TableHead>Overall</TableHead>
                    <TableHead>Requirements Delivered</TableHead>
                    <TableHead>Legacy Score</TableHead>
                    <TableHead>Comments</TableHead>
                    <TableHead>Submitted / Updated</TableHead>
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
                      <TableCell>{fb.submittedByUser.name ?? fb.submittedByUser.email}</TableCell>
                      <TableCell>{fb.project.department?.name ?? "—"}</TableCell>
                      <TableCell className="font-medium">{fb.deliverySpeedRating ?? "—"}</TableCell>
                      <TableCell className="font-medium">{fb.communicationRating ?? "—"}</TableCell>
                      <TableCell className="font-medium">{fb.functionalityRating ?? "—"}</TableCell>
                      <TableCell className="font-medium">{fb.easeOfUseRating ?? "—"}</TableCell>
                      <TableCell className="font-medium">{fb.overallRating ?? "—"}</TableCell>
                      <TableCell>{fb.requirementsDelivered === null ? "—" : fb.requirementsDelivered ? "Yes" : "No"}</TableCell>
                      <TableCell className="text-muted-foreground">{fb.legacySatisfactionScore !== null ? `${fb.legacySatisfactionScore} / 10` : "—"}</TableCell>
                      <TableCell className="max-w-xs truncate" title={fb.comments ?? undefined}>
                        {fb.comments ?? <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatDate(fb.createdAt)}
                        {fb.updatedAt.getTime() !== fb.createdAt.getTime() && <span className="text-muted-foreground"> (upd. {formatDate(fb.updatedAt)})</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
