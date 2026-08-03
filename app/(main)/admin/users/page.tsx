import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { UserManagement } from "@/components/admin/user-management";
import {
  parsePageParam,
  parsePageSizeParam,
  computePagination,
  isOutOfRange,
} from "@/lib/pagination";
import { buildAdminUserListQueryArgs, buildAdminUserListWhere } from "@/lib/services/admin-user-list-query";

interface SearchParams {
  departmentId?: string;
  search?: string;
  page?: string;
  pageSize?: string;
}

export default async function UsersAdminPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  try {
    await requireAdmin();
  } catch {
    redirect("/dashboard");
  }

  const params = await searchParams;
  const selectedDepartmentId = params.departmentId && params.departmentId !== "all" ? params.departmentId : "all";
  const search = params.search?.trim() ?? "";
  const requestedPage = parsePageParam(params.page);
  const pageSize = parsePageSizeParam(params.pageSize);

  // Index check (done, not assumed): `User` currently has no @@index beyond
  // the unique constraints on id/email/microsoftUserId (confirmed via
  // pg_indexes). No new migration was added for this feature — a plain
  // B-tree index wouldn't speed up the `contains` (ILIKE '%x%') search
  // below anyway (that needs pg_trgm/GIN, a materially bigger, separately-
  // justified change), and `departmentId`/`name`/`createdAt` filtering or
  // sorting over this table's real size (single/low-double-digit rows in
  // this deployment) is already effectively instant via a sequential scan.
  // Revisit if this table grows into the thousands and admin/users
  // pagination is observed to be slow — add the index then, backed by a
  // real EXPLAIN ANALYZE, not preemptively.
  const queryArgs = buildAdminUserListQueryArgs({
    departmentId: selectedDepartmentId,
    search,
    page: requestedPage,
    pageSize,
  });
  const userWhere = buildAdminUserListWhere(selectedDepartmentId, search);

  // findMany + count in one transaction so the page of rows and the total
  // used to compute totalPages/canonical-redirect are read from the same
  // consistent snapshot (never a total that reflects a row created/deleted
  // between two separate round trips).
  const [users, totalCount, departments, businessUnits] = await prisma.$transaction([
    prisma.user.findMany(queryArgs),
    prisma.user.count({ where: userWhere }),
    prisma.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, slug: true } }),
    prisma.businessUnit.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  const pagination = computePagination(totalCount, requestedPage, pageSize);

  // The requested page doesn't exist (e.g. a bookmarked/typed URL past the
  // end, or the last item on the last page was just deleted) — never
  // render the empty/wrong result `users` holds for that out-of-range skip;
  // send a canonical redirect to the real last valid page instead, keeping
  // every other param (search/department/pageSize) intact.
  if (isOutOfRange(requestedPage, pagination)) {
    const canonical = new URLSearchParams();
    if (selectedDepartmentId !== "all") canonical.set("departmentId", selectedDepartmentId);
    if (search) canonical.set("search", search);
    if (pageSize !== 20) canonical.set("pageSize", String(pageSize));
    canonical.set("page", String(pagination.page));
    redirect(`/admin/users?${canonical.toString()}`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">User Management</h1>
        <p className="text-muted-foreground mt-1">
          Manage user roles and permissions
        </p>
      </div>
      <UserManagement
        users={users as any}
        departments={departments}
        businessUnits={businessUnits}
        currentUserId={session.user.id}
        selectedDepartmentId={selectedDepartmentId}
        search={search}
        pagination={pagination}
      />
    </div>
  );
}
